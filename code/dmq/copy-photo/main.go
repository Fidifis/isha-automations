package main

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

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
	JobId string `json:"jobId"`
	Direction string `json:"direction"`
	DriveFolderId string `json:"sourceDriveFolderId"`
	DriveId string `json:"driveId"`
	S3Bucket string `json:"s3Bucket"`
	S3Key string `json:"s3Key"`
	Date time.Time `json:"date,omitempty"`
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

func selectFileByDay(ctx context.Context, driveId string, searchFolderId string, day int) (string, error) {
	log.Debugf("Searching %s for day %d", searchFolderId, day)
	folderIter, err := driveSvc.Files.List().
		Context(ctx).
		Q(fmt.Sprintf("'%s' in parents and trashed = false", searchFolderId)).
		Fields("files(id, name)").
		Corpora("drive").
		SupportsAllDrives(true).
		IncludeItemsFromAllDrives(true).
		DriveId(driveId).
		Do()
	if err != nil {
		return "", errors.Join(fmt.Errorf("Error listing drive folder: %s", searchFolderId), err)
	}

	if len(folderIter.Files) == 0 {
		return "", errors.Join(fmt.Errorf("There is no file in: %s", searchFolderId), err)
	}

	errEncountered := false
	for _, image := range folderIter.Files {
		split := strings.SplitN(image.Name, "-", 3)
		if len(split) != 3 {
			errEncountered = true
			log.Warnf("File name was not split into expected number of segments searchfolder=%s splitLen=%d expect=3 file=%s", searchFolderId, len(split), image.Name)
			continue
		}
		imgNumStr := split[1]
		imgNum, err := strconv.Atoi(imgNumStr)
		if err != nil {
			errEncountered = true
			log.Warnf("First segment of folder name does not contain valid number searchfolder=%s file=%s", searchFolderId, image.Name)
			continue
		}

		if imgNum == day {
			return image.Id, nil
		}
	}

	if errEncountered {
		err = fmt.Errorf("During iteration some errors raised")
	} else {
		err = nil
	}
	return "", errors.Join(fmt.Errorf("Image for day %d not found in %s", day, searchFolderId), err)
}
func selectFolderByMonth(ctx context.Context, driveId string, searchFolderId string, month int) (string, error) {
	log.Debugf("Searching %s for month %d", searchFolderId, month)
	folderIter, err := driveSvc.Files.List().
		Context(ctx).
		Q(fmt.Sprintf("'%s' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'", searchFolderId)).
		Fields("files(id, name)").
		Corpora("drive").
		SupportsAllDrives(true).
		IncludeItemsFromAllDrives(true).
		DriveId(driveId).
		Do()
	if err != nil {
		return "", errors.Join(fmt.Errorf("Error listing drive folder: %s", searchFolderId), err)
	}

	if len(folderIter.Files) == 0 {
		return "", errors.Join(fmt.Errorf("There is no folder in: %s", searchFolderId), err)
	}

	errEncountered := false
	for _, monthFolder := range folderIter.Files {
		split := strings.SplitN(monthFolder.Name, " ", 2)
		if len(split) != 2 {
			errEncountered = true
			log.Warnf("Folder name was not split into expected number of segments searchfolder=%s splitLen=%d expect=2 folder=%s", searchFolderId, len(split), monthFolder.Name)
			continue
		}
		folderNumStr := split[0]
		folderNum, err := strconv.Atoi(folderNumStr)
		if err != nil {
			errEncountered = true
			log.Warnf("First segment of folder name does not contain valid number searchfolder=%s folder=%s", searchFolderId, monthFolder.Name)
			continue
		}

		if folderNum == month {
			return monthFolder.Id, nil
		}
	}

	if errEncountered {
		err = fmt.Errorf("During iteration some errors raised")
	} else {
		err = nil
	}
	return "", errors.Join(fmt.Errorf("Folder for month %d not found in %s", month, searchFolderId), err)
}
func getImageByDate(ctx context.Context, driveId string, searchFolderId string, date time.Time) (string, error) {
	year := date.Year()
	log.Debugf("Searching folder %s for year %d", searchFolderId, year)
	folderIter, err := driveSvc.Files.List().
		Context(ctx).
		Q(fmt.Sprintf("'%s' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'", searchFolderId)).
		Fields("files(id, name)").
		Corpora("drive").
		SupportsAllDrives(true).
		IncludeItemsFromAllDrives(true).
		DriveId(driveId).
		Do()
	if err != nil {
		return "", errors.Join(fmt.Errorf("Error listing drive folder: %s", searchFolderId), err)
	}

	if len(folderIter.Files) == 0 {
		return "", errors.Join(fmt.Errorf("There is no folder in: ", searchFolderId), err)
	}

	for _, yearFolder := range folderIter.Files {
		if strings.Contains(yearFolder.Name, string(year)) {
			monthId, err := selectFolderByMonth(ctx, driveId, yearFolder.Id, int(date.Month()))
			if err != nil {
				return "", err
			}

			img, err := selectFileByDay(ctx, driveId, monthId, date.Day())
			if err != nil {
				return "", err
			}
			return img, nil
		}
	}

	return "", fmt.Errorf("Folder for year %d not found in %s", year, searchFolderId)
}

func HandleRequest(ctx context.Context, event Event) error {
	log.Infof("jobid=%s", event.JobId)

	log.Infof("direction=%s", event.Direction)
	switch event.Direction {
	case "s3ToDrive":
		key := fmt.Sprintf("%d-%02d-%02d", event.Date.Year(), int(event.Date.Month()), event.Date.Day())
		vertical := fmt.Sprintf("%s_vertical", key)
		square := fmt.Sprintf("%s_square", key)
		s3Vertical := event.S3Key + "-vertical"
		s3Square := event.S3Key + "-square"
		err1 := fileTransfer.S3ToDrive(ctx, s3c, driveSvc, event.S3Bucket, s3Vertical, event.DriveFolderId, vertical)
		err2 := fileTransfer.S3ToDrive(ctx, s3c, driveSvc, event.S3Bucket, s3Square, event.DriveFolderId, square)
		if err1 != nil || err2 != nil {
			return errors.Join(errors.New("Fail upload DMQ"), err1, err2)
		}
	case "driveToS3":
	log.Debugf("looking for image with date %s", event.Date.String())
	imageId, err := getImageByDate(ctx, event.DriveId, event.DriveFolderId, event.Date)
	if err != nil {
		return err
	}

	log.Debug("copy from drive to s3")
	err = fileTransfer.DriveToS3(ctx, s3c, driveSvc, imageId, event.S3Bucket, event.S3Key)
	if err != nil {
		return err
	}
	}

	
	return nil
}
