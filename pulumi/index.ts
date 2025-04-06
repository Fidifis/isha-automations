import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { DMQs } from "./dmqs";
import * as utils from "./utils";
import ApiAccess from "./apiAccess";

async function main() {
  const meta = {
    accountId: (await aws.getCallerIdentity({})).accountId,
    region: (await aws.getRegion()).id,
  };

  const codeBucket = new aws.s3.BucketV2("LambdaCode", {
    bucket: `${pulumi.getProject()}-${pulumi.getStack()}-lambda-code`,
  });
  utils.addS3BasicRules("LambdaCodeRules", codeBucket);

  const apiAccessRes = new ApiAccess("ApiAuthorizerPSK", {
    codeBucket,
    keys: ["GR/cz"],
    meta,
  });

  new DMQs("DMQs", { codeBucket, apiAuthorizer: apiAccessRes.apiAuthorizer });
}

main();
