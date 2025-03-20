import * as aws from "@pulumi/aws";
import * as apigateway from "@pulumi/aws-apigateway";
import { makerLambda } from "./makerLambda"

const identity = aws.getCallerIdentity({}).then((x) => x);

const api = new apigateway.RestAPI("api", {
  routes: [
    { path: "/unstable/v1/make", method: "POST", eventHandler: makerLambda },
  ],
});
