import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ApiGatewayRoute } from "../components/apiGateway";
import { Arch, GoLambda, HashFolder } from "../components/lambda";
import { MetaProps } from "../utils";

export interface VideoRenderProps {
  meta: MetaProps;
  codeBucket: aws.s3.BucketV2;
  procFilesBucket: aws.s3.BucketV2;
  assetsBucket: aws.s3.BucketV2;
  rng: aws.lambda.Function;
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
    super("project:components:video-render", name, {}, opts);

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
                actions: ["s3:ListBucket"],
                resources: [args.procFilesBucket.arn, args.assetsBucket.arn],
              },
              {
                actions: ["s3:PutObject", "s3:GetObject"],
                resources: [
                  pulumi.interpolate`${args.procFilesBucket.arn}/video-render/*`,
                ],
              },
              {
                actions: ["s3:GetObject"],
                resources: [
                  pulumi.interpolate`${args.assetsBucket.arn}/fonts/*`,
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
        tags: args.meta.tags,
        source: {
          s3Bucket: args.codeBucket,
          s3Key: "video-render-copy-in.zip",
          hash: HashFolder("../code/video-render/copy-in/"),
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
        tags: args.meta.tags,
        source: {
          s3Bucket: args.codeBucket,
          s3Key: "video-render-srt-docs-extract.zip",
          hash: HashFolder("../code/video-render/srt-docs-extract/"),
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
    const lambdaDeliverGSheet = new GoLambda(
      `${name}-DeliverGSheet`,
      {
        tags: args.meta.tags,
        source: {
          s3Bucket: args.codeBucket,
          s3Key: "video-render-deliver-gsheet.zip",
          hash: HashFolder("../code/video-render/deliver-gsheet/"),
        },
        architecture: Arch.arm,
        reservedConcurrency: 20,
        timeout: 300,
        memory: 256,
        logs: { retention: 30 },
        ephemeralStorage: 4096,
        env: {
          variables: {
            SSM_GCP_CONFIG: args.gcpConfigParam.name,
          },
        },
      },
      { parent: this },
    );

    const ffmpegLayer = new aws.lambda.LayerVersion(
      `${name}-FfmpegLayer`,
      {
        layerName: "ffmpeg",
        compatibleArchitectures: [Arch.x86],
        s3Bucket: args.codeBucket.id,
        s3Key: "video-render-ffmpeg-layer.zip",
        sourceCodeHash: HashFolder("../code/video-render/ffmpeg-layer/"),
      },
      { parent: this },
    );

    const lambdaConvertSrt = new GoLambda(
      `${name}-ConvertSrt`,
      {
        tags: args.meta.tags,
        source: {
          s3Bucket: args.codeBucket,
          s3Key: "video-render-srt-convert.zip",
          hash: HashFolder("../code/video-render/srt-convert/"),
        },
        layers: [ffmpegLayer.arn],
        architecture: Arch.x86,
        timeout: 60,
        memory: 256,
        logs: { retention: 30 },
      },
      { parent: this },
    );

    const lambdaFfmpegBurn = new GoLambda(
      `${name}-FfmpegBurn`,
      {
        tags: args.meta.tags,
        source: {
          s3Bucket: args.codeBucket,
          s3Key: "video-render-ffmpeg-burn.zip",
          hash: HashFolder("../code/video-render/ffmpeg-burn/"),
        },
        layers: [ffmpegLayer.arn],
        architecture: Arch.x86,
        reservedConcurrency: 3,
        timeout: 900,
        memory: 2048,
        logs: { retention: 30 },
        ephemeralStorage: 10240,
      },
      { parent: this },
    );

    new aws.iam.PolicyAttachment(
      `${name}-Policy`,
      {
        roles: [
          lambdaDocsExtract.role,
          lambdaCopyIn.role,
          lambdaConvertSrt.role,
          lambdaFfmpegBurn.role,
          lambdaDeliverGSheet.role,
        ],
        policyArn: lambdaPolicy.arn,
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
        definition: pulumi.jsonStringify({
          Comment: "A description of my state machine",
          StartAt: "jobID",
          QueryLanguage: "JSONata",
          States: {
            jobID: {
              Type: "Task",
              Resource: "arn:aws:states:::lambda:invoke",
              Output: "{% $states.input %}",
              Retry: [
                {
                  ErrorEquals: ["Lambda.TooManyRequestsException"],
                  IntervalSeconds: 1,
                  MaxAttempts: 3,
                  BackoffRate: 2,
                  JitterStrategy: "FULL",
                },
              ],
              Next: "Parallel",
              Assign: {
                jobId: "{% $states.result.Payload.result %}",
                deliveryWorkflow: "{% $states.input.deliveryWorkflow %}",
                delivieryParams: "{% $states.input.deliveryParams %}",
              },
              Arguments: {
                FunctionName: pulumi.interpolate`${args.rng.arn}:$LATEST`,
                Payload: {
                  length: 5,
                },
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
                        FunctionName: pulumi.interpolate`${lambdaCopyIn.lambda.arn}:$LATEST`,
                        Payload: {
                          sourceDriveFolderId:
                            "{% $states.input.videoDriveFolderId %}",
                          driveId: "{% $states.input.videoDriveId %}",
                          jobId: "{% $jobId %}",
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
                {
                  StartAt: "Extract srts in",
                  States: {
                    "Extract srts in": {
                      Type: "Task",
                      Resource: "arn:aws:states:::lambda:invoke",
                      Output: "{% $states.result.Payload %}",
                      Arguments: {
                        FunctionName: pulumi.interpolate`${lambdaDocsExtract.lambda.arn}:$LATEST`,
                        Payload: {
                          sourceDriveFolderId:
                            "{% $states.input.srtDriveFolderId %}",
                          driveId: "{% $states.input.srtDriveId %}",
                          jobId: "{% $jobId %}",
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
                      Next: "Convert SRT",
                    },
                    "Convert SRT": {
                      Type: "Task",
                      Resource: "arn:aws:states:::lambda:invoke",
                      Output: "{% $states.result.Payload %}",
                      Arguments: {
                        FunctionName: pulumi.interpolate`${lambdaConvertSrt.lambda.arn}:$LATEST`,
                        Payload: {
                          bucket: args.procFilesBucket.id,
                          sourceKey:
                            "{% 'video-render/download/' & $jobId & '/subtitles.srt' %}",
                          destKey:
                            "{% 'video-render/download/' & $jobId & '/subtitles.ass' %}",
                          fontName: "Merriweather Sans",
                          fontSize: "22",
                          textHeight: "100",
                          vertical: true,
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
              ],
              Next: "Burn to video",
            },
            "Burn to video": {
              Type: "Task",
              Resource: "arn:aws:states:::lambda:invoke",
              Output: "{% $states.result.Payload %}",
              Arguments: {
                FunctionName: pulumi.interpolate`${lambdaFfmpegBurn.lambda.arn}:$LATEST`,
                Payload: {
                  jobId: "{% $jobId %}",
                  bucket: args.procFilesBucket.id,
                  downloadFolderKey: "video-render/download/",
                  resultFolderKey: "video-render/result/",
                  fontBucket: args.assetsBucket.id,
                  fontKey: "fonts/merriweather_sans.ttf",
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
              Next: "DeliverChoice",
            },
            DeliverChoice: {
              Type: "Choice",
              Choices: [
                {
                  Next: "Deliver",
                  Condition:
                    '{% ($deliveryWorkflow) = ("googleSpreadsheet") %}',
                },
              ],
              Default: "Fail",
            },
            Deliver: {
              Type: "Task",
              Resource: "arn:aws:states:::lambda:invoke",
              Output: "{% $states.result.Payload %}",
              Arguments: {
                FunctionName: pulumi.interpolate`${lambdaDeliverGSheet.lambda.arn}:$LATEST`,
                Payload: {
                  deliveryParams: "{% $delivieryParams %}",
                  bucket: args.procFilesBucket.id,
                  videoKey:
                    "{% 'video-render/result/' & $jobId & '/video.mp4' %}",
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
            Fail: {
              Type: "Fail",
              Error: "Cannot deliver",
              Cause: "invalid input parameter deliveryWorkflow",
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
        ],
      },
      { parent: this },
    );

    this.routes = [
      {
        path: "/unstable/v2/video-render/reel",
        method: "POST",
        eventHandler: stateMachine,
        authorizer: args.apiAuthorizer,
        execRole: apiGwExec,
      },
    ];

    this.registerOutputs({
      routes: this.routes,
    });
  }
}
