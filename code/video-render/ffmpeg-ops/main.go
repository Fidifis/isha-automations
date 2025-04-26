package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
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
	MetadataKey string `json:"metadataKey"`
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
	log.Debug("Testing ffmpeg commands")
	cmd := exec.CommandContext(ctx, "ffmpeg", "-version")
	if err := cmd.Run(); err != nil {
		return errors.Join(errors.New("Failed inital ffmpeg test"), err)
	}
	cmd = exec.CommandContext(ctx, "ffprobe", "-version")
	if err := cmd.Run(); err != nil {
		return errors.Join(errors.New("Failed inital ffprobe test"), err)
	}
	return nil
}

func s3Get(ctx context.Context, s3Bucket string, s3Key string, file *os.File) error {
	// no debug logging as it spam for every frame
	s3File, err := s3c.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s3Bucket),
		Key:    aws.String(s3Key),
	})
	if err != nil {
		return errors.Join(fmt.Errorf("Error Downloading video from s3=%s key=%s", s3Bucket, s3Key), err)
	}
	defer s3File.Body.Close()

	file.Seek(0, io.SeekStart)
	_, err = io.Copy(file, s3File.Body)
	if err != nil {
		return errors.Join(fmt.Errorf("Error writing downloaded file from s3=%s key=%s to file=%s", s3Bucket, s3Key, file.Name()), err)
	}
	return nil
}

func copyVideoIn(ctx context.Context, videoFile *os.File, s3Bucket string, s3Key string) error {
	log.Debugf("Downloading video from s3=%s key=%s", s3Bucket, s3Key)
	return s3Get(ctx, s3Bucket, s3Key, videoFile)
}

func ffmpegDecode(ctx context.Context, videoFile *os.File, frameFolder string) error {
	log.Debug("ffmpeg decoding...")
	cmd := exec.CommandContext(ctx, "ffmpeg", "-i", videoFile.Name(), "-vsync", "0", frameFolder + "/frame_%06d.jpg")
	if err := cmd.Run(); err != nil {
		return errors.Join(errors.New("Failed ffmpeg decode to frames"), err)
	}
	return nil
}

func s3Put(ctx context.Context, s3Bucket string, s3Key string, objName string, content io.Reader) error {
	// no debug logging as it spam for every frame
	bKey := fmt.Sprintf("%s%s", s3Key, objName)
	_, err := s3c.PutObject(ctx, &s3.PutObjectInput{
			Bucket: &s3Bucket,
			Key:    &bKey,
			Body:   content,
		})
	if err != nil {
		return errors.Join(fmt.Errorf("Error S3 upload: bucket=%s key=%s file: %s", s3Bucket, bKey, objName), err)
	}
	return nil
}

func copyFramesOut(ctx context.Context, framesFolder string, s3Bucket string, s3Key string) error {
	counter := 0
	log.Debugf("Uploading frames to s3=%s key=%s", s3Bucket, s3Key)
	err := filepath.WalkDir(framesFolder, func(path string, entry fs.DirEntry, err error) error {
		if entry.IsDir() {
			return nil
		}

		file, err := os.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()
		
		err = s3Put(ctx, s3Bucket, s3Key, entry.Name(), file)
		if err != nil {
			return err
		}
		counter++
		return nil
	})
	log.Infof("Uploaded %d frames", counter)
	return err
}

func saveMeta(ctx context.Context, videoFile *os.File, s3Bucket string, metadataKey string) error {
	var frameRate float64
	log.Debug("Probing frame rate")
	cmd := exec.Command("ffprobe",
		"-v", "0",
		"-select_streams", "v:0",
		"-show_entries", "stream=r_frame_rate",
		"-of", "default=noprint_wrappers=1:nokey=1",
		videoFile.Name(),
	)

	var out bytes.Buffer
	cmd.Stdout = &out

	if err := cmd.Run(); err != nil {
		return errors.Join(errors.New("Failed ffmpeg describe metadata"), err)
	}

	rawRate := strings.TrimSpace(out.String())

	// Expected output: "30000/1001\n"
	parts := strings.Split(rawRate, "/")
	if len(parts) == 2 {
		numerator, err1 := strconv.ParseFloat(parts[0], 64)
		denominator, err2 := strconv.ParseFloat(parts[1], 64)
		if err1 != nil || err2 != nil || denominator == 0 {
			return fmt.Errorf("invalid frame rate format: %s", rawRate)
		}
		frameRate = numerator / denominator
	} else if len(parts) == 1 {
		// It's already a decimal number
		var err error
		frameRate, err = strconv.ParseFloat(parts[0], 64)
		if err != nil {
			return fmt.Errorf("invalid frame rate format: %s", rawRate)
		}
	}

	log.Infof("Frame rate = %f", frameRate)
	log.Debugf("Upload metadata to s3=%s key=%s%s", s3Bucket, metadataKey, "framerate")
	objContent := bytes.NewReader([]byte(strconv.FormatFloat(frameRate, 'f', -1, 64)))
	err := s3Put(ctx, s3Bucket, metadataKey, "framerate", objContent)
	if err != nil {
		return err
	}
	return nil
}

func copyFramesIn(ctx context.Context, framesFolder string, s3Bucket string, s3Key string) error {
	paginator := s3.NewListObjectsV2Paginator(s3c, &s3.ListObjectsV2Input{
		Bucket: &s3Bucket,
		Prefix: &s3Key,
	})
	for paginator.HasMorePages() {
		list, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("Error listing bucket s3=%s key=%s", s3Bucket, s3Key)
		}
		for _, object := range list.Contents {
			fName := fmt.Sprintf("%s/%s", framesFolder, *object.Key)
			frameFile, err := os.OpenFile(fName, os.O_CREATE|os.O_RDWR, 644)
			if err != nil {
				return errors.Join(fmt.Errorf("Error creating file %s", fName), err)
			}
			defer frameFile.Close()

			err = s3Get(ctx, s3Bucket, *object.Key, frameFile)
			if err != nil {
				return err
			}
		}
	}
	return nil
}

func HandleRequest(ctx context.Context, event Event) (error) {
	err := testFFmpeg(ctx)
	if err != nil {
		return err
	}

	framesFolderKey := getBucketKey(event.JobId, event.FrameFolderKey)
	metadataFolderKey := getBucketKey(event.JobId, event.MetadataKey)

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

	log.Infof("Action: %s", event.Action)
	switch event.Action {
	case "vid2frame":
		err := copyVideoIn(ctx, videoFile, event.VideoFileBucket, event.VideoFileKey)
		if err != nil {
			return err
		}
		err = saveMeta(ctx, videoFile, event.FrameFolderBucket, metadataFolderKey)
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
		err := copyFramesIn(ctx, frameDir, event.FrameFolderBucket, framesFolderKey)
		if err != nil {
			return err
		}
	default:
		return errors.New("Unknown action " + event.Action)
	}

	return nil
}
