package fileTransfer

import (
	"context"
	"errors"
	"fmt"
	"os"
	"io"

	"google.golang.org/api/drive/v3"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// MimeType can be empty to be autodetected
func S3ToDrive(ctx context.Context, s3c *s3.Client, driveSvc *drive.Service, s3Bucket string, s3Key string, folderId string, fileName string, mimeType string) error {
	s3File, err := s3c.GetObject(ctx, &s3.GetObjectInput{
		Bucket: &s3Bucket,
		Key:    &s3Key,
	})
	if err != nil {
		return errors.Join(fmt.Errorf("Error downloading file from s3=%s key=%s", s3Bucket, s3Key), err)
	}
	defer s3File.Body.Close()

	_, err = driveSvc.Files.
		Create(&drive.File{
			Name:     fileName,
			Parents:  []string{folderId},
			MimeType: mimeType,
		}).
		Media(s3File.Body).
		SupportsAllDrives(true).
		Do()
	if err != nil {
		return errors.Join(fmt.Errorf("Error uploading file to folder=%s file=%s", folderId, fileName), err)
	}
	return nil
}

func DriveToS3(ctx context.Context, s3c *s3.Client, driveSvc *drive.Service, fileId string, s3Bucket string, s3Key string) error {
	resp, err := driveSvc.Files.Get(fileId).Download()
	if err != nil {
		return errors.Join(fmt.Errorf("Unable to download file: %s", fileId), err)
	}
	defer resp.Body.Close()

	tmpFile, err := os.CreateTemp("", "gdrive-")
	if err != nil {
		return errors.Join(errors.New("Error creating temporary file"), err)
	}
	defer os.Remove(tmpFile.Name()) // Clean up the temporary file
	defer tmpFile.Close()

	_, err = io.Copy(tmpFile, resp.Body)
	if err != nil {
		return errors.Join(fmt.Errorf("Error copying Google Drive content to temporary file: ", tmpFile.Name()), err)
	}

	// Rewind to start of FS stream
	_, err = tmpFile.Seek(0, io.SeekStart)
	if err != nil {
		return errors.Join(errors.New("Error file stream rewind"), err)
	}

	_, err = s3c.PutObject(ctx, &s3.PutObjectInput{
			Bucket: &s3Bucket,
			Key:    &s3Key,
			Body:   tmpFile,
		})
	if err != nil {
		return errors.Join(fmt.Errorf("Error S3 upload: bucket=%s key=%s file=%s", s3Bucket, s3Key, fileId), err)
	}

	return nil
}

func S3ToLocal(ctx context.Context, s3c *s3.Client, s3Bucket string, s3Key string, fileHandle *os.File) error {
	s3File, err := s3c.GetObject(ctx, &s3.GetObjectInput{
		Bucket: &s3Bucket,
		Key:    &s3Key,
	})
	if err != nil {
		return errors.Join(fmt.Errorf("Error downloading file from s3=%s key=%s", s3Bucket, s3Key), err)
	}
	defer s3File.Body.Close()

	_, err = io.Copy(fileHandle, s3File.Body)
	if err != nil {
		return errors.Join(fmt.Errorf("Error writing downloaded file from s3=%s key=%s file=%s", s3Bucket, s3Key, fileHandle.Name()), err)
	}
	return nil
}
