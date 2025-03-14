import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as apigateway from "@pulumi/aws-apigateway";
import { FileArchive, FileAsset } from "@pulumi/pulumi/asset";

const assumeRole = aws.iam.getPolicyDocument({
  statements: [
    {
      effect: "Allow",
      principals: [
        {
          type: "Service",
          identifiers: ["lambda.amazonaws.com"],
        },
      ],
      actions: ["sts:AssumeRole"],
    },
  ],
});
const policy = JSON.stringify({
  Version: "2012-10-17",
  Statement: {
    Effect: "Allow",
    Action: [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:CreateLogGroup",
    ],
    Resource: ["arn:aws:logs:eu-north-1:956941652442:log-group:/aws/lambda/*"],
  },
});
const iamForLambda = new aws.iam.Role("iam_for_lambda", {
  name: "iam_for_lambda",
  assumeRolePolicy: assumeRole.then((assumeRole) => assumeRole.json),
  inlinePolicies: [
    {
      name: "ano",
      policy: policy,
    },
  ],
});

const dmqLambda = new aws.lambda.Function("test_lambda", {
  code: new FileArchive("../code/bin/package.zip"),
  name: "DMQMaker",
  role: iamForLambda.arn,
  handler: "Lambda",
  runtime: aws.lambda.Runtime.Dotnet8,
  timeout: 30,
  memorySize: 512,
});

const api = new apigateway.RestAPI("api", {
  routes: [
    { path: "/unstable/v1/make", method: "POST", eventHandler: dmqLambda },
  ],
});

export const url = api.url;
