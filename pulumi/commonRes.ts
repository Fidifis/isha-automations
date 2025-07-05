import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as fs from "fs";
import * as utils from "./utils";
import { Arch, GoLambda, HashFolder } from "./components/lambda";

export default class CommonRes extends pulumi.ComponentResource {
  public readonly codeBucket: aws.s3.BucketV2;
  public readonly assetsBucket: aws.s3.BucketV2;
  public readonly procFilesBucket: aws.s3.BucketV2;
  public readonly gcpConfigParam: aws.ssm.Parameter;
  // public readonly rngLambda: GoLambda;
  public readonly sparkLambda: GoLambda;
  public readonly sparkApiGwExec: aws.iam.Role;
  public readonly sfnExec: aws.iam.Role;

  constructor(
    name: string,
    meta: utils.MetaProps,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("project:components:CommonRes", name, {}, opts);

    this.codeBucket = new aws.s3.BucketV2(
      "LambdaCode",
      {
        bucket: `${pulumi.getProject()}-${pulumi.getStack()}-lambda-code`,
        tags: meta.tags,
      },
      { parent: this },
    );
    utils.addS3BasicRules("LambdaCodeRules", this.codeBucket);

    this.assetsBucket = new aws.s3.BucketV2(
      "Assets",
      {
        tags: meta.tags,
      },
      { parent: this },
    );
    utils.addS3BasicRules("AssetsRules", this.assetsBucket);

    this.procFilesBucket = new aws.s3.BucketV2(
      "ProcFiles",
      {
        tags: meta.tags,
      },
      { parent: this },
    );
    utils.addS3BasicRules("ProcFilesRules", this.procFilesBucket, {
      noLifecycle: true,
    });
    new aws.s3.BucketLifecycleConfigurationV2(
      "ProcFilesLifecycle",
      {
        bucket: this.procFilesBucket.id,
        rules: [
          {
            id: "DeleteAllOldFiles",
            status: "Enabled",
            expiration: {
              days: 90,
            },
          },
          // {
          //   id: "DeleteDmqDownloads",
          //   status: "Enabled",
          //   filter: {
          //     prefix: "dmq/download/"
          //   },
          //   expiration: {
          //     days: 1,
          //   },
          // },
          {
            id: "DeleteVideoDownloads",
            status: "Enabled",
            filter: {
              prefix: "video-render/download/",
            },
            expiration: {
              days: 1,
            },
          },
          ...utils.bucketCommonLifecycleRules,
        ],
      },
      { parent: this },
    );

    this.gcpConfigParam = new aws.ssm.Parameter(
      "GCPAccessConfig",
      {
        name: `/isha/${pulumi.getStack()}/gcp-fed/lib-config`,
        description:
          "Client library config file for GCP federation to impersonate Google service account",
        type: aws.ssm.ParameterType.String,
        value: fs.readFileSync("./clientLibConfig.json", "utf8"),
        tags: meta.tags,
      },
      { parent: this },
    );

    // this.rngLambda = new GoLambda(
    //   "RNG",
    //   {
    //     meta.tags,
    //     source: {
    //       code: "../bin/rng.zip",
    //       hash: HashFolder("../code/rng/"),
    //     },
    //     xray: true,
    //     architecture: Arch.arm,
    //     logs: { retention: 7 },
    //   },
    //   { parent: this },
    // );

    this.sparkLambda = new GoLambda(
      "Spark",
      {
        tags: meta.tags,
        source: {
          code: "../bin/spark.zip",
          hash: HashFolder("../code/spark/"),
        },
        architecture: Arch.arm,
        xray: true,
        logs: { retention: 30 },
        env: {
          variables: {
            ID_LEN: "8",
          },
        },
      },
      { parent: this },
    );

    new aws.resourcegroups.Group("ResourceGroup", {
      resourceQuery: {
        query: JSON.stringify({
          ResourceTypeFilters: ["AWS::AllSupported"],
          TagFilters: Object.entries(meta.tags).map(([key, value]) => ({
            Key: key,
            Values: [value],
          })),
        }),
      },
    });

    this.sparkApiGwExec = new aws.iam.Role(
      `${name}-SparkApiGwExec`,
      {
        tags: meta.tags,
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
                    resources: [this.sparkLambda.lambda.arn],
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

    this.sfnExec = new aws.iam.Role(
      `${name}-SFNExec`,
      {
        tags: meta.tags,
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
                    values: [meta.accountId],
                  },
                ],
              },
            ],
          },
          { parent: this },
        ).json,
        inlinePolicies: [
          {
            name: "operational",
            policy: aws.iam.getPolicyDocumentOutput(
              {
                statements: [
                  {
                    actions: ["lambda:InvokeFunction"],
                    resources: [
                      pulumi.interpolate`arn:aws:lambda:${meta.region}:${meta.accountId}:function:${pulumi.getProject()}-${pulumi.getStack()}-*`,
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

    this.registerOutputs({
      codeBucket: this.codeBucket,
      assetsBucket: this.assetsBucket,
      procFilesBucket: this.procFilesBucket,
      gcpConfigParam: this.gcpConfigParam,
      // rngLambda: this.rngLambda,
      sparkLambda: this.sparkLambda,
      sparkApiGwExec: this.sparkApiGwExec,
      sfnExec: this.sfnExec,
    });
  }
}
