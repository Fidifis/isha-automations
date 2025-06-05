import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
// import * as lambdaBuilders from "@pulumi/lambda-builders";
import { Input } from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

export enum Arch {
  x86 = "x86_64",
  arm = "arm64",
}

export const AssumePolicy = aws.iam.getPolicyDocumentOutput({
  statements: [
    {
      effect: "Allow",
      principals: [
        {
          type: "Service",
          identifiers: ["lambda.amazonaws.com"],
        },
      ],
      actions: ["sts:AssumeRole"],
    },
  ],
});

export function HashFolder(folderPath: string): string {
  const hash = crypto.createHash("sha256");

  function walk(currentPath: string) {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const content = fs.readFileSync(fullPath);
        hash.update(content);
      }
    }
  }

  walk(folderPath);

  return hash.digest("base64");
}

export interface GoLambdaProps {
  tags: aws.Tags;
  source: {
    code?: Input<string>;
    s3Key?: Input<string>;
    s3Bucket?: aws.s3.BucketV2;
    hash?: Input<string>;
  };
  name?: string;
  handler?: Input<string>;
  timeout?: Input<number>;
  memory?: Input<number>;
  architecture?: Arch;
  reservedConcurrency?: Input<number>;
  logs?: {
    retention?: Input<number>;
  };
  role?: aws.iam.Role;
  roleInlinePolicies?: Input<aws.types.input.iam.RoleInlinePolicy>[];
  env?: Input<aws.types.input.lambda.FunctionEnvironment>;
  ephemeralStorage?: Input<number>;
  layers?: Input<string>[];
  xray?: boolean;
}

export function constructLambdaName(nameProp: string | GoLambdaProps): string {
  const name = typeof nameProp === "string" ? nameProp : nameProp.name;
  return `${pulumi.getProject()}-${pulumi.getStack()}-${name}`;
}

export class GoLambda extends pulumi.ComponentResource {
  public readonly lambda: aws.lambda.Function;
  public readonly role: aws.iam.Role;
  public readonly logGroup: aws.cloudwatch.LogGroup;

  constructor(
    name: string,
    args: GoLambdaProps,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("fidifis:aws:LambdaGo", name, {}, opts);

    const lambdaName = constructLambdaName(args.name ?? name);

    this.logGroup = new aws.cloudwatch.LogGroup(
      `${name}-Log`,
      {
        name: `/aws/lambda/${lambdaName}`,
        tags: args.tags,
        retentionInDays: args.logs?.retention ?? 30,
      },
      { parent: this },
    );

    const loggingPolicy = {
      name: "CloudWatch-logging",
      policy: aws.iam.getPolicyDocumentOutput(
        {
          statements: [
            {
              actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
              resources: [
                this.logGroup.arn,
                pulumi.interpolate`${this.logGroup.arn}:*`,
              ],
            },
          ],
        },
        { parent: this },
      ).json,
    };
    const xrayPolicy = {
      name: "XRay-metrics",
      policy: aws.iam.getPolicyDocumentOutput(
        {
          statements: [
            {
              actions: ["xray:PutTelemetryRecords", "xray:PutTraceSegments"],
              resources: ["*"],
            },
          ],
        },
        { parent: this },
      ).json,
    };

    if (args.role) {
      this.role = args.role;
    } else {
      this.role = new aws.iam.Role(
        `${name}-ExecRole`,
        {
          tags: args.tags,
          assumeRolePolicy: AssumePolicy.json,
          inlinePolicies: [
            loggingPolicy,
            ...(args.xray ? [xrayPolicy] : []),
            ...(args.roleInlinePolicies ?? []),
          ],
        },
        { parent: this },
      );
    }

    // const builder = lambdaBuilders.buildGoOutput({
    //   code: args.code,
    //   architecture: args.architecture,
    // }, {parent: this})

    this.lambda = new aws.lambda.Function(
      name,
      {
        // code: builder.asset,
        name: lambdaName,
        tags: args.tags,
        code: args.source.code,
        s3Bucket: args.source.s3Bucket?.id,
        s3Key: args.source.s3Key,
        sourceCodeHash: args.source.hash,
        role: this.role.arn,
        reservedConcurrentExecutions: args.reservedConcurrency,
        handler: args.handler ?? "bootstrap",
        runtime: aws.lambda.Runtime.CustomAL2023,
        timeout: args.timeout,
        memorySize: args.memory,
        architectures: args.architecture ? [args.architecture] : undefined,
        environment: args.env,
        tracingConfig: args.xray
          ? {
              mode: "Active",
            }
          : undefined,
        ephemeralStorage: {
          size: args.ephemeralStorage ?? 512,
        },
        layers: args.layers,
      },
      { parent: this },
    );

    this.registerOutputs({
      lambda: this.lambda,
      role: this.role,
      logGroup: this.logGroup,
    });
  }
}
