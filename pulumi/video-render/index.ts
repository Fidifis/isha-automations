import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ApiGatewayRoute } from "../components/apiGateway";
import { Arch, GoLambda, HashFolder, AssumePolicy } from "../components/lambda";
import { MetaProps } from "../utils";

export interface VideoRenderProps {
  meta: MetaProps;
  codeBucket: aws.s3.BucketV2;
  procFilesBucket: aws.s3.BucketV2;
  assetsBucket: aws.s3.BucketV2;
  rng: aws.lambda.Function;
  gcpConfigParam: aws.ssm.Parameter;
  fileTranferLambda: GoLambda;
}

export default class VideoRender extends pulumi.ComponentResource {
  public readonly routes: ApiGatewayRoute[];

  constructor(
    name: string,
    args: VideoRenderProps,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("project:components:video-render", name, {}, opts);

    const xray = true;

    const s3Policy = new aws.iam.Policy(
      `${name}-S3Policy`,
      {
        policy: aws.iam.getPolicyDocumentOutput(
          {
            statements: [
              {
                actions: ["s3:PutObject", "s3:GetObject"],
                resources: [
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

    const videoRole = new aws.iam.Role(
      `${name}-Role`,
      {
        tags: args.meta.tags,
        assumeRolePolicy: AssumePolicy.json,
        inlinePolicies: [
          {
            name: "Logging",
            policy: aws.iam.getPolicyDocumentOutput(
              {
                statements: [
                  {
                    actions: [
                      "xray:PutTelemetryRecords",
                      "xray:PutTraceSegments",
                    ],
                    resources: ["*"],
                  },
                ],
              },
              { parent: this },
            ).json,
          },
          {
            name: "WorkPermissions",
            policy: aws.iam.getPolicyDocumentOutput(
              {
                statements: [
                  {
                    actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
                    resources: [
                      pulumi.interpolate`arn:aws:logs:${args.meta.region}:${args.meta.accountId}:log-group:/aws/lambda/${pulumi.getProject()}-${pulumi.getStack()}-${name}*`,
                    ],
                  },
                  {
                    actions: ["ssm:GetParameter"],
                    resources: [args.gcpConfigParam.arn],
                  },
                  {
                    actions: ["s3:ListBucket"],
                    resources: [
                      args.procFilesBucket.arn,
                      args.assetsBucket.arn,
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
        ],
      },
      { parent: this },
    );

    new aws.iam.PolicyAttachment(
      `${name}-S3Policy`,
      {
        roles: [videoRole, args.fileTranferLambda.role],
        policyArn: s3Policy.arn,
      },
      { parent: this },
    );

    const lambdaCopyIn = new GoLambda(
      `${name}-CopyIn`,
      {
        tags: args.meta.tags,
        source: {
          code: "../bin/video-render-copy-in.zip",
          hash: HashFolder("../code/video-render/copy-in/"),
        },
        xray,
        role: videoRole,
        architecture: Arch.arm,
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
          code: "../bin/video-render-srt-docs-extract.zip",
          hash: HashFolder("../code/video-render/srt-docs-extract/"),
        },
        xray,
        role: videoRole,
        architecture: Arch.arm,
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
          code: "../bin/video-render-deliver-gsheet.zip",
          hash: HashFolder("../code/video-render/deliver-gsheet/"),
        },
        xray,
        role: videoRole,
        architecture: Arch.arm,
        timeout: 300,
        memory: 256,
        logs: { retention: 30 },
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

    const lambdaProbe = new GoLambda(
      `${name}-Ffprobe`,
      {
        tags: args.meta.tags,
        source: {
          code: "../bin/video-render-ffmpeg-probe.zip",
          hash: HashFolder("../code/video-render/ffmpeg-probe/"),
        },
        xray,
        role: videoRole,
        layers: [ffmpegLayer.arn],
        architecture: Arch.x86,
        timeout: 60,
        memory: 256,
        ephemeralStorage: 10240,
        logs: { retention: 30 },
      },
      { parent: this },
    );

    const lambdaConvertSrt = new GoLambda(
      `${name}-ConvertSrt`,
      {
        tags: args.meta.tags,
        source: {
          code: "../bin/video-render-srt-convert.zip",
          hash: HashFolder("../code/video-render/srt-convert/"),
        },
        xray,
        role: videoRole,
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
          code: "../bin/video-render-ffmpeg-burn.zip",
          hash: HashFolder("../code/video-render/ffmpeg-burn/"),
        },
        xray,
        role: videoRole,
        layers: [ffmpegLayer.arn],
        architecture: Arch.x86,
        reservedConcurrency: 5,
        timeout: 900,
        memory: 2048,
        logs: { retention: 30 },
        ephemeralStorage: 10240,
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
              Next: "Copy files in",
              Assign: {
                jobId: "{% $states.result.Payload.result %}",
                videoDriveFolderId: "{% $states.input.videoDriveFolderId %}",
                videoDriveId: "{% $states.input.videoDriveId %}",
                videoFileId:
                  "{% $exists($states.input.videoFileId) ? $states.input.videoFileId : null %}",
                srtDriveFolderId: "{% $states.input.srtDriveFolderId %}",
                srtDriveId: "{% $states.input.srtDriveId %}",
                destinationFolderId: "{% $states.input.destinationFolderId %}",
                deliveryWorkflow: "{% $states.input.deliveryWorkflow %}",
                delivieryParams: "{% $states.input.deliveryParams %}",
                errDeliveryParams: "{% $states.input.errDeliveryParams %}",
              },
              Arguments: {
                FunctionName: pulumi.interpolate`${args.rng.arn}:$LATEST`,
                Payload: {
                  length: 5,
                },
              },
            },
            "Copy files in": {
              Type: "Task",
              Resource: "arn:aws:states:::lambda:invoke",
              Output: "{% $states.result.Payload %}",
              Arguments: {
                FunctionName: pulumi.interpolate`${lambdaCopyIn.lambda.arn}:$LATEST`,
                Payload: {
                  sourceDriveFolderId: "{% $videoDriveFolderId %}",
                  driveId: "{% $videoDriveId %}",
                  jobId: "{% $jobId %}",
                  videoFileId: "{% $videoFileId %}",
                },
              },
              Retry: [
                {
                  ErrorEquals: ["Lambda.TooManyRequestsException"],
                  IntervalSeconds: 1,
                  MaxAttempts: 3,
                  BackoffRate: 3,
                  JitterStrategy: "FULL",
                },
              ],
              Catch: [
                {
                  ErrorEquals: ["States.ALL"],
                  Next: "Deliver error",
                  Output: {
                    err: "{% $states.errorOutput.Cause %}",
                  },
                },
              ],
              Next: "Extract srts in",
            },
            "Extract srts in": {
              Type: "Task",
              Resource: "arn:aws:states:::lambda:invoke",
              Output: "{% $states.result.Payload %}",
              Arguments: {
                FunctionName: pulumi.interpolate`${lambdaDocsExtract.lambda.arn}:$LATEST`,
                Payload: {
                  sourceDriveFolderId: "{% $srtDriveFolderId %}",
                  driveId: "{% $srtDriveId %}",
                  jobId: "{% $jobId %}",
                },
              },
              Retry: [
                {
                  ErrorEquals: ["Lambda.TooManyRequestsException"],
                  IntervalSeconds: 1,
                  MaxAttempts: 3,
                  BackoffRate: 3,
                  JitterStrategy: "FULL",
                },
              ],
              Next: "Probe video meta",
              Catch: [
                {
                  ErrorEquals: ["States.ALL"],
                  Next: "Deliver error",
                  Output: {
                    err: "{% $states.errorOutput.Cause %}",
                  },
                },
              ],
            },
            "Probe video meta": {
              Type: "Task",
              Resource: "arn:aws:states:::lambda:invoke",
              Output: "{% $states.result.Payload %}",
              Arguments: {
                FunctionName: pulumi.interpolate`${lambdaProbe.lambda.arn}:$LATEST`,
                Payload: {
                  jobId: "{% $jobId %}",
                  s3Bucket: args.procFilesBucket.id,
                  downloadFolderKey: "video-render/download/",
                },
              },
              Retry: [
                {
                  ErrorEquals: ["Lambda.TooManyRequestsException"],
                  IntervalSeconds: 1,
                  MaxAttempts: 3,
                  BackoffRate: 3,
                  JitterStrategy: "FULL",
                },
              ],
              Catch: [
                {
                  ErrorEquals: ["States.ALL"],
                  Next: "Deliver error",
                  Output: {
                    err: "{% $states.errorOutput.Cause %}",
                  },
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
                  videoResolution: "{% $states.input.resolution %}",
                  fontName: "Open Sans Bold",
                  fontSize: 22,
                  // fontWeight: 800,
                  textHeight: "100",
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
              Catch: [
                {
                  ErrorEquals: ["States.ALL"],
                  Next: "Deliver error",
                  Output: {
                    err: "{% $states.errorOutput.Cause %}",
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
                  fontKey: "fonts/open_sans_bold.ttf",
                },
              },
              Retry: [
                {
                  ErrorEquals: ["Lambda.TooManyRequestsException"],
                  IntervalSeconds: 10,
                  MaxAttempts: 3,
                  BackoffRate: 3,
                  JitterStrategy: "FULL",
                },
              ],
              Next: "Copy out",
              Catch: [
                {
                  ErrorEquals: ["States.ALL"],
                  Next: "Deliver error",
                  Output: {
                    err: "{% $states.errorOutput.Cause %}",
                  },
                },
              ],
            },
            "Copy out": {
              Type: "Task",
              Resource: "arn:aws:states:::lambda:invoke",
              Output: "{% $states.result.Payload %}",
              Arguments: {
                FunctionName: pulumi.interpolate`${args.fileTranferLambda.lambda.arn}:$LATEST`,
                Payload: {
                  direction: "s3ToDrive",
                  s3Bucket: args.procFilesBucket.id,
                  s3Key: "{% 'video-render/result/' & $jobId & '/video.mp4' %}",
                  driveFolderId: "{% $destinationFolderId %}",
                  driveFileName: "OUT_video.mp4",
                  mimeType: "video/mp4",
                },
              },
              Retry: [
                {
                  ErrorEquals: ["Lambda.TooManyRequestsException"],
                  IntervalSeconds: 1,
                  MaxAttempts: 3,
                  BackoffRate: 3,
                  JitterStrategy: "FULL",
                },
              ],
              Next: "DeliverChoice",
              Catch: [
                {
                  ErrorEquals: ["States.ALL"],
                  Next: "Deliver error",
                  Output: {
                    err: "{% $states.errorOutput.Cause %}",
                  },
                },
              ],
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
              Default: "Deliver param Fail",
            },
            Deliver: {
              Type: "Task",
              Resource: "arn:aws:states:::lambda:invoke",
              Output: "{% $states.result.Payload %}",
              Arguments: {
                FunctionName: pulumi.interpolate`${lambdaDeliverGSheet.lambda.arn}:$LATEST`,
                Payload: {
                  jobId: "{% $jobId %}",
                  deliveryParams: "{% $delivieryParams %}",
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
              Catch: [
                {
                  ErrorEquals: ["States.ALL"],
                  Next: "Deliver error",
                  Output: {
                    err: "{% $states.errorOutput.Cause %}",
                  },
                },
              ],
            },
            "Deliver param Fail": {
              Type: "Fail",
              Error: "Cannot deliver",
              Cause: "invalid input parameter deliveryWorkflow",
            },
            "Deliver error": {
              Type: "Task",
              Resource: "arn:aws:states:::lambda:invoke",
              Output: "{% $states.result.Payload %}",
              Arguments: {
                FunctionName: pulumi.interpolate`${lambdaDeliverGSheet.lambda.arn}:$LATEST`,
                Payload: {
                  jobId: "{% $jobId %}",
                  deliveryParams: "{% $delivieryParams %}",
                  errDeliveryParams: "{% $errDeliveryParams %}",
                  errMsg: "{% $states.input.err %}",
                },
              },
              Retry: [
                {
                  ErrorEquals: ["States.ALL"],
                  IntervalSeconds: 1,
                  MaxAttempts: 3,
                  BackoffRate: 2,
                  JitterStrategy: "FULL",
                },
              ],
              Next: "Fail",
            },
            Fail: {
              Type: "Fail",
              Error: "error",
              Cause: "a stage has failed",
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
        execRole: apiGwExec,
      },
    ];

    this.registerOutputs({
      routes: this.routes,
    });
  }
}
