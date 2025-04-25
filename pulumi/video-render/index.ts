import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ApiGatewayRoute } from "../components/apiGateway";
import { Arch, GoLambda } from "../components/lambda";
import { MetaProps } from "../utils";

export interface VideoRenderProps {
  meta: MetaProps;
  codeBucket: aws.s3.BucketV2;
  procFilesBucket: aws.s3.BucketV2;
  apiAuthorizer: aws.lambda.Function;
  gcpConfigParam: aws.ssm.Parameter;
}

export default class VideoRender extends pulumi.ComponentResource {
  public readonly routes: ApiGatewayRoute[];

  constructor(
    name: string,
    args: VideoRenderProps,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("fidifis:components:video-render", name, {}, opts);

    const lambdaPolicy = new aws.iam.Policy(
      `${name}-Policy`,
      {
        policy: aws.iam.getPolicyDocumentOutput(
          {
            statements: [
              {
                actions: ["ssm:GetParameter"],
                resources: [args.gcpConfigParam.arn],
              },
              {
                actions: ["s3:PutObject", "s3:GetObject", "s3:ListBucket"],
                resources: [
                  pulumi.interpolate`${args.procFilesBucket.arn}/video-render`,
                  pulumi.interpolate`${args.procFilesBucket.arn}/video-render/*`,
                ],
              },
            ],
          },
          { parent: this },
        ).json,
      },
      { parent: this },
    );

    const lambdaCopyIn = new GoLambda(
      `${name}-CopyIn`,
      {
        source: {
          s3Bucket: args.codeBucket,
          s3Key: "video-render-copy-in.zip",
        },
        architecture: Arch.arm,
        reservedConcurrency: 20,
        timeout: 300,
        memory: 256,
        ephemeralStorage: 10240,
        logs: { retention: 30 },
        env: {
          variables: {
            SSM_GCP_CONFIG: args.gcpConfigParam.name,
            BUCKET_NAME: args.procFilesBucket.id,
            BUCKET_KEY: "video-render/download",
          },
        },
      },
      { parent: this },
    );

    const lambdaDocsExtract = new GoLambda(
      `${name}-SrtDocsExtract`,
      {
        source: {
          s3Bucket: args.codeBucket,
          s3Key: "video-render-srt-docs-extract.zip",
        },
        architecture: Arch.arm,
        reservedConcurrency: 20,
        timeout: 60,
        memory: 128,
        logs: { retention: 30 },
        env: {
          variables: {
            SSM_GCP_CONFIG: args.gcpConfigParam.name,
            BUCKET_NAME: args.procFilesBucket.id,
            BUCKET_KEY: "video-render/download",
          },
        },
      },
      { parent: this },
    );

    const ffmpegLayer = new aws.lambda.LayerVersion(`${name}-FfmpegLayer`, {
        layerName: "ffmpeg",
        compatibleArchitectures: [Arch.x86],
        s3Bucket: args.codeBucket.id,
        s3Key: "video-render-ffmpeg-layer.zip",
    }, {parent: this});

    const lambdaFfmpeg = new GoLambda(
      `${name}-FfmpegOps`,
      {
        source: {
          s3Bucket: args.codeBucket,
          s3Key: "video-render-ffmpeg-ops.zip",
        },
        layers: [ffmpegLayer.arn],
        architecture: Arch.x86,
        reservedConcurrency: 3,
        timeout: 600,
        memory: 512,
        logs: { retention: 30 },
        ephemeralStorage: 10240,
      },
      { parent: this },
    );

    new aws.iam.PolicyAttachment(
      `${name}-Policy`,
      {
        roles: [lambdaDocsExtract.role, lambdaCopyIn.role, lambdaFfmpeg.role],
        policyArn: lambdaPolicy.arn,
      },
      { parent: this },
    );

    const stateRole = new aws.iam.Role(
      `${name}-SFSM`,
      {
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
      },
      { parent: this },
    );

    new aws.sfn.StateMachine(
      `${name}`,
      {
        roleArn: stateRole.arn,
        definition: JSON.stringify({
          Comment: "A description of my state machine",
          StartAt: "Pass",
          States: {
            Pass: {
              Type: "Pass",
              Next: "Parallel",
              Assign: {
                jobId: "{% $states.context.Execution.Id %}",
              },
            },
            Parallel: {
              Type: "Parallel",
              Branches: [
                {
                  StartAt: "Copy files in",
                  States: {
                    "Copy files in": {
                      Type: "Task",
                      Resource: "arn:aws:states:::lambda:invoke",
                      Output: "{% $states.result.Payload %}",
                      Arguments: {
                        FunctionName:
                          "arn:aws:lambda:eu-north-1:956941652442:function:isha-automations-dev-VideoRender-CopyIn:$LATEST",
                        Payload: "{% $states.input %}",
                      },
                      Retry: [
                        {
                          ErrorEquals: [
                            "Lambda.ServiceException",
                            "Lambda.AWSLambdaException",
                            "Lambda.SdkClientException",
                            "Lambda.TooManyRequestsException",
                          ],
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
                {
                  StartAt: "Extract srts in",
                  States: {
                    "Extract srts in": {
                      Type: "Task",
                      Resource: "arn:aws:states:::lambda:invoke",
                      Output: "{% $states.result.Payload %}",
                      Arguments: {
                        FunctionName:
                          "arn:aws:lambda:eu-north-1:956941652442:function:isha-automations-dev-VideoRender-SrtDocsExtract:$LATEST",
                        Payload: "{% $states.input %}",
                      },
                      Retry: [
                        {
                          ErrorEquals: [
                            "Lambda.ServiceException",
                            "Lambda.AWSLambdaException",
                            "Lambda.SdkClientException",
                            "Lambda.TooManyRequestsException",
                          ],
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
              ],
              Next: "S3 object keys",
              Arguments: {
                jobId: "{% $jobId %}",
              },
            },
            "S3 object keys": {
              Type: "Map",
              ItemProcessor: {
                ProcessorConfig: {
                  Mode: "DISTRIBUTED",
                  ExecutionType: "STANDARD",
                },
                StartAt: "Lambda Invoke",
                States: {
                  "Lambda Invoke": {
                    Type: "Task",
                    Resource: "arn:aws:states:::lambda:invoke",
                    Output: "{% $states.result.Payload %}",
                    Arguments: {
                      FunctionName: "",
                      Payload: "{% $states.input %}",
                    },
                    Retry: [
                      {
                        ErrorEquals: [
                          "Lambda.ServiceException",
                          "Lambda.AWSLambdaException",
                          "Lambda.SdkClientException",
                          "Lambda.TooManyRequestsException",
                        ],
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
              ItemReader: {
                Resource: "arn:aws:states:::s3:listObjectsV2",
                Arguments: {
                  Bucket: "isha-automations-dev-procfiles-xu2dj",
                  Prefix: "video-render/decompose/",
                },
              },
              MaxConcurrency: 10,
              Label: "S3objectkeys",
              End: true,
            },
          },
          QueryLanguage: "JSONata",
        }),
      },
      { parent: this },
    );

    this.routes = [
      {
        path: "/v1/process/reel",
        method: "POST",
        eventHandler: lambdaCopyIn.lambda,
        authorizer: args.apiAuthorizer,
      },
    ];

    this.registerOutputs({
      routes: this.routes,
    });
  }
}
