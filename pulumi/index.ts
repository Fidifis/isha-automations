import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { DMQs } from "./dmqs";
import * as utils from "./utils";
import ApiAccess from "./apiAccess";
import * as fs from "fs";

async function main() {
  const meta = {
    accountId: (await aws.getCallerIdentity({})).accountId,
    region: (await aws.getRegion()).id,
  };

  const codeBucket = new aws.s3.BucketV2("LambdaCode", {
    bucket: `${pulumi.getProject()}-${pulumi.getStack()}-lambda-code`,
  });
  utils.addS3BasicRules("LambdaCodeRules", codeBucket);

  new aws.ssm.Parameter(
    "GCPAccessConfig",
    {
      name: `/isha/gcp-fed/lib-config`,
      description: `Client library config file for GCP federation to impersonate Google service account`,
      type: aws.ssm.ParameterType.String,
      value: fs.readFileSync("./clientLibConfig.json", "utf8")
    },
  );

  const apiAccessRes = new ApiAccess("ApiAuthorizerPSK", {
    codeBucket,
    keys: ["GR/cz"],
    meta,
  });

  new DMQs("DMQs", { codeBucket, apiAuthorizer: apiAccessRes.apiAuthorizer });
}

main();
