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
	JobId  string `json:"jobId"`
	Action string `json:"action"`

	VideoFileBucket   string `json:"videoFileBucket"`
	VideoFileKey      string `json:"videoFileKey"`
	DownloadFolderKey string `json:"downloadFolderKey,omitempty"`
	FrameFolderBucket string `json:"imgFolderBucket"`
	FrameFolderKey    string `json:"imgFolderKey"`
	MetadataKey       string `json:"metadataKey"`
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
	cmd = exec.CommandContext(ctx, "ffprobe", "-version")
	if err := cmd.Run(); err != nil {
		return errors.Join(errors.New("Failed inital ffprobe test"), err)
	}
	return nil
}

func s3Get(ctx context.Context, s3Bucket string, s3Key string, file io.Writer) error {
	// no debug logging as it spam for every frame
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
	return s3Get(ctx, s3Bucket, s3Key, videoFile)
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

func ffmpegDecode(ctx context.Context, videoFile string, frameFolder string) error {
	log.Debug("ffmpeg decoding...")
	cmd := exec.CommandContext(ctx, "ffmpeg", "-loglevel", "error", "-i", videoFile, "-vsync", "0", filepath.Join(frameFolder, "frame_%06d.jpg"))

	var cmdErr bytes.Buffer
	cmd.Stderr = &cmdErr

	if err := cmd.Run(); err != nil {
		return errors.Join(fmt.Errorf("Failed ffmpeg decode to frames. Logs:\n%s", cmdErr.String()), err)
	}
	return nil
}

func getMeta(ctx context.Context, s3Bucket string, metadataKey string) (string, error) {
	log.Debugf("Pulling framerate from s3=%s key=%s%s", s3Bucket, metadataKey, "framerate")
	var buf bytes.Buffer
	err := s3Get(ctx, s3Bucket, metadataKey+"framerate", &buf)
	if err != nil {
		return "", err
	}
	framerate := buf.String()
	framerate = strings.TrimSpace(framerate)
	log.Infof("framerate = %s", framerate)
	return framerate, nil
}

func ffmpegEncode(ctx context.Context, videoFile string, frameFolder string, audioFolder string, framerate string) error {
	args := []string{
		"-loglevel", "error",
		"-framerate", framerate,
		"-i", filepath.Join(frameFolder, "frame_%06d.jpg"),
	}
	log.Debugf("Listing audio files in %s", audioFolder)
	audioFiles, err := os.ReadDir(audioFolder)
	if err != nil {
		return errors.Join(fmt.Errorf("Failed to list folder %s", audioFolder), err)
	}
	for _, audioFile := range audioFiles {
		args = append(args, "-i", filepath.Join(audioFolder, audioFile.Name()))
	}
	args = append(args, "-map", "0:v")
	for i := range audioFiles {
		args = append(args, "-map", fmt.Sprintf("%d:a", i+1))
	}
	args = append(args, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", videoFile)

	log.Debugf("FFMPEG args: %s", strings.Join(args, " "))

	log.Debug("ffmpeg encoding...")
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)

	var cmdErr bytes.Buffer
	cmd.Stderr = &cmdErr

	if err := cmd.Run(); err != nil {
		return errors.Join(fmt.Errorf("Failed ffmpeg encode to video. Logs:\n%s", cmdErr.String()), err)
	}
	return nil
}

func s3Put(ctx context.Context, s3Bucket string, s3Key string, content io.Reader) error {
	// no debug logging as it spam for every frame
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

		bKey := fmt.Sprintf("%s%s", s3Key, entry.Name())
		err = s3Put(ctx, s3Bucket, bKey, file)
		if err != nil {
			return err
		}
		counter++
		return nil
	})
	log.Infof("Uploaded %d frames", counter)
	return err
}

func saveMeta(ctx context.Context, videoFile string, s3Bucket string, metadataKey string) error {
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
		return errors.Join(errors.New("Failed ffmpeg describe metadata"), err)
	}

	rawRate := strings.TrimSpace(out.String())

	// Expected output: "30000/1001\n"
	framerate := strings.TrimSpace(rawRate)
	log.Infof("framerate = %f", framerate)

	bKey := fmt.Sprintf("%s%s", metadataKey, "framerate")
	log.Debugf("Upload metadata to s3=%s key=%s", s3Bucket, bKey)
	objContent := bytes.NewReader([]byte(framerate))
	err := s3Put(ctx, s3Bucket, bKey, objContent)
	if err != nil {
		return err
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
	log.Infof("jobid=%s", event.JobId)
	err := testFFmpeg(ctx)
	if err != nil {
		return err
	}

	framesFolderKey := getBucketKey(event.JobId, event.FrameFolderKey)
	metadataFolderKey := getBucketKey(event.JobId, event.MetadataKey)
	audioFolderKey := fmt.Sprintf("%saudio/", getBucketKey(event.JobId, event.DownloadFolderKey))

	frameDir, err := os.MkdirTemp("", "frames-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(frameDir)

	log.Infof("Action: %s", event.Action)
	switch event.Action {
	case "vid2frame":
		videoFile, err := os.CreateTemp("", "video-")
		if err != nil {
			return err
		}
		defer os.Remove(videoFile.Name())
		defer videoFile.Close()

		err = copyVideoIn(ctx, videoFile, event.VideoFileBucket, event.VideoFileKey)
		if err != nil {
			return err
		}
		videoFile.Close() // close so ffmpeg can open
		err = saveMeta(ctx, videoFile.Name(), event.FrameFolderBucket, metadataFolderKey)
		if err != nil {
			return err
		}
		err = ffmpegDecode(ctx, videoFile.Name(), frameDir)
		if err != nil {
			return err
		}
		err = copyFramesOut(ctx, frameDir, event.FrameFolderBucket, framesFolderKey)
		if err != nil {
			return err
		}
	case "frame2vid":
		if event.DownloadFolderKey == "" {
			return errors.New("downloadFolderKey must be specified when action is frame2vid")
		}
		audioDir, err := os.MkdirTemp("", "audio-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(audioDir)

		resultsDir, err := os.MkdirTemp("", "result-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(resultsDir)
		resultVideo := filepath.Join(resultsDir, "video.mp4")

		framerate, err := getMeta(ctx, event.FrameFolderBucket, metadataFolderKey)
		if err != nil {
			return err
		}
		err = s3CopyInMany(ctx, audioDir, event.VideoFileBucket, audioFolderKey)
		if err != nil {
			return err
		}
		err = s3CopyInMany(ctx, frameDir, event.FrameFolderBucket, framesFolderKey)
		if err != nil {
			return err
		}
		err = ffmpegEncode(ctx, resultVideo, frameDir, audioDir, framerate)
		if err != nil {
			return err
		}
		defer os.Remove(resultVideo)
		err = copyVideoOut(ctx, resultVideo, event.VideoFileBucket, event.VideoFileKey)
		if err != nil {
			return err
		}
	default:
		return errors.New("Unknown action " + event.Action)
	}

	return nil
}
