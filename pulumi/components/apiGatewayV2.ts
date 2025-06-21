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
  payloadFormatVersion?: Input<string>;
}

export interface ApiGatewayProps {
  name?: Input<string>;
  tags: aws.Tags;
  description?: Input<string>;
  routes: ApiGatewayRoute[];
  domain?: Input<string>;
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
}

export default class ApiGatewayV2 extends pulumi.ComponentResource {
  public readonly apiGateway: aws.apigatewayv2.Api;
  public readonly stage: aws.apigatewayv2.Stage;
  public readonly integrations: aws.apigatewayv2.Integration[] = [];
  public readonly routes: aws.apigatewayv2.Route[] = [];
  public readonly permissions: aws.lambda.Permission[] = [];
  public readonly domain?: aws.apigatewayv2.DomainName;
  public readonly certificate?: aws.acm.Certificate;
  private readonly authorizers: aws.apigatewayv2.Authorizer[] = [];

  constructor(
    name: string,
    args: ApiGatewayProps,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("fidifis:aws:ApiGatewayV2", name, {}, opts);

    this.apiGateway = new aws.apigatewayv2.Api(
      name,
      {
        tags: args.tags,
        protocolType: "HTTP",
        name: args.name,
        description: args.description,
        ipAddressType: "dualstack",
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
      const integrationAdditional =
        route.eventHandler instanceof aws.sfn.StateMachine
          ? {
              integrationSubtype: route.stateMachineStartSync
                ? "StepFunctions-StartSyncExecution"
                : "StepFunctions-StartExecution",
              requestParameters: {
                Input: "$request.body",
                StateMachineArn: route.eventHandler.arn,
              },
              payloadFormatVersion: route.payloadFormatVersion ?? "1.0",
            }
          : {
              integrationUri: route.eventHandler.invokeArn,
              payloadFormatVersion: route.payloadFormatVersion ?? "2.0",
              integrationMethod: "POST",
            };
      const integration = new aws.apigatewayv2.Integration(
        `${name}-integration-${index}`,
        {
          apiId: this.apiGateway.id,
          integrationType: "AWS_PROXY",
          credentialsArn: route.execRole?.arn,
          ...integrationAdditional,
        },
        { parent: this },
      );
      this.integrations.push(integration);

      const authorizer = route.authorizer
        ? new aws.apigatewayv2.Authorizer(
            `${name}-authorizer-${index}`,
            {
              apiId: this.apiGateway.id,
              authorizerType: "REQUEST",
              authorizerUri: route.authorizer.invokeArn,
              authorizerPayloadFormatVersion: "2.0",
              enableSimpleResponses: true,
            },
            { parent: this },
          )
        : null;
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
              : `${route.method ?? "POST"} ${route.path}`,
          target: pulumi.interpolate`integrations/${integration.id}`,
          authorizationType: route.authorizer ? "CUSTOM" : "NONE",
          authorizerId: authorizer?.id,
        },
        { parent: this },
      );
      this.routes.push(apiRoute);

      if (route.eventHandler instanceof aws.lambda.Function) {
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
      }

      const authorizerPermission = route.authorizer
        ? new aws.lambda.Permission(
            `${name}-authPermission-${index}`,
            {
              action: "lambda:InvokeFunction",
              function: route.authorizer.name,
              principal: "apigateway.amazonaws.com",
              sourceArn: pulumi.interpolate`${this.apiGateway.executionArn}/*`,
            },
            { parent: this },
          )
        : null;
      if (authorizerPermission) {
        this.permissions.push(authorizerPermission);
      }
    });

    if (args.domain) {
      this.certificate = new aws.acm.Certificate(`${name}-Certificate`, {
        domainName: args.domain,
        validationMethod: "DNS",
      });

      this.domain = new aws.apigatewayv2.DomainName(`${name}-Domain`, {
        domainName: args.domain,
        domainNameConfiguration: {
          certificateArn: this.certificate.arn,
          endpointType: "REGIONAL",
          ipAddressType: "dualstack",
          securityPolicy: "TLS_1_2",
        },
      });

      new aws.apigatewayv2.ApiMapping(`${name}-Mapping`, {
        apiId: this.apiGateway.id,
        domainName: this.domain.id,
        stage: this.stage.id,
      });
    }

    this.registerOutputs({
      apiGateway: this.apiGateway,
      stage: this.stage,
      routes: this.routes,
      integrains: this.integrations,
      premissions: this.permissions,
      domain: this.domain,
      certificate: this.certificate,
    });
  }
}
