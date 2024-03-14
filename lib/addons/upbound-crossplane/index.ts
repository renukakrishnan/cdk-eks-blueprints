import { Construct } from 'constructs';
import { ManagedPolicy, Policy, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import * as eks from "aws-cdk-lib/aws-eks";
import merge from "ts-deepmerge";
import * as cdk from 'aws-cdk-lib';
import { HelmAddOn, HelmAddOnUserProps } from "../helm-addon";
import { ClusterInfo } from "../../spi/types";
import { Values } from "../../spi";
import { createNamespace} from "../../utils/namespace-utils";
import { CrossplaneProvider, providerMappings } from './providerMappings';
import { loadYaml, readYamlDocument, changeTextBetweenTokens } from "../../utils";
import * as iam from 'aws-cdk-lib/aws-iam';
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

         //Providerconfig
        const eksProviderConfig = new eks.KubernetesManifest(cluster.stack, "EKSProviderConfig", {
            cluster: cluster,
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


        //loop through the list of providers, customize the template file and apply
        let doc: string;
        
        if (this.options.providers) {
            for (let provider of this.options.providers) {
                doc = readYamlDocument(__dirname + '/provider-config.ytpl');
                //doc.replace("{{provider-name}}",'provider-aws-' + providerMappings[provider]?.provider);
                let manifest = loadYaml(doc);
            
                const awsProvider =  new eks.KubernetesManifest(cluster.stack, 'provider-aws-' + providerMappings[provider]?.provider, {
                    cluster,
                    manifest: [manifest],
                    overwrite: true
                });
                awsProvider.node.addDependency(chart);
                eksProviderConfig.node.addDependency(awsProvider);
            }
        }
        
        return Promise.resolve(chart);
    }
}

