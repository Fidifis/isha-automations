import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { Input } from "@pulumi/pulumi";

export interface ApiGatewayV2Props {
  name?: Input<string>;
  description?: Input<string>;
  routes: {
    path: Input<string>;
    method?: Input<string>;
    eventHandler: aws.lambda.Function;
    authorizer?: aws.lambda.Function;
    payloadFormatVersion?: Input<string>;
  }[];
  corsConfig?: {
    allowOrigins: Input<Input<string>[]>;
    allowMethods: Input<Input<string>[]>;
    allowHeaders?: Input<Input<string>[]>;
    exposeHeaders?: Input<Input<string>[]>;
    maxAge?: Input<number>;
    allowCredentials?: Input<boolean>;
  };
  stage?: {
    name?: Input<string>;
    autoDeployEnabled?: Input<boolean>;
  };
  tags?: { [key: string]: Input<string> };
}

export default class ApiGatewayV2 extends pulumi.ComponentResource {
  public readonly apiGateway: aws.apigatewayv2.Api;
  public readonly stage: aws.apigatewayv2.Stage;
  public readonly integrations: aws.apigatewayv2.Integration[] = [];
  public readonly routes: aws.apigatewayv2.Route[] = [];
  public readonly permissions: aws.lambda.Permission[] = [];
  public readonly authorizers: aws.apigatewayv2.Authorizer[] = [];

  constructor(
    name: string,
    args: ApiGatewayV2Props,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("fidifis:aws:ApiGatewayV2", name, {}, opts);

    this.apiGateway = new aws.apigatewayv2.Api(
      `${name}-Api`,
      {
        protocolType: "HTTP",
        name: args.name,
        description: args.description,
        corsConfiguration: args.corsConfig
          ? {
              allowOrigins: args.corsConfig.allowOrigins,
              allowMethods: args.corsConfig.allowMethods,
              allowHeaders: args.corsConfig.allowHeaders,
              exposeHeaders: args.corsConfig.exposeHeaders,
              maxAge: args.corsConfig.maxAge,
              allowCredentials: args.corsConfig.allowCredentials || false,
            }
          : undefined,
        tags: args.tags,
      },
      { parent: this },
    );

    this.stage = new aws.apigatewayv2.Stage(
      `${name}-Stage`,
      {
        apiId: this.apiGateway.id,
        name: args.stage?.name ?? "$default",
        autoDeploy: args.stage?.autoDeployEnabled ?? true,
        tags: args.tags,
      },
      { parent: this },
    );

    args.routes.forEach((route, index) => {
      const integration = new aws.apigatewayv2.Integration(
        `${name}-integration-${index}`,
        {
          apiId: this.apiGateway.id,
          integrationType: "AWS_PROXY",
          integrationMethod: route.method ?? "GET",
          integrationUri: route.eventHandler.invokeArn,
          payloadFormatVersion: route.payloadFormatVersion ?? "2.0",
        },
        { parent: this },
      );
      this.integrations.push(integration);

      const authorizer = route.authorizer ? new aws.apigatewayv2.Authorizer(
        `${name}-authorizer-${index}`,
        {
          apiId: this.apiGateway.id,
          authorizerType: "REQUEST",
          authorizerUri: route.authorizer.invokeArn,
          authorizerPayloadFormatVersion: "2.0",
          enableSimpleResponses: true,
        },
        { parent: this },
      ) : null;
      if (authorizer) {
          this.authorizers.push(authorizer);
      }

      const apiRoute = new aws.apigatewayv2.Route(
        `${name}-route-${index}`,
        {
          apiId: this.apiGateway.id,
          routeKey:
            route.path === "$default"
              ? route.path
              : `${route.method ?? "GET"} ${route.path}`,
          target: pulumi.interpolate`integrations/${integration.id}`,
          authorizationType: route.authorizer ? "CUSTOM" : "NONE",
          authorizerId: authorizer?.id,
        },
        { parent: this },
      );
      this.routes.push(apiRoute);

      const permission = new aws.lambda.Permission(
        `${name}-permission-${index}`,
        {
          action: "lambda:InvokeFunction",
          function: route.eventHandler.name,
          principal: "apigateway.amazonaws.com",
          sourceArn: pulumi.interpolate`${this.apiGateway.executionArn}/*`,
        },
        { parent: this },
      );
      this.permissions.push(permission);

      const authorizerPermission = route.authorizer ?new aws.lambda.Permission(
        `${name}-authPermission-${index}`,
        {
          action: "lambda:InvokeFunction",
          function: route.authorizer.name,
          principal: "apigateway.amazonaws.com",
          sourceArn: pulumi.interpolate`${this.apiGateway.executionArn}/*`,
        },
        { parent: this },
      ):null;
      if (authorizerPermission) {
        this.permissions.push(authorizerPermission);
      }
    });

    this.registerOutputs({
      apiGateway: this.apiGateway,
      stage: this.stage,
      routes: this.routes,
      integrains: this.integrations,
      premissions: this.permissions,
    });
  }
}
