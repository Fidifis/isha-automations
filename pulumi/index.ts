import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { DMQs } from "./dmqs";
import * as utils from "./utils"
import { GoLambda } from "./components/lambda"

async function main() {

  const codeBucket = new aws.s3.BucketV2("LambdaCode", {
    bucket: `${pulumi.getProject()}-${pulumi.getStack()}-lambda-code`,
  });
  utils.addS3BasicRules("LambdaCodeRules", codeBucket);
  
  const apiAuthorizer = new GoLambda("ApiAuthorizer", {
    code: "../code/receive_dmq"
  })

  new DMQs("DMQs", { codeBucket });
}

main();
