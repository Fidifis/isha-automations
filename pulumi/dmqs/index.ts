import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { DmqMakerLambda } from "./makerLambda";
import { ApiGatewayRoute } from "../components/apiGateway";
import { Arch, GoLambda, HashFolder } from "../components/lambda";

export interface DMQsProps {
  tags: aws.Tags;
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
            ],
          },
          { parent: this },
        ).json,
      },
      { parent: this },
    );

    const makerLambda = new DmqMakerLambda(
      `${name}-MakerLambda`,
      { codeBucket: args.codeBucket, tags: args.tags },
      { parent: this },
    );

    const copyPhotoLambda = new GoLambda(
      `${name}-CopyPhoto`,
      {
        tags: args.tags,
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
        roles: [
          makerLambda.role,
          copyPhotoLambda.role,
        ],
        policyArn: procBcktPolicy.arn,
      },
      { parent: this },
    );

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
