package configRead

import (
	"context"
	"os"
	"errors"

	"github.com/aws/aws-sdk-go-v2/service/ssm"
)

func GcpConfig(ctx context.Context, ssmc *ssm.Client) (string, error) {
	ssmConfigName := os.Getenv("SSM_GCP_CONFIG")
	if ssmConfigName == "" {
		return "", errors.New("env SSM_GCP_CONFIG empty")
	}
	param, err := ssmc.GetParameter(ctx, &ssm.GetParameterInput{
		Name: &ssmConfigName,
	})
	if err != nil {
		return "", err
	}

	result := param.Parameter.Value
	return *result, nil
}
