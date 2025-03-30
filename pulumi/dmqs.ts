import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as apigateway from "@pulumi/aws-apigateway";
import { DmqMakerLambda } from "./makerLambda";

export class DMQs extends pulumi.ComponentResource {
  constructor(
    name: string,
    args: { codeBucket: aws.s3.BucketV2 },
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("pkg:index:DMQ", name, {}, opts);

    const makerLambda = new DmqMakerLambda(
      `${name}-MakerLambda`,
      { codeBucket: args.codeBucket },
      { parent: this },
    );

    new apigateway.RestAPI(
      `${name}-Api`,
      {
        routes: [
          {
            path: "/unstable/v1/make",
            method: "POST",
            eventHandler: makerLambda.lambda,
          },
        ],
      },
      { parent: this },
    );

    this.registerOutputs();
  }
}
