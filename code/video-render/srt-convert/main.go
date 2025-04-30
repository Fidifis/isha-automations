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
	"regexp"
	"strconv"
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
	Bucket    string `json:"bucket"`
	SourceKey string `json:"sourceKey"`
	DestKey   string `json:"destKey"`
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

func testFFmpeg(ctx context.Context) error {
	log.Debug("Testing ffmpeg commands")
	cmd := exec.CommandContext(ctx, "ffmpeg", "-version")
	if err := cmd.Run(); err != nil {
		return errors.Join(errors.New("Failed inital ffmpeg test"), err)
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

	s3File, err := s3c.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s3Bucket),
		Key:    aws.String(s3Key),
	})
	if err != nil {
		return errors.Join(fmt.Errorf("Error downloading file from s3=%s key=%s", s3Bucket, s3Key), err)
	}
	defer s3File.Body.Close()

	_, err = io.Copy(fileHandle, s3File.Body)
	if err != nil {
		return errors.Join(fmt.Errorf("Error writing downloaded file from s3=%s key=%s file=%s", s3Bucket, s3Key, file), err)
	}
	return nil
}

func fixSrtFormatting(srt string) string {
	lines := strings.Split(srt, "\n")

	regex := regexp.MustCompile(`\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}`)
	var newLines []string
	var segmentNumber string
	for _, line := range lines {
		trimed := strings.TrimSpace(line)

		if trimed != "" {
			if segmentNumber != "" {
				if len(newLines) != 0 && regex.FindString(trimed) != "" {
					newLines = append(newLines, "")
				}
				newLines = append(newLines, segmentNumber)
				segmentNumber = ""
			}
			if _, parsErr := strconv.ParseInt(trimed, 10, 64); parsErr == nil {
				segmentNumber = trimed
			} else {
				newLines = append(newLines, trimed)
			}
		}
	}

	return strings.Join(newLines, "\n")
}

func ffmpegConvert(ctx context.Context, srtFile string, assFile string) error {
	args := []string{
		"-loglevel", "error",
		"-i", srtFile,
		assFile,
	}
	log.Debugf("FFMPEG args: %s", strings.Join(args, " "))
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)

	var cmdErr bytes.Buffer
	cmd.Stderr = &cmdErr

	if err := cmd.Run(); err != nil {
		return errors.Join(fmt.Errorf("Failed ffmpeg convert subtitles. in=%s out=%s Logs:\n%s", srtFile, assFile, cmdErr.String()), err)
	}
	return nil
}

func addStyle(ass string) (string, error) {
	lines := strings.Split(ass, "\n")
	var output []string
	inStyles := false

	for _, line := range lines {
		trim := strings.TrimSpace(line)

		// Start of [V4+ Styles]
		if trim == "[V4+ Styles]" {
			inStyles = true
			output = append(output, line)
			continue
		}

		// End of styles section
		if inStyles && strings.HasPrefix(trim, "[") && trim != "[V4+ Styles]" {
			inStyles = false
		}

		// Modify Style line
		if inStyles && strings.HasPrefix(trim, "Style:") {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) != 2 {
				return "", fmt.Errorf("invalid Style line: %s", line)
			}

			styleFields := strings.Split(parts[1], ",")
			if len(styleFields) < 23 {
				return "", fmt.Errorf("Style line too short: %s", line)
			}

			styleFields[1] = "Open Sans"
			styleFields[2] = "36"
			styleFields[20] = "80"

			newStyle := "Style:" + strings.Join(styleFields, ",")
			output = append(output, newStyle)
			continue
		}

		// Copy other lines
		output = append(output, line)
	}

	return strings.Join(output, "\n"), nil
}

func overwriteResolution(ass string) string {
	res := ass
	res = strings.Replace(res, fmt.Sprintf("PlayResX: %d", 384), fmt.Sprintf("PlayResX: %d", 1080), 1)
	res = strings.Replace(res, fmt.Sprintf("PlayResY: %d", 288), fmt.Sprintf("PlayResY: %d", 1920), 1)
	return res
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

func fixSrtFile(srtFile string) error {
	file, err := os.ReadFile(srtFile)
	if err != nil {
		return errors.Join(fmt.Errorf("Failed to open srt file (fix formatting func) file=%s", srtFile), err)
	}
	srt := string(file)
	fixed := fixSrtFormatting(srt)
	err = os.WriteFile(srtFile, []byte(fixed), 0644)
	if err != nil {
		return errors.Join(fmt.Errorf("Failed to save srt file (fix formatting func) file=%s", srtFile), err)
	}
	return nil
}

func HandleRequest(ctx context.Context, event Event) error {
	err := testFFmpeg(ctx)
	if err != nil {
		return err
	}

	downloadsDir, err := os.MkdirTemp("", "downloads-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(downloadsDir)
	srtFile := filepath.Join(downloadsDir, "subtitles.srt")
	defer os.Remove(srtFile)

	resultsDir, err := os.MkdirTemp("", "result-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(resultsDir)
	assFile := filepath.Join(resultsDir, "subtitles.ass")
	defer os.Remove(assFile)

	err = s3Get(ctx, event.Bucket, event.SourceKey, srtFile)
	if err != nil {
		return err
	}

	err = fixSrtFile(srtFile)
	if err != nil {
		return err
	}

	err = ffmpegConvert(ctx, srtFile, assFile)
	if err != nil {
		return err
	}

	assBytes, err := os.ReadFile(assFile)
	if err != nil {
		return err
	}

	// styledAssString, err := addStyle(string(assBytes))
	// if err != nil {
	// 	return err
	// }
	// styledAssString = overwriteResolution(styledAssString)
	styledAssString := string(assBytes)

	err = s3Put(ctx, event.Bucket, event.DestKey, strings.NewReader(styledAssString))
	if err != nil {
		return err
	}

	return nil
}
