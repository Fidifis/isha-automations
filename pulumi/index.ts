import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { DMQs } from "./dmqs";
import * as utils from "./utils";
import ApiAccess from "./apiAccess";
import * as fs from "fs";
import ApigatewayV2 from "./components/apiGateway";
import VideoRender from "./video-render";

async function main() {
  const meta = {
    accountId: (await aws.getCallerIdentity({})).accountId,
    region: (await aws.getRegion()).id,
  };

  const codeBucket = new aws.s3.BucketV2("LambdaCode", {
    bucket: `${pulumi.getProject()}-${pulumi.getStack()}-lambda-code`,
  });
  utils.addS3BasicRules("LambdaCodeRules", codeBucket);

  const procFilesBucket = new aws.s3.BucketV2("ProcFiles");
  utils.addS3BasicRules("ProcFilesRules", procFilesBucket);

  const gcpConfigParam = new aws.ssm.Parameter("GCPAccessConfig", {
    name: `/isha/${pulumi.getStack()}/gcp-fed/lib-config`,
    description: `Client library config file for GCP federation to impersonate Google service account`,
    type: aws.ssm.ParameterType.String,
    value: fs.readFileSync("./clientLibConfig.json", "utf8"),
  });

  const apiAccessRes = new ApiAccess("ApiAuthorizerPSK", {
    codeBucket,
    keys: ["GR/cz"],
    meta,
  });

  new DMQs("DMQs", { codeBucket, apiAuthorizer: apiAccessRes.apiAuthorizer });
  const videoRender = new VideoRender("VideoRender", {
    codeBucket,
    procFilesBucket,
    apiAuthorizer: apiAccessRes.apiAuthorizer,
    gcpConfigParam,
  });

  new ApigatewayV2(`prime-Api`, {
    routes: [...videoRender.routes],
  });
}

main();
