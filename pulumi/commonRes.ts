import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as fs from "fs";
import * as utils from "./utils";
import { Arch, GoLambda } from "./components/lambda";

export default class CommonRes extends pulumi.ComponentResource {
  public readonly codeBucket: aws.s3.BucketV2;
  public readonly procFilesBucket: aws.s3.BucketV2;
  public readonly gcpConfigParam: aws.ssm.Parameter;
  public readonly rngLambda: GoLambda;

  constructor(name: string, tags: utils.Tags, opts?: pulumi.ComponentResourceOptions) {
    super("project:components:CommonRes", name, {}, opts);

    this.codeBucket = new aws.s3.BucketV2("LambdaCode", {
      bucket: `${pulumi.getProject()}-${pulumi.getStack()}-lambda-code`,
      tags,
    }, { parent: this });
    utils.addS3BasicRules("LambdaCodeRules", this.codeBucket);

    this.procFilesBucket = new aws.s3.BucketV2("ProcFiles", {
      tags,
    }, { parent: this });
    utils.addS3BasicRules("ProcFilesRules", this.procFilesBucket, {
      noLifecycle: true,
    });
    new aws.s3.BucketLifecycleConfigurationV2("ProcFilesLifecycle", {
      bucket: this.procFilesBucket.id,
      rules: [
        {
          id: "DeleteOldFiles",
          status: "Enabled",
          expiration: {
            days: 1,
          },
        },
        ...utils.bucketCommonLifecycleRules,
      ],
    }, { parent: this });

    this.gcpConfigParam = new aws.ssm.Parameter("GCPAccessConfig", {
      name: `/isha/${pulumi.getStack()}/gcp-fed/lib-config`,
      description:
        "Client library config file for GCP federation to impersonate Google service account",
      type: aws.ssm.ParameterType.String,
      value: fs.readFileSync("./clientLibConfig.json", "utf8"),
      tags
    }, { parent: this });

    this.rngLambda = new GoLambda(
      "RNG",
      {
        tags,
        source: {
          s3Bucket: this.codeBucket,
          s3Key: "rng.zip",
        },
        architecture: Arch.arm,
        logs: { retention: 7 },
      },
      { parent: this },
    );

    this.registerOutputs({
      codeBucket: this.codeBucket,
      procFilesBucket: this.procFilesBucket,
      gcpConfigParam: this.gcpConfigParam,
    });
  }
}
