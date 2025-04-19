package main

import (
	"context"
	"fmt"
	"io"
	"math/rand/v2"
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
	ssmc      *ssm.Client
	gcpConfig *string

	// value is priority. Lower value means more important
	videoFormats = map[string]int{".mp4": 0, ".m4v": 1, ".mov": 2}
	audioFormats = map[string]int{".wav": 0, ".m4a": 1, ".mp3": 2, ".ogg": 3}
)

type Event struct {
	SourceFolderId string `json:"sourceDriveFolderId"`
}
type Output struct {
	JobId string `json:"jobId"`
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

	cfg, err := config.LoadDefaultConfig(context.TODO())
	if err != nil {
		log.Fatal("unable to load SDK config ", err)
	}

	ssmc = ssm.NewFromConfig(cfg)
	s3c = s3.NewFromConfig(cfg)
}

func GCPConfig(ctx context.Context) (*string, error) {
	if gcpConfig != nil {
		return gcpConfig, nil
	}

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
	gcpConfig = result
	return result, nil
}

func InitDrive(ctx context.Context) (*drive.Service, error) {
	gconf, err := GCPConfig(ctx)
	if err != nil {
		return nil, err
	}

	conf, err := google.JWTConfigFromJSON([]byte(*gconf), drive.DriveReadonlyScope)
	if err != nil {
		log.Error("Error parsing JWT config: ", err)
		return nil, err
	}

	client := conf.Client(ctx)
	driveService, err := drive.NewService(ctx, option.WithHTTPClient(client))
	if err != nil {
		log.Error("Error creating Drive client: ", err)
		return nil, err
	}

	return driveService, nil
}

func Sanitize(text string) string {
	text = strings.ToLower(text)
	text = strings.ReplaceAll(text, "-", "_")
	text = strings.ReplaceAll(text, " ", "_")

	reg := regexp.MustCompile(`[^a-z0-9\_\.]+`)
	text = reg.ReplaceAllString(text, "")

	return text
}

func HandleRequest(ctx context.Context, event Event) (Output, error) {
	// lctx, ok := lambdacontext.FromContext(ctx)
	// if !ok {
	// 	log.Fatal("Unable to read Lambda Context")
	// }

	targetBucket := os.Getenv("BUCKET_NAME")
	targetKey := os.Getenv("BUCKET_KEY")
	if targetBucket == "" {
		log.Fatal("env BUCKET_NAME is empty")
	}
	if len(targetKey) > 0 && !strings.HasSuffix(targetKey, "/") {
		targetKey = fmt.Sprintf("%s/", targetKey)
	}

	jobId := fmt.Sprintf("%x", rand.IntN(4294967295))
	log.Info("Job ID: ", jobId)

	driveSvc, err := InitDrive(ctx)
	if err != nil {
		log.Error("Error initializig G drive client service: ", err)
		return Output{}, err
	}

	stemsIter, err := driveSvc.Files.List().
		Context(ctx).
		Q(fmt.Sprintf("'%s' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder' and name = 'Stems'", event.SourceFolderId)).
		Fields("files(id, name)").
		Do()
	if err != nil {
		log.Error("Error finding stems in: ", event.SourceFolderId, err)
		return Output{}, err
	}

	if len(stemsIter.Files) == 0 {
		log.Error("There is no folder Stems in: ", event.SourceFolderId)
		return Output{}, err
	}
	stems := stemsIter.Files[0].Id

	// There is a possible nextPageToken field.
	// I do ignore it as I expect only a few files.
	files, err := driveSvc.Files.List().
		Context(ctx).
		Q(fmt.Sprintf("'%s' in parents and trashed = false", event.SourceFolderId)).
		Fields("files(id, name, mimeType)").
		Do()
	if err != nil {
		log.Error("Error listing files in: ", stems, err)
		return Output{}, err
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

	resp, err := driveSvc.Files.Get(videoFile.Id).Download()
	if err != nil {
		log.Error("Unable to download file: ", err)
		return Output{}, err
	}
	defer resp.Body.Close()

	tmpFile, err := os.CreateTemp("", "gdrive-download-")
	if err != nil {
		 log.Error("Error creating temporary file: ", err)
		return Output{}, err
	}
	defer os.Remove(tmpFile.Name()) // Clean up the temporary file
	defer tmpFile.Close()

	log.Info("Downloading Google Drive file to temporary storage: ", tmpFile.Name())

	_, err = io.Copy(tmpFile, resp.Body)
	if err != nil {
		 log.Error("Error copying Google Drive content to temporary file: ", err)
		return Output{}, err
	}

  bKey := fmt.Sprintf("%s%s/%s", targetKey, jobId, Sanitize(videoFile.Name))
	_, err = s3c.PutObject(ctx, &s3.PutObjectInput{
			Bucket: &targetBucket,
			Key:    &bKey,
			Body:   tmpFile,
		})
	if err != nil {
		 log.Error("Error S3 upload: ", err)
		return Output{}, err
	}

	return Output{
		JobId: jobId,
	}, nil
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
