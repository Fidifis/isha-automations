package main

import (
	"context"
	"os"
	"strings"

	"go.uber.org/zap"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
)

var (
	log        *zap.SugaredLogger
	ssmc       *ssm.Client
	cachedKeys map[string]string
)

func getSSMPath() string {
	ssmPath := os.Getenv("SSM_LOOKUP_PATH")
	if ssmPath == "" {
		ssmPath = "/isha/auth"
	}
	if strings.HasSuffix(ssmPath, "/") {
		ssmPath = ssmPath[:len(ssmPath)-1]
	}
	return ssmPath
}

func getParameters(ctx context.Context) (map[string]string, error) {
	if cachedKeys != nil {
		return cachedKeys, nil
	}

	ssmPath := getSSMPath()

	log.Debug("Loading keys from parameter store. Path: ", ssmPath)

	keyMap := make(map[string]string)

	firstRun := true
	var nextToken *string = nil

	for firstRun || nextToken != nil {
		firstRun = false

		response, err := ssmc.GetParametersByPath(ctx, &ssm.GetParametersByPathInput{
			WithDecryption: aws.Bool(true),
			Path:           aws.String(ssmPath),
			Recursive:      aws.Bool(true),
			NextToken:      nextToken,
		})
		if err != nil {
			return nil, err
		}

		nextToken = response.NextToken

		for _, param := range response.Parameters {
			name := strings.TrimPrefix(*param.Name, ssmPath+"/")
			keyMap[*param.Value] = name
		}
	}

	log.Debug("Loaded ", len(keyMap), " API keys")

	cachedKeys = keyMap
	return keyMap, nil
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

	cfg, err := config.LoadDefaultConfig(context.TODO())
	if err != nil {
		log.Fatal("unable to load SDK config ", err)
	}

	ssmc = ssm.NewFromConfig(cfg)
}

func validate(keys map[string]string, apiKey string) (bool, string) {
	name, ok := keys[apiKey]
	return ok, name
}

func HandleRequest(ctx context.Context, event events.APIGatewayV2CustomAuthorizerV2Request) (events.APIGatewayV2CustomAuthorizerSimpleResponse, error) {
	apiKey, ok := event.Headers["x-api-key"]

	keyMap, err := getParameters(ctx)
	if err != nil {
		log.Fatal("error reading from parameter store. ", err)
	}

	valid := false
	if ok {
		var name string
		valid, name = validate(keyMap, apiKey)
		log.Info("key belongs to: ", name)
	} else {
		log.Info("request doesn't have x-api-key header")
	}

	log.Info("request validity: ", valid)

	return events.APIGatewayV2CustomAuthorizerSimpleResponse{
		IsAuthorized: valid,
	}, nil
}
