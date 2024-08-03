// main.js
import { AkashDeploymentFetcher } from './AkashDeploymentFetcher';
import { QueryClientImpl as QueryProviderClient, QueryProviderRequest } from "@akashnetwork/akash-api/akash/provider/v1beta3";
import { getRpc } from "@akashnetwork/akashjs/build/rpc";
import CertificateManager from "./certificate-manager";
import { URL } from 'url';
import * as https from 'https';
import { sleep } from '@cosmjs/utils';
import { SDL } from "@akashnetwork/akashjs/build/sdl";
import { mnemonic } from './config-mnemonic';
import { getNextRpcEndpoint } from './config-rpc';
import { sdlContent } from './config-sdl';



interface DeploymentInfo {
    dseq: any;
    provider: string | null;
    publicUrl: string | null;
    status: any;
}

const deploymentInfoArray: DeploymentInfo[] = [];

async function httpsRequest(options: https.RequestOptions): Promise<any> {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (error) {
                        reject(new Error(`Failed to parse response: ${error.message}`));
                    }
                } else {
                    reject(new Error(`HTTP Error: ${res.statusCode} ${res.statusMessage}`));
                }
            });
        });

        req.on('error', (error) => reject(error));
        req.end();
    });
}

async function getDeploymentStatus(providerUri: string, owner: string, dseq: string, certificate: any): Promise<any> {
    const url = new URL(`/deployment/${owner}/${dseq}/status`, providerUri);
    
    const options: https.RequestOptions = {
        method: 'GET',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
            'Content-Type': 'application/json',
        },
        cert: certificate.cert,
        key: certificate.privateKey,
        rejectUnauthorized: false // Only use this in development. In production, properly verify the certificate.
    };

    try {
        return await httpsRequest(options);
    } catch (error) {
        console.error(`Error fetching deployment status: ${error.message}`);
        return null;
    }
}

async function getLeaseStatus(providerUri: string, owner: string, dseq: string, gseq: number, oseq: number, certificate: any): Promise<any> {
    const url = new URL(`/lease/${dseq}/${gseq}/${oseq}/status`, providerUri);
    
    const options: https.RequestOptions = {
        method: 'GET',
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
            'Content-Type': 'application/json',
        },
        cert: certificate.cert,
        key: certificate.privateKey,
        rejectUnauthorized: false // Only use this in development. In production, properly verify the certificate.
    };

    try {
        return await httpsRequest(options);
    } catch (error) {
        console.error(`Error fetching lease status: ${error.message}`);
        return null;
    }
}

async function retryRpcCall<T>(
    call: () => Promise<T>,
    maxRetries: number = 3,
    delay: number = 1000
): Promise<T> {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await call();
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            console.log(`RPC call failed, retrying in ${delay}ms...`);
            await sleep(delay);
            delay *= 2; // Exponential backoff
        }
    }
    throw new Error('Max retries reached');
}

async function fetchWithRetry(fetcher: AkashDeploymentFetcher, maxRetries = 5, initialDelay = 1000) {
    let retries = 0;
    while (retries < maxRetries) {
        try {
            return await fetcher.fetchActiveDeployments();
        } catch (error) {
            if ((error.message.includes('504') || error.message.includes('Bad status')) && retries < maxRetries - 1) {
                console.log(`Attempt ${retries + 1} failed. Retrying with a different RPC endpoint...`);
                const newRpcEndpoint = getNextRpcEndpoint();
                await fetcher.updateRpcEndpoint(newRpcEndpoint);
                await new Promise(resolve => setTimeout(resolve, initialDelay));
                initialDelay *= 2;  // Exponential backoff
                retries++;
            } else {
                throw error;
            }
        }
    }
    throw new Error('Max retries reached when fetching active deployments');
}

export async function main() {
    let rpcEndpoint = getNextRpcEndpoint();
    const deploymentInfoArray = [];

    // Initialize CertificateManager
    const certificateManager = CertificateManager.getInstance();
    await certificateManager.initialize(mnemonic, rpcEndpoint);
    const certificate = await certificateManager.getOrCreateCertificate();

    const fetcher = new AkashDeploymentFetcher(mnemonic, rpcEndpoint);
    await fetcher.initialize();

    const rpc = await getRpc(rpcEndpoint);
    const providerClient = new QueryProviderClient(rpc);

    try {
        const activeDeployments = await fetchWithRetry(fetcher);
        console.log(`Found ${activeDeployments.length} active deployments`);

        for (const deployment of activeDeployments) {
            if (deployment.deployment && deployment.deployment.deploymentId) {
                const dseq = deployment.deployment.deploymentId.dseq;

                let deploymentInfo = {
                    dseq: dseq,
                    owner: deployment.deployment.deploymentId.owner,
                    state: deployment.deployment.state,
                    version: deployment.deployment.version,
                    createdAt: deployment.deployment.createdAt,
                    provider: null,
                    providerHostUri: null,
                    publicUrl: null,
                    services: [],
                    resources: {
                        cpu: '',
                        memory: '',
                        storage: ''
                    },
                    price: ''
                };

                // Extract resource information
                if (deployment.groups && deployment.groups.length > 0) {
                    const group = deployment.groups[0];
                    if (group.groupSpec && group.groupSpec.resources && group.groupSpec.resources.length > 0) {
                        const resource = group.groupSpec.resources[0].resource;
                        deploymentInfo.resources = {
                            cpu: resource.cpu ? resource.cpu.units.val : '',
                            memory: resource.memory ? resource.memory.quantity.val : '',
                            storage: resource.storage && resource.storage.length > 0 ? resource.storage[0].quantity.val : ''
                        };
                    }
                }

                let lease;
                try {
                    lease = await retryRpcCall(() => fetcher.getLeaseStatus(deploymentInfo.owner, dseq));
                    
                    if (lease && lease.lease) {
                        deploymentInfo.provider = lease.lease.leaseId.provider;
                        deploymentInfo.price = lease.lease.price ? `${lease.lease.price.amount} ${lease.lease.price.denom}` : '';
                    }
                } catch (error) {
                    console.error(`Error fetching lease status for deployment ${dseq}:`, error);
                    continue;  // Move to the next deployment
                }
                
                if (deploymentInfo.provider) {
                    try {
                        const providerRequest = QueryProviderRequest.fromPartial({
                            owner: deploymentInfo.provider
                        });
                        const providerResponse = await retryRpcCall(() => providerClient.Provider(providerRequest));
                        
                        if (providerResponse.provider && providerResponse.provider.hostUri) {
                            deploymentInfo.providerHostUri = providerResponse.provider.hostUri;

                            try {
                                const leaseStatus = await getLeaseStatus(
                                    deploymentInfo.providerHostUri,
                                    deploymentInfo.owner,
                                    dseq,
                                    lease.lease.leaseId.gseq,
                                    lease.lease.leaseId.oseq,
                                    certificate
                                );

                                if (leaseStatus && leaseStatus.forwarded_ports) {
                                    for (const [serviceName, ports] of Object.entries(leaseStatus.forwarded_ports)) {
                                        if (ports && ports.length > 0) {
                                            const port = ports[0];  // Get the first port
                                            deploymentInfo.publicUrl = `http://${port.host}:${port.externalPort}`;
                                            break;  // We only need one public URL
                                        }
                                    }
                                }

                                if (!deploymentInfo.publicUrl && leaseStatus && leaseStatus.services) {
                                    for (const [serviceName, serviceInfo] of Object.entries(leaseStatus.services)) {
                                        if (serviceInfo.uris && serviceInfo.uris.length > 0) {
                                            deploymentInfo.publicUrl = serviceInfo.uris[0];
                                            break;  // We only need one public URL
                                        }
                                    }
                                }

                                // Collect services information
                                if (leaseStatus && leaseStatus.services) {
                                    deploymentInfo.services = Object.entries(leaseStatus.services).map(([name, info]) => ({
                                        name,
                                        available: info.available,
                                        total: info.total,
                                        uris: info.uris || []
                                    }));
                                }
                            } catch (error) {
                                console.error(`Error fetching lease status for deployment ${dseq}:`, error.message);
                            }
                        }
                    } catch (error) {
                        console.error(`Error fetching provider details for deployment ${dseq}:`, error);
                    }
                }

                deploymentInfoArray.push(deploymentInfo);
            }
        }
    } catch (error) {
        console.error("Error in fetching process:", error);
    }

    return deploymentInfoArray;
}

// main().catch(console.error);


























