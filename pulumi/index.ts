import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as apigateway from "@pulumi/aws-apigateway";
import { FileArchive, FileAsset } from "@pulumi/pulumi/asset";

const assumeRole = aws.iam.getPolicyDocument({
    statements: [{
        effect: "Allow",
        principals: [{
            type: "Service",
            identifiers: ["lambda.amazonaws.com"],
        }],
        actions: ["sts:AssumeRole"],
    }],
});
const iamForLambda = new aws.iam.Role("iam_for_lambda", {
    name: "iam_for_lambda",
    assumeRolePolicy: assumeRole.then(assumeRole => assumeRole.json),
});

const testLambda = new aws.lambda.Function("test_lambda", {
    code: new FileArchive('../code/bin/package.zip'),
    name: "lambda_function_name",
    role: iamForLambda.arn,
    handler: "maker",
    runtime: aws.lambda.Runtime.Dotnet8,
});
// A REST API to route requests to HTML content and the Lambda function
//const api = new apigateway.RestAPI("api", {
//    routes: [
//        { path: "/", localPath: "www"},
//        { path: "/date", method: "GET", eventHandler: fn },
//    ]
//});
//
// The URL at which the REST API will be served.
//export const url = api.url;
