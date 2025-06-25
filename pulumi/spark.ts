import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { Arch, GoLambda, HashFolder } from "./components/lambda";
import { MetaProps } from "./utils";

export interface SparkProps {
  meta: MetaProps;
}

export default class Spark extends pulumi.ComponentResource {
  public readonly transferLambda: GoLambda;

  constructor(
    name: string,
    args: SparkProps,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("project:components:spark", name, {}, opts);

    const lambdaPolicy = new aws.iam.Policy(
      `${name}-Policy`,
      {
        policy: aws.iam.getPolicyDocumentOutput(
          {
            statements: [
              {
                actions: ["s3:PutObject", "s3:GetObject"],
                resources: [
                  pulumi.interpolate`${args.procFilesBucket.arn}/*`,
                ],
              },
            ],
          },
          { parent: this },
        ).json,
      },
      { parent: this },
    );

    this.transferLambda = new GoLambda(
      `${name}-TransferFiles`,
      {
        tags: args.meta.tags,
        source: {
          s3Bucket: args.codeBucket,
          s3Key: "s3-gdrive-transfer.zip",
          hash: HashFolder("../code/s3-gdrive-transfer/"),
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
          },
        },
      },
      { parent: this },
    );

    new aws.iam.PolicyAttachment(
      `${name}-Policy`,
      {
        roles: [
          this.transferLambda.role,
        ],
        policyArn: lambdaPolicy.arn,
      },
      { parent: this },
    );

    this.registerOutputs({
      transferLambda: this.transferLambda,
    });
  }
}
