package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
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
	s3c *s3.Client
	log *zap.SugaredLogger
)

type Event struct {
	JobId             string `json:"jobId"`
	Bucket            string `json:"bucket"`
	DownloadFolderKey string `json:"downloadFolderKey"`
	ResultFolderKey   string `json:"resultFolderKey"`
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

func getBucketKey(jobId string, targetKey string) string {
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
	return nil
}

func s3Get(ctx context.Context, s3Bucket string, s3Key string, file io.Writer) error {
	log.Debugf("getObject s3=%s key=%s", s3Bucket, s3Key)
	s3File, err := s3c.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s3Bucket),
		Key:    aws.String(s3Key),
	})
	if err != nil {
		return errors.Join(fmt.Errorf("Error Downloading video from s3=%s key=%s", s3Bucket, s3Key), err)
	}
	defer s3File.Body.Close()

	_, err = io.Copy(file, s3File.Body)
	if err != nil {
		return errors.Join(fmt.Errorf("Error writing downloaded file from s3=%s key=%s", s3Bucket, s3Key), err)
	}
	return nil
}

func copyVideoIn(ctx context.Context, videoFile *os.File, s3Bucket string, s3Key string) error {
	log.Debugf("Downloading video from s3=%s key=%s", s3Bucket, s3Key)
	paginator := s3.NewListObjectsV2Paginator(s3c, &s3.ListObjectsV2Input{
		Bucket: &s3Bucket,
		Prefix: &s3Key,
	})

	for paginator.HasMorePages() {
		list, err := paginator.NextPage(ctx)
		if err != nil {
			return errors.Join(fmt.Errorf("Error listing bucket s3=%s key=%s", s3Bucket, s3Key), err)
		}
		for _, object := range list.Contents {
			return s3Get(ctx, s3Bucket, *object.Key, videoFile)
		}
	}
	return fmt.Errorf("Nothing returned while looking for video, listing bucket s3=%s key=%s", s3Bucket, s3Key)
}

func copyVideoOut(ctx context.Context, videoFileName string, s3Bucket string, s3Key string) error {
	log.Debugf("Uploading video to s3=%s key=%s from_file=%s", s3Bucket, s3Key, videoFileName)
	videoFile, err := os.Open(videoFileName)
	if err != nil {
		return errors.Join(fmt.Errorf("Cannot open file with result video %s", videoFileName))
	}
	defer videoFile.Close()
	return s3Put(ctx, s3Bucket, s3Key, videoFile)
}

func getAss(ctx context.Context, assFile *os.File, s3Bucket string, s3Key string) error {
	log.Debugf("Pulling subtitles from s3=%s key=%s", s3Bucket, s3Key)
	return s3Get(ctx, s3Bucket, s3Key, assFile)
}

func ffmpegRender(ctx context.Context, inVideoFile string, audioFolder string, assFile string, outVideoFile string) error {
	args := []string{
		"-loglevel", "error",
		"-i", inVideoFile,
	}
	log.Debugf("Listing audio files in %s", audioFolder)
	audioFiles, err := os.ReadDir(audioFolder)
	if err != nil {
		return errors.Join(fmt.Errorf("Failed to list folder %s", audioFolder), err)
	}
	for _, audioFile := range audioFiles {
		args = append(args, "-i", filepath.Join(audioFolder, audioFile.Name()))
	}
	args = append(args, "-vf", "ass="+assFile, "-map", "0:v")
	for i := range audioFiles {
		args = append(args, "-map", fmt.Sprintf("%d:a", i+1))
	}
	args = append(args, "-c:v", "libx264", "-c:a", "aac", outVideoFile)

	log.Debugf("FFMPEG args: %s", strings.Join(args, " "))

	log.Debug("ffmpeg encoding...")
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)

	var cmdErr bytes.Buffer
	cmd.Stderr = &cmdErr

	if err := cmd.Run(); err != nil {
		return errors.Join(fmt.Errorf("Failed ffmpeg encode to video. Logs:\n%s", cmdErr.String()), err)
	}
	if cmdErr.Len() > 0 {
		log.Warnf("ffmpeg output: %s", cmdErr.String())
	}
	return nil
}

func s3Put(ctx context.Context, s3Bucket string, s3Key string, content io.Reader) error {
	log.Debugf("putObject s3=%s key=%s", s3Bucket, s3Key)
	_, err := s3c.PutObject(ctx, &s3.PutObjectInput{
		Bucket: &s3Bucket,
		Key:    &s3Key,
		Body:   content,
	})
	if err != nil {
		return errors.Join(fmt.Errorf("Error S3 upload: bucket=%s key=%s", s3Bucket, s3Key), err)
	}
	return nil
}

func s3CopyInMany(ctx context.Context, systemFolder string, s3Bucket string, s3Key string) error {
	log.Debugf("Download to folder=%s from s3=%s key=%s", systemFolder, s3Bucket, s3Key)
	paginator := s3.NewListObjectsV2Paginator(s3c, &s3.ListObjectsV2Input{
		Bucket: &s3Bucket,
		Prefix: &s3Key,
	})

	gotAny := false
	for paginator.HasMorePages() {
		list, err := paginator.NextPage(ctx)
		if err != nil {
			return errors.Join(fmt.Errorf("Error listing bucket s3=%s key=%s", s3Bucket, s3Key), err)
		}
		for _, object := range list.Contents {
			objKeySplit := strings.Split(*object.Key, "/")
			nameOnly := objKeySplit[len(objKeySplit)-1]
			fName := filepath.Join(systemFolder, nameOnly)

			file, err := os.Create(fName)
			if err != nil {
				log.Warn("Error hint: if object key seems to be empty or '/' it may be caused by hiden file representing the folder itself, that is created during 'create folder' from UI.\nuse `aws s3 ls s3://` to debug")
				return errors.Join(fmt.Errorf("Error creating file %s ; objectKey=%s", fName, *object.Key), err)
			}
			defer file.Close()

			// frameFile.Seek(0, io.SeekStart)
			err = s3Get(ctx, s3Bucket, *object.Key, file)
			if err != nil {
				return err
			}
			gotAny = true
		}
	}

	if !gotAny {
		log.Warnf("Nothing found in s3=%s key=%s", s3Bucket, s3Key)
	}
	return nil
}

func HandleRequest(ctx context.Context, event Event) error {
	err := testFFmpeg(ctx)
	if err != nil {
		return err
	}

	videoFolderKey := fmt.Sprintf("%svideo/", getBucketKey(event.JobId, event.DownloadFolderKey))
	audioFolderKey := fmt.Sprintf("%saudio/", getBucketKey(event.JobId, event.DownloadFolderKey))
	resultVideoKey := fmt.Sprintf("%svideo.mp4", getBucketKey(event.JobId, event.ResultFolderKey))
	downloadFolderKey := getBucketKey(event.JobId, event.DownloadFolderKey)

	videoFile, err := os.CreateTemp("", "video-")
	if err != nil {
		return err
	}
	defer os.Remove(videoFile.Name())
	defer videoFile.Close()

	assFile, err := os.CreateTemp("", "ass-")
	if err != nil {
		return err
	}
	defer os.Remove(assFile.Name())
	defer assFile.Close()

	resultsDir, err := os.MkdirTemp("", "result-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(resultsDir)
	resultVideo := filepath.Join(resultsDir, "video.mp4")
	defer os.Remove(resultVideo)

	audioDir, err := os.MkdirTemp("", "audio-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(audioDir)

	err = getAss(ctx, assFile, event.Bucket, fmt.Sprintf("%ssubtitles.ass", downloadFolderKey))
	if err != nil {
		return err
	}
	assFile.Close() // close so ffmpeg can open

	err = copyVideoIn(ctx, videoFile, event.Bucket, videoFolderKey)
	if err != nil {
		return err
	}
	videoFile.Close() // close so ffmpeg can open

	err = s3CopyInMany(ctx, audioDir, event.Bucket, audioFolderKey)
	if err != nil {
		return err
	}

	err = ffmpegRender(ctx, videoFile.Name(), audioDir, assFile.Name(), resultVideo)
	if err != nil {
		return err
	}

	err = copyVideoOut(ctx, resultVideo, event.Bucket, resultVideoKey)
	if err != nil {
		return err
	}

	return nil
}
