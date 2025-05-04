import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { DmqMakerLambda } from "./makerLambda";
import { ApiGatewayRoute } from "../components/apiGateway";
import { Arch, GoLambda, HashFolder } from "../components/lambda";
import { MetaProps } from "../utils";

export interface DMQsProps {
  meta: MetaProps;
  codeBucket: aws.s3.BucketV2;
  procFilesBucket: aws.s3.BucketV2;
  apiAuthorizer: aws.lambda.Function;
  gcpConfigParam: aws.ssm.Parameter;
  rng: aws.lambda.Function;
}

export class DMQs extends pulumi.ComponentResource {
  public readonly routes: ApiGatewayRoute[];

  constructor(
    name: string,
    args: DMQsProps,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("project:components:DMQ", name, {}, opts);

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

    const makerLambda = new DmqMakerLambda(
      `${name}-MakerLambda`,
      { codeBucket: args.codeBucket, tags: args.meta.tags },
      { parent: this },
    );

    const copyPhotoLambda = new GoLambda(
      `${name}-CopyPhoto`,
      {
        tags: args.meta.tags,
        source: {
          s3Bucket: args.codeBucket,
          s3Key: "dmq-copy-photo.zip",
          hash: HashFolder("../code/dmq/copy-photo/"),
        },
        architecture: Arch.arm,
        reservedConcurrency: 20,
        timeout: 60,
        memory: 128,
        logs: { retention: 30 },
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
                ],
              },
              { parent: this },
            ).json,
          },
        ],
      },
      { parent: this },
    );

    const stateMachine = new aws.sfn.StateMachine(`${name}`, {
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
            Assign: {
              jobId: "{% $states.result.Payload.result %}",
            },
            Arguments: {
              FunctionName: pulumi.interpolate`${args.rng.arn}:$LATEST`,
              Payload: {
                length: 5,
              },
            },
            Next: "Copy in",
          },
          "Copy in": {
            Type: "Task",
            Resource: "arn:aws:states:::lambda:invoke",
            Output: "{% $states.input %}",
            Arguments: {
              FunctionName: pulumi.interpolate`${copyPhotoLambda.lambda.arn}:$LATEST`,
              Payload: {
                jobId: "$jobId",
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
                ErrorEquals: [
                  "Lambda.TooManyRequestsException",
                ],
                IntervalSeconds: 1,
                MaxAttempts: 3,
                BackoffRate: 2,
                JitterStrategy: "FULL",
              },
            ],
            Next: "Map",
            Assign: {
              input: "{% $states.input %}",
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
                      jobId: "{% $jobId %}",
                      text: "{% $input.text %}",
                      resolution: "{% $states.input.resolution %}",
                      s3Bucket: args.procFilesBucket.id,
                      s3Key: "{% 'dmq/' & $jobId & '/request' %}",
                      resultS3Key:
                        "{% 'dmq/' & $jobId & '/result-' & $states.input.suffix & '.png' %}",
                    },
                  },
                  Retry: [
                    {
                      ErrorEquals: [
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
            Items: [
              {
                resolution: [1080, 1080],
                suffix: "square",
              },
              {
                resolution: [1080, 1350],
                suffix: "vertical",
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
                jobId: "$jobId",
                direction: "s3ToDrive",
                driveFolderId: "{% $input.destDriveFolderId %}",
                driveId: "{% $input.destDriveId %}",
                s3Bucket: args.procFilesBucket.id,
                s3Key: "{% 'dmq/' & $jobId & '/result' %}",
                date: "{% $input.date %}",
              },
            },
            Retry: [
              {
                ErrorEquals: [
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
      }),
    }, {parent: this});
    this.routes = [
      {
        path: "/unstable/v2/dmq/make",
        method: "POST",
        eventHandler: makerLambda.lambda,
        authorizer: args.apiAuthorizer,
      },
    ];

    this.registerOutputs({
      routes: this.routes,
    });
  }
}
