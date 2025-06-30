package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"go.uber.org/zap"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"

	"google.golang.org/api/sheets/v4"

	"lambdalib/clientInit"
	"lambdalib/configRead"
)

var (
	log      *zap.SugaredLogger
	sheetSvc *sheets.Service
)

const errorReplKey = "$errmsg"
const jobIdKey = "$jobid"

type Event struct {
	JobId               string `json:"jobId"`
	DeliveryParams      string `json:"deliveryParams"`
	ErrorDeliveryParams string `json:"errDeliveryParams"`
	ErrorMessage        string `json:"errMsg"`
}

type SheetSetCellVals struct {
	SheetName string `json:"sheetName"`
	Column    int    `json:"column"`
	Row       int    `json:"row"`
	Value     string `json:"value"`
}
type DeliveryParams struct {
	SheetId   string             `json:"sheetId"`
	SetValues []SheetSetCellVals `json:"setValues"`
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

	ctx := context.Background()

	var err error
	var cfg *aws.Config

	ssmc, cfg, err := clientInit.InitSSM(ctx, cfg)
	if err != nil {
		log.Fatal(err)
	}

	gcpConfig, err := configRead.GcpConfig(ctx, ssmc)
	if err != nil {
		log.Fatal(err)
	}

	sheetSvc, _, err = clientInit.InitGSheet(ctx, clientInit.GInit{ConfigJson: &gcpConfig})
	if err != nil {
		log.Fatal("Error initializig Google service client: ", err)
	}
}

func columnToLetter(column int) string {
	result := ""
	for column >= 0 {
		result = string(rune('A'+(column%26))) + result
		column = column/26 - 1
	}
	return result
}

func WriteToSheet(ctx context.Context, params DeliveryParams) error {
	var valueRanges []*sheets.ValueRange

	for _, cellVal := range params.SetValues {
		// Convert 0-based index to A1 notation (e.g., A1, B2)
		// In A1 notation, columns start with A and rows start with 1
		columnLetter := columnToLetter(cellVal.Column)
		cellReference := fmt.Sprintf("%s!%s%d", cellVal.SheetName, columnLetter, cellVal.Row+1)

		valueRange := &sheets.ValueRange{
			Range:  cellReference,
			Values: [][]interface{}{{cellVal.Value}},
		}
		valueRanges = append(valueRanges, valueRange)
	}

	batchUpdateRequest := &sheets.BatchUpdateValuesRequest{
		ValueInputOption: "RAW",
		Data:             valueRanges,
	}
	_, err := sheetSvc.Spreadsheets.Values.BatchUpdate(params.SheetId, batchUpdateRequest).Context(ctx).Do()
	if err != nil {
		return errors.Join(fmt.Errorf("Error Spreadsheet update sheetid=%s", params.SheetId), err)
	}
	return nil
}

func substituteVars(jobId string, errorMsg string, params *DeliveryParams) {
	for i, p := range params.SetValues {
		if strings.Contains(p.Value, errorReplKey) {
			params.SetValues[i].Value = strings.ReplaceAll(p.Value, errorReplKey, errorMsg)
		}
		if strings.Contains(p.Value, jobIdKey) {
			params.SetValues[i].Value = strings.ReplaceAll(p.Value, jobIdKey, jobId)
		}
	}
}

func HandleRequest(ctx context.Context, event Event) error {
	var paramsStr string
	if event.ErrorDeliveryParams != "" {
		paramsStr = event.ErrorDeliveryParams
	} else {
		paramsStr = event.DeliveryParams
	}

	var params DeliveryParams
	err := json.Unmarshal([]byte(paramsStr), &params)
	if err != nil {
		return errors.Join(errors.New("Failed to Unmarshal deliveryParams"), err)
	}

	substituteVars(event.JobId, event.ErrorMessage, &params)

	err = WriteToSheet(ctx, params)
	if err != nil {
		return err
	}

	return nil
}
