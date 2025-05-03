package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"go.uber.org/zap"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/ssm"

	"golang.org/x/oauth2/google"
	"google.golang.org/api/docs/v1"
	"google.golang.org/api/drive/v3"
	"google.golang.org/api/option"
)

var (
	s3c       *s3.Client
	log       *zap.SugaredLogger
	driveSvc *drive.Service
	docsSvc *docs.Service
)
const (
	translationFilePrefix string = "SUB_"
	startMarker string = "{{translation_start}}"
	endMarker string = "{{translation_end}}"
)

type Event struct {
	SourceFolderId string `json:"sourceDriveFolderId"`
	DriveId string `json:"driveId"`
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

	ctx := context.Background()

	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		log.Fatal("unable to load SDK config ", err)
	}

	ssmc := ssm.NewFromConfig(cfg)
	s3c = s3.NewFromConfig(cfg)

	err = InitDrive(ctx, ssmc)
	if err != nil {
		log.Fatal("Error initializig Google service client: ", err)
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

	optCred := option.WithCredentials(cred)

	driveService, err := drive.NewService(ctx, optCred)
	if err != nil {
		return errors.Join(errors.New("Error creating Drive client"), err)
	}

	docsService, err := docs.NewService(ctx, optCred)
	if err != nil {
		return errors.Join(errors.New("Error creating Docs client"), err)
	}

	driveSvc = driveService
	docsSvc = docsService
	return nil
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

func findTranslation(ctx context.Context, folderId string, driveId string) (*drive.File, error) {
	files, err := driveSvc.Files.List().
		Context(ctx).
		Q(fmt.Sprintf("'%s' in parents and trashed = false and mimeType = 'application/vnd.google-apps.document'", folderId)).
		Fields("nextPageToken, files(id, name, mimeType)").
		Corpora("drive").
		SupportsAllDrives(true).
		IncludeItemsFromAllDrives(true).
		DriveId(driveId).
		Do()
	if err != nil {
		return nil, errors.Join(errors.New(fmt.Sprint("Error finding translation doc in: ", folderId)), err)
	}
	if len(files.Files) == 0 {
		return nil, errors.Join(errors.New(fmt.Sprint("There are no files in: ", folderId)), err)
	}
	if files.NextPageToken != "" {
		log.Warn("Next Page Token is present. Pagination is not implemented. This may cause an absence of materials.")
	}

	for _, file := range files.Files {
		if strings.HasPrefix(file.Name, translationFilePrefix) {
			return file, nil
		}
	}
	return nil, errors.New(fmt.Sprintf("No translation file with %s prefix found in %s", translationFilePrefix, folderId))
}

func substringBetween(s, start, end string) (string, bool) {
	startIdx := strings.Index(s, start)
	if startIdx == -1 {
		return "", false
	}
	startIdx += len(start)

	endIdx := strings.Index(s[startIdx:], end)
	if endIdx == -1 {
		return "", false
	}

	return s[startIdx : startIdx+endIdx], true
}

func GetRelevantContent(ctx context.Context, doc *docs.Document) (string, bool) {
	for _, element := range doc.Body.Content {
		if element.Table != nil {
			for _, row := range element.Table.TableRows {
				for _, cell := range row.TableCells {

					agregatedCell := ""

					for _, subElement := range cell.Content {
						if subElement.Paragraph != nil {
							for _, paragraph := range subElement.Paragraph.Elements {
								if paragraph.TextRun != nil {
									agregatedCell += paragraph.TextRun.Content
								}
							}
						}
					}

					srts, ok := substringBetween(agregatedCell, startMarker, endMarker)
					if ok {
						return srts, true
					}
				}
			}
		}
	}
	return "", false
}

func HandleRequest(ctx context.Context, event Event) (error) {
	log.Infof("jobid=%s", event.JobId)
	targetBucket, targetKey := getBucket(event.JobId)

	transFile, err := findTranslation(ctx, event.SourceFolderId, event.DriveId)
	if err != nil {
		return err
	}

	doc, err := docsSvc.Documents.Get(transFile.Id).Do()
	if err != nil {
		return errors.Join(errors.New(fmt.Sprint("Error opening translation document", transFile.Id)), err)
	}

	srt, ok := GetRelevantContent(ctx, doc)
	if !ok {
		return errors.New(fmt.Sprintf("Nothing found in document %s. Maybe it's missing markers %s and %s", transFile.Id, startMarker, endMarker))
	}
	srt = strings.ReplaceAll(srt, "\v", "\n") // replace vertical tab

  bKey := fmt.Sprintf("%s%s", targetKey, "subtitles.srt")
	_, err = s3c.PutObject(ctx, &s3.PutObjectInput{
			Bucket: &targetBucket,
			Key:    &bKey,
			Body:   bytes.NewReader([]byte(srt)),
		})
	if err != nil {
		return errors.Join(errors.New(fmt.Sprintf("Error S3 upload: bucket=%s key=%s", targetBucket, targetKey)), err)
	}

	return nil
}
