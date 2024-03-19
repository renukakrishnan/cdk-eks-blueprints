import { Construct } from 'constructs';
import { ManagedPolicy, Policy, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import * as eks from "aws-cdk-lib/aws-eks";
import { merge } from "ts-deepmerge";
import * as cdk from 'aws-cdk-lib';
import { HelmAddOn, HelmAddOnUserProps } from "../helm-addon";
import { ClusterInfo } from "../../spi/types";
import { Values } from "../../spi";
import { createNamespace} from "../../utils/namespace-utils";
import { CrossplaneProvider, providerMappings } from './providerMappings';
import { loadYaml, readYamlDocument, changeTextBetweenTokens } from "../../utils";
import { KubernetesObjectValue } from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Function, Runtime } from 'aws-cdk-lib/aws-lambda'; 

/**
 * User provided options for the Helm Chart
 */
export interface UpboundCrossplaneAddOnProps extends HelmAddOnUserProps {
    /**
     * To Create Namespace using CDK
     */    
    createNamespace?: boolean;


    providers: CrossplaneProvider[];

    /**
    * Inline IAM Policy for the ack controller
    * @default undefined
    */
    inlinePolicyStatements?: PolicyStatement[];

    /**
     * Managed IAM Policy of the ack controller
     * @default IAMFullAccess
     */
    managedPolicyName?: string;
  }

const defaultProps: UpboundCrossplaneAddOnProps = {
    name: 'uxp',
    release: 'blueprints-addon-uxp',
    namespace: 'upbound-system',
    chart: 'universal-crossplane',
    version: '1.14.6-up.1',
    repository: 'https://charts.upbound.io/stable',
    values: { 
        provider : {
        packages: ['xpkg.upbound.io/crossplane-contrib/provider-aws:v0.39.0']
        }
    },
    providers:[CrossplaneProvider.EKS]
};

export class UpboundCrossplaneAddOn extends HelmAddOn {

    readonly options: UpboundCrossplaneAddOnProps;

    constructor(props?: UpboundCrossplaneAddOnProps) {
      super({...defaultProps as any, ...props});
      this.options = this.props as UpboundCrossplaneAddOnProps;
    }

    deploy(clusterInfo: ClusterInfo): void | Promise<Construct> {
        const cluster = clusterInfo.cluster;

        // Create the `upbound-system` namespace.
        const namespace = this.options.namespace;
        const ns = createNamespace(this.options.namespace!, cluster, true);

        let values: Values = this.options.values ?? {};
        values = merge(values, values);


        // Create the CrossPlane AWS Provider IRSA.
        
        const serviceAccountName = "provider-aws";
        const sa = cluster.addServiceAccount(serviceAccountName, {
            name: serviceAccountName,
            namespace: this.options.namespace!
        });
        sa.node.addDependency(ns);

        //attach the managed policies for all the providers to the role
        if (this.options.providers) {
                for (let provider of this.options.providers) {
                    const managedPolicyname = this.options.managedPolicyName ?? providerMappings[provider]?.managedPolicyName
                    const inlinePolicyStatements = this.options.inlinePolicyStatements ?? providerMappings[provider!]?.inlinePolicyStatements;
                    sa.role.addManagedPolicy(ManagedPolicy.fromAwsManagedPolicyName(managedPolicyname!));
                    if (inlinePolicyStatements && inlinePolicyStatements.length > 0) {
                        sa.role.attachInlinePolicy(new Policy(cluster.stack, `${this.options.chart}-inline-policy`, {
                        statements: inlinePolicyStatements
                    }));
                }
            }
        }

        
        clusterInfo.addAddOnContext(UpboundCrossplaneAddOn.name, {
            arn: sa.role.roleArn
        });
        
        new cdk.CfnOutput(cluster.stack, 'provider-aws-sa-iam-role', { value: sa.role.roleArn });

        const chart = this.addHelmChart(clusterInfo, values,true,true);
        chart.node.addDependency(sa);

        //controller config, provider and provider config
        const controllerConfig = new eks.KubernetesManifest(cluster.stack, "ControllerConfig", {
            cluster: cluster,
            manifest: [
                {
                    apiVersion: "pkg.crossplane.io/v1alpha1",
                    kind: "ControllerConfig",
                    metadata: {
                        name: "aws-config",
                        annotations: {
                            "eks.amazonaws.com/role-arn": sa.role.roleArn
                        }
                    },
                    spec: {},
                },
            ],
        });
        controllerConfig.node.addDependency(chart);

                
        //loop through the list of providers, customize the template file and apply
        let doc: string;
        
        
        if (this.options.providers) {
            for (let provider of this.options.providers) {
                doc = readYamlDocument(__dirname + '/provider-config.ytpl');
                //doc.replace("{{provider-name}}",'provider-aws-' + providerMappings[provider]?.provider);
                let manifest = loadYaml(doc);
            
                let awsProvider =  new eks.KubernetesManifest(cluster.stack, 'provider-aws-' + providerMappings[provider]?.provider, {
                    cluster,
                    manifest: [manifest],
                    overwrite: true
                });
                awsProvider.node.addDependency(chart);
                awsProvider.node.addDependency(controllerConfig);
                //last provider, apply the provider config manifest only after the provider has been created. 
                if (this.options.providers.indexOf(provider) == this.options.providers.length - 1) {

                    const providerConfig = new eks.KubernetesManifest(cluster.stack, "ProviderConfig", {
                        cluster,
                        manifest: [
                            {
                                apiVersion: "aws.upbound.io/v1beta1",
                                kind: "ProviderConfig",
                                metadata: {
                                    name: "default",
                                },
                                spec: {
                                    credentials: {
                                        source: "IRSA"
                                    }
                                },
                            },
                        ],
                    });
                    const status = new KubernetesObjectValue(cluster.stack, 'Status', {
                        cluster,
                        objectName: 'providerconfigs.aws.upbound.io',
                        objectType: 'apiextensions.k8s.io/CustomResourceDefinition',
                        objectNamespace: 'crossplane-system',
                        jsonPath: '$.status.conditions[?(@.type=="Established")].status'
                      });
                    
                    const wait = new cdk.CfnWaitCondition(cluster.stack, 'Wait', {
                        count: 1,
                        timeout: '300',
                        handle: new cdk.CfnWaitConditionHandle(cluster.stack, 'WaitHandle').ref,        
                         
                    });
                    const handle = new cdk.CfnWaitConditionHandle(cluster.stack, 'Handle');

                    // Lambda function to check status
                    const checkStatus = new Function(cluster.stack, 'CheckStatus', {
                    runtime: Runtime.NODEJS_16_X,
                    code: Code.fromAsset('path/to/lambda'),
                    memorySize: 128,
                    timeout: cdk.Duration.minutes(1),
                    handler: 'index.handler'  
                    });

                    // Wait condition 
                    new cdk.CfnWaitCondition(cluster.stack, 'WaitCondition', {
                    handle : handle.ref,
                    timeout: '300' 
                    });

                    // Custom resource to invoke lambda
                    new cdk.CustomResource(cluster.stack, 'WaitResource', {

                        serviceToken: 'checkStatus',

                        properties: {
                            // Get status from KubernetesObjectValue
                            Status: status,
                            // Check condition
                            Condition: status.value === "established"

                        }

                    });
                    wait.addDependency(status);
                    providerConfig.node.addDependency(chart);
                    providerConfig.node.addDependency(controllerConfig);
                    providerConfig.node.addDependency(awsProvider);
                    //Add CFN wait for 120 seconds to ensure that provider is available before applying the provider config manifest using CfnWaitCondition and cfnwaitconditionhandle

                }

                
            }    
        }



        return Promise.resolve(chart);
    }

    
}

function checkForCRD(clusterInfo: ClusterInfo): Promise<boolean> {
    const cluster = clusterInfo.cluster;
    const crdValue = new KubernetesObjectValue(cluster.stack, 'ObjectValue', {
        cluster: cluster,
        objectName: 'providerconfigs.aws.upbound.io', 
        objectType: 'apiextensions.k8s.io/CustomResourceDefinition',
        objectNamespace: 'crossplane-system',
        jsonPath: '$.metadata.name' 
      });
    if (crdValue) {
        return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  exports.handler = function(event, context, callback) {

    // event contains request parameters 
    const status = event.ResourceProperties.Status;
  
    // check condition
    if(event.ResourceProperties.Condition) {
      callback(null, SUCCESS);
    } else {
      callback(null, FAILURE); 
    }
  
  }

