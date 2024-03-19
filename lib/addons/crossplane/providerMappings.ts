import {PolicyStatement} from "aws-cdk-lib/aws-iam";

/**
 * Chart Mapping for fields such as chart, version, managed IAM policy.
 */
export interface CrossplaneProviderMapping {
    provider: string,
    version: string,
    managedPolicyName?: string
    inlinePolicyStatements?: PolicyStatement[]
}

/**
 * List of all supported supported AWS services by ACK Addon.
 */
export enum CrossplaneProvider {
  DYNAMODB = "dynamodb",
  EKS = "eks",
  S3 = "s3",
}

/**
 * List of all Service Mappings such as chart, version, managed IAM policy 
 * for all supported AWS services by Crossplane Addon.
 */
export const providerMappings : {[key in CrossplaneProvider]?: CrossplaneProviderMapping } = {
    [CrossplaneProvider.S3]: {
      provider: "s3",
      version:  "v1.1.0",
      managedPolicyName: "AmazonS3FullAccess"
    },
    [CrossplaneProvider.DYNAMODB]: {
      provider: "dynamodb",
      version:  "v1.1.0",
      managedPolicyName: "AmazonDynamoDBFullAccess"
    },
    [CrossplaneProvider.EKS]: {
      provider: "eks",
      version:  "v1.1.0",
      managedPolicyName: "AdministratorAccess",
      inlinePolicyStatements: [PolicyStatement.fromJson({
        "Effect": "Allow",
        "Action": [
          "eks:*",
          "iam:GetRole",
          "iam:PassRole"
        ],
        "Resource": "*"
      })]
    }
};
