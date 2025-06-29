package main

import (
	"context"
	"os"
	"strings"

	"go.uber.org/zap"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ssm"

	"github.com/pquerna/otp/totp"
)

var (
	log        *zap.SugaredLogger
	ssmc       *ssm.Client
	cachedKeys map[string]string
)

type Event struct {
	Owner string `json:"owner"`
	Otp   string `json:"otp"`
}
type Response struct {
	Validity bool `json:"validity"`
}

func getSSMPath() string {
	ssmPath := os.Getenv("SSM_PREFIX_PATH")
	if ssmPath == "" {
		ssmPath = "/isha/otp"
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
			keyMap[name] = *param.Value
		}
	}

	log.Debug("Loaded ", len(keyMap), " OTP keys")

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

func validate(keys map[string]string, owner string, otp string) bool {
	if strings.HasPrefix(owner, "/") {
		owner = owner[1:]
	}
	if strings.HasSuffix(owner, "/") {
		owner = owner[:len(owner)-1]
	}

	secret, ok := keys[owner]
	if !ok {
		log.Info("owner not found")
		return false
	}

	return totp.Validate(otp, secret)
}

func HandleRequest(ctx context.Context, event Event) (Response, error) {
	defer log.Sync()

	keyMap, err := getParameters(ctx)
	if err != nil {
		log.Fatal("error reading from parameter store. ", err)
	}

	log.Info("owner: ", event.Owner)
	valid := validate(keyMap, event.Owner, event.Otp)

	log.Info("request validity: ", valid)

	return Response{
		Validity: valid,
	}, nil
}
