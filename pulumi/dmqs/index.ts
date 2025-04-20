import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { DmqMakerLambda } from "./makerLambda";
import { ApiGatewayRoute } from "../components/apiGateway";

export interface DMQsProps {
  codeBucket: aws.s3.BucketV2;
  apiAuthorizer: aws.lambda.Function;
}

export class DMQs extends pulumi.ComponentResource {
  public readonly routes: ApiGatewayRoute[];

  constructor(
    name: string,
    args: DMQsProps,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("fidifis:components:DMQ", name, {}, opts);

    const makerLambda = new DmqMakerLambda(
      `${name}-MakerLambda`,
      { codeBucket: args.codeBucket },
      { parent: this },
    );

    this.routes = [
      {
        path: "/unstable/v1/make",
        method: "POST",
        eventHandler: makerLambda.lambda,
        authorizer: args.apiAuthorizer,
      },
    ];

    this.registerOutputs({
      routes: this.routes,
    });
  }
}
