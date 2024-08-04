import { AkashDeploymentFetcher } from './AkashDeploymentFetcher';
import { QueryClientImpl } from "@akashnetwork/akash-api/akash/market/v1beta4";
import { QueryProviderRequest } from "@akashnetwork/akash-api/akash/provider/v1beta3";
import { QueryAccountsRequest } from '@akashnetwork/akash-api/akash/escrow/v1beta1';
import { QueryLeaseRequest, QueryLeaseResponse, QueryBidRequest, QueryBidResponse ,QueryBidsRequest} from "@akashnetwork/akash-api/akash/market/v1beta4";
import Long from "long";
import { getRpc } from "@akashnetwork/akashjs/build/rpc";
import CertificateManager from "./certificate-manager";
import { URL } from 'url';
import * as https from 'https';
import { sleep } from '@cosmjs/utils';
import { SDL } from "@akashnetwork/akashjs/build/sdl";
import { mnemonic } from './config-mnemonic';
import { getNextRpcEndpoint } from './config-rpc';
import { sdlContent } from './config-sdl';

interface EscrowAccount {
    id: {
        scope: string;
        xid: string;
    };
    owner: string;
    state: string;
    balance: {
        denom: string;
        amount: string;
    };
    transferred: {
        denom: string;
        amount: string;
    };
    settled_at: string;
    depositor: string;
    funds: {
        denom: string;
        amount: string;
    };
}

interface DeploymentInfo {
    dseq: string;
    owner: string;
    state: string;
    version: string;
    createdAt: string;
    provider: string | null;
    providerHostUri: string | null;
    publicUrl: string | null;
    services: any[];
    resources: {
        cpu: string;
        memory: string;
        storage: string;
    };
    price: string;
    escrowAccount: EscrowAccount | null;
    escrowBalance: string;
    logs: string;
    leaseState: number;
    leaseCreatedAt: string;
    leaseClosedOn: string;
    escrowPayment: {
        paymentId: string;
        owner: string;
        state: number;
        rate: {
            denom: string;
            amount: string;
        };
        balance: {
            denom: string;
            amount: string;
        };
        withdrawn: {
            denom: string;
            amount: string;
        };
    } | null;
}

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
        rejectUnauthorized: false
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
        rejectUnauthorized: false
    };

    try {
        return await httpsRequest(options);
    } catch (error) {
        console.error(`Error fetching lease status: ${error.message}`);
        return null;
    }
}

async function getLogs(providerUri: string, owner: string, dseq: string, certificate: any): Promise<string> {
    const url = new URL(`/deployment/${owner}/${dseq}/logs`, providerUri);
    
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
        rejectUnauthorized: false
    };

    try {
        console.log(`Fetching logs from: ${url.toString()}`);
        const response = await httpsRequest(options);
        console.log('Raw logs response:', JSON.stringify(response, null, 2));
        return response.logs || 'No logs available';
    } catch (error) {
        console.error(`Error fetching logs: ${error.message}`);
        return 'Error fetching logs';
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

function decodeBase64(str: string): string {
    try {
        return Buffer.from(str, 'base64').toString('utf-8');
    } catch (error) {
        console.error(`Error decoding base64: ${error.message}`);
        return str; // Return the original string if decoding fails
    }
}

async function getEscrowAccount(rpc: any, owner: string, dseq: string): Promise<EscrowAccount | null> {
    try {
        console.log('Initializing QueryClientImpl for escrow...');
        const escrowClient = new QueryClientImpl(rpc);
        console.log('QueryClientImpl initialized for escrow');

        console.log('Creating QueryAccountRequest...');
        const request = QueryAccountRequest.fromPartial({
            id: {
                scope: owner,
                xid: dseq
            }
        });
        console.log('QueryAccountRequest created:', JSON.stringify(request, null, 2));

        console.log('Calling escrowClient.Account...');
        const response = await retryRpcCall(() => escrowClient.Account(request));
        console.log('Raw escrow account response:', JSON.stringify(response, null, 2));

        if (response.account) {
            return response.account as EscrowAccount;
        } else {
            console.log('No escrow account found');
            return null;
        }
    } catch (error) {
        console.error(`Error in getEscrowAccount:`, error);
        return null;
    }
}

async function fetchBid(queryClient: QueryClientImpl, owner: string, dseq: string): Promise<string | null> {
    console.log(`Fetching bids for deployment ${dseq}...`);
    const request = QueryBidsRequest.fromPartial({
        filters: {
            owner: owner,
            dseq: BigInt(dseq)
        }
    });
    try {
        const bids = await retryRpcCall(() => queryClient.Bids(request));
        console.log(`Received ${bids.bids.length} bids for deployment ${dseq}`);

        if (bids.bids.length > 0) {
            const validBids = bids.bids.filter(bid => bid.bid !== undefined);
            if (validBids.length > 0) {
                // Select the first valid bid
                const selectedBid = validBids[0].bid!;
                console.log(`Selected bid from provider ${selectedBid.bidId.provider}`);
                return selectedBid.bidId.provider;
            }
        }
        console.log(`No valid bids found for deployment ${dseq}`);
        return null;
    } catch (error) {
        console.error(`Error fetching bids for deployment ${dseq}:`, error);
        return null;
    }
}

export async function main() {
    let rpcEndpoint = getNextRpcEndpoint();
    const deploymentInfoArray: DeploymentInfo[] = [];

    console.log('Starting main function');

    // Initialize CertificateManager
    const certificateManager = CertificateManager.getInstance();
    await certificateManager.initialize(mnemonic, rpcEndpoint);
    const certificate = await certificateManager.getOrCreateCertificate();

    const fetcher = new AkashDeploymentFetcher(mnemonic, rpcEndpoint);
    await fetcher.initialize();

    const rpc = await getRpc(rpcEndpoint);
    const queryClient = new QueryClientImpl(rpc);

    try {
        const activeDeployments = await fetchWithRetry(fetcher);
        console.log(`Found ${activeDeployments.length} active deployments}`);

        for (const deployment of activeDeployments) {
            if (deployment.deployment && deployment.deployment.deploymentId) {
                const dseq = deployment.deployment.deploymentId.dseq;
                const provider = deployment.deployment.deploymentId.provider;
                console.log(`Processing deployment ${dseq} with provider ${provider}`);

                let deploymentInfo: DeploymentInfo = {
                    dseq: dseq,
                    owner: deployment.deployment.deploymentId.owner,
                    state: deployment.deployment.state,
                    version: deployment.deployment.version,
                    createdAt: deployment.deployment.createdAt,
                    provider: provider,
                    providerHostUri: null,
                    publicUrl: null,
                    services: [],
                    resources: {
                        cpu: '',
                        memory: '',
                        storage: ''
                    },
                    price: '',
                    escrowAccount: null,
                    escrowBalance: '',
                    logs: '',
                    leaseState: 0, 
                    leaseCreatedAt: '', 
                    leaseClosedOn: '', 
                    escrowPayment: null, 
                    accountId: {
                        scope: '', 
                        xid: '' 
                    }
                };
                console.log('Initial deploymentInfo:', JSON.stringify(deploymentInfo, null, 2));

                // Extract and decode resource information
                if (deployment.groups && deployment.groups.length > 0) {
                    const group = deployment.groups[0];
                    if (group.groupSpec && group.groupSpec.resources && group.groupSpec.resources.length > 0) {
                        const resource = group.groupSpec.resources[0].resource;
                        deploymentInfo.resources = {
                            cpu: resource.cpu ? decodeBase64(resource.cpu.units.val) : '',
                            memory: resource.memory ? decodeBase64(resource.memory.quantity.val) : '',
                            storage: resource.storage && resource.storage.length > 0 ? decodeBase64(resource.storage[0].quantity.val) : ''
                        };
                        console.log('Decoded resources:', JSON.stringify(deploymentInfo.resources, null, 2));
                    }
                }
                // Fetch lease information
                try {
                    console.log(`Fetching lease information for deployment ${dseq}`);
                    deploymentInfo.provider = await fetchBid(queryClient, deploymentInfo.owner, dseq);
                    console.log('Provider:', deploymentInfo.provider);
                    const getLeaseStatusRequest = QueryLeaseRequest.fromPartial({
                        id: {
                            owner: deploymentInfo.owner,
                            dseq: parseInt(dseq),
                            gseq: 1,
                            oseq: 1,
                            provider: "akash1u5cdg7k3gl43mukca4aeultuz8x2j68mgwn28e"
                        }
                    });
                
                    console.log('Lease request:', JSON.stringify(getLeaseStatusRequest, null, 2));
                
                    const lease = QueryLeaseRequest.create(getLeaseStatusRequest);
                
                    const leaseStatusResponse: QueryLeaseResponse = await queryClient.Lease(lease);
                    console.log('Raw lease response:', JSON.stringify(leaseStatusResponse, null, 2));
                
                    // Update deploymentInfo with lease data
                    if (leaseStatusResponse.lease) {
                        deploymentInfo.provider = leaseStatusResponse.lease.provider;
                        deploymentInfo.leaseState = leaseStatusResponse.lease.state;
                        deploymentInfo.leaseCreatedAt = leaseStatusResponse.lease.createdAt.toString();
                        deploymentInfo.leaseClosedOn = leaseStatusResponse.lease.closedOn.toString();
                        if (leaseStatusResponse.lease.price) {
                            deploymentInfo.price = `${leaseStatusResponse.lease.price.amount} ${leaseStatusResponse.lease.price.denom}`;
                        }
                    }
                
                    // Handle escrow payment information if available
                    if (leaseStatusResponse.escrowPayment) {
                        deploymentInfo.escrowPayment = {
                            accountId: {
                                scope: leaseStatusResponse.escrowPayment.accountId.scope,
                                xid: leaseStatusResponse.escrowPayment.accountId.xid
                            },
                            paymentId: leaseStatusResponse.escrowPayment.paymentId,
                            owner: leaseStatusResponse.escrowPayment.owner,
                            state: leaseStatusResponse.escrowPayment.state,
                            rate: {
                                denom: leaseStatusResponse.escrowPayment.rate.denom,
                                amount: leaseStatusResponse.escrowPayment.rate.amount
                            },
                            balance: {
                                denom: leaseStatusResponse.escrowPayment.balance.denom,
                                amount: leaseStatusResponse.escrowPayment.balance.amount
                            },
                            withdrawn: {
                                denom: leaseStatusResponse.escrowPayment.withdrawn.denom,
                                amount: leaseStatusResponse.escrowPayment.withdrawn.amount
                            }
                        };
                    } else {
                        deploymentInfo.escrowPayment = null;
                    }
                    // Add the updated deploymentInfo to the array
                    deploymentInfoArray.push(deploymentInfo);
                
                } catch (error) {
                    console.error(`Error fetching lease status for deployment ${dseq}:`, error);
                    console.error('Error stack:', error.stack);
                
                    // Even if there's an error, we might want to add the partial info to the array
                    deploymentInfoArray.push(deploymentInfo);
                }
            }
        }
    } catch (error) {
        console.error("Error in fetching process:", error);
    }

    console.log('All deployments processed:', JSON.stringify(deploymentInfoArray, null, 2));

    return deploymentInfoArray;
}

console.log(main().catch(console.error));



