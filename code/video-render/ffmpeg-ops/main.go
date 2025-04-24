package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"go.uber.org/zap"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

var (
	s3c       *s3.Client
	log       *zap.SugaredLogger
)

type Event struct {
	JobId string `json:"jobId"`
	Action string `json:"action"`

	VideoFileBucket string `json:"videoFileBucket"`
	VideoFileKey string `json:"videoFileKey"`
	FrameFolderBucket string `json:"imgFolderBucket"`
	FrameFolderKey string `json:"imgFolderKey"`
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

	s3c = s3.NewFromConfig(cfg)
}

func getBucketKey(jobId string, targetKey string) (string) {
	if len(targetKey) > 0 && !strings.HasSuffix(targetKey, "/") {
		targetKey = fmt.Sprintf("%s/", targetKey)
	}

  targetKey = fmt.Sprintf("%s%s/", targetKey, jobId)
	log.Debug("S3 key: ", targetKey)
	return targetKey
}

func testFFmpeg(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, "ffmpeg", "-version")
	if err := cmd.Run(); err != nil {
		return errors.Join(errors.New("Failed inital ffmpeg test"), err)
	}
	return nil
}

func copyVideoIn(ctx context.Context, videoFile *os.File, s3Bucket string, s3Key string) error {
	file, err := s3c.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s3Bucket),
		Key:    aws.String(s3Key),
	})
	if err != nil {
		return errors.Join(errors.New("Error downloading video from S3"), err)
	}
	defer file.Body.Close()

	videoFile.Seek(0, io.SeekStart)
	io.Copy(videoFile, file.Body)
	return nil
}

func ffmpegDecode(ctx context.Context, videoFile *os.File, frameFolder string) error {
	cmd := exec.CommandContext(ctx, "ffmpeg", "-i", videoFile.Name(), "-vsync", "0", frameFolder + "/frame_%06d.jpg")
	if err := cmd.Run(); err != nil {
		return errors.Join(errors.New("Failed ffmpeg decode to frames"), err)
	}
	return nil
}

func copyFramesOut(ctx context.Context, framesFolder string, s3Bucket string, s3Key string) error {
	err := filepath.WalkDir(framesFolder, func(path string, entry fs.DirEntry, err error) error {
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()
		
		bKey := fmt.Sprintf("%s%s", s3Key, entry.Name())
		_, err = s3c.PutObject(ctx, &s3.PutObjectInput{
				Bucket: &s3Bucket,
				Key:    &bKey,
				Body:   file,
			})
		if err != nil {
			return errors.Join(errors.New(fmt.Sprintf("Error S3 upload: bucket=%s key=%s file: %s", s3Bucket, bKey, file.Name())), err)
		}
		return nil
	})
	return err
}

func HandleRequest(ctx context.Context, event Event) (error) {
	err := testFFmpeg(ctx)
	if err != nil {
		return err
	}

	framesFolderKey := getBucketKey(event.JobId, event.FrameFolderKey)

	frameDir, err := os.MkdirTemp("", "frames-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(frameDir)

	videoFile, err := os.CreateTemp("", "video-")
	if err != nil {
		return err
	}
	defer os.Remove(videoFile.Name())
	defer videoFile.Close()

	switch event.Action {
	case "vid2frame":
		err := copyVideoIn(ctx, videoFile, event.VideoFileBucket, event.VideoFileKey)
		if err != nil {
			return err
		}
		err = ffmpegDecode(ctx, videoFile, frameDir)
		if err != nil {
			return err
		}
		err = copyFramesOut(ctx, frameDir, event.FrameFolderBucket, framesFolderKey)
		if err != nil {
			return err
		}
	case "frame2vid":
	default:
		return errors.New("Unknown action " + event.Action)
	}

	return nil
}
