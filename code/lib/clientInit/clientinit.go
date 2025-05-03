package clientInit

import (
	"context"
	"errors"

	"golang.org/x/oauth2/google"
	"google.golang.org/api/docs/v1"
	"google.golang.org/api/drive/v3"
	"google.golang.org/api/option"
	"google.golang.org/api/sheets/v4"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
)

type GInit struct {
	Credentials *google.Credentials
	ConfigJson  *string
}

func initGoogleCredentials(ctx context.Context, init GInit) (*google.Credentials, error) {
	var creds *google.Credentials
	if init.Credentials != nil {
		creds = init.Credentials
	} else if init.ConfigJson != nil {
		var err error
		creds, err = google.CredentialsFromJSON(ctx, []byte(*init.ConfigJson), drive.DriveScope)
		if err != nil {
			return nil, errors.Join(errors.New("Error parsing JWT config"), err)
		}
	} else {
		return nil, errors.New("All GInit struct fields are empty. Cannot init.")
	}
	return creds, nil
}

func InitGDrive(ctx context.Context, init GInit) (*drive.Service, GInit, error) {
	creds, err := initGoogleCredentials(ctx, init)
	if err != nil {
		return nil, GInit{}, err
	}

	optCred := option.WithCredentials(creds)
	service, err := drive.NewService(ctx, optCred)
	if err != nil {
		return nil, GInit{}, errors.Join(errors.New("Error creating Drive client"), err)
	}
	return service, GInit{ Credentials: creds }, nil
}

func InitGDoc(ctx context.Context, init GInit) (*docs.Service, GInit, error) {
	creds, err := initGoogleCredentials(ctx, init)
	if err != nil {
		return nil, GInit{}, err
	}

	optCred := option.WithCredentials(creds)
	service, err := docs.NewService(ctx, optCred)
	if err != nil {
		return nil, GInit{}, errors.Join(errors.New("Error creating Docs client"), err)
	}
	return service, GInit{ Credentials: creds }, nil
}

func InitGSheet(ctx context.Context, init GInit) (*sheets.Service, GInit, error) {
	creds, err := initGoogleCredentials(ctx, init)
	if err != nil {
		return nil, GInit{}, err
	}

	optCred := option.WithCredentials(creds)
	service, err := sheets.NewService(ctx, optCred)
	if err != nil {
		return nil, GInit{}, errors.Join(errors.New("Error creating Sheets client"), err)
	}
	return service, GInit{ Credentials: creds }, nil
}

func initAwsConfig(ctx context.Context, cfg *aws.Config) (*aws.Config, error) {
	if cfg == nil {
		cfg1, err := config.LoadDefaultConfig(ctx)
		if err != nil {
			return nil, errors.Join(errors.New("unable to load SDK config"), err)
		}
		cfg = &cfg1
	}
	return cfg, nil
}

func InitS3(ctx context.Context, cfg *aws.Config) (*s3.Client, *aws.Config, error) {
	cfg, err := initAwsConfig(ctx, cfg)
	if err != nil {
		return nil, nil, err
	}
	return s3.NewFromConfig(*cfg), cfg, nil
}

func InitSSM(ctx context.Context, cfg *aws.Config) (*ssm.Client, *aws.Config, error) {
	cfg, err := initAwsConfig(ctx, cfg)
	if err != nil {
		return nil, nil, err
	}
	return ssm.NewFromConfig(*cfg), cfg, nil
}
