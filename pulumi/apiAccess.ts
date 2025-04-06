import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as random from "@pulumi/random";
import { GoLambda } from "./components/lambda";

export interface ApiAccessProps {
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

    const apiAuthorizer = new GoLambda(name, {
      source: {
        s3Bucket: args.codeBucket,
        s3Key: "authorizer-psk.zip",
      },
      handler: "authorizer-psk",
      logs: { retention: 14 },
      env: {
        variables: {
          SSM_LOOKUP_PATH: "/isha/auth",
        },
      },
    }, {parent:this});

    args.keys.forEach((element) => {
      this.apiKeyParam(element);
    });

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
        overrideSpecial: "$-_.+!*'();/?:@=&",
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
      { parent: this },
    );
  }
}
