import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { Input } from "@pulumi/pulumi";

export interface ApiGatewayRoute {
  path: Input<string>;
  method?: Input<string>;
  eventHandler: aws.lambda.Function | aws.sfn.StateMachine;
  stateMachineStartSync?: Input<boolean>;
  execRole?: aws.iam.Role;
  authorizer?: aws.lambda.Function;
}

export interface ApiKey {
  name: string;
  customValue?: Input<string>;
}

export interface UsagePlan {
  name: string;
  apiKeys: ApiKey[];
  throttle?: Input<aws.types.input.apigateway.UsagePlanThrottleSettings>;
  quota?: Input<aws.types.input.apigateway.UsagePlanQuotaSettings>;
}

export interface ApiGatewayProps {
  name?: Input<string>;
  tags: aws.Tags;
  description?: Input<string>;
  routes: ApiGatewayRoute[];
  domain?: Input<string>;
  edge?: Input<boolean>;
  xray?: Input<boolean>;
  stage?: {
    name?: Input<string>;
    autoDeployEnabled?: Input<boolean>;
  };
  authorizer?: aws.lambda.Function;
  usagePlans?: UsagePlan[];
}

export default class RestApiGateway extends pulumi.ComponentResource {
  public readonly apiGateway: aws.apigateway.RestApi;
  public readonly deployment: aws.apigateway.Deployment;
  public readonly stage: aws.apigateway.Stage;

  constructor(
    name: string,
    args: ApiGatewayProps,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("fidifis:aws:RestApiGateway", name, {}, opts);

    this.apiGateway = new aws.apigateway.RestApi(
      name,
      {
        name: args.name,
        description: args.description,
        tags: args.tags,
        endpointConfiguration: {
          types: args.edge ? "EDGE" : "REGIONAL",
          ipAddressType: "dualstack",
        },
      },
      { parent: this },
    );

    let globalAuthorizer: aws.apigateway.Authorizer | undefined;
    if (args.authorizer) {
      const { apiAuthorizer } = this.CreateAuthorizer(
        name,
        "global",
        args.authorizer,
      );
      globalAuthorizer = apiAuthorizer;
    }

    let apiKeyActive = false;

    args.usagePlans?.forEach((planProp) => {
      if (planProp.apiKeys.length != 0) {
        apiKeyActive = true;
        return;
      }
    });

    let methods: aws.apigateway.Method[] = [];
    let integrations: aws.apigateway.Integration[] = [];

    let madeResources = new Map<string, pulumi.Output<string>>();
    args.routes.forEach((route, index) => {
      const method = route.method ?? "POST";
      const pathParts = route.path
        .toString()
        .split("/")
        .filter((part) => part !== "");

      let currentResource: pulumi.Output<string> =
        this.apiGateway.rootResourceId;
      let resourcePath = "";

      // Create nested resources for path segments
      pathParts.forEach((part, partIndex) => {
        resourcePath += `/${part}`;
        if (madeResources.has(resourcePath)) {
          currentResource = madeResources.get(resourcePath)!;
          return;
        }
        const resourceName = `${name}-Res-${index}-${partIndex}`;

        const resource = new aws.apigateway.Resource(
          resourceName,
          {
            restApi: this.apiGateway.id,
            parentId: currentResource,
            pathPart: part,
          },
          { parent: this },
        );

        currentResource = resource.id;
        madeResources.set(resourcePath, resource.id);
      });

      // Create authorizer if needed
      let authorizer: aws.apigateway.Authorizer | null =
        globalAuthorizer ?? null;
      if (route.authorizer) {
        const { apiAuthorizer } = this.CreateAuthorizer(
          name,
          index.toString(),
          route.authorizer,
        );
        authorizer = apiAuthorizer;
      }

      // Create method
      const apiMethod = new aws.apigateway.Method(
        `${name}-Method-${index}`,
        {
          restApi: this.apiGateway.id,
          resourceId: currentResource,
          httpMethod: method,
          authorization: authorizer ? "CUSTOM" : "NONE",
          authorizerId: authorizer?.id,
          apiKeyRequired: apiKeyActive,
        },
        { parent: this },
      );
      methods.push(apiMethod);

      const methodResponse = new aws.apigateway.MethodResponse(
        `${name}-MethodResp-${index}`,
        {
          restApi: this.apiGateway,
          resourceId: currentResource,
          httpMethod: apiMethod.httpMethod,
          statusCode: "200",
        },
      );

      // Create integration
      const integrationConfig =
        route.eventHandler instanceof aws.sfn.StateMachine
          ? {
              type: "AWS",
              integrationHttpMethod: "POST",
              uri: pulumi.interpolate`arn:aws:apigateway:${aws.getRegionOutput().name}:states:action/${route.stateMachineStartSync ? "StartSyncExecution" : "StartExecution"}`,
              credentials: route.execRole?.arn,
              requestTemplates: {
                "application/json": pulumi.jsonStringify({
                  input: "$util.escapeJavaScript($input.json('$'))",
                  stateMachineArn: route.eventHandler.arn,
                }),
              },
            }
          : {
              type: "AWS_PROXY",
              integrationHttpMethod: "POST",
              uri: route.eventHandler.invokeArn,
            };

      const integration = new aws.apigateway.Integration(
        `${name}-Integration-${index}`,
        {
          restApi: this.apiGateway.id,
          resourceId: currentResource,
          httpMethod: methodResponse.httpMethod,
          ...integrationConfig,
        },
        { parent: this },
      );
      integrations.push(integration);

      new aws.apigateway.IntegrationResponse(
        `${name}-IntegrationResp-${index}`,
        {
          restApi: this.apiGateway.id,
          resourceId: currentResource,
          httpMethod: integration.httpMethod,// NOTE: All the dependencies here and around, are to create good dependency tree for correct deploy order.
          statusCode: methodResponse.statusCode,
        },
      );

      if (route.eventHandler instanceof aws.lambda.Function) {
        new aws.lambda.Permission(
          `${name}-Permission-${index}`,
          {
            action: "lambda:InvokeFunction",
            function: route.eventHandler.name,
            principal: "apigateway.amazonaws.com",
            sourceArn: pulumi.interpolate`${this.apiGateway.executionArn}/*`,
          },
          { parent: this },
        );
      }
    });

    this.deployment = new aws.apigateway.Deployment(
      `${name}-Deployment`,
      {
        restApi: this.apiGateway.id,
        description: "Deployment for REST API",
      },
      {
        parent: this,
        dependsOn: [...methods, ...integrations],
      },
    );

    // Create stage
    this.stage = new aws.apigateway.Stage(
      `${name}-Stage`,
      {
        restApi: this.apiGateway.id,
        deployment: this.deployment.id,
        stageName: args.stage?.name ?? "api",
        tags: args.tags,
        xrayTracingEnabled: args.xray,
      },
      { parent: this },
    );

    args.usagePlans?.forEach((planProp) => {
      const plan = new aws.apigateway.UsagePlan(
        `${name}-${planProp.name}`,
        {
          tags: args.tags,
          apiStages: [
            {
              apiId: this.apiGateway.id,
              stage: this.stage.stageName,
            },
          ],
          throttleSettings: planProp.throttle,
          quotaSettings: planProp.quota,
        },
        { parent: this },
      );

      planProp.apiKeys.forEach((apiKeyProp) => {
        const apiKey = new aws.apigateway.ApiKey(
          `${name}-${planProp.name}-${apiKeyProp.name}`,
          {
            tags: args.tags,
            value: apiKeyProp.customValue,
          },
          { parent: this },
        );

        new aws.apigateway.UsagePlanKey(
          `${name}-${planProp.name}-${apiKeyProp.name}`,
          {
            keyId: apiKey.id,
            usagePlanId: plan.id,
            keyType: "API_KEY",
          },
          { parent: this },
        );
      });
    });

    // Handle custom domain if provided
    if (args.domain) {
      const certificate = new aws.acm.Certificate(
        `${name}-Certificate`,
        {
          domainName: args.domain,
          validationMethod: "DNS",
          tags: args.tags,
        },
        { parent: this },
      );

      const domain = new aws.apigateway.DomainName(
        `${name}-Domain`,
        {
          domainName: args.domain,
          regionalCertificateArn: args.edge ? undefined : certificate.arn,
          certificateArn: args.edge ? certificate.arn : undefined,
          endpointConfiguration: {
            types: args.edge ? "EDGE" : "REGIONAL",
            ipAddressType: "dualstack",
          },
          tags: args.tags,
        },
        { parent: this },
      );

      new aws.apigateway.BasePathMapping(
        `${name}-Mapping`,
        {
          restApi: this.apiGateway.id,
          stageName: this.stage.stageName,
          domainName: domain.domainName,
        },
        { parent: this },
      );
    }

    this.registerOutputs({
      apiGateway: this.apiGateway,
      deployment: this.deployment,
      stage: this.stage,
    });
  }

  private CreateAuthorizer(
    namePre: string,
    namePost: string,
    authorizerFn: aws.lambda.Function,
  ) {
    const apiAuthorizer = new aws.apigateway.Authorizer(
      `${namePre}-Authorizer-${namePost}`,
      {
        name: `${namePre}-authorizer-${namePost}`,
        restApi: this.apiGateway.id,
        authorizerUri: authorizerFn.invokeArn,
        type: "REQUEST",
        identitySource: "method.request.header.Authorization",
      },
      { parent: this },
    );

    // Permission for authorizer
    const authorizerPermission = new aws.lambda.Permission(
      `${namePre}-AuthPermission-${namePost}`,
      {
        action: "lambda:InvokeFunction",
        function: authorizerFn.name,
        principal: "apigateway.amazonaws.com",
        sourceArn: pulumi.interpolate`${this.apiGateway.executionArn}/*`,
      },
      { parent: this },
    );

    return { apiAuthorizer, authorizerPermission };
  }
}
