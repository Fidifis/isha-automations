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

	log.Debug("Loading keys from parameter store. ID: ", ssmPath)

	leMap := make(map[string]string)

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

		for i := range response.Parameters {
			name := strings.Replace(*response.Parameters[i].Name, ssmPath, "", 1)
			value := *response.Parameters[i].Value
			leMap[name] = value
		}
	}
	log.Debug("Loaded ", len(leMap), "parameters")

	cachedKeys = leMap
	return leMap, nil
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

func validate(keys map[string]string, keyId string, key string) bool {
	log.Info("Presented auth key for: ", keyId)
	v, ok := keys[keyId]
	return ok && v == key
}

func HandleRequest(ctx context.Context, event events.APIGatewayV2CustomAuthorizerV2Request) (events.APIGatewayV2CustomAuthorizerSimpleResponse, error) {
	keyId, okId := event.Headers["x-auth-id"]
	key, okKey := event.Headers["x-auth-key"]

	keyMap, err := getParameters(ctx)
	if err != nil {
		log.Fatal("error reading from parameter store. ", err)
	}

	var valid bool
	if okId && okKey {
		valid = validate(keyMap, keyId, key)
	} else {
		valid = false
		log.Info("request doesn't have expected headers")
	}

	log.Info("request validity: ", valid)

	return events.APIGatewayV2CustomAuthorizerSimpleResponse{
		IsAuthorized: valid,
	}, nil
}
