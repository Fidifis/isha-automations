import * as aws from "@pulumi/aws";

export interface MetaProps {
  accountId: string;
  region: string;
  tags: aws.Tags;
}

export const bucketCommonLifecycleRules = [
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
];

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
  options?: { noPolicy?: boolean; noLifecycle?: boolean },
) {
  if (!options?.noLifecycle) {
    new aws.s3.BucketLifecycleConfigurationV2(name, {
      bucket: bucket.id,
      rules: bucketCommonLifecycleRules,
    }, {parent: bucket});
  }

  if (!options?.noPolicy) {
    new aws.s3.BucketPolicy(
      name,
      {
        bucket: bucket.id,
        policy: bucket.arn.apply(bucketSecureTransportPolicy).json,
      },
      {
        parent: bucket,
        deleteBeforeReplace: true,
      },
    );
  }
}
