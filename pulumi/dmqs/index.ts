import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { DmqMakerLambda } from "./makerLambda";
import ApigatewayV2 from "../components/apiGateway";

export interface DMQsProps {
  codeBucket: aws.s3.BucketV2;
  apiAuthorizer: aws.lambda.Function;
}

export class DMQs extends pulumi.ComponentResource {
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

    new ApigatewayV2(
      `${name}-Api`,
      {
        routes: [
          {
            path: "/unstable/v1/make",
            method: "POST",
            eventHandler: makerLambda.lambda,
            authorizer: args.apiAuthorizer,
          },
        ],
      },
      { parent: this },
    );

    // new apigateway.RestAPI(
    //   `${name}-Api`,
    //   {
    //     routes: [
    //       {
    //         path: "/unstable/v1/make",
    //         method: "POST",
    //         eventHandler: makerLambda.lambda,
    //       },
    //     ],
    //   },
    //   { parent: this },
    // );

    this.registerOutputs();
  }
}
