import * as https from 'https';
import { URL } from 'url';
import { SigningStargateClient, StdFee } from "@cosmjs/stargate";
import { DirectSecp256k1HdWallet, Registry } from "@cosmjs/proto-signing";
import { MsgCreateDeployment } from "@akashnetwork/akash-api/akash/deployment/v1beta3";
import { QueryClientImpl as QueryProviderClient, QueryProviderRequest } from "@akashnetwork/akash-api/akash/provider/v1beta3";
import { QueryBidsRequest, QueryClientImpl as QueryMarketClient, MsgCreateLease, BidID } from "@akashnetwork/akash-api/akash/market/v1beta4";
import { getRpc } from "@akashnetwork/akashjs/build/rpc";
import { SDL } from "@akashnetwork/akashjs/build/sdl";
import { getAkashTypeRegistry } from "@akashnetwork/akashjs/build/stargate";
import CertificateManager from "./certificate-manager";
import * as fs from 'fs';
import { mnemonic } from './config-mnemonic';
import { sdlContent } from './config-sdl';
import { rpcEndpoints} from './config-rpc';
import { preferredProviders } from './providers';
import '../../../crypto-polyfill.js';
import _ from 'lodash';
import '../../../../crypto-wrapper.js';
type Deployment = {
  id: {
    owner: string;
    dseq: number;
  };
};

type Lease = {
  id: {
    owner: string;
    dseq: number;
    provider: string;
    gseq: number;
    oseq: number;
  };
};

const AVERAGE_GAS_PRICE = 0.0025;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function saveUrl(url: string) {
  const urlsFile = 'urls.json';
  let urls = { deploymentUrls: [] as string[] };
  if (fs.existsSync(urlsFile)) {
    const data = fs.readFileSync(urlsFile, 'utf8');
    urls = JSON.parse(data);
  }
  if (!urls.deploymentUrls.includes(url)) {
    urls.deploymentUrls.push(url);
    fs.writeFileSync(urlsFile, JSON.stringify(urls, null, 2));
    console.log(`URL ${url} added to ${urlsFile}`);
  } else {
    console.log(`URL ${url} already exists in ${urlsFile}`);
  }
}

async function httpsRequest(options: https.RequestOptions, body?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`HTTP Error: ${res.statusCode} ${res.statusMessage}`));
        }
      });
    });

    req.on('error', (error) => reject(error));

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function connectToRpc(): Promise<{ rpcEndpoint: string, client: SigningStargateClient, wallet: DirectSecp256k1HdWallet }> {
  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "akash" });
  const registry = getAkashTypeRegistry();

  const connectionPromises = rpcEndpoints.map(async (endpoint) => {
    try {
      console.log(`Attempting to connect to RPC endpoint: ${endpoint}`);
      const client = await SigningStargateClient.connectWithSigner(endpoint, wallet, {
        registry: new Registry(registry)
      });
      console.log(`Successfully connected to RPC endpoint: ${endpoint}`);
      return { rpcEndpoint: endpoint, client, wallet };
    } catch (error) {
      console.error(`Failed to connect to RPC endpoint ${endpoint}:`, error.message);
      throw error;
    }
  });

  try {
    return await Promise.any(connectionPromises);
  } catch (error) {
    console.error("Failed to connect to any RPC endpoint:", error);
    throw new Error("Failed to connect to any RPC endpoint");
  }
}

async function executeTransaction(client: SigningStargateClient, address: string, msgs: any[], fee: StdFee, memo: string) {
  const promise = rpcEndpoints.map(endpoint =>
    (async () => {
      try {
        const client = await SigningStargateClient.connectWithSigner(endpoint, await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "akash" }), {
          registry: new Registry(getAkashTypeRegistry())
        });
        const response = await client.signAndBroadcast(address, msgs, fee, memo);
        console.log(`Response from ${endpoint}: \ncode: ${response.code}\ntxhash: ${response.transactionHash}`);
        return { endpoint, code: response.code, txHash: response.transactionHash };
      } catch (error: any) {
        console.error(`Error with ${endpoint}: ${error}`);
        return { endpoint, code: 100, txHash: '' };
      }
    })()
  );

  const results = await Promise.allSettled(promise);
  const successfulResults = results
    .filter((result): result is PromiseFulfilledResult<{ endpoint: string; code: number; txHash: string }> => 
      result.status === "fulfilled" && result.value.code === 0
    )
    .map(result => result.value);

  if (successfulResults.length > 0) {
    const fastestResult = successfulResults[0];
    console.log(`Transaction successful. Hash: ${fastestResult.txHash}`);
    return fastestResult;
  }

  throw new Error("Failed to execute transaction on any endpoint");
}

async function createDeployment(sdl: SDL, wallet: DirectSecp256k1HdWallet, client: SigningStargateClient) {
  console.log("Creating deployment...");
  const blockheight = await client.getHeight();
  console.log(`Current block height: ${blockheight}`);

  const groups = sdl.groups();
  const accounts = await wallet.getAccounts();
  console.log(`Deployment will be created for account: ${accounts[0].address}`);

  const deployment = {
    id: {
      owner: accounts[0].address,
      dseq: blockheight
    },
    groups: groups,
    deposit: {
      denom: "uakt",
      amount: "1000000"
    },
    version: await sdl.manifestVersion(),
    depositor: accounts[0].address
  };

  const msg = {
    typeUrl: "/akash.deployment.v1beta3.MsgCreateDeployment",
    value: MsgCreateDeployment.fromPartial(deployment)
  };

  const simulatedGas = await client.simulate(accounts[0].address, [msg], "create deployment");
  const maxGas = Math.ceil(simulatedGas * 1.7);
  const gasPrice = 0.025; // uakt
  const feeAmount = Math.ceil(maxGas * gasPrice);
  
  const fee: StdFee = {
    amount: [{ denom: "uakt", amount: feeAmount.toString() }],
    gas: maxGas.toString()
  };

  console.log("Sending create deployment transaction...");
  const result = await executeTransaction(client, accounts[0].address, [msg], fee, "create deployment");

  if (result.code === 0) {
    console.log(`Deployment created successfully. DSEQ: ${deployment.id.dseq}`);
    return deployment;
  }

  throw new Error(`Could not create deployment: ${result.txHash}`);
}

async function fetchBid(dseq: number, owner: string, rpcEndpoint: string) {
  console.log(`Fetching bids for deployment ${dseq}...`);
  const rpc = await getRpc(rpcEndpoint);
  const client = new QueryMarketClient(rpc);
  const request = QueryBidsRequest.fromPartial({
    filters: {
      owner: owner,
      dseq: dseq
    }
  });

  console.log("Waiting 30 seconds for bids to accumulate...");
  await sleep(30000);

  const startTime = Date.now();
  const timeout = 1000 * 60 * 5; // 5 minutes timeout

  while (Date.now() - startTime < timeout) {
    console.log("Fetching bids...");
    const bids = await client.Bids(request);

    if (bids.bids.length > 0) {
      console.log(`Received ${bids.bids.length} bids. Logging all bid information:`);
      
      bids.bids.forEach((bid, index) => {
        console.log(`\nBid ${index + 1}:`);
        console.log(`Provider: ${bid.bid?.bidId.provider}`);
        console.log(`Price: ${bid.bid?.price.amount} ${bid.bid?.price.denom}`);
        console.log("Bid Attributes:");
        bid.bid?.bidAttributes?.forEach(attr => {
          console.log(`  ${attr.key}: ${attr.value}`);
        });
      });

      const validBids = bids.bids.filter(bid => bid.bid !== undefined);

      if (validBids.length > 0) {
        const preferredBids = validBids.filter(bid => preferredProviders.includes(bid.bid!.bidId.provider));
        
        if (preferredBids.length > 0) {
          preferredBids.sort((a, b) => parseFloat(a.bid!.price.amount) - parseFloat(b.bid!.price.amount));
          const selectedBid = preferredBids[0].bid!;
          console.log(`Selected lowest bid from preferred provider ${selectedBid.bidId.provider} with price ${selectedBid.price.amount} ${selectedBid.price.denom}`);
          return selectedBid;
        } else {
          validBids.sort((a, b) => parseFloat(a.bid!.price.amount) - parseFloat(b.bid!.price.amount));
          const selectedBid = validBids[0].bid!;
          console.log(`Selected lowest bid from provider ${selectedBid.bidId.provider} with price ${selectedBid.price.amount} ${selectedBid.price.denom}`);
          return selectedBid;
        }
      } else {
        console.log("No valid bids found. Waiting for more bids...");
      }
    } else {
      console.log("No bids received yet. Waiting for bids...");
    }

    console.log("Waiting 5 seconds before checking for new bids...");
    await sleep(5000);
  }

  throw new Error(`Could not fetch a suitable bid for deployment ${dseq}. Timeout reached.`);
}

async function createLease(deployment: Deployment, wallet: DirectSecp256k1HdWallet, client: SigningStargateClient, rpcEndpoint: string): Promise<Lease> {
  console.log("Creating lease...");
  const {
    id: { dseq, owner }
  } = deployment;
  const bid = await fetchBid(dseq, owner, rpcEndpoint);
  const accounts = await wallet.getAccounts();

  if (bid.bidId === undefined) {
    throw new Error("Bid ID is undefined");
  }

  const lease = {
    bidId: bid.bidId
  };

  const msg = {
    typeUrl: `/${MsgCreateLease.$type}`,
    value: MsgCreateLease.fromPartial(lease)
  };

  const simulatedGas = await client.simulate(accounts[0].address, [msg], "create lease");
  const maxGas = Math.ceil(simulatedGas * 1.7);
  const gasPrice = 0.025; // uakt
  const feeAmount = Math.ceil(maxGas * gasPrice);
  
  const fee: StdFee = {
    amount: [{ denom: "uakt", amount: feeAmount.toString() }],
    gas: maxGas.toString()
  };

  console.log("Sending create lease transaction...");
  const result = await executeTransaction(client, accounts[0].address, [msg], fee, "create lease");

  if (result.code === 0) {
    console.log(`Lease created successfully. Provider: ${bid.bidId.provider}`);
    return {
      id: BidID.toJSON(bid.bidId) as {
        owner: string;
        dseq: number;
        provider: string;
        gseq: number;
        oseq: number;
      }
    };
  }

  throw new Error(`Could not create lease: ${result.txHash}`);
}

async function getProviderUri(providerAddress: string, rpcEndpoint: string): Promise<string> {
  console.log(`Fetching provider URI for address: ${providerAddress}`);
  const rpc = await getRpc(rpcEndpoint);
  const providerClient = new QueryProviderClient(rpc);
  const providerRequest = QueryProviderRequest.fromPartial({
    owner: providerAddress
  });
  const providerResponse = await providerClient.Provider(providerRequest);

  if (!providerResponse.provider) {
    throw new Error(`Could not find provider ${providerAddress}`);
  }

  console.log(`Provider URI: ${providerResponse.provider.hostUri}`);
  return providerResponse.provider.hostUri;
}

async function sendManifest(
  sdl: SDL, 
  lease: Lease, 
  wallet: DirectSecp256k1HdWallet, 
  certificate: { cert: string; privateKey: string; publicKey: string },
  rpcEndpoint: string
): Promise<void> {
  console.log("Sending manifest...");
  if (!lease.id) {
    throw new Error("Lease ID is undefined");
  }

  const { dseq, provider } = lease.id;
  const manifest = sdl.manifestSortedJSON();

  const providerUri = await getProviderUri(provider, rpcEndpoint);
  const url = new URL(`/deployment/${dseq}/manifest`, providerUri);

  const agent = new https.Agent({
    cert: certificate.cert,
    key: certificate.privateKey,
    rejectUnauthorized: false // Note: This is not recommended for production use
  });

  const options: https.RequestOptions = {
    method: 'PUT',
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    agent: agent
  };

  console.log("Sending manifest with options:", JSON.stringify(options, null, 2));

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          console.log("Manifest sent successfully");
          resolve();
        } else {
          reject(new Error(`HTTP Error: ${res.statusCode} ${res.statusMessage}\n${data}`));
        }
      });
    });

    req.on('error', (error) => {
      console.error("Error sending manifest:", error);
      reject(error);
    });

    req.write(manifest);
    req.end();
  });
}

async function queryLeaseStatus(lease: Lease, providerUri: string, certificate: any): Promise<any> {
  console.log("Querying lease status...");
  console.log("Lease details:", JSON.stringify(lease, null, 2));
  console.log("Provider URI:", providerUri);

  if (!lease || !lease.id) {
    throw new Error("Invalid lease object");
  }

  const { dseq, gseq, oseq } = lease.id;

  const leasePath = `/lease/${dseq}/${gseq}/${oseq}/status`;
  console.log("Lease status path:", leasePath);

  const url = new URL(leasePath, providerUri);
  console.log("Full URL:", url.toString());

  const agent = new https.Agent({
    cert: certificate.cert,
    key: certificate.privateKey,
    rejectUnauthorized: false // Note: This is not recommended for production use
  });

  const options: https.RequestOptions = {
    method: 'GET',
    hostname: url.hostname,
    port: url.port,
    path: url.pathname + url.search,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    agent: agent
  };

  console.log("Request options:", JSON.stringify(options, null, 2));

  try {
    const result = await httpsRequest(options);
    if (result === null || result === undefined) {
      console.error("Error: Lease status query returned null or undefined.");
      return null;
    }
    console.log("Lease status result:", JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    console.error(`Error fetching lease status: ${error.message}`);
    if (error instanceof Error && error.stack) {
      console.error("Stack trace:", error.stack);
    }
    return null;
  }
}

export async function deploy() {
  console.log("Starting deployment process...");
  const { wallet, client, rpcEndpoint } = await connectToRpc();

  const certificateManager = CertificateManager.getInstance();
  await certificateManager.initialize(mnemonic, rpcEndpoint);
  console.log("CertificateManager initialized.");
  const certificate = await certificateManager.getOrCreateCertificate();
  console.log("Certificate obtained or created successfully.");

  const sdl = SDL.fromString(sdlContent, "beta3");
  console.log("SDL parsed successfully.");

  console.log("Creating deployment...");
  const deployment = await createDeployment(sdl, wallet, client);

  console.log("Creating lease...");
  const lease = await createLease(deployment, wallet, client, rpcEndpoint);

  console.log("Sending manifest...");
  try {
    await sendManifest(sdl, lease, wallet, certificate, rpcEndpoint);
    console.log("Manifest sent successfully!");
  } catch (error) {
    console.error("Error during deployment:", error);
    throw error;
  }

  console.log("Deployment process completed.");

  console.log("Performing final status check...");
  try {
    const providerUri = await getProviderUri(lease.id.provider, rpcEndpoint);
    const finalStatus = await queryLeaseStatus(lease, providerUri, certificate);
    console.log("Final deployment status:");
    console.log(JSON.stringify(finalStatus, null, 2));

    if (finalStatus === null || finalStatus === undefined) {
      console.error("Error: Lease status query returned null or undefined.");
      return;
    }

    if (finalStatus.services) {
      console.log("Services found in the lease status:");
      for (const [serviceName, serviceDetails] of Object.entries(finalStatus.services)) {
        console.log(`Service: ${serviceName}`);
        console.log(`Details: ${JSON.stringify(serviceDetails, null, 2)}`);
      }
    } else {
      console.log("No services found in the lease status.");
    }
    let publicUrl = null
    if (finalStatus.forwarded_ports) {
      for (const [serviceName, ports] of Object.entries(finalStatus.forwarded_ports)) {
        for (const port of ports) {
          publicUrl = `http://${port.host}:${port.externalPort}`;
          console.log(`Service ${serviceName} is available at: ${publicUrl}`);
          saveUrl(publicUrl);
          console.log(`Public URL saved: ${publicUrl}`);
        }
      }
      return {
        publicUrl: publicUrl, dseq: lease.id.dseq, provider: lease.id.provider
      }
    } else {
      console.log("No forwarded ports found in the final status check.");
      console.log("Full lease status:");
      console.log(JSON.stringify(finalStatus, null, 2));
    }

    // Additional check for lease readiness
    if (finalStatus.services) {
      for (const service of Object.values(finalStatus.services)) {
        if (service.available === 0 || service.total === 0) {
          console.log("Service is not yet ready. You may need to wait longer and check the status again.");
          break;
        }
      }
    }

  } catch (error) {
    console.error("Error fetching final status:", error);
  }
}

// Execute the deployment
// deploy().catch(console.error);































































// // File: deploy.ts

// import * as https from 'https';
// import { URL } from 'url';
// import { SigningStargateClient, StdFee } from "@cosmjs/stargate";
// import { DirectSecp256k1HdWallet, Registry } from "@cosmjs/proto-signing";
// import { MsgCreateDeployment } from "@akashnetwork/akash-api/akash/deployment/v1beta3";
// import { QueryClientImpl as QueryProviderClient, QueryProviderRequest } from "@akashnetwork/akash-api/akash/provider/v1beta3";
// import { QueryBidsRequest, QueryClientImpl as QueryMarketClient, MsgCreateLease, BidID } from "@akashnetwork/akash-api/akash/market/v1beta4";
// import { getRpc } from "@akashnetwork/akashjs/build/rpc";
// import { SDL } from "@akashnetwork/akashjs/build/sdl";
// import { getAkashTypeRegistry } from "@akashnetwork/akashjs/build/stargate";
// import CertificateManager from "./certificate-manager";
// import * as fs from 'fs';
// import { mnemonic } from './config-mnemonic';
// import { sdlContent } from './config-sdl';
// import { getNextRpcEndpoint } from './config-rpc';
// import { preferredProviders } from './providers';

// type Deployment = {
//   id: {
//     owner: string;
//     dseq: number;
//   };
// };

// type Lease = {
//   id: {
//     owner: string;
//     dseq: number;
//     provider: string;
//     gseq: number;
//     oseq: number;
//   };
// };

// const dseq = 0;
// const AVERAGE_GAS_PRICE = 0.0025;

// function sleep(ms: number) {
//   return new Promise(resolve => setTimeout(resolve, ms));
// }

// function saveUrl(url: string) {
//   const urlsFile = 'urls.json';
//   let urls = { deploymentUrls: [] as string[] };
//   if (fs.existsSync(urlsFile)) {
//     const data = fs.readFileSync(urlsFile, 'utf8');
//     urls = JSON.parse(data);
//   }
//   if (!urls.deploymentUrls.includes(url)) {
//     urls.deploymentUrls.push(url);
//     fs.writeFileSync(urlsFile, JSON.stringify(urls, null, 2));
//     console.log(`URL ${url} added to ${urlsFile}`);
//   } else {
//     console.log(`URL ${url} already exists in ${urlsFile}`);
//   }
// }

// async function httpsRequest(options: https.RequestOptions, body?: string): Promise<any> {
//   return new Promise((resolve, reject) => {
//     const req = https.request(options, (res) => {
//       let data = '';
//       res.on('data', (chunk) => data += chunk);
//       res.on('end', () => {
//         if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
//           resolve(JSON.parse(data));
//         } else {
//           reject(new Error(`HTTP Error: ${res.statusCode} ${res.statusMessage}`));
//         }
//       });
//     });

//     req.on('error', (error) => reject(error));

//     if (body) {
//       req.write(body);
//     }
//     req.end();
//   });
// }

// async function connectToRpc(): Promise<{ rpcEndpoint: string, client: SigningStargateClient }> {
//   const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "akash" });
//   const registry = getAkashTypeRegistry();

//   for (let i = 0; i < 5; i++) { // Try up to 5 times
//     const rpcEndpoint = getNextRpcEndpoint();
//     try {
//       console.log(`Attempting to connect to RPC endpoint: ${rpcEndpoint}`);
//       const client = await SigningStargateClient.connectWithSigner(rpcEndpoint, wallet, {
//         registry: new Registry(registry)
//       });
//       console.log(`Successfully connected to RPC endpoint: ${rpcEndpoint}`);
//       return { rpcEndpoint, client };
//     } catch (error) {
//       console.error(`Failed to connect to RPC endpoint ${rpcEndpoint}:`, error.message);
//     }
//   }
//   throw new Error("Failed to connect to any RPC endpoint after 5 attempts");
// }

// async function loadPrerequisites() {
//   console.log("Loading prerequisites...");
//   const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "akash" });
//   console.log("Wallet created successfully.");

//   const { rpcEndpoint, client } = await connectToRpc();

//   const certificateManager = CertificateManager.getInstance();
//   await certificateManager.initialize(mnemonic, rpcEndpoint);
//   console.log("CertificateManager initialized.");
//   const certificate = await certificateManager.getOrCreateCertificate();
//   console.log("Certificate obtained or created successfully.");

//   const sdl = SDL.fromString(sdlContent, "beta3");
//   console.log("SDL parsed successfully.");

//   return {
//     wallet,
//     client,
//     rpcEndpoint,
//     certificate,
//     sdl
//   };
// }

// async function simulateAndExecute(client: SigningStargateClient, address: string, msgs: any[], memo: string) {
//   console.log(`Simulating transaction for ${memo}...`);
//   const gasEstimation = await client.simulate(address, msgs, memo);
//   console.log(`Gas estimation completed. Estimated gas: ${gasEstimation}`);
  
//   const gasAdjustment = 1.3;
//   const adjustedGas = Math.ceil(gasEstimation * gasAdjustment);
  
//   // Use a fixed gas price (in uakt)
//   const gasPrice = 0.025;
  
//   const feeAmount = Math.ceil(adjustedGas * gasPrice);
  
//   const fee: StdFee = {
//     amount: [{ denom: "uakt", amount: feeAmount.toString() }],
//     gas: adjustedGas.toString()
//   };
//   console.log(`Transaction fee set. Amount: ${fee.amount[0].amount} ${fee.amount[0].denom}, Gas: ${fee.gas}`);

//   console.log(`Executing transaction for ${memo}...`);
//   const result = await client.signAndBroadcast(address, msgs, fee, memo);
//   console.log(`Transaction executed. Result code: ${result.code}, Transaction hash: ${result.transactionHash}`);
//   return result;
// }

// async function createDeployment(sdl: SDL, wallet: DirectSecp256k1HdWallet, client: SigningStargateClient) {
//   console.log("Creating deployment...");
//   const blockheight = await client.getHeight();
//   console.log(`Current block height: ${blockheight}`);

//   const groups = sdl.groups();
//   const accounts = await wallet.getAccounts();
//   console.log(`Deployment will be created for account: ${accounts[0].address}`);

//   if (dseq != 0) {
//     console.log(`Using provided dseq: ${dseq}`);
//     return {
//       id: {
//         owner: accounts[0].address,
//         dseq: dseq
//       },
//       groups: groups,
//       deposit: {
//         denom: "uakt",
//         amount: "1000000"
//       },
//       version: await sdl.manifestVersion(),
//       depositor: accounts[0].address
//     };
//   }

//   const deployment = {
//     id: {
//       owner: accounts[0].address,
//       dseq: blockheight
//     },
//     groups: groups,
//     deposit: {
//       denom: "uakt",
//       amount: "1000000"
//     },
//     version: await sdl.manifestVersion(),
//     depositor: accounts[0].address
//   };

//   const msg = {
//     typeUrl: "/akash.deployment.v1beta3.MsgCreateDeployment",
//     value: MsgCreateDeployment.fromPartial(deployment)
//   };

//   console.log("Sending create deployment transaction...");
//   const tx = await simulateAndExecute(client, accounts[0].address, [msg], "create deployment");

//   if (tx.code !== undefined && tx.code === 0) {
//     console.log(`Deployment created successfully. DSEQ: ${deployment.id.dseq}`);
//     return deployment;
//   }

//   throw new Error(`Could not create deployment: ${tx.rawLog} `);
// }

// async function fetchBid(dseq: number, owner: string, rpcEndpoint: string) {
//   console.log(`Fetching bids for deployment ${dseq}...`);
//   const rpc = await getRpc(rpcEndpoint);
//   const client = new QueryMarketClient(rpc);
//   const request = QueryBidsRequest.fromPartial({
//     filters: {
//       owner: owner,
//       dseq: dseq
//     }
//   });

//   console.log("Waiting 30 seconds for bids to accumulate...");
//   await sleep(30000);

//   const startTime = Date.now();
//   const timeout = 1000 * 60 * 5; // 5 minutes timeout

//   while (Date.now() - startTime < timeout) {
//     console.log("Fetching bids...");
//     const bids = await client.Bids(request);

//     if (bids.bids.length > 0) {
//       console.log(`Received ${bids.bids.length} bids. Logging all bid information:`);
      
//       bids.bids.forEach((bid, index) => {
//         console.log(`\nBid ${index + 1}:`);
//         console.log(`Provider: ${bid.bid?.bidId.provider}`);
//         console.log(`Price: ${bid.bid?.price.amount} ${bid.bid?.price.denom}`);
//         console.log("Bid Attributes:");
//         bid.bid?.bidAttributes?.forEach(attr => {
//           console.log(`  ${attr.key}: ${attr.value}`);
//         });
//       });

//       const validBids = bids.bids.filter(bid => bid.bid !== undefined);

//       if (validBids.length > 0) {
//         // First, check if any preferred providers have submitted a bid
//         const preferredBids = validBids.filter(bid => preferredProviders.includes(bid.bid!.bidId.provider));
        
//         if (preferredBids.length > 0) {
//           // If there are preferred bids, select the lowest among them
//           preferredBids.sort((a, b) => parseFloat(a.bid!.price.amount) - parseFloat(b.bid!.price.amount));
//           const selectedBid = preferredBids[0].bid!;
//           console.log(`Selected lowest bid from preferred provider ${selectedBid.bidId.provider} with price ${selectedBid.price.amount} ${selectedBid.price.denom}`);
//           return selectedBid;
//         } else {
//           // If no preferred providers have bid, select the lowest bid overall
//           validBids.sort((a, b) => parseFloat(a.bid!.price.amount) - parseFloat(b.bid!.price.amount));
//           const selectedBid = validBids[0].bid!;
//           console.log(`Selected lowest bid from provider ${selectedBid.bidId.provider} with price ${selectedBid.price.amount} ${selectedBid.price.denom}`);
//           return selectedBid;
//         }
//       } else {
//         console.log("No valid bids found. Waiting for more bids...");
//       }
//     } else {
//       console.log("No bids received yet. Waiting for bids...");
//     }

//     console.log("Waiting 5 seconds before checking for new bids...");
//     await sleep(5000);
//   }

//   throw new Error(`Could not fetch a suitable bid for deployment ${dseq}. Timeout reached.`);
// }

// async function createLease(deployment: Deployment, wallet: DirectSecp256k1HdWallet, client: SigningStargateClient, rpcEndpoint: string): Promise<Lease> {
//   console.log("Creating lease...");
//   const {
//     id: { dseq, owner }
//   } = deployment;
//   const bid = await fetchBid(dseq, owner, rpcEndpoint);
//   const accounts = await wallet.getAccounts();

//   if (bid.bidId === undefined) {
//     throw new Error("Bid ID is undefined");
//   }

//   const lease = {
//     bidId: bid.bidId
//   };

//   const msg = {
//     typeUrl: `/${MsgCreateLease.$type}`,
//     value: MsgCreateLease.fromPartial(lease)
//   };

//   console.log("Sending create lease transaction...");
//   const tx = await simulateAndExecute(client, accounts[0].address, [msg], "create lease");

//   if (tx.code !== undefined && tx.code === 0) {
//     console.log(`Lease created successfully. Provider: ${bid.bidId.provider}`);
//     return {
//       id: BidID.toJSON(bid.bidId) as {
//         owner: string;
//         dseq: number;
//         provider: string;
//         gseq: number;
//         oseq: number;
//       }
//     };
//   }

//   throw new Error(`Could not create lease: ${tx.rawLog} `);
// }

// async function getProviderUri(providerAddress: string, rpcEndpoint: string): Promise<string> {
//   console.log(`Fetching provider URI for address: ${providerAddress}`);
//   const rpc = await getRpc(rpcEndpoint);
//   const providerClient = new QueryProviderClient(rpc);
//   const providerRequest = QueryProviderRequest.fromPartial({
//     owner: providerAddress
//   });
//   const providerResponse = await providerClient.Provider(providerRequest);

//   if (!providerResponse.provider) {
//     throw new Error(`Could not find provider ${providerAddress}`);
//   }

//   console.log(`Provider URI: ${providerResponse.provider.hostUri}`);
//   return providerResponse.provider.hostUri;
// }

// async function sendManifest(
//   sdl: SDL, 
//   lease: Lease, 
//   wallet: DirectSecp256k1HdWallet, 
//   certificate: { cert: string; privateKey: string; publicKey: string },
//   rpcEndpoint: string
// ): Promise<void> {
//   console.log("Sending manifest...");
//   if (!lease.id) {
//     throw new Error("Lease ID is undefined");
//   }

//   const { dseq, provider } = lease.id;
//   const manifest = sdl.manifestSortedJSON();

//   const providerUri = await getProviderUri(provider, rpcEndpoint);
//   const url = new URL(`/deployment/${dseq}/manifest`, providerUri);

//   const agent = new https.Agent({
//     cert: certificate.cert,
//     key: certificate.privateKey,
//     rejectUnauthorized: false // Note: This is not recommended for production use
//   });

//   const options: https.RequestOptions = {
//     method: 'PUT',
//     hostname: url.hostname,
//     port: url.port,
//     path: url.pathname,
//     headers: {
//       'Content-Type': 'application/json',
//       'Accept': 'application/json',
//     },
//     agent: agent
//   };

//   console.log("Sending manifest with options:", JSON.stringify(options, null, 2));

//   return new Promise((resolve, reject) => {
//     const req = https.request(options, (res) => {
//       let data = '';
//       res.on('data', (chunk) => data += chunk);
//       res.on('end', () => {
//         if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
//           console.log("Manifest sent successfully");
//           resolve();
//         } else {
//           reject(new Error(`HTTP Error: ${res.statusCode} ${res.statusMessage}\n${data}`));
//         }
//       });
//     });

//     req.on('error', (error) => {
//       console.error("Error sending manifest:", error);
//       reject(error);
//     });

//     req.write(manifest);
//     req.end();
//   });
// }

// async function queryLeaseStatus(lease: Lease, providerUri: string, certificate: any): Promise<any> {
//   console.log("Querying lease status...");
//   console.log("Lease details:", JSON.stringify(lease, null, 2));
//   console.log("Provider URI:", providerUri);

//   if (!lease || !lease.id) {
//     throw new Error("Invalid lease object");
//   }

//   const { dseq, gseq, oseq } = lease.id;

//   const leasePath = `/lease/${dseq}/${gseq}/${oseq}/status`;
//   console.log("Lease status path:", leasePath);

//   const url = new URL(leasePath, providerUri);
//   console.log("Full URL:", url.toString());

//   const agent = new https.Agent({
//     cert: certificate.cert,
//     key: certificate.privateKey,
//     rejectUnauthorized: false // Note: This is not recommended for production use
//   });

//   const options: https.RequestOptions = {
//     method: 'GET',
//     hostname: url.hostname,
//     port: url.port,
//     path: url.pathname + url.search,
//     headers: {
//       'Content-Type': 'application/json',
//       'Accept': 'application/json',
//     },
//     agent: agent
//   };

//   console.log("Request options:", JSON.stringify(options, null, 2));

//   try {
//     const result = await httpsRequest(options);
//     if (result === null || result === undefined) {
//       console.error("Error: Lease status query returned null or undefined.");
//       return null;
//     }
//     console.log("Lease status result:", JSON.stringify(result, null, 2));
//     return result;
//   } catch (error) {
//     console.error(`Error fetching lease status: ${error.message}`);
//     if (error instanceof Error && error.stack) {
//       console.error("Stack trace:", error.stack);
//     }
//     return null;
//   }
// }

// export async function deploy() {
//   console.log("Starting deployment process...");
//   const { wallet, client, rpcEndpoint, certificate, sdl } = await loadPrerequisites();

//   console.log("Creating deployment...");
//   const deployment = await createDeployment(sdl, wallet, client);

//   console.log("Creating lease...");
//   const lease = await createLease(deployment, wallet, client, rpcEndpoint);

//   console.log("Sending manifest...");
//   try {
//     await sendManifest(sdl, lease, wallet, certificate, rpcEndpoint);
//     console.log("Manifest sent successfully!");
//   } catch (error) {
//     console.error("Error during deployment:", error);
//     throw error;
//   }

//   console.log("Deployment process completed.");

//   console.log("Performing final status check...");
//   try {
//     const providerUri = await getProviderUri(lease.id.provider, rpcEndpoint);
//     const finalStatus = await queryLeaseStatus(lease, providerUri, certificate);
//     console.log("Final deployment status:");
//     console.log(JSON.stringify(finalStatus, null, 2));

//     if (finalStatus === null || finalStatus === undefined) {
//       console.error("Error: Lease status query returned null or undefined.");
//       return;
//     }

//     if (finalStatus.services) {
//       console.log("Services found in the lease status:");
//       for (const [serviceName, serviceDetails] of Object.entries(finalStatus.services)) {
//         console.log(`Service: ${serviceName}`);
//         console.log(`Details: ${JSON.stringify(serviceDetails, null, 2)}`);
//       }
//     } else {
//       console.log("No services found in the lease status.");
//     }
//     let publicUrl = null
//     if (finalStatus.forwarded_ports) {
//       for (const [serviceName, ports] of Object.entries(finalStatus.forwarded_ports)) {
//         for (const port of ports) {
//           publicUrl = `http://${port.host}:${port.externalPort}`;
//           console.log(`Service ${serviceName} is available at: ${publicUrl}`);
//           saveUrl(publicUrl);
//           console.log(`Public URL saved: ${publicUrl}`);
//         }
//       }
//       return{
//         publicUrl: publicUrl, dseq: lease.id.dseq, provider: lease.id.provider}
//     } else {
//       console.log("No forwarded ports found in the final status check.");
//       console.log("Full lease status:");
//       console.log(JSON.stringify(finalStatus, null, 2));
//     }

//     // Additional check for lease readiness
//     if (finalStatus.services) {
//       for (const service of Object.values(finalStatus.services)) {
//         if (service.available === 0 || service.total === 0) {
    
//       console.log("Service is not yet ready. You may need to wait longer and check the status again.");
//           break;
//         }
//       }
//     }

//   } catch (error) {
//     console.error("Error fetching final status:", error);
//   }
// }






































// import * as https from 'https';
// import { URL } from 'url';
// import { SigningStargateClient, StdFee } from "@cosmjs/stargate";
// import { DirectSecp256k1HdWallet, Registry } from "@cosmjs/proto-signing";
// import { MsgCreateDeployment } from "@akashnetwork/akash-api/akash/deployment/v1beta3";
// import { QueryClientImpl as QueryProviderClient, QueryProviderRequest } from "@akashnetwork/akash-api/akash/provider/v1beta3";
// import { QueryBidsRequest, QueryClientImpl as QueryMarketClient, MsgCreateLease, BidID } from "@akashnetwork/akash-api/akash/market/v1beta4";
// import { getRpc } from "@akashnetwork/akashjs/build/rpc";
// import { SDL } from "@akashnetwork/akashjs/build/sdl";
// import { getAkashTypeRegistry } from "@akashnetwork/akashjs/build/stargate";
// import CertificateManager from "./certificate-manager";
// import * as fs from 'fs';
// import { config } from './config';
// import { preferredProviders } from './providers';

// type Deployment = {
//   id: {
//     owner: string;
//     dseq: number;
//   };
// };

// type Lease = {
//   id: {
//     owner: string;
//     dseq: number;
//     provider: string;
//     gseq: number;
//     oseq: number;
//   };
// };

// const dseq = 0;

// function sleep(ms: number) {
//   return new Promise(resolve => setTimeout(resolve, ms));
// }

// function saveUrl(url: string) {
//   const urlsFile = 'urls.json';
//   let urls = { deploymentUrls: [] as string[] };
//   if (fs.existsSync(urlsFile)) {
//     const data = fs.readFileSync(urlsFile, 'utf8');
//     urls = JSON.parse(data);
//   }
//   urls.deploymentUrls.push(url);
//   fs.writeFileSync(urlsFile, JSON.stringify(urls, null, 2));
// }

// async function httpsRequest(options: https.RequestOptions, body?: string): Promise<any> {
//   return new Promise((resolve, reject) => {
//     const req = https.request(options, (res) => {
//       let data = '';
//       res.on('data', (chunk) => data += chunk);
//       res.on('end', () => {
//         if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
//           resolve(JSON.parse(data));
//         } else {
//           reject(new Error(`HTTP Error: ${res.statusCode} ${res.statusMessage}`));
//         }
//       });
//     });

//     req.on('error', (error) => reject(error));

//     if (body) {
//       req.write(body);
//     }
//     req.end();
//   });
// }

// async function loadPrerequisites(mnemonic: string, sdlContent: string, rpcEndpoint: string) {
//   console.log("Loading prerequisites...");
//   const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "akash" });
//   console.log("Wallet created successfully.");

//   const registry = getAkashTypeRegistry();
//   console.log("Akash type registry obtained.");

//   const client = await SigningStargateClient.connectWithSigner(rpcEndpoint, wallet, {
//     registry: new Registry(registry)
//   });
//   console.log("SigningStargateClient connected successfully.");

//   const certificateManager = CertificateManager.getInstance();
//   await certificateManager.initialize(mnemonic, rpcEndpoint);
//   console.log("CertificateManager initialized.");
//   const certificate = await certificateManager.getOrCreateCertificate();
//   console.log("Certificate obtained or created successfully.");

//   const sdl = SDL.fromString(sdlContent, "beta3");
//   console.log("SDL parsed successfully.");

//   return {
//     wallet,
//     client,
//     certificate,
//     sdl
//   };
// }

// async function simulateAndExecute(client: SigningStargateClient, address: string, msgs: any[], memo: string) {
//   console.log(`Simulating transaction for ${memo}...`);
//   const gasEstimation = await client.simulate(address, msgs, memo);
//   console.log(`Gas estimation completed. Estimated gas: ${gasEstimation}`);
  
//   const fee: StdFee = {
//     amount: [{ denom: "uakt", amount: "50000" }],
//     gas: Math.ceil(gasEstimation * 1.3).toString()
//   };
//   console.log(`Transaction fee set. Amount: ${fee.amount[0].amount} ${fee.amount[0].denom}, Gas: ${fee.gas}`);

//   console.log(`Executing transaction for ${memo}...`);
//   const result = await client.signAndBroadcast(address, msgs, fee, memo);
//   console.log(`Transaction executed. Result code: ${result.code}, Transaction hash: ${result.transactionHash}`);
//   return result;
// }

// async function createDeployment(sdl: SDL, wallet: DirectSecp256k1HdWallet, client: SigningStargateClient) {
//   console.log("Creating deployment...");
//   const blockheight = await client.getHeight();
//   console.log(`Current block height: ${blockheight}`);

//   const groups = sdl.groups();
//   const accounts = await wallet.getAccounts();
//   console.log(`Deployment will be created for account: ${accounts[0].address}`);

//   if (dseq != 0) {
//     console.log(`Using provided dseq: ${dseq}`);
//     return {
//       id: {
//         owner: accounts[0].address,
//         dseq: dseq
//       },
//       groups: groups,
//       deposit: {
//         denom: "uakt",
//         amount: "1000000"
//       },
//       version: await sdl.manifestVersion(),
//       depositor: accounts[0].address
//     };
//   }

//   const deployment = {
//     id: {
//       owner: accounts[0].address,
//       dseq: blockheight
//     },
//     groups: groups,
//     deposit: {
//       denom: "uakt",
//       amount: "1000000"
//     },
//     version: await sdl.manifestVersion(),
//     depositor: accounts[0].address
//   };

//   const msg = {
//     typeUrl: "/akash.deployment.v1beta3.MsgCreateDeployment",
//     value: MsgCreateDeployment.fromPartial(deployment)
//   };

//   console.log("Sending create deployment transaction...");
//   const tx = await simulateAndExecute(client, accounts[0].address, [msg], "create deployment");

//   if (tx.code !== undefined && tx.code === 0) {
//     console.log(`Deployment created successfully. DSEQ: ${deployment.id.dseq}`);
//     return deployment;
//   }

//   throw new Error(`Could not create deployment: ${tx.rawLog} `);
// }

// async function fetchBid(dseq: number, owner: string, rpcEndpoint: string) {
//   console.log(`Fetching bids for deployment ${dseq}...`);
//   const rpc = await getRpc(rpcEndpoint);
//   const client = new QueryMarketClient(rpc);
//   const request = QueryBidsRequest.fromPartial({
//     filters: {
//       owner: owner,
//       dseq: dseq
//     }
//   });

//   console.log("Waiting 30 seconds for bids to accumulate...");
//   await sleep(30000);

//   const startTime = Date.now();
//   const timeout = 1000 * 60 * 5; // 5 minutes timeout

//   while (Date.now() - startTime < timeout) {
//     console.log("Fetching bids...");
//     const bids = await client.Bids(request);

//     if (bids.bids.length > 0) {
//       console.log(`Received ${bids.bids.length} bids. Logging all bid information:`);
      
//       bids.bids.forEach((bid, index) => {
//         console.log(`\nBid ${index + 1}:`);
//         console.log(`Provider: ${bid.bid?.bidId.provider}`);
//         console.log(`Price: ${bid.bid?.price.amount} ${bid.bid?.price.denom}`);
//         console.log("Bid Attributes:");
//         bid.bid?.bidAttributes?.forEach(attr => {
//           console.log(`  ${attr.key}: ${attr.value}`);
//         });
//       });

//       const validBids = bids.bids.filter(bid => bid.bid !== undefined);

//       if (validBids.length > 0) {
//         // First, check if any preferred providers have submitted a bid
//         const preferredBids = validBids.filter(bid => preferredProviders.includes(bid.bid!.bidId.provider));
        
//         if (preferredBids.length > 0) {
//           // If there are preferred bids, select the lowest among them
//           preferredBids.sort((a, b) => parseFloat(a.bid!.price.amount) - parseFloat(b.bid!.price.amount));
//           const selectedBid = preferredBids[0].bid!;
//           console.log(`Selected lowest bid from preferred provider ${selectedBid.bidId.provider} with price ${selectedBid.price.amount} ${selectedBid.price.denom}`);
//           return selectedBid;
//         } else {
//           // If no preferred providers have bid, select the lowest bid overall
//           validBids.sort((a, b) => parseFloat(a.bid!.price.amount) - parseFloat(b.bid!.price.amount));
//           const selectedBid = validBids[0].bid!;
//           console.log(`Selected lowest bid from provider ${selectedBid.bidId.provider} with price ${selectedBid.price.amount} ${selectedBid.price.denom}`);
//           return selectedBid;
//         }
//       } else {
//         console.log("No valid bids found. Waiting for more bids...");
//       }
//     } else {
//       console.log("No bids received yet. Waiting for bids...");
//     }

//     console.log("Waiting 5 seconds before checking for new bids...");
//     await sleep(5000);
//   }

//   throw new Error(`Could not fetch a suitable bid for deployment ${dseq}. Timeout reached.`);
// }

// async function createLease(deployment: Deployment, wallet: DirectSecp256k1HdWallet, client: SigningStargateClient, rpcEndpoint: string): Promise<Lease> {
//   console.log("Creating lease...");
//   const {
//     id: { dseq, owner }
//   } = deployment;
//   const bid = await fetchBid(dseq, owner, rpcEndpoint);
//   const accounts = await wallet.getAccounts();

//   if (bid.bidId === undefined) {
//     throw new Error("Bid ID is undefined");
//   }

//   const lease = {
//     bidId: bid.bidId
//   };

//   const msg = {
//     typeUrl: `/${MsgCreateLease.$type}`,
//     value: MsgCreateLease.fromPartial(lease)
//   };

//   console.log("Sending create lease transaction...");
//   const tx = await simulateAndExecute(client, accounts[0].address, [msg], "create lease");

//   if (tx.code !== undefined && tx.code === 0) {
//     console.log(`Lease created successfully. Provider: ${bid.bidId.provider}`);
//     return {
//       id: BidID.toJSON(bid.bidId) as {
//         owner: string;
//         dseq: number;
//         provider: string;
//         gseq: number;
//         oseq: number;
//       }
//     };
//   }

//   throw new Error(`Could not create lease: ${tx.rawLog} `);
// }

// async function getProviderUri(providerAddress: string, rpcEndpoint: string): Promise<string> {
//   console.log(`Fetching provider URI for address: ${providerAddress}`);
//   const rpc = await getRpc(rpcEndpoint);
//   const providerClient = new QueryProviderClient(rpc);
//   const providerRequest = QueryProviderRequest.fromPartial({
//     owner: providerAddress
//   });
//   const providerResponse = await providerClient.Provider(providerRequest);

//   if (!providerResponse.provider) {
//     throw new Error(`Could not find provider ${providerAddress}`);
//   }

//   console.log(`Provider URI: ${providerResponse.provider.hostUri}`);
//   return providerResponse.provider.hostUri;
// }

// async function sendManifest(
//   sdl: SDL, 
//   lease: Lease, 
//   wallet: DirectSecp256k1HdWallet, 
//   certificate: { cert: string; privateKey: string; publicKey: string },
//   rpcEndpoint: string
// ): Promise<void> {
//   console.log("Sending manifest...");
//   if (!lease.id) {
//     throw new Error("Lease ID is undefined");
//   }

//   const { dseq, provider } = lease.id;
//   const manifest = sdl.manifestSortedJSON();

//   const providerUri = await getProviderUri(provider, rpcEndpoint);
//   const url = new URL(`/deployment/${dseq}/manifest`, providerUri);

//   const agent = new https.Agent({
//     cert: certificate.cert,
//     key: certificate.privateKey,
//     rejectUnauthorized: false // Note: This is not recommended for production use
//   });

//   const options: https.RequestOptions = {
//     method: 'PUT',
//     hostname: url.hostname,
//     port: url.port,
//     path: url.pathname,
//     headers: {
//       'Content-Type': 'application/json',
//       'Accept': 'application/json',
//     },
//     agent: agent
//   };

//   console.log("Sending manifest with options:", JSON.stringify(options, null, 2));

//   return new Promise((resolve, reject) => {
//     const req = https.request(options, (res) => {
//       let data = '';
//       res.on('data', (chunk) => data += chunk);
//       res.on('end', () => {
//         if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
//           console.log("Manifest sent successfully");
//           resolve();
//         } else {
//           reject(new Error(`HTTP Error: ${res.statusCode} ${res.statusMessage}\n${data}`));
//         }
//       });
//     });

//     req.on('error', (error) => {
//       console.error("Error sending manifest:", error);
//       reject(error);
//     });

//     req.write(manifest);
//     req.end();
//   });
// }

// async function queryLeaseStatus(lease: Lease, providerUri: string, certificate: any): Promise<any> {
//     console.log("Querying lease status...");
//     console.log("Lease details:", JSON.stringify(lease, null, 2));
//     console.log("Provider URI:", providerUri);
  
//     if (!lease || !lease.id) {
//       throw new Error("Invalid lease object");
//     }
  
//     const { dseq, gseq, oseq } = lease.id;
  
//     const leasePath = `/lease/${dseq}/${gseq}/${oseq}/status`;
//     console.log("Lease status path:", leasePath);
  
//     const url = new URL(leasePath, providerUri);
//     console.log("Full URL:", url.toString());
  
//     const agent = new https.Agent({
//       cert: certificate.cert,
//       key: certificate.privateKey,
//       rejectUnauthorized: false // Note: This is not recommended for production use
//     });
  
//     const options: https.RequestOptions = {
//       method: 'GET',
//       hostname: url.hostname,
//       port: url.port,
//       path: url.pathname + url.search,
//       headers: {
//         'Content-Type': 'application/json',
//         'Accept': 'application/json',
//       },
//       agent: agent
//     };
  
//     console.log("Request options:", JSON.stringify(options, null, 2));
  
//     try {
//       const result = await httpsRequest(options);
//       if (result === null || result === undefined) {
//         console.error("Error: Lease status query returned null or undefined.");
//         return null;
//       }
//       console.log("Lease status result:", JSON.stringify(result, null, 2));
//       return result;
//     } catch (error) {
//       console.error(`Error fetching lease status: ${error.message}`);
//       if (error instanceof Error && error.stack) {
//         console.error("Stack trace:", error.stack);
//       }
//       return null;
//     }
//   }
  
//   async function deploy() {
//     console.log("Starting deployment process...");
//     const { wallet, client, certificate, sdl } = await loadPrerequisites(config.mnemonic, config.sdlContent, config.rpcEndpoint);
  
//     console.log("Creating deployment...");
//     const deployment = await createDeployment(sdl, wallet, client);
  
//     console.log("Creating lease...");
//     const lease = await createLease(deployment, wallet, client, config.rpcEndpoint);
  
//     console.log("Sending manifest...");
//     try {
//       await sendManifest(sdl, lease, wallet, certificate, config.rpcEndpoint);
//       console.log("Manifest sent successfully!");
//     } catch (error) {
//       console.error("Error during deployment:", error);
//       throw error;
//     }
  
//     console.log("Deployment process completed.");
  
//     console.log("Performing final status check...");
//     try {
//       const providerUri = await getProviderUri(lease.id.provider, config.rpcEndpoint);
//       const finalStatus = await queryLeaseStatus(lease, providerUri, certificate);
//       console.log("Final deployment status:");
//       console.log(JSON.stringify(finalStatus, null, 2));
  
//       if (finalStatus === null || finalStatus === undefined) {
//         console.error("Error: Lease status query returned null or undefined.");
//         return;
//       }
  
//       if (finalStatus.services) {
//         console.log("Services found in the lease status:");
//         for (const [serviceName, serviceDetails] of Object.entries(finalStatus.services)) {
//           console.log(`Service: ${serviceName}`);
//           console.log(`Details: ${JSON.stringify(serviceDetails, null, 2)}`);
//         }
//       } else {
//         console.log("No services found in the lease status.");
//       }
  
//       if (finalStatus.forwarded_ports) {
//         for (const [serviceName, ports] of Object.entries(finalStatus.forwarded_ports)) {
//           for (const port of ports) {
//             const publicUrl = `http://${port.host}:${port.externalPort}`;
//             console.log(`Service ${serviceName} is available at: ${publicUrl}`);
//             saveUrl(publicUrl);
//             console.log(`Public URL saved: ${publicUrl}`);
//           }
//         }
//       } else {
//         console.log("No forwarded ports found in the final status check.");
//         console.log("Full lease status:");
//         console.log(JSON.stringify(finalStatus, null, 2));
//       }
  
//       // Additional check for lease readiness
//       if (finalStatus.services) {
//         for (const service of Object.values(finalStatus.services)) {
//           if (service.available === 0 || service.total === 0) {
//             console.log("Service is not yet ready. You may need to wait longer and check the status again.");
//             break;
//           }
//         }
//       }
  
//     } catch (error) {
//       console.error("Error fetching final status:", error);
//     }
//   }
  
//   function saveUrl(url: string) {
//     const urlsFile = 'urls.json';
//     let urls = { deploymentUrls: [] as string[] };
//     if (fs.existsSync(urlsFile)) {
//       const data = fs.readFileSync(urlsFile, 'utf8');
//       urls = JSON.parse(data);
//     }
//     if (!urls.deploymentUrls.includes(url)) {
//       urls.deploymentUrls.push(url);
//       fs.writeFileSync(urlsFile, JSON.stringify(urls, null, 2));
//       console.log(`URL ${url} added to ${urlsFile}`);
//     } else {
//       console.log(`URL ${url} already exists in ${urlsFile}`);
//     }
//   }
  
//   // Execute the deployment
//   deploy().catch(console.error);