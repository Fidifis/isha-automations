import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ApiGatewayRoute } from "../components/apiGateway";
import { GoLambda } from "../components/lambda";
import { MetaProps } from "../utils";
import * as make from "./make";

export interface DMQsProps {
  meta: MetaProps;
  codeBucket: aws.s3.BucketV2;
  procFilesBucket: aws.s3.BucketV2;
  assetsBucket: aws.s3.BucketV2;
  gcpConfigParam: aws.ssm.Parameter;
  sparkLambda: GoLambda;
  otpLambda: GoLambda;
  sparkApiGwExec: aws.iam.Role;
  sfnExec: aws.iam.Role;
}

export class DMQs extends pulumi.ComponentResource {
  public readonly routes: ApiGatewayRoute[];

  constructor(
    name: string,
    args: DMQsProps,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("project:components:DMQ", name, {}, opts);

    const makeOut = make.create(this, `${name}-Make`, args);
    this.routes = makeOut.routes;

    this.registerOutputs({
      routes: this.routes,
    });
  }
}
