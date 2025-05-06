package main

import (
	"context"
	"go.uber.org/zap"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"google.golang.org/api/drive/v3"

	"lambdalib/clientInit"
	"lambdalib/configRead"
	"lambdalib/fileTransfer"
)

var (
	s3c      *s3.Client
	log      *zap.SugaredLogger
	driveSvc *drive.Service
)

type Event struct {
	Direction     string    `json:"direction"`
	DriveFolderId string    `json:"driveFolderId"`
	DriveFileName      string    `json:"driveFileName"`
	DriveFileId string    `json:"driveFileId"`
	MimeType      string    `json:"mimeType"`
	S3Bucket      string    `json:"s3Bucket"`
	S3Key         string    `json:"s3Key"`
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

	driveSvc, _, err = clientInit.InitGDrive(ctx, clientInit.GInit{ConfigJson: &gcpConfig})
	if err != nil {
		log.Fatal("Error initializig Google service client: ", err)
	}
}

func HandleRequest(ctx context.Context, event Event) error {
	log.Infof("direction=%s", event.Direction)
	switch event.Direction {
	case "s3ToDrive":
		log.Debugf("uploading from bucket=%s key=%s to driveFolder=%s file=%s", event.S3Bucket, event.S3Key, event.DriveFolderId, event.DriveFileName)
		err := fileTransfer.S3ToDrive(ctx, s3c, driveSvc, event.S3Bucket, event.S3Key, event.DriveFolderId, event.DriveFileName, event.MimeType)
		if err != nil {
			return err
		}

	case "driveToS3":
		log.Debugf("downloading from driveFile=%s to bucket=%s key=%s", event.DriveFileId, event.S3Bucket, event.S3Key)
		err := fileTransfer.DriveToS3(ctx, s3c, driveSvc, event.DriveFileId, event.S3Bucket, event.S3Key)
		if err != nil {
			return err
		}
	}

	return nil
}
