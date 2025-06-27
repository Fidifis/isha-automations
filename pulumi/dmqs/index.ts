import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ApiGatewayRoute } from "../components/apiGateway";
import { Arch, GoLambda, HashFolder } from "../components/lambda";
import { MetaProps } from "../utils";

export interface DMQsProps {
  meta: MetaProps;
  codeBucket: aws.s3.BucketV2;
  procFilesBucket: aws.s3.BucketV2;
  assetsBucket: aws.s3.BucketV2;
  gcpConfigParam: aws.ssm.Parameter;
  sparkLambda: GoLambda;
}

export class DMQs extends pulumi.ComponentResource {
  public readonly routes: ApiGatewayRoute[];

  constructor(
    name: string,
    args: DMQsProps,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("project:components:DMQ", name, {}, opts);

    const xray = true;

    const procBcktPolicy = new aws.iam.Policy(
      `${name}-s3Policy`,
      {
        policy: aws.iam.getPolicyDocumentOutput(
          {
            statements: [
              {
                effect: "Allow",
                actions: ["s3:GetObject", "s3:PutObject"],
                resources: [
                  pulumi.interpolate`${args.procFilesBucket.arn}/dmq/*`,
                ],
              },
              {
                effect: "Allow",
                actions: ["s3:GetObject"],
                resources: [
                  pulumi.interpolate`${args.assetsBucket.arn}/fonts/*`,
                ],
              },
              {
                actions: ["ssm:GetParameter"],
                resources: [args.gcpConfigParam.arn],
              },
            ],
          },
          { parent: this },
        ).json,
      },
      { parent: this },
    );

    const makerLambda = new GoLambda(
      `${name}-MakerLambda`,
      {
        tags: args.meta.tags,
        source: {
          s3Bucket: args.codeBucket,
          s3Key: "dmq-maker.zip",
        },
        handler: "Lambda",
        runtime: aws.lambda.Runtime.Dotnet8,
        architecture: Arch.x86,
        timeout: 30,
        memory: 512,
        reservedConcurrency: 5,
        logs: { retention: 30 },
        xray,
      },
      { parent: this },
    );

    const copyPhotoLambda = new GoLambda(
      `${name}-CopyPhoto`,
      {
        tags: args.meta.tags,
        source: {
          code: "../bin/dmq-copy-photo.zip",
          hash: HashFolder("../code/dmq/copy-photo/"),
        },
        architecture: Arch.arm,
        reservedConcurrency: 20,
        timeout: 60,
        memory: 128,
        logs: { retention: 30 },
        xray,
        env: {
          variables: {
            SSM_GCP_CONFIG: args.gcpConfigParam.name,
          },
        },
      },
      { parent: this },
    );

    new aws.iam.PolicyAttachment(
      `${name}-PolicyAttach`,
      {
        roles: [makerLambda.role, copyPhotoLambda.role],
        policyArn: procBcktPolicy.arn,
      },
      { parent: this },
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
          { parent: this },
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
              { parent: this },
            ).json,
          },
        ],
      },
      { parent: this },
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
          StartAt: "Copy in",
          QueryLanguage: "JSONata",
          States: {
            "Copy in": {
              Type: "Task",
              Resource: "arn:aws:states:::lambda:invoke",
              Output: "{% $states.input %}",
              Arguments: {
                FunctionName: pulumi.interpolate`${copyPhotoLambda.lambda.arn}:$LATEST`,
                Payload: {
                  jobId: "$states.input.jobId",
                  direction: "driveToS3",
                  driveFolderId: "{% $states.input.sourceDriveFolderId %}",
                  driveId: "{% $states.input.sourceDriveId %}",
                  s3Bucket: args.procFilesBucket.id,
                  s3Key: "{% 'dmq/' & $jobId & '/request' %}",
                  date: "{% $states.input.date %}",
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
              Next: "Inject fonts map",
              Assign: {
                input: "{% $states.input %}",
              },
            },
            "Inject fonts map": {
              Type: "Pass",
              Next: "Map",
              Output: {
                fontMap: {
                  "Merriweather Sans": "fonts/merriweather_sans.ttf",
                  "Open Sans": "fonts/open_sans_bold.ttf",
                },
              },
            },
            Map: {
              Type: "Map",
              ItemProcessor: {
                ProcessorConfig: {
                  Mode: "INLINE",
                },
                StartAt: "MakeDmq",
                States: {
                  MakeDmq: {
                    Type: "Task",
                    Resource: "arn:aws:states:::lambda:invoke",
                    Output: "{% $states.result.Payload %}",
                    Arguments: {
                      FunctionName: pulumi.interpolate`${makerLambda.lambda.arn}:$LATEST`,
                      Payload: {
                        jobId: "{% $input.jobId %}",
                        text: "{% $input.text %}",
                        resolution: "{% $states.input.resolution %}",
                        s3Bucket: args.procFilesBucket.id,
                        s3Key: "{% 'dmq/' & $jobId & '/request' %}",
                        resultS3Key:
                          "{% 'dmq/' & $jobId & '/result-' & $states.input.suffix & '.png' %}",
                        fontS3Bucket: args.assetsBucket.id,
                        fontS3Key: "{% $states.input.font %}",
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
              Items: [
                {
                  resolution: [1080, 1080],
                  suffix: "square",
                  font: "{% $exists($input.font) ? $lookup($states.input.fontMap, $input.font) : null %}",
                },
                {
                  resolution: [1080, 1350],
                  suffix: "vertical",
                  font: "{% $exists($input.font) ? $lookup($states.input.fontMap, $input.font) : null %}",
                },
              ],
              Next: "Copy out",
            },
            "Copy out": {
              Type: "Task",
              Resource: "arn:aws:states:::lambda:invoke",
              Output: "{% $states.result.Payload %}",
              Arguments: {
                FunctionName: pulumi.interpolate`${copyPhotoLambda.lambda.arn}:$LATEST`,
                Payload: {
                  jobId: "$input.jobId",
                  direction: "s3ToDrive",
                  driveFolderId: "{% $input.destDriveFolderId %}",
                  s3Bucket: args.procFilesBucket.id,
                  s3Key: "{% 'dmq/' & $jobId & '/result' %}",
                  date: "{% $input.date %}",
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
        }),
      },
      { parent: this },
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
          { parent: this },
        ).json,
        inlinePolicies: [
          {
            policy: aws.iam.getPolicyDocumentOutput(
              {
                statements: [
                  {
                    actions: [
                      // "states:StartExecution",
                      // "states:StopExecution",
                      // "states:StartSyncExecution",
                      "lambda:InvokeFunction",
                    ],
                    // resources: [stateMachine.arn],
                    resources: [args.sparkLambda.lambda.arn],
                  },
                ],
              },
              { parent: this },
            ).json,
          },
        ],
      },
      { parent: this },
    );

    this.routes = [
      {
        path: "/unstable/v2/dmq/make",
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
                actions: [
                  "states:StartExecution",
                  "states:StopExecution",
                  "states:StartSyncExecution",
                ],
                resources: [stateMachine.arn],
              },
            ],
          },
          { parent: this },
        ).json,
      },
      { parent: this },
    );

    new aws.iam.PolicyAttachment(
      `${name}-SparkPolicy`,
      {
        roles: [args.sparkLambda.role],
        policyArn: sparkPolicy.arn,
      },
      { parent: this },
    );

    this.registerOutputs({
      routes: this.routes,
    });
  }
}
