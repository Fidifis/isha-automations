package main

import (
	"context"
	"fmt"
	"time"
  "log"
  "encoding/json"

	"github.com/aws/aws-lambda-go/lambda"
  "github.com/aws/aws-lambda-go/events"
  "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
  "github.com/google/uuid"
)
var (
	s3c *s3.Client
  db *dynamodb.Client
)

type Event struct {
	Date time.Time `json:"date"`
  Image string `json:"image_base64"`
  Text string `json:"text"`
}

func main() {
	lambda.Start(HandleRequest)
}
func init() {
	cfg, err := config.LoadDefaultConfig(context.TODO())
	if err != nil {
		log.Fatalf("unable to load SDK config, %v", err)
	}

	s3c = s3.NewFromConfig(cfg)
  db = dynamodb.NewFromConfig(cfg)
}

func MakeResponse(ok_response *map[string]interface{}, error *string) (events.APIGatewayProxyResponse, error) {
  var status int
  var respMap map[string]interface{}
  if error != nil {
    status = 400
    respMap = map[string]interface{}{
      "error": *error,
    }
  } else {
    status = 200
    respMap = *ok_response
  }

  responseBody, _ := json.Marshal(respMap)
  return events.APIGatewayProxyResponse{
		StatusCode: status,
		Body:       string(responseBody),
		Headers: map[string]string{
			"Content-Type": "application/json",
		},
	}, nil
}

func HandleRequest(ctx context.Context, event Event) (events.APIGatewayProxyResponse, error) {
  return MakeResponse(&map[string]interface{}{
    "hello": "hello",
  }, nil)
}
