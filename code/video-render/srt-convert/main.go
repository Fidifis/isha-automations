package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
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
	Bucket          string `json:"bucket"`
	SourceKey       string `json:"sourceKey"`
	DestKey         string `json:"destKey"`
	VideoResolution string `json:"videoResolution"`

	FontName   string `json:"fontName,omitempty"`
	FontSize   int    `json:"fontSize,omitempty"`
	FontWeight int    `json:"fontWeight,omitempty"`
	TextHeight string `json:"textHeight,omitempty"`
	// Vertical   bool   `json:"vertical,omitempty"`
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

func addStyle(ass string, fontName string, fontSize int, height string, weight int) (string, error) {
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

			if fontName != "" {
				styleFields[1] = fontName
			}
			if fontSize != 0 {
				styleFields[2] = strconv.Itoa(fontSize)
			}
			if height != "" {
				styleFields[21] = height
			}
			if weight != 0 {
				styleFields[7] = strconv.Itoa(weight)
			}

			newStyle := "Style:" + strings.Join(styleFields, ",")
			output = append(output, newStyle)
			continue
		}

		// Copy other lines
		output = append(output, line)
	}

	return strings.Join(output, "\n"), nil
}

func normalizeResolution(resX int, resY int) (int, int) {
	const targetProduct = 110592

	ratio := float64(resX) / float64(resY)
	y := math.Sqrt(float64(targetProduct) / ratio)
	x := ratio * y

	return int(math.Round(x)), int(math.Round(y))
}

func writeResolution(ass string, resX int, resY int) string {
	origX := fmt.Sprintf("PlayResX: %d", 384)
	origY := fmt.Sprintf("PlayResY: %d", 288)

	if !strings.Contains(ass, origX) || !strings.Contains(ass, origY) {
		panic("Resolution in generated .ass file are not expected numbers")
	}

	newX, newY := normalizeResolution(resX, resY)

	res := ass
	res = strings.Replace(res, origX, fmt.Sprintf("PlayResX: %d", newX), 1)
	res = strings.Replace(res, origY, fmt.Sprintf("PlayResY: %d", newY), 1)
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

// When resolution is equal, isVertical is true. Reels are sometimes square format. To keep formating of reels / shorts consistent, assume squares are vertical
func isVertical(resX int, resY int) bool {
	return resY >= resX
}

func HandleRequest(ctx context.Context, event Event) error {
	err := testFFmpeg(ctx)
	if err != nil {
		return err
	}

	resolution := strings.Split(event.VideoResolution, "x")
	if len(resolution) != 2 {
		return fmt.Errorf("videoResolution is in bad format. Expected dimensions 2, got %d", len(resolution))
	}
	resX, err1 := strconv.Atoi(resolution[0])
	resY, err2 := strconv.Atoi(resolution[1])
	if err1 != nil || err2 != nil {
		return errors.Join(fmt.Errorf("videoResolution cannot be converted to 2 numbers"), err1, err2)
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

	srtBytes, err := os.ReadFile(srtFile)
	if err != nil {
		return errors.Join(fmt.Errorf("Failed to open srt file (pre-process) file=%s", srtFile), err)
	}
	srt := string(srtBytes)

	srt = fixSrtFormatting(srt)
	if isVertical(resX, resY) {
		srt = strings.ToUpper(srt)
	}

	err = os.WriteFile(srtFile, []byte(srt), 0644)
	if err != nil {
		return errors.Join(fmt.Errorf("Failed to save srt file (pre-process) file=%s", srtFile), err)
	}

	err = ffmpegConvert(ctx, srtFile, assFile)
	if err != nil {
		return err
	}

	assBytes, err := os.ReadFile(assFile)
	if err != nil {
		return err
	}

	styledAssString, err := addStyle(string(assBytes), event.FontName, event.FontSize, event.TextHeight, event.FontWeight)
	if err != nil {
		return err
	}
	styledAssString = writeResolution(styledAssString, resX, resY)

	err = s3Put(ctx, event.Bucket, event.DestKey, strings.NewReader(styledAssString))
	if err != nil {
		return err
	}

	return nil
}
