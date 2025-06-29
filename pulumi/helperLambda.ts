import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { Arch, GoLambda, HashFolder } from "./components/lambda";
import { MetaProps } from "./utils";

export interface HelperProps {
  meta: MetaProps;
  procFilesBucket: aws.s3.BucketV2;
  gcpConfigParam: aws.ssm.Parameter;
}

export default class HelperLambda extends pulumi.ComponentResource {
  public readonly transferLambda: GoLambda;
  public readonly otpLambda: GoLambda;

  constructor(
    name: string,
    args: HelperProps,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("project:components:helperLambda", name, {}, opts);

    const transferLambdaPolicy = {
      actions: ["ssm:GetParameter"],
      resources: [args.gcpConfigParam.arn],
    };
    const otpAuthLambdaPolicy = {
      actions: ["ssm:GetParametersByPath"],
      resources: [
        `arn:aws:ssm:${args.meta.region}:${args.meta.accountId}:parameter/isha/${pulumi.getStack()}/otp`,
      ],
    };

    this.transferLambda = new GoLambda(
      `${name}-TransferFiles`,
      {
        tags: args.meta.tags,
        source: {
          code: "../bin/s3-gdrive-transfer.zip",
          hash: HashFolder("../code/s3-gdrive-transfer/"),
        },
        architecture: Arch.arm,
        timeout: 300,
        memory: 256,
        ephemeralStorage: 10240,
        rolePolicyStatements: [transferLambdaPolicy],
        xray: true,
        logs: { retention: 30 },
        env: {
          variables: {
            SSM_GCP_CONFIG: args.gcpConfigParam.name,
          },
        },
      },
      { parent: this },
    );
    this.otpLambda = new GoLambda(
      `${name}-OtpAuth`,
      {
        tags: args.meta.tags,
        source: {
          code: "../bin/authorizer-otp.zip",
          hash: HashFolder("../code/authorizer-otp/"),
        },
        architecture: Arch.arm,
        rolePolicyStatements: [otpAuthLambdaPolicy],
        xray: true,
        logs: { retention: 30 },
        env: {
          variables: {
            SSM_PREFIX_PATH: `/isha/${pulumi.getStack()}/otp`,
          },
        },
      },
      { parent: this },
    );

    this.registerOutputs({
      transferLambda: this.transferLambda,
      otpLambda: this.otpLambda,
    });
  }
}
