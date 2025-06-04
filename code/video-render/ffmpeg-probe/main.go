package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"go.uber.org/zap"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"

	"lambdalib/clientInit"
	"lambdalib/fileTransfer"
)

var (
	s3c *s3.Client
	log *zap.SugaredLogger
)

type Event struct {
	JobId             string `json:"jobId"`
	S3Bucket          string `json:"s3Bucket"`
	DownloadFolderKey string `json:"downloadFolderKey"`
}

type Output struct {
	Framerate  string `json:"framerate"`
	Resolution string `json:"resolution"`
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
}

func testFFmpeg(ctx context.Context) error {
	log.Debug("Testing ffmpeg commands")
	cmd := exec.CommandContext(ctx, "ffmpeg", "-version")
	cmdProbe := exec.CommandContext(ctx, "ffprobe", "-version")

	if err := cmd.Run(); err != nil {
		return errors.Join(errors.New("Failed inital ffmpeg test"), err)
	}
	if err := cmdProbe.Run(); err != nil {
		return errors.Join(errors.New("Failed inital ffprobe test"), err)
	}
	return nil
}

func getFramerate(ctx context.Context, videoFile string) (string, error) {
	log.Debug("Probing frame rate")
	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "0",
		"-select_streams", "v:0",
		"-show_entries", "stream=r_frame_rate",
		"-of", "default=noprint_wrappers=1:nokey=1",
		videoFile,
	)

	var out bytes.Buffer
	cmd.Stdout = &out

	if err := cmd.Run(); err != nil {
		return "", errors.Join(errors.New("Failed ffprobe framerate"), err)
	}

	rawRate := strings.TrimSpace(out.String())

	// Expected output: "30000/1001\n"
	framerate := strings.TrimSpace(rawRate)
	log.Infof("framerate = %f", framerate)

	return framerate, nil
}

func getResolution(ctx context.Context, videoFile string) (string, error) {
	log.Debug("Probing resolution")
	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "0",
		"-select_streams", "v:0",
		"-show_entries", "stream=width,height",
		"-of", "csv=s=x:p=0",
		videoFile,
	)

	var out bytes.Buffer
	cmd.Stdout = &out

	if err := cmd.Run(); err != nil {
		return "", errors.Join(errors.New("Failed ffprobe resolution"), err)
	}

	rawRate := strings.TrimSpace(out.String())

	// expected output: "1080x1920"
	resolution := strings.TrimSpace(rawRate)
	log.Infof("resolution = %s", resolution)

	return resolution, nil
}

func copyVideoIn(ctx context.Context, videoFile string, s3Bucket string, s3Key string) error {
	log.Debugf("Downloading video from s3=%s key=%s", s3Bucket, s3Key)
	paginator := s3.NewListObjectsV2Paginator(s3c, &s3.ListObjectsV2Input{
		Bucket: &s3Bucket,
		Prefix: &s3Key,
	})

	var file *types.Object

	for paginator.HasMorePages() {
		list, err := paginator.NextPage(ctx)
		if err != nil {
			return errors.Join(fmt.Errorf("Error listing bucket s3=%s key=%s", s3Bucket, s3Key), err)
		}
		for _, object := range list.Contents {
			file = &object
			break
		}
	}

	if file == nil {
		return fmt.Errorf("Nothing returned while looking for video, listing bucket s3=%s key=%s", s3Bucket, s3Key)
	}

	fileHandle, err := os.Create(videoFile)
	if err != nil {
		return errors.Join(fmt.Errorf("Error create a file for the download s3=%s key=%s file=%s", s3Bucket, s3Key, file), err)
	}
	defer fileHandle.Close()

	return fileTransfer.S3ToLocal(ctx, s3c, s3Bucket, *file.Key, fileHandle)
}

func getBucketKey(jobId string, targetKey string) string {
	if len(targetKey) > 0 && !strings.HasSuffix(targetKey, "/") {
		targetKey = fmt.Sprintf("%s/", targetKey)
	}

	targetKey = fmt.Sprintf("%s%s/", targetKey, jobId)
	log.Debug("S3 key: ", targetKey)
	return targetKey
}

func HandleRequest(ctx context.Context, event Event) (Output, error) {
	log.Infof("jobid=%s", event.JobId)
	err := testFFmpeg(ctx)
	if err != nil {
		return Output{}, err
	}

	downloadsDir, err := os.MkdirTemp("", "downloads-")
	if err != nil {
		return Output{}, err
	}
	defer os.RemoveAll(downloadsDir)

	videoFile := filepath.Join(downloadsDir, "video")
	defer os.Remove(videoFile)

	videoFolderKey := fmt.Sprintf("%svideo/", getBucketKey(event.JobId, event.DownloadFolderKey))

	err = copyVideoIn(ctx, videoFile, event.S3Bucket, videoFolderKey)
	if err != nil {
		return Output{}, err
	}

	resolution, err := getResolution(ctx, videoFile)
	if err != nil {
		return Output{}, err
	}
	framerate, err := getFramerate(ctx, videoFile)
	if err != nil {
		return Output{}, err
	}

	return Output{
		Resolution: resolution,
		Framerate:  framerate,
	}, nil
}
