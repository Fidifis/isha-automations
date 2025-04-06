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
	if ssmPath[len(ssmPath)-1:] == "/" {
		ssmPath = ssmPath[:len(ssmPath)-1]
	}
	return ssmPath
}

func getParameters(ssmPath string) (map[string]string, error) {
	log.Debug("Loading keys from parameter store. ID: ", ssmPath)

	leMap := make(map[string]string)

	firstRun := true
	var nextToken *string = nil

	for firstRun || nextToken != nil {
		firstRun = false

		response, err := ssmc.GetParametersByPath(context.Background(), &ssm.GetParametersByPathInput{
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

	return leMap, nil
}

func main() {
	lambda.Start(HandleRequest)
}
func init() {
	logger, _ := zap.NewProduction()
	defer logger.Sync()
	log = logger.Sugar()

	cfg, err := config.LoadDefaultConfig(context.TODO())
	if err != nil {
		log.Fatal("unable to load SDK config ", err)
	}

	ssmc = ssm.NewFromConfig(cfg)
	ssmPath := getSSMPath()
	cachedKeys, err = getParameters(ssmPath)
	if err != nil {
		log.Fatal("error reading from parameter store. ", err)
	}
}

// Expected key is /GR/cz:12345
func validate(key string) bool {
	splited := strings.Split(key, ":")
	if len(splited) != 2 {
		log.Error("Invalid authorization key. Has incorrect number of `:`, expected 1. ", key)
		return false
	}
	v, ok := cachedKeys[splited[0]]
	return ok && v == splited[1]
}

func HandleRequest(ctx context.Context, event events.APIGatewayV2CustomAuthorizerV2Request) (events.APIGatewayV2CustomAuthorizerSimpleResponse, error) {
	key, ok := event.Headers["x-auth-key"]

	var valid bool
	if ok {
		valid = validate(key)
	} else {
		valid = false
		log.Info("request doesn't have expected header")
	}

	log.Info("request validity: ", valid)

	return events.APIGatewayV2CustomAuthorizerSimpleResponse{
		IsAuthorized: valid,
	}, nil
}
