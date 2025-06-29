import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { Arch, GoLambda, HashFolder } from "../components/lambda";
import { DMQsProps } from "./index";

export function create(parent: pulumi.Resource, name: string, args: DMQsProps) {
  const xray = true;

  const procBcktPolicy = new aws.iam.Policy(
    `${name}-s3Policy`,
    {
      policy: aws.iam.getPolicyDocumentOutput(
        {
          statements: [
            {
              effect: "Allow",
              actions: ["s3:GetObject"],
              resources: [
                pulumi.interpolate`${args.procFilesBucket.arn}/dmq/*`,
              ],
            },
            // {
            //   actions: ["ssm:GetParameter"],
            //   resources: [args.gcpConfigParam.arn],
            // },
          ],
        },
        { parent },
      ).json,
    },
    { parent },
  );

  const publishLambda = new GoLambda(
    `${name}-PubLambda`,
    {
      tags: args.meta.tags,
      source: {
        code: "../bin/dmq-publish.zip",
        hash: HashFolder("../code/dmq/publish/"),
      },
      architecture: Arch.arm,
      timeout: 60,
      memory: 128,
      logs: { retention: 30 },
      xray,
      env: {
        variables: {},
      },
    },
    { parent },
  );

  const stateRole = new aws.iam.Role(
    `${name}-SFSM`,
    {
      tags: args.meta.tags,
      assumeRolePolicy: aws.iam.getPolicyDocumentOutput(
        {
          statements: [
            {
              effect: "Allow",
              principals: [
                {
                  type: "Service",
                  identifiers: ["states.amazonaws.com"],
                },
              ],
              actions: ["sts:AssumeRole"],
              conditions: [
                {
                  test: "StringEquals",
                  variable: "aws:SourceAccount",
                  values: [args.meta.accountId],
                },
              ],
            },
          ],
        },
        { parent },
      ).json,
      inlinePolicies: [
        {
          policy: aws.iam.getPolicyDocumentOutput(
            {
              statements: [
                {
                  actions: ["lambda:InvokeFunction"],
                  resources: [
                    pulumi.interpolate`arn:aws:lambda:${args.meta.region}:${args.meta.accountId}:function:${pulumi.getProject()}-${pulumi.getStack()}-*`,
                  ],
                },
                {
                  actions: [
                    "xray:PutTelemetryRecords",
                    "xray:PutTraceSegments",
                    "xray:GetSamplingRules",
                    "xray:GetSamplingTargets",
                  ],
                  resources: ["*"],
                },
              ],
            },
            { parent },
          ).json,
        },
      ],
    },
    { parent },
  );

  const stateMachine = new aws.sfn.StateMachine(
    `${name}`,
    {
      tags: args.meta.tags,
      roleArn: stateRole.arn,
      tracingConfiguration: {
        enabled: xray,
      },
      definition: pulumi.jsonStringify({
        Comment: "A description of my state machine",
        StartAt: "otp verify",
        QueryLanguage: "JSONata",
        States: {
          "otp verify": {
            Type: "Task",
            Resource: "arn:aws:states:::lambda:invoke",
            Output: "{% $states.input %}",
            Arguments: {
              FunctionName: pulumi.interpolate`${args.otpLambda.lambda.arn}:$LATEST`,
              Payload: {
                owner: "$states.input.owner",
                otp: "$states.input.otp",
              },
            },
            Retry: [
              {
                ErrorEquals: ["Lambda.TooManyRequestsException"],
                IntervalSeconds: 1,
                MaxAttempts: 3,
                BackoffRate: 2,
                JitterStrategy: "FULL",
              },
            ],
            Next: "ValidOtpCheck",
            Assign: {
              input: "{% $states.input %}",
            },
          },
          ValidOtpCheck: {
            Type: "Choice",
            Choices: [
              {
                Next: "Map",
                Condition: "{% ($states.input.valid) = (true) %}",
              },
            ],
            Default: "Invalid OTP",
          },
          "Invalid OTP": {
            Type: "Fail",
            Error: "Invalid OTP",
            Cause: "Entered owner and OTP pair is incorrect",
          },
          Map: {
            Type: "Map",
            Items: [
              {
                suffix: "square",
                selector: "youtube",
              },
              {
                suffix: "square",
                selector: "facebook",
              },
              {
                suffix: "vertical",
                selector: "instagram",
              },
            ],
            ItemProcessor: {
              ProcessorConfig: {
                Mode: "INLINE",
              },
              StartAt: "Publish",
              States: {
                Publish: {
                  Type: "Task",
                  Resource: "arn:aws:states:::lambda:invoke",
                  Output: "{% $states.result.Payload %}",
                  Arguments: {
                    FunctionName: pulumi.interpolate`${publishLambda.lambda.arn}:$LATEST`,
                    Payload: {
                      jobId: "{% $input.jobId %}",
                      s3Bucket: args.procFilesBucket.id,
                      s3Key:
                        "{% 'dmq/' & $input.jobId & '/result-' & $states.input.suffix & '.png' %}",
                    },
                  },
                  Retry: [
                    {
                      ErrorEquals: ["Lambda.TooManyRequestsException"],
                      IntervalSeconds: 1,
                      MaxAttempts: 3,
                      BackoffRate: 2,
                      JitterStrategy: "FULL",
                    },
                  ],
                  End: true,
                },
              },
            },
            End: true,
          },
        },
      }),
    },
    { parent },
  );

  const apiGwExec = new aws.iam.Role(
    `${name}-ApiGwExec`,
    {
      tags: args.meta.tags,
      assumeRolePolicy: aws.iam.getPolicyDocumentOutput(
        {
          statements: [
            {
              effect: "Allow",
              principals: [
                {
                  type: "Service",
                  identifiers: ["apigateway.amazonaws.com"],
                },
              ],
              actions: ["sts:AssumeRole"],
            },
          ],
        },
        { parent },
      ).json,
      inlinePolicies: [
        {
          policy: aws.iam.getPolicyDocumentOutput(
            {
              statements: [
                {
                  actions: ["lambda:InvokeFunction"],
                  resources: [args.sparkLambda.lambda.arn],
                },
              ],
            },
            { parent },
          ).json,
        },
      ],
    },
    { parent },
  );

  const routes = [
    {
      path: "/unstable/v2/dmq/publish",
      method: "POST",
      eventHandler: args.sparkLambda.lambda,
      execRole: apiGwExec,
      requestTemplate: {
        "application/json": pulumi.jsonStringify({
          input: "$util.escapeJavaScript($input.json('$'))",
          stateMachineArn: stateMachine.arn,
          traceHeader: "$method.request.header.X-Amzn-Trace-Id",
          apiKeyId: "$context.identity.apiKeyId",
        }),
      },
    },
  ];

  const sparkPolicy = new aws.iam.Policy(
    `${name}-SparkPolicy`,
    {
      policy: aws.iam.getPolicyDocumentOutput(
        {
          statements: [
            {
              actions: ["states:StartExecution", "states:StartSyncExecution"],
              resources: [stateMachine.arn],
            },
          ],
        },
        { parent },
      ).json,
    },
    { parent },
  );

  new aws.iam.PolicyAttachment(
    `${name}-SparkPolicy`,
    {
      roles: [args.sparkLambda.role],
      policyArn: sparkPolicy.arn,
    },
    { parent },
  );
  return {
    routes,
  };
}
