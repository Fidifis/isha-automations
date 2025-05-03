package main

import (
	"context"
	"errors"
	"time"

	"go.uber.org/zap"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"google.golang.org/api/drive/v3"

	"lambdalib/clientInit"
	"lambdalib/configRead"
)

var (
	s3c      *s3.Client
	log      *zap.SugaredLogger
	driveSvc *drive.Service
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

	var err error
	var cfg *aws.Config

	s3c, cfg, err = clientInit.InitS3(ctx, cfg)
	if err != nil {
		log.Fatal(err)
	}
	ssmc, cfg, err := clientInit.InitSSM(ctx, cfg)
	if err != nil {
		log.Fatal(err)
	}

	gcpConfig, err := configRead.GcpConfig(ctx, ssmc)
	if err != nil {
		log.Fatal(err)
	}

	driveSvc, _, err = clientInit.InitGDrive(ctx, clientInit.GInit{ ConfigJson: &gcpConfig })
	if err != nil {
		log.Fatal("Error initializig Google service client: ", err)
	}
}

func getImageByDate(ctx context.Context, driveId string, serchFolderId string, date time.Time) {

}

func HandleRequest(ctx context.Context, event Event) error {
	
	return nil
}
