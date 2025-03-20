import * as aws from "@pulumi/aws";
import { FileArchive } from "@pulumi/pulumi/asset";

export class MakerLambda {
  public readonly lambda: aws.lambda.Function;

  constructor(accountId: string) {
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
    const policy = aws.iam.getPolicyDocument({
      statements: [
        {
          effect: "Allow",
          actions: [
            "logs:CreateLogStream",
            "logs:PutLogEvents",
          ],
          resources: [
            `arn:aws:logs:eu-north-1:${accountId}:log-group:/aws/lambda/*`,
          ],
        },
      ],
    });
    const iamForLambda = new aws.iam.Role("dmq_maker_exec", {
      name: "DMQMaker-exec",
      assumeRolePolicy: assumeLambda.then((assumeRole) => assumeRole.json),
      inlinePolicies: [
        {
          name: "ano",
          policy: policy.then((x) => x.json),
        },
      ],
    });

    this.lambda = new aws.lambda.Function("dmq_maker_lambda", {
      code: new FileArchive("../code/bin/package.zip"),
      name: "DMQMaker",
      role: iamForLambda.arn,
      handler: "Lambda",
      runtime: aws.lambda.Runtime.Dotnet8,
      timeout: 30,
      memorySize: 512,
    });
  }
}
