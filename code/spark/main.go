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

func HandleRequest(ctx context.Context, event events.APIGatewayProxyRequest) (events.APIGatewayProxyResponse, error) {
	length_s := os.Getenv("ID_LEN")
	length, err := strconv.Atoi(length_s)
	if err != nil {
		log.Fatal("ID_LEN expected number")
	}
	log.Infof("Authored by: ", event.RequestContext.Identity.APIKey)

	randId := makeRandStr(length)

	log.Infof("Generated jobId: ", randId)

	var sfnInput sfn.StartExecutionInput
	err = json.Unmarshal([]byte(event.Body), &sfnInput)
	if err != nil {
		return events.APIGatewayProxyResponse{}, errors.Join(errors.New("Failed processing StartExecutionInput"), err)
	}

	var realInput map[string]any
	err = json.Unmarshal([]byte(*sfnInput.Input), &realInput)
	if err != nil {
		return events.APIGatewayProxyResponse{}, errors.Join(errors.New("Failed decode input data"), err)
	}

	realInput[injectIdKey] = randId

	encodedInput, err := json.Marshal(realInput)
	if err != nil {
		return events.APIGatewayProxyResponse{}, errors.Join(errors.New("Failed encode input data"), err)
	}
	encodedInput_s := string(encodedInput)

	result, err := sfnc.StartExecution(ctx, &sfn.StartExecutionInput{
		Input: &encodedInput_s,
		StateMachineArn: sfnInput.StateMachineArn,
		TraceHeader: sfnInput.TraceHeader,
	})
	if err != nil {
		return events.APIGatewayProxyResponse{}, errors.Join(errors.New("Failed to Start Execution"), err)
	}

	log.Infof("StepFunctions Execution Arn: ", result.ExecutionArn)

	return apiGwResponse.OkResponse(ResponseBody{
		JobId: randId,
	})
}
