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
  edge?: Input<boolean>;
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

export class ApiGatewayV2 extends pulumi.ComponentResource {
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

export class RestApiGateway extends pulumi.ComponentResource {
  public readonly apiGateway: aws.apigateway.RestApi;
  public readonly deployment: aws.apigateway.Deployment;
  public readonly stage: aws.apigateway.Stage;
  public readonly resources: aws.apigateway.Resource[] = [];
  public readonly methods: aws.apigateway.Method[] = [];
  public readonly integrations: aws.apigateway.Integration[] = [];
  public readonly permissions: aws.lambda.Permission[] = [];
  public readonly domain?: aws.apigateway.DomainName;
  public readonly certificate?: aws.acm.Certificate;
  public readonly basePathMapping?: aws.apigateway.BasePathMapping;
  private readonly authorizers: aws.apigateway.Authorizer[] = [];

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
        },
      },
      { parent: this },
    );

    let madeResources = new Map<string, pulumi.Output<string>>();
    args.routes.forEach((route, index) => {
      const method = route.method ?? "POST";
      const pathParts = route.path.toString().split('/').filter(part => part !== '');
      
      let currentResource: pulumi.Output<string> = this.apiGateway.rootResourceId;
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
        
        this.resources.push(resource);
        currentResource = resource.id;
        madeResources.set(resourcePath, resource.id);
      });

      // Create authorizer if needed
      let authorizer: aws.apigateway.Authorizer | null = null;
      if (route.authorizer) {
        authorizer = new aws.apigateway.Authorizer(
          `${name}-Authorizer-${index}`,
          {
            name: `${name}-authorizer-${index}`,
            restApi: this.apiGateway.id,
            authorizerUri: route.authorizer.invokeArn,
            authorizerCredentials: route.execRole?.arn,
            type: "REQUEST",
            identitySource: "method.request.header.Authorization",
          },
          { parent: this },
        );
        this.authorizers.push(authorizer);

        // Permission for authorizer
        const authorizerPermission = new aws.lambda.Permission(
          `${name}-AuthPermission-${index}`,
          {
            action: "lambda:InvokeFunction",
            function: route.authorizer.name,
            principal: "apigateway.amazonaws.com",
            sourceArn: pulumi.interpolate`${this.apiGateway.executionArn}/*`,
          },
          { parent: this },
        );
        this.permissions.push(authorizerPermission);
      }

      // Create method
      const apiMethod = new aws.apigateway.Method(
        `${name}-Method-${index}`,
        {
          restApi: this.apiGateway.id,
          resourceId: currentResource,
          httpMethod: method,
          authorization: route.authorizer ? "CUSTOM" : "NONE",
          authorizerId: authorizer?.id,
        },
        { parent: this },
      );
      this.methods.push(apiMethod);

      // Create integration
      const integrationConfig = route.eventHandler instanceof aws.sfn.StateMachine
        ? {
            type: "AWS",
            integrationHttpMethod: "POST",
            uri: pulumi.interpolate`arn:aws:apigateway:${aws.getRegionOutput().name}:states:action/${route.stateMachineStartSync ? "StartSyncExecution" : "StartExecution"}`,
            credentials: route.execRole?.arn,
            requestTemplates: {
              "application/json": pulumi.interpolate`{
                "input": "$util.escapeJavaScript($input.json('$'))",
                "stateMachineArn": "${route.eventHandler.arn}"
              }`,
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
          httpMethod: apiMethod.httpMethod,
          ...integrationConfig,
        },
        { parent: this },
      );
      this.integrations.push(integration);

      if (route.eventHandler instanceof aws.lambda.Function) {
        const permission = new aws.lambda.Permission(
          `${name}-Permission-${index}`,
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
    });

    this.deployment = new aws.apigateway.Deployment(
      `${name}-Deployment`,
      {
        restApi: this.apiGateway.id,
        description: "Deployment for REST API",
      },
      { 
        parent: this,
        dependsOn: [...this.methods, ...this.integrations]
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
      },
      { parent: this },
    );

    // Handle custom domain if provided
    if (args.domain) {
    this.certificate = new aws.acm.Certificate(
      `${name}-Certificate`,
      {
        domainName: args.domain,
        validationMethod: "DNS",
        tags: args.tags,
      },
      { parent: this },
    );

    this.domain = new aws.apigateway.DomainName(
      `${name}-Domain`,
      {
        domainName: args.domain,
        regionalCertificateArn: args.edge ? undefined : this.certificate.arn,
        certificateArn: args.edge ? this.certificate.arn : undefined,
        endpointConfiguration: {
          types: args.edge ? "EDGE" : "REGIONAL",
        },
        tags: args.tags,
      },
      { parent: this },
    );

    this.basePathMapping = new aws.apigateway.BasePathMapping(
      `${name}-Mapping`,
      {
        restApi: this.apiGateway.id,
        stageName: this.stage.stageName,
        domainName: this.domain.domainName,
      },
      { parent: this },
    );
    }

    if (args.corsConfig) {
      throw "cors not implemented"
    }

    this.registerOutputs({
      apiGateway: this.apiGateway,
      deployment: this.deployment,
      stage: this.stage,
      resources: this.resources,
      methods: this.methods,
      integrations: this.integrations,
      permissions: this.permissions,
      domain: this.domain,
      certificate: this.certificate,
      basePathMapping: this.basePathMapping,
    });
  }
}
