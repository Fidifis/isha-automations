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
  public readonly rngLambda: GoLambda;
  public readonly sparkLambda: GoLambda;

  constructor(name: string, tags: aws.Tags, opts?: pulumi.ComponentResourceOptions) {
    super("project:components:CommonRes", name, {}, opts);

    this.codeBucket = new aws.s3.BucketV2("LambdaCode", {
      bucket: `${pulumi.getProject()}-${pulumi.getStack()}-lambda-code`,
      tags,
    }, { parent: this });
    utils.addS3BasicRules("LambdaCodeRules", this.codeBucket);

    this.assetsBucket = new aws.s3.BucketV2("Assets", {
      tags,
    }, { parent: this });
    utils.addS3BasicRules("AssetsRules", this.assetsBucket);

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
            prefix: "video-render/download/"
          },
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
          code: "../bin/rng.zip",
          hash: HashFolder("../code/rng/"),
        },
        architecture: Arch.arm,
        logs: { retention: 7 },
      },
      { parent: this },
    );

    this.sparkLambda = new GoLambda(
      "Spark",
      {
        tags,
        source: {
          code: "../bin/spark.zip",
          hash: HashFolder("../code/spark/"),
        },
        architecture: Arch.arm,
        xray: true,
        logs: { retention: 30 },
        env: {
          variables: {
            ID_LEN: "8"
          },
        },
      },
      { parent: this },
    );

    new aws.resourcegroups.Group("ResourceGroup", {
      resourceQuery: {
        query: JSON.stringify({
          ResourceTypeFilters: ["AWS::AllSupported"],
          TagFilters: Object.entries(tags).map(([key, value]) => ({
            Key: key,
            Values: [value]
          }))
        })
      },
    });

    this.registerOutputs({
      codeBucket: this.codeBucket,
      assetsBucket: this.assetsBucket,
      procFilesBucket: this.procFilesBucket,
      gcpConfigParam: this.gcpConfigParam,
      rngLambda: this.rngLambda,
      sparkLambda: this.sparkLambda,
    });
  }
}
