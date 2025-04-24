package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"go.uber.org/zap"

	// "github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	// "github.com/aws/aws-lambda-go/lambdacontext"
	// "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/ssm"

	// "golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	"google.golang.org/api/drive/v3"
	"google.golang.org/api/option"
)

var (
	s3c       *s3.Client
	log       *zap.SugaredLogger
	driveSvc *drive.Service

	// value is priority. Lower value means more important
	videoFormats = map[string]int{".mp4": 0, ".m4v": 1, ".avi": 2, ".mov": 3}
	audioFormats = map[string]int{".wav": 0, ".m4a": 1, ".mp3": 2, ".ogg": 3}
)

type Event struct {
	JobId string `json:"jobId"`
	SourceFolderId string `json:"sourceDriveFolderId"`
	DriveId string `json:"driveId"`
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

func FindStems(ctx context.Context, folderId string, driveId string) (*drive.File, error) {
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
		return nil, errors.Join(errors.New(fmt.Sprint("Error finding stems in: ", folderId)), err)
	}

	if len(stemsIter.Files) == 0 {
		return nil, errors.Join(errors.New(fmt.Sprint("There is no folder Stems in: ", folderId)), err)
	}
	return stemsIter.Files[0], nil
}

func FilterFiles(ctx context.Context, stemsId string, driveId string) (*drive.File, []*drive.File, error) {
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
	videoPrio := 10000

	for _, f := range files.Files {
		normalisedName := Sanitize(f.Name)
		extension := filepath.Ext(normalisedName)

		// Try to pick the most suitable video, if videos > 1
		if prio, ok := videoFormats[extension]; ok {
			// Prioritise video files containg 'All video'
			if strings.Contains(normalisedName, "all_video") {
				prio = prio - 100
			}
			if prio < videoPrio {
				videoPrio = prio
				videoFile = f
			}
		}
		// Pick all audio
		if _, ok := audioFormats[extension]; ok {
			audioFiles = append(audioFiles, f)
		}
	}
	if videoFile == nil {
		return nil, nil, errors.New("No video file found in stems")
	}
	if len(audioFiles) == 0 {
		return nil, nil, errors.New("No audio files found in stems")
	}

	return videoFile, audioFiles, nil
}

func drive2s3(ctx context.Context, file *drive.File, targetBucket string, targetKey string) error {
	resp, err := driveSvc.Files.Get(file.Id).Download()
	if err != nil {
		return errors.Join(errors.New(fmt.Sprintf("Unable to download file: %s: %s", file.Id, file.Name)), err)
	}
	defer resp.Body.Close()

	tmpFile, err := os.CreateTemp("", "gdrive-")
	if err != nil {
		 log.Error("Error creating temporary file: ", err)
		return errors.Join(errors.New("Error creating temporary file"), err)
	}
	defer os.Remove(tmpFile.Name()) // Clean up the temporary file
	defer tmpFile.Close()

	log.Debug("Downloading Google Drive file to temporary storage: ", tmpFile.Name())

	copyBytes, err := io.Copy(tmpFile, resp.Body)
	if err != nil {
		return errors.Join(errors.New(fmt.Sprint("Error copying Google Drive content to temporary file: ", tmpFile.Name())), err)
	}
	log.Debug("Bytes Downloaded ", copyBytes)

	// Rewind to start of FS stream
	_, err = tmpFile.Seek(0, io.SeekStart)
	if err != nil {
		return errors.Join(errors.New("Error file stream rewind"), err)
	}

  // bKey := fmt.Sprintf("%s%s", targetKey, Sanitize(file.Name))
	_, err = s3c.PutObject(ctx, &s3.PutObjectInput{
			Bucket: &targetBucket,
			Key:    &targetKey,
			Body:   tmpFile,
		})
	if err != nil {
		return errors.Join(errors.New(fmt.Sprintf("Error S3 upload: bucket=%s key=%s file: %s", targetBucket, targetKey, file.Name)), err)
	}

	return nil
}

func HandleRequest(ctx context.Context, event Event) (error) {
	// lctx, ok := lambdacontext.FromContext(ctx)
	// if !ok {
	// 	log.Fatal("Unable to read Lambda Context")
	// }

	targetBucket, targetKey := getBucket(event.JobId)

	stems, err := FindStems(ctx, event.SourceFolderId, event.DriveId)
	if err != nil {
		return err
	}

	videoFile, audioFiles, err := FilterFiles(ctx, stems.Id, event.DriveId)

  bKey := fmt.Sprintf("%svideo.%s", targetKey, filepath.Ext(videoFile.Name))
	err = drive2s3(ctx, videoFile, targetBucket, bKey)
	if err != nil {
		return err
	}

	for i, audioFile := range audioFiles {
		bKey := fmt.Sprintf("%saudio_%d.%s", targetKey, i, filepath.Ext(audioFile.Name))
		err = drive2s3(ctx, audioFile, targetBucket, bKey)
		if err != nil {
			return err
		}
	}

	return nil
}

// func ErrResponse(response string, ctx *lambdacontext.LambdaContext) (events.APIGatewayV2HTTPResponse, error) {
// 	execId := ctx.AwsRequestID
// 	responseBody, _ := json.Marshal(map[string]string{
// 		"error":     response,
// 		"execution": execId,
// 	})
// 	return events.APIGatewayV2HTTPResponse{
// 		StatusCode: 400,
// 		Body:       string(responseBody),
// 		Headers: map[string]string{
// 			"Content-Type": "application/json",
// 		},
// 	}, nil
// }
// func OkResponse(response *map[string]any) (events.APIGatewayV2HTTPResponse, error) {
// 	responseBody, err := json.Marshal(response)
// 	if err != nil {
// 		log.Error("Marshaling response ", err.Error())
// 		return events.APIGatewayV2HTTPResponse{}, err
// 	}
// 	return events.APIGatewayV2HTTPResponse{
// 		StatusCode: 200,
// 		Body:       string(responseBody),
// 		Headers: map[string]string{
// 			"Content-Type": "application/json",
// 		},
// 	}, nil
// }
