import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export interface DmqMakerLambdaProps {
  codeBucket: aws.s3.BucketV2;
  tags: aws.Tags;
}

export class DmqMakerLambda extends pulumi.ComponentResource {
  public readonly lambda: aws.lambda.Function;
  public readonly role: aws.iam.Role;

  constructor(
    name: string,
    args: DmqMakerLambdaProps,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("project:components:MakerLambda", name, {}, opts);

    const lambdaName = `${pulumi.getProject()}-${pulumi.getStack()}-${name}`;

    const logGroup = new aws.cloudwatch.LogGroup(
      `${name}-Log`,
      {
        name: `/aws/lambda/${lambdaName}`,
        tags: args.tags,
        retentionInDays: 30,
      },
      { parent: this },
    );

    const assumeLambda = aws.iam.getPolicyDocumentOutput(
      {
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
      },
      { parent: this },
    );
    const policy = aws.iam.getPolicyDocumentOutput(
      {
        statements: [
          {
            effect: "Allow",
            actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
            resources: [logGroup.arn, pulumi.interpolate`${logGroup.arn}:*`],
          },
        ],
      },
      { parent: this },
    );
    this.role = new aws.iam.Role(
      `${name}-ExecRole`,
      {
        tags: args.tags,
        assumeRolePolicy: assumeLambda.json,
        inlinePolicies: [
          {
            name: "CloudWatch-logging",
            policy: policy.json,
          },
        ],
      },
      { parent: this },
    );

    this.lambda = new aws.lambda.Function(
      `${name}`,
      {
        tags: args.tags,
        s3Bucket: args.codeBucket.id,
        s3Key: "dmq-maker.zip",
        name: lambdaName,
        role: this.role.arn,
        reservedConcurrentExecutions: 5,
        handler: "Lambda",
        runtime: aws.lambda.Runtime.Dotnet8,
        timeout: 30,
        memorySize: 512,
      },
      { parent: this },
    );

    this.registerOutputs({
      lambda: this.lambda,
    });
  }
}
