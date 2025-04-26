package main

import (
	"context"
	"fmt"
	"math/rand"
	"time"

	"github.com/aws/aws-lambda-go/lambda"
)

type Event struct {
	Length int `json:"length"`
}
type Response struct {
	Result string `json:"result"`
}

const letterBytes = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
var seededRand *rand.Rand = rand.New(rand.NewSource(time.Now().UnixNano()))

func main() {
	lambda.Start(HandleRequest)
}
func HandleRequest(ctx context.Context, event Event) (Response, error) {
	if event.Length <= 0 {
		return Response{}, fmt.Errorf("length must be grater than zero; %d", event.Length)
	}

	b := make([]byte, event.Length)
	for i := range b {
		b[i] = letterBytes[seededRand.Intn(len(letterBytes))]
	}

	return Response{
		Result: string(b),
	}, nil
}
