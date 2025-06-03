package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"go.uber.org/zap"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"lambdalib/clientInit"
	"lambdalib/fileTransfer"
)

var (
	s3c *s3.Client
	log *zap.SugaredLogger
)

type Event struct {
	S3Bucket            string `json:"s3Bucket"`
	S3Key            string `json:"s3Key"`
}

type Output struct {
	Framerate string `json:"framerate"`
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

func s3Get(ctx context.Context, s3Bucket string, s3Key string, file string) error {
	log.Debugf("getObject s3=%s key=%s", s3Bucket, s3Key)
	fileHandle, err := os.Create(file)
	if err != nil {
		return errors.Join(fmt.Errorf("Error create a file for the download s3=%s key=%s file=%s", s3Bucket, s3Key, file), err)
	}
	defer fileHandle.Close()

	return fileTransfer.S3ToLocal(ctx, s3c, s3Bucket, s3Key, fileHandle)
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

func HandleRequest(ctx context.Context, event Event) (Output, error) {
	err := testFFmpeg(ctx)
	if err != nil {
		return Output{}, err
	}

	extension := strings.Split(event.S3Key, ".")[len(event.S3Key)-1]
	videoFile, err := os.CreateTemp("", fmt.Sprintf("video-*.%s", extension))
	defer os.Remove(videoFile.Name())

	err = fileTransfer.S3ToLocal(ctx, s3c, event.S3Bucket, event.S3Key, videoFile)
	videoFile.Close()

	resolution, err := getResolution(ctx, videoFile.Name())
	framerate, err := getFramerate(ctx, videoFile.Name())

	return Output{
		Resolution: resolution,
		Framerate: framerate,
	}, nil
}
