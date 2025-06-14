package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"go.uber.org/zap"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/ssm"

	"golang.org/x/oauth2/google"
	"google.golang.org/api/drive/v3"
	"google.golang.org/api/option"

	"lambdalib/fileTransfer"
	"lambdalib/random"
)

var (
	s3c      *s3.Client
	log      *zap.SugaredLogger
	driveSvc *drive.Service

	videoFormats = map[string]int{".mp4": 10, ".m4v": 9, ".avi": 8, ".mov": 7}
	audioFormats = map[string]int{".wav": 10, ".m4a": 9, ".mp3": 8, ".ogg": 7}
)

type Event struct {
	JobId          string `json:"jobId"`
	SourceFolderId string `json:"sourceDriveFolderId"`
	DriveId        string `json:"driveId"`
	VideoFileId    string `json:"videoFileId"`
}

func main() {
	lambda.Start(HandleRequest)
}
func init() {
	logConfig := zap.NewProductionConfig()
	logConfig.Level = zap.NewAtomicLevelAt(zap.DebugLevel)
	logger, _ := logConfig.Build()
	defer logger.Sync()
	log = logger.Sugar()

	ctx := context.Background()

	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		log.Fatal("unable to load SDK config ", err)
	}

	ssmc := ssm.NewFromConfig(cfg)
	s3c = s3.NewFromConfig(cfg)

	err = InitDrive(ctx, ssmc)
	if err != nil {
		log.Fatal("Error initializig G drive client service: ", err)
	}
}

func GCPConfig(ctx context.Context, ssmc *ssm.Client) (*string, error) {
	log.Debug("Reading client lib config from param store")
	ssmConfigName := os.Getenv("SSM_GCP_CONFIG")
	if ssmConfigName == "" {
		log.Fatal("env SSM_GCP_CONFIG empty")
	}
	param, err := ssmc.GetParameter(ctx, &ssm.GetParameterInput{
		Name: &ssmConfigName,
	})
	if err != nil {
		return nil, err
	}

	result := param.Parameter.Value
	return result, nil
}

func InitDrive(ctx context.Context, ssmc *ssm.Client) error {
	gconf, err := GCPConfig(ctx, ssmc)
	if err != nil {
		return err
	}

	cred, err := google.CredentialsFromJSON(ctx, []byte(*gconf), drive.DriveScope)
	if err != nil {
		return errors.Join(errors.New("Error parsing JWT config"), err)
	}

	driveService, err := drive.NewService(ctx, option.WithCredentials(cred))
	if err != nil {
		return errors.Join(errors.New("Error creating Drive client"), err)
	}

	driveSvc = driveService
	return nil
}

func Sanitize(text string) string {
	text = strings.ToLower(text)
	text = strings.ReplaceAll(text, "-", "_")
	text = strings.ReplaceAll(text, " ", "_")

	reg := regexp.MustCompile(`[^a-z0-9\_\.]+`)
	text = reg.ReplaceAllString(text, "")

	return text
}

func getBucket(jobId string) (string, string) {
	targetBucket := os.Getenv("BUCKET_NAME")
	targetKey := os.Getenv("BUCKET_KEY")
	if targetBucket == "" {
		log.Fatal("env BUCKET_NAME is empty")
	}
	if len(targetKey) > 0 && !strings.HasSuffix(targetKey, "/") {
		targetKey = fmt.Sprintf("%s/", targetKey)
	}

	targetKey = fmt.Sprintf("%s%s/", targetKey, jobId)
	log.Debug("S3 key: ", targetKey)
	return targetBucket, targetKey
}

func FindStemsFolder(ctx context.Context, folderId string, driveId string) (string, error) {
	stemsIter, err := driveSvc.Files.List().
		Context(ctx).
		Q(fmt.Sprintf("'%s' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder' and name = 'Stems'", folderId)).
		Fields("files(id, name)").
		Corpora("drive").
		SupportsAllDrives(true).
		IncludeItemsFromAllDrives(true).
		DriveId(driveId).
		Do()
	if err != nil {
		return "", errors.Join(errors.New(fmt.Sprint("Error finding stems in: ", folderId)), err)
	}
	if stemsIter.NextPageToken != "" {
		log.Warn("Next Page Token is present. Pagination is not implemented. This may cause an absence of materials.")
	}

	if len(stemsIter.Files) == 0 {
		return "", nil
	}

	return stemsIter.Files[0].Id, nil
}

func FindStemsOCDLink(ctx context.Context, folderId string, driveId string) (string, error) {
	stemsIter, err := driveSvc.Files.List().
		Context(ctx).
		Q(fmt.Sprintf("'%s' in parents and trashed = false and mimeType = 'application/vnd.google-apps.shortcut'", folderId)).
		Fields("files(id, name, shortcutDetails)").
		Corpora("drive").
		SupportsAllDrives(true).
		IncludeItemsFromAllDrives(true).
		DriveId(driveId).
		Do()
	if err != nil {
		return "", errors.Join(errors.New(fmt.Sprint("Error finding stems in: ", folderId)), err)
	}
	if stemsIter.NextPageToken != "" {
		log.Warn("Next Page Token is present. Pagination is not implemented. This may cause an absence of materials.")
	}

	if len(stemsIter.Files) > 1 {
		log.Warn("When searching for stems, encountered more than 1 link in folder ", folderId, " Only the first link pointing to folder type is followed.")
	}

	for _, file := range stemsIter.Files {
		if file.ShortcutDetails.TargetMimeType == "application/vnd.google-apps.folder" {
			return file.ShortcutDetails.TargetId, nil
		}
	}
	return "", nil
}

func FindStems(ctx context.Context, folderId string, driveId string) (string, error) {
	stems, err := FindStemsFolder(ctx, folderId, driveId)
	if err != nil {
		return "", err
	}
	if stems != "" {
		return stems, nil
	}
	log.Info("No Stems here. Trying to find link (OCD - youtube stems).")
	stems, err = FindStemsOCDLink(ctx, folderId, driveId)
	if err != nil {
		return "", err
	}
	if stems != "" {
		return stems, nil
	}
	return "", errors.Join(errors.New(fmt.Sprint("There is no folder Stems or stem link in: ", folderId)), err)
}

func FilterFiles(ctx context.Context, stemsId string, driveId string, skipVideo bool) (*drive.File, []*drive.File, error) {
	// There is a possible nextPageToken field.
	// I do ignore it as I expect only a few files.
	files, err := driveSvc.Files.List().
		Context(ctx).
		Q(fmt.Sprintf("'%s' in parents and trashed = false", stemsId)).
		Fields("nextPageToken, files(id, name, mimeType)").
		Corpora("drive").
		SupportsAllDrives(true).
		IncludeItemsFromAllDrives(true).
		DriveId(driveId).
		Do()
	if err != nil {
		return nil, nil, errors.Join(errors.New(fmt.Sprint("Error listing files in:", stemsId)), err)
	}
	if files.NextPageToken != "" {
		log.Warn("Next Page Token is present. Pagination is not implemented. This may cause an absence of materials.")
	}

	var audioFiles []*drive.File
	var videoFile *drive.File
	videoPrio := 0

	filesShuffled := files.Files
	rand := random.NewRandom()
	random.Shuffle(rand, files.Files)

	for _, f := range filesShuffled {
		normalisedName := Sanitize(f.Name)
		extension := filepath.Ext(normalisedName)

		// Try to pick the most suitable video, if videos > 1
		if prio, ok := videoFormats[extension]; ok {
			// Strongly prioritise video files containg 'All video'
			if strings.Contains(normalisedName, "all_video") {
				prio += 100
			}
			wcount := strings.Count(normalisedName, "copy")

			// If there is Copy in name, prioritise it
			prio += wcount * 10

			if prio > videoPrio {
				videoPrio = prio
				videoFile = f
			}
		}
		// Pick all audio
		if _, ok := audioFormats[extension]; ok {
			audioFiles = append(audioFiles, f)
		}
	}
	if videoFile == nil && !skipVideo {
		return nil, nil, errors.New("No video file found in stems")
	}
	if len(audioFiles) == 0 {
		return nil, nil, errors.New("No audio files found in stems")
	}

	return videoFile, audioFiles, nil
}

func HandleRequest(ctx context.Context, event Event) error {
	// lctx, ok := lambdacontext.FromContext(ctx)
	// if !ok {
	//	log.Fatal("Unable to read Lambda Context")
	// }

	log.Infof("jobid=%s", event.JobId)
	targetBucket, targetKey := getBucket(event.JobId)

	stems, err := FindStems(ctx, event.SourceFolderId, event.DriveId)
	if err != nil {
		return err
	}

	var videoFileId string
	videoFile, audioFiles, err := FilterFiles(ctx, stems, event.DriveId, event.VideoFileId != "")
	if err != nil {
		return err
	}
	if event.VideoFileId != "" {
		videoFileId = event.VideoFileId
		log.Info("Using video specified in request: ", videoFileId)
	} else {
		videoFileId = videoFile.Id
	}

	bKey := fmt.Sprintf("%svideo/video%s", targetKey, filepath.Ext(videoFile.Name)) // BUG: When file doesn't exist, this fails
	err = fileTransfer.DriveToS3(ctx, s3c, driveSvc, videoFileId, targetBucket, bKey) // TODO: add ability to append file extension in file transfer lib
	if err != nil {
		return err
	}

	for i, audioFile := range audioFiles {
		bKey := fmt.Sprintf("%saudio/audio_%d%s", targetKey, i, filepath.Ext(audioFile.Name))
		err = fileTransfer.DriveToS3(ctx, s3c, driveSvc, audioFile.Id, targetBucket, bKey)
		if err != nil {
			return err
		}
	}

	return nil
}
