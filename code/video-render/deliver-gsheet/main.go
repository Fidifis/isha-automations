package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"go.uber.org/zap"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/ssm"

	"golang.org/x/oauth2/google"
	"google.golang.org/api/drive/v3"
	"google.golang.org/api/option"
	"google.golang.org/api/sheets/v4"
)

var (
	s3c      *s3.Client
	log      *zap.SugaredLogger
	driveSvc *drive.Service
	sheetSvc *sheets.Service
)

const (
	deliverName string = "OUT_video.mp4"
)

type Event struct {
	DeliveryParams string `json:"deliveryParams"`
	Bucket         string `json:"bucket"`
	VideoKey       string `json:"videoKey"`
}

type SheetSetCellVals struct {
	SheetName string `json:"sheetName"`
	Column    int    `json:"column"`
	Row       int    `json:"row"`
	Value     string `json:"value"`
}
type DeliveryParams struct {
	VideoFolder  string             `json:"videoFolderId"`
	SheetId      string             `json:"sheetId"`
	SetValues    []SheetSetCellVals `json:"setValues"`
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

	sheetService, err := sheets.NewService(ctx, optCred)
	if err != nil {
		return errors.Join(errors.New("Error creating Sheets client"), err)
	}

	driveSvc = driveService
	sheetSvc = sheetService
	return nil
}

func columnToLetter(column int) string {
	result := ""
	for column >= 0 {
		result = string(rune('A'+(column%26))) + result
		column = column/26 - 1
	}
	return result
}

func WriteToSheet(ctx context.Context, params DeliveryParams) error {
	var valueRanges []*sheets.ValueRange

	for _, cellVal := range params.SetValues {
		// Convert 0-based index to A1 notation (e.g., A1, B2)
		// In A1 notation, columns start with A and rows start with 1
		columnLetter := columnToLetter(cellVal.Column)
		cellReference := fmt.Sprintf("%s!%s%d", cellVal.SheetName, columnLetter, cellVal.Row+1)

		valueRange := &sheets.ValueRange{
			Range:  cellReference,
			Values: [][]interface{}{{cellVal.Value}},
		}
		valueRanges = append(valueRanges, valueRange)
	}

	batchUpdateRequest := &sheets.BatchUpdateValuesRequest{
		ValueInputOption: "RAW",
		Data:             valueRanges,
	}
	_, err := sheetSvc.Spreadsheets.Values.BatchUpdate(params.SheetId, batchUpdateRequest).Context(ctx).Do()
	if err != nil {
		return errors.Join(fmt.Errorf("Error Spreadsheet update sheetid=%s", params.SheetId), err)
	}
	return nil
}

func CopyToDrive(ctx context.Context, s3Bucket string, s3Key string, folderId string) error {
	s3File, err := s3c.GetObject(ctx, &s3.GetObjectInput{
		Bucket: &s3Bucket,
		Key:    &s3Key,
	})
	if err != nil {
		return errors.Join(fmt.Errorf("Error downloading file from s3=%s key=%s", s3Bucket, s3Key), err)
	}
	defer s3File.Body.Close()

	_, err = driveSvc.Files.Create(&drive.File{
		Name:    deliverName,
		Parents:  []string{folderId},
		MimeType: "application/vnd.google-apps.video",
	}).Media(s3File.Body).Do()
	if err != nil {
		return errors.Join(fmt.Errorf("Error uploading file to folder=%s file=%s", folderId, deliverName), err)
	}
	return nil
}

func HandleRequest(ctx context.Context, event Event) error {
	var params DeliveryParams
	err := json.Unmarshal([]byte(event.DeliveryParams), &params)
	if err != nil {
		return errors.Join(errors.New("Failed to Unmarshal deliveryParams"), err)
	}

	err = CopyToDrive(ctx, event.Bucket, event.VideoKey, params.VideoFolder)
	if err != nil {
		return err
	}

	err = WriteToSheet(ctx, params)
	if err != nil {
		return err
	}

	return nil
}
