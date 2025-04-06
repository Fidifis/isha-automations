import * as aws from "@pulumi/aws";

export interface MetaProps {
  accountId: string;
  region: string;
}

export const bucketSecureTransportPolicy = (arn: string) =>
  aws.iam.getPolicyDocument({
    statements: [
      {
        principals: [
          {
            type: "*",
            identifiers: ["*"],
          },
        ],
        effect: "Deny",
        actions: ["s3:*"],
        resources: [arn, `${arn}/*`],
        conditions: [
          {
            test: "Bool",
            variable: "aws:SecureTransport",
            values: ["false"],
          },
        ],
      },
      {
        principals: [
          {
            type: "*",
            identifiers: ["*"],
          },
        ],
        effect: "Deny",
        actions: ["s3:*"],
        resources: [arn, `${arn}/*`],
        conditions: [
          {
            test: "NumericLessThan",
            variable: "s3:TlsVersion",
            values: ["1.2"],
          },
        ],
      },
    ],
  });

export function addS3BasicRules(
  name: string,
  bucket: aws.s3.BucketV2,
  options: { policy: boolean } = { policy: true },
) {
  new aws.s3.BucketLifecycleConfigurationV2(name, {
    bucket: bucket.id,
    rules: [
      {
        id: "CommonLifecycle",
        status: "Enabled",
        abortIncompleteMultipartUpload: {
          daysAfterInitiation: 1,
        },
        expiration: {
          expiredObjectDeleteMarker: true,
        },
      },
    ],
  });

  if (options.policy) {
    new aws.s3.BucketPolicy(
      name,
      {
        bucket: bucket.id,
        policy: bucket.arn.apply(bucketSecureTransportPolicy).json,
      },
      {
        deleteBeforeReplace: true,
      },
    );
  }
}
