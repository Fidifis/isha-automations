import * as aws from "@pulumi/aws";
import { FileArchive } from "@pulumi/pulumi/asset";

export class MakerLambda {
  public readonly lambda: aws.lambda.Function;

  constructor() {
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
    const policy = logGroup.arn.apply((logGroupArn) => aws.iam.getPolicyDocument({
      statements: [
        {
          effect: "Allow",
          actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
          resources: [ logGroupArn ],
        },
      ],
    }));
    const execRole = new aws.iam.Role("dmq_maker_exec", {
      name: "DMQMaker-exec",
      assumeRolePolicy: assumeLambda.then((assumeRole) => assumeRole.json),
      inlinePolicies: [
        {
          name: "ano",
          policy: policy.apply(x => x.json)
        },
      ],
    });

    this.lambda = new aws.lambda.Function("dmq_maker_lambda", {
      code: new FileArchive("../code/bin/package.zip"),
      name:lambdaName,
      role: execRole.arn,
      handler: "Lambda",
      runtime: aws.lambda.Runtime.Dotnet8,
      timeout: 30,
      memorySize: 512,
    });
  }
}
