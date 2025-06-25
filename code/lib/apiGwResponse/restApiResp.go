package apiGwResponse

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambdacontext"
)

func ErrResponse(response string, ctx context.Context) (events.APIGatewayProxyResponse, error) {
	lctx, ok := lambdacontext.FromContext(ctx)
	if !ok {
		return events.APIGatewayProxyResponse{}, errors.New("Unable to read Lambda Context")
	}

	execId := lctx.AwsRequestID
	responseBody, _ := json.Marshal(map[string]string{
		"error":     response,
		"execution": execId,
	})
	return events.APIGatewayProxyResponse{
		StatusCode: 400,
		Body:       string(responseBody),
		Headers: map[string]string{
			"Content-Type": "application/json",
		},
	}, nil
}
func OkResponse(response any) (events.APIGatewayProxyResponse, error) {
	responseBody, err := json.Marshal(response)
	if err != nil {
		return events.APIGatewayProxyResponse{}, err
	}
	return events.APIGatewayProxyResponse{
		StatusCode: 200,
		Body:       string(responseBody),
		Headers: map[string]string{
			"Content-Type": "application/json",
		},
	}, nil
}
