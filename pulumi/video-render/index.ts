import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ApiGatewayRoute } from "../components/apiGateway";
import { Arch, GoLambda } from "../components/lambda";

export interface VideoRenderProps {
  codeBucket: aws.s3.BucketV2;
  procFilesBucket: aws.s3.BucketV2;
  apiAuthorizer: aws.lambda.Function;
  gcpConfigParam: aws.ssm.Parameter;
}

export default class VideoRender extends pulumi.ComponentResource {
  public readonly routes: ApiGatewayRoute[];

  constructor(
    name: string,
    args: VideoRenderProps,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("fidifis:components:video-render", name, {}, opts);

    const lambdaPolicy = {
      name: "AccessSSM",
      policy: aws.iam.getPolicyDocumentOutput(
        {
          statements: [
            {
              actions: ["ssm:GetParameter"],
              resources: [
                args.gcpConfigParam.arn,
              ],
            },
            {
              actions: ["s3:PutObject"],
              resources: [
                args.procFilesBucket.arn,
                pulumi.interpolate`${args.procFilesBucket.arn}/*`,
              ],
            },
          ],
        },
        { parent: this },
      ).json,
    };

    const lambda = new GoLambda(`${name}-Lambda`, {
      source: {
        s3Bucket: args.codeBucket,
        s3Key: "video-copy-in.zip",
      },
      architecture: Arch.arm,
      logs: { retention: 14 },
      env: {
        variables: {
          SSM_GCP_CONFIG: args.gcpConfigParam.name,
          BUCKET_NAME: args.procFilesBucket.id,
          BUCKET_KEY: "video-render",
        },
      },
      roleInlinePolicies: [lambdaPolicy],
      reservedConcurrency: 20,
      timeout: 300
    }, {parent: this});

    this.routes = [
      {
        path: "/unstable/v1/process/reel",
        method: "POST",
        eventHandler: lambda.lambda,
        authorizer: args.apiAuthorizer,
      },
    ];

    this.registerOutputs({
      routes: this.routes,
    });
  }
}
