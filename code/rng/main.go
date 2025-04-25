package rng

import (
	"context"
	"fmt"
	"math"
	"math/rand"
	"github.com/aws/aws-lambda-go/lambda"
)

type Event struct {
	Length int `json:"length"`
}
type Response struct {
	Result string `json:"result"`
}

func main() {
	lambda.Start(HandleRequest)
}
func HandleRequest(ctx context.Context, event Event) (Response, error) {
	number := rand.Intn(int(math.Pow(16, float64(event.Length))))
	return Response{
		Result: fmt.Sprintf("%x", number),
	}, nil
}
