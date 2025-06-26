package main

import (
	"context"
	"encoding/json"
	"errors"
	"math/rand"
	"os"
	"strconv"

	"go.uber.org/zap"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sfn"

	"lambdalib/apiGwResponse"
	"lambdalib/random"
)

const injectIdKey = "jobId"
var (
	log  *zap.SugaredLogger
	sfnc *sfn.Client
)

type Request struct {
	APIKeyID string `json:"apiKeyId"`
	SfnArn string `json:"stateMachineArn"`
	Input string `json:"input"`
	TraceHeader string `json:"traceHeader"`
}

type ResponseBody struct {
	JobId string `json:"jobId"`
}

const letterBytes = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

var seededRand *rand.Rand = random.NewRandom()

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
	sfnc = sfn.NewFromConfig(cfg)
}

func makeRandStr(length int) string {
	b := make([]byte, length)
	for i := range b {
		b[i] = letterBytes[seededRand.Intn(len(letterBytes))]
	}
	return string(b)
}

func HandleRequest(ctx context.Context, event Request) (events.APIGatewayProxyResponse, error) {
	length_s := os.Getenv("ID_LEN")
	length, err := strconv.Atoi(length_s)
	if err != nil {
		log.Fatal("ID_LEN expected number")
	}
	if length < 1 {
		log.Fatal("ID_LEN must be > 0")
	}
	log.Info("Authored by key ID: '", event.APIKeyID, "'")
	if event.APIKeyID == "" {
		log.Warn("Incoming api key id is empty")
	}

	randId := makeRandStr(length)

	log.Info("Generated jobId: ", randId)

	var realInput map[string]any
	err = json.Unmarshal([]byte(event.Input), &realInput)
	if err != nil {
		return events.APIGatewayProxyResponse{}, errors.Join(errors.New("Failed to decode input data"), err)
	}

	realInput[injectIdKey] = randId

	encodedInput, err := json.Marshal(realInput)
	if err != nil {
		return events.APIGatewayProxyResponse{}, errors.Join(errors.New("Failed re-encode input data"), err)
	}
	encodedInput_s := string(encodedInput)

	result, err := sfnc.StartExecution(ctx, &sfn.StartExecutionInput{
		Input: &encodedInput_s,
		StateMachineArn: &event.SfnArn,
		TraceHeader: &event.TraceHeader,
	})
	if err != nil {
		return events.APIGatewayProxyResponse{}, errors.Join(errors.New("Failed to Start Execution"), err)
	}

	log.Info("StepFunctions Execution Arn: ", result.ExecutionArn)

	return apiGwResponse.OkResponse(ResponseBody{
		JobId: randId,
	})
}
