import * as eks from "aws-cdk-lib/aws-eks";
import { ClusterAddOn, ClusterInfo, Values } from "../../spi";
import { dependable } from "../../utils";
import { Construct } from 'constructs';
import { UpboundCrossplaneAddOn } from "../upbound-crossplane";

export class CrossplaneAWSProvider implements ClusterAddOn {
    id?: string | undefined;
    @dependable(UpboundCrossplaneAddOn.name)
    deploy(clusterInfo: ClusterInfo): void | Promise<Construct> {
        const cluster = clusterInfo.cluster;
        const crossplaneIRSARole = clusterInfo.getAddOnContexts().get("UpboundCrossplaneAddOn")!["arn"];
        const controllerConfig = new eks.KubernetesManifest(clusterInfo.cluster.stack, "ControllerConfig", {
            cluster: cluster,
            manifest: [
                {
                    apiVersion: "pkg.crossplane.io/v1alpha1",
                    kind: "ControllerConfig",
                    metadata: {
                        name: "aws-config",
                        annotations: {
                            "eks.amazonaws.com/role-arn": crossplaneIRSARole
                        }
                    },
                    spec: {},
                },
            ],
        });

        const awsEksProvider = new eks.KubernetesManifest(clusterInfo.cluster.stack, "EKSProvider", {
            cluster: cluster,
            manifest: [
                {
                    apiVersion: "pkg.crossplane.io/v1",
                    kind: "Provider",
                    metadata: {
                        name: "provider-aws-eks",
                    },
                    spec: {
                        package: "xpkg.upbound.io/upbound/provider-aws-eks:v1.1.0",
                        controllerConfigRef: {
                            name: "aws-config"
                        }
                    },
                },
            ],
        });
        const eksProviderConfig = new eks.KubernetesManifest(clusterInfo.cluster.stack, "EKSProviderConfig", {
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

        //awsProvider.node.addDependency(controllerConfig);
        awsEksProvider.node.addDependency(controllerConfig);
        return Promise.resolve(controllerConfig);
    }
}