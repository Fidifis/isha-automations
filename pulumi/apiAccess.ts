import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as random from "@pulumi/random";
import { Arch, GoLambda } from "./components/lambda";
import { MetaProps } from "./utils";

export interface ApiAccessProps {
  meta: MetaProps;
  codeBucket: aws.s3.BucketV2;
  keys: string[];
}

export default class ApiAccess extends pulumi.ComponentResource {
  public readonly apiAuthorizer: aws.lambda.Function;

  constructor(
    name: string,
    args: ApiAccessProps,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("fidifis:components:ApiAccess", name, {}, opts);

    args.keys.forEach((element) => {
      this.apiKeyParam(element);
    });

    const lambdaPolicy = {
      name: "AccessSSM",
      policy: aws.iam.getPolicyDocumentOutput(
        {
          statements: [
            {
              actions: ["ssm:GetParametersByPath"],
              resources: [
                `arn:aws:ssm:${args.meta.region}:${args.meta.accountId}:parameter/isha/auth`,
                `arn:aws:ssm:${args.meta.region}:${args.meta.accountId}:parameter/isha/auth/*`,
              ],
            },
          ],
        },
        { parent: this },
      ).json,
    };
    const apiAuthorizer = new GoLambda(
      name,
      {
        source: {
          s3Bucket: args.codeBucket,
          s3Key: "authorizer-psk.zip",
        },
        architecture: Arch.arm,
        logs: { retention: 14 },
        env: {
          variables: {
            SSM_LOOKUP_PATH: "/isha/auth",
          },
        },
        roleInlinePolicies: [lambdaPolicy],
        reservedConcurrency: 20,
      },
      { parent: this },
    );

    this.apiAuthorizer = apiAuthorizer.lambda;
    this.registerOutputs({
      apiAuthorizer: this.apiAuthorizer,
    });
  }

  apiKeyParam(keyPath: string) {
    const name = keyPath.replace("/", "-");

    const password = new random.RandomPassword(
      `${name}-password`,
      {
        length: 32,
        special: true,
        overrideSpecial: "-_.+!*'();/?@=&",
      },
      { parent: this },
    );

    return new aws.ssm.Parameter(
      name,
      {
        name: `/isha/auth/${keyPath}`,
        description: `API key for ${keyPath} team`,
        type: aws.ssm.ParameterType.SecureString,
        value: password.result,
      },
      { parent: this, deleteBeforeReplace: true },
    );
  }
}
