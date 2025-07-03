import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { DMQs } from "./dmqs";
import RestApiGateway from "./components/apiGateway";
import VideoRender from "./video-render";
import CommonRes from "./commonRes";
import HelperLambda from "./helperLambda";
import { MetaProps } from "./utils";

interface ConfigDomains {
  api: string;
}

const apiUsers = [
  "gr-cz",
  "gr-demo",
];

const usagePlanQuotas = {
  throttle: {
    burstLimit: 10,
    rateLimit: 1,
  },
  quota: {
    limit: 50,
    period: "DAY",
  },
};

async function main() {
  const config = new pulumi.Config();
  const domains = config.requireObject<ConfigDomains>("domains");

  const tags = {
    project: pulumi.getProject(),
    env: pulumi.getStack(),
  };
  const meta: MetaProps = {
    accountId: (await aws.getCallerIdentity({})).accountId,
    region: (await aws.getRegion()).id,
    tags,
  };

  const {
    codeBucket,
    assetsBucket,
    procFilesBucket,
    gcpConfigParam,
    rngLambda,
    sparkLambda,
  } = new CommonRes("CommonRes", tags);

  // const { apiAuthorizer } = new ApiAccess("ApiAuthorizerPSK", {
  //   codeBucket,
  //   keys: ["GR/cz"],
  //   meta,
  // });

  const helperLambda = new HelperLambda("Helper", {
    meta,
    procFilesBucket,
    gcpConfigParam,
  });

  const dmqs = new DMQs("DMQs", {
    meta,
    codeBucket,
    assetsBucket,
    procFilesBucket,
    gcpConfigParam,
    sparkLambda,
    otpLambda: helperLambda.otpLambda,
  });
  const videoRender = new VideoRender("VideoRender", {
    meta,
    codeBucket,
    assetsBucket,
    procFilesBucket,
    rng: rngLambda.lambda,
    gcpConfigParam,
    fileTranferLambda: helperLambda.transferLambda,
  });

  new RestApiGateway(`rest-Api`, {
    tags,
    domain: domains.api,
    xray: true,
    usagePlans: apiUsers.map((user) => {
      return {
        name: user,
        apiKeys: [
          {
            name: user,
          },
        ],
        ...usagePlanQuotas,
      };
    }),

    routes: [...videoRender.routes, ...dmqs.routes],
  });
}

main();
