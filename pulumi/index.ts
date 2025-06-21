import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { DMQs } from "./dmqs";
import ApiAccess from "./apiAccess";
import RestApiGateway from "./components/apiGateway";
import ApiGatewayV2 from "./components/apiGatewayV2";
import VideoRender from "./video-render";
import CommonRes from "./commonRes";
import HelperLambda from "./helperLambda";
import { MetaProps } from "./utils";

interface ConfigDomains {
  api: string
}

async function main() {
  const config = new pulumi.Config();
  const domains = config.requireObject<ConfigDomains>("domains")

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
  } = new CommonRes("CommonRes", tags);

  const { apiAuthorizer } = new ApiAccess("ApiAuthorizerPSK", {
    codeBucket,
    keys: ["GR/cz"],
    meta,
  });

  const helperLambda = new HelperLambda("Helper", {
    meta,
    codeBucket,
    procFilesBucket,
    gcpConfigParam,
  })

  const dmqs = new DMQs("DMQs", {
    meta,
    codeBucket,
    assetsBucket,
    procFilesBucket,
    rng: rngLambda.lambda,
    gcpConfigParam,
  });
  const videoRender = new VideoRender("VideoRender", {
    meta,
    codeBucket,
    assetsBucket,
    procFilesBucket,
    rng: rngLambda.lambda,
    gcpConfigParam,
    fileTranferLambda: helperLambda.transferLambda.lambda,
  });

  new RestApiGateway(`rest-Api`, {
    tags,
    authorizer: apiAuthorizer,
    domain: domains.api,
    routes: [...videoRender.routes, ...dmqs.routes],
  });
}

main();
