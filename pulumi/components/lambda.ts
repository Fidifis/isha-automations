import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
// import * as lambdaBuilders from "@pulumi/lambda-builders";
import { Input } from "@pulumi/pulumi";

export interface GoLambdaProps {
  source: {
    code?: Input<string>;
    s3Key?: Input<string>;
    s3Bucket?: aws.s3.BucketV2;
  }
  name?: Input<string>;
  handler?: Input<string>;
  timeout?: Input<number>;
  memory?: Input<number>;
  architecture?: Input<string>;
  reservedConcurrency?: Input<number>;
  logs?: {
    retention?: Input<number>;
  };
  roleInlinePolicies?: Input<aws.types.input.iam.RoleInlinePolicy>[];
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
    super("fidifis:automations:MakerLambda", name, {}, opts);

    const lambdaName = `${pulumi.getProject()}-${pulumi.getStack()}-${args.name ?? name}`;

     this.logGroup = new aws.cloudwatch.LogGroup(
      `${name}-Log`,
      {
        name: `/aws/lambda/${lambdaName}`,
        retentionInDays: args.logs?.retention ?? 30,
      },
      { parent: this },
    );

    const assumeLambda = aws.iam.getPolicyDocumentOutput({
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
    },{parent: this});
    const policy = aws.iam.getPolicyDocumentOutput({
      statements: [
        {
          effect: "Allow",
          actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
          resources: [this.logGroup.arn, `${this.logGroup.arn}:*`],
        },
      ],
    }, {parent: this});
    this.role = new aws.iam.Role(
      `${name}-ExecRole`,
      {
        assumeRolePolicy: assumeLambda.json,
        inlinePolicies: [
          {
            name: "CloudWatch-logging",
            policy: policy.json,
          },
          ...(args.roleInlinePolicies ?? []),
        ],
      },
      { parent: this },
    );

    // const builder = lambdaBuilders.buildGoOutput({
    //   code: args.code,
    //   architecture: args.architecture,
    // }, {parent: this})

    this.lambda = new aws.lambda.Function(
      `${name}-Lambda`,
      {
        // code: builder.asset,
        code: args.source.code,
        s3Bucket: args.source.s3Bucket?.id,
        s3Key: args.source.s3Key,
        name: lambdaName,
        role: this.role.arn,
        reservedConcurrentExecutions: args.reservedConcurrency,
        handler: args.handler ?? "lambda",
        runtime: aws.lambda.Runtime.CustomAL2023,
        timeout: args.timeout,
        memorySize: args.memory,
        architectures: args.architecture ? [args.architecture] : undefined
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
