import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { DMQs } from "./dmqs";
import ApiAccess from "./apiAccess";
import ApigatewayV2 from "./components/apiGateway";
import VideoRender from "./video-render";
import CommonRes from "./commonRes";
import { MetaProps } from "./utils";

async function main() {
  const tags = {
    project: pulumi.getProject(),
    env: pulumi.getStack()
  }
  const meta: MetaProps = {
    accountId: (await aws.getCallerIdentity({})).accountId,
    region: (await aws.getRegion()).id,
    tags,
  };

  const { codeBucket, procFilesBucket, gcpConfigParam, rngLambda } = new CommonRes(
    "CommonRes", tags
  );

  const { apiAuthorizer } = new ApiAccess("ApiAuthorizerPSK", {
    codeBucket,
    keys: ["GR/cz"],
    meta,
  });

  const dmqs = new DMQs("DMQs", {
    tags,
    codeBucket,
    apiAuthorizer: apiAuthorizer,
  });
  const videoRender = new VideoRender("VideoRender", {
    meta,
    codeBucket,
    procFilesBucket,
    rng: rngLambda.lambda,
    apiAuthorizer,
    gcpConfigParam,
  });

  new ApigatewayV2(`prime-Api`, {
    tags,
    routes: [...videoRender.routes, ...dmqs.routes],
  });
}

main();
