import * as aws from "@pulumi/aws";
import { FileArchive } from "@pulumi/pulumi/asset";

export class MakerLambda {
  public readonly lambda: aws.lambda.Function;

  constructor(s3Bucket: aws.s3.BucketV2) {
    const lambdaName = "DMQMaker";

    const logGroup = new aws.cloudwatch.LogGroup("dmq_log_group", {
      name: `/aws/lambda/${lambdaName}`,
      retentionInDays: 30,
    });

    const assumeLambda = aws.iam.getPolicyDocument({
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
    const policy = logGroup.arn.apply((logGroupArn) =>
      aws.iam.getPolicyDocument({
        statements: [
          {
            effect: "Allow",
            actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
            resources: [logGroupArn, `${logGroupArn}:*`],
          },
        ],
      }),
    );
    const execRole = new aws.iam.Role("dmq_maker_exec", {
      name: "DMQMaker-exec",
      assumeRolePolicy: assumeLambda.then((assumeRole) => assumeRole.json),
      inlinePolicies: [
        {
          name: "CloudWatch-logging",
          policy: policy.apply((x) => x.json),
        },
      ],
    });

    this.lambda = new aws.lambda.Function("dmq_maker_lambda", {
      //code: new FileArchive("../code/bin/package.zip"),
      s3Bucket: s3Bucket.id,
      s3Key: "dmq-maker.zip",
      name: lambdaName,
      role: execRole.arn,
      reservedConcurrentExecutions: 5,
      handler: "Lambda",
      runtime: aws.lambda.Runtime.Dotnet8,
      timeout: 30,
      memorySize: 512,
    });
  }
}
