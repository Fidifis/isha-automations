import * as aws from "@pulumi/aws";
import * as apigateway from "@pulumi/aws-apigateway";
import { MakerLambda } from "./makerLambda"

async function main() {
  //const identity = await aws.getCallerIdentity({});

  const makerLambda = new MakerLambda();

  new apigateway.RestAPI("api", {
    routes: [
      { path: "/unstable/v1/make", method: "POST", eventHandler: makerLambda.lambda },
    ],
  });
}

main();
