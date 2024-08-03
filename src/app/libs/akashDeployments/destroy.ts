import { DirectSecp256k1HdWallet, Registry } from "@cosmjs/proto-signing";
import { SigningStargateClient } from "@cosmjs/stargate";
import { MsgCloseDeployment, QueryDeploymentsResponse, QueryDeploymentsRequest, QueryClientImpl, QueryDeploymentRequest } from "@akashnetwork/akash-api/akash/deployment/v1beta3";
import { getAkashTypeRegistry, getTypeUrl } from "@akashnetwork/akashjs/build/stargate";
import { getRpc } from "@akashnetwork/akashjs/build/rpc";

// Import mnemonic from config file
import { mnemonic } from './config-mnemonic';

// Import RPC endpoint functions
import { getNextRpcEndpoint } from './config-rpc';

interface TakeDownResult {
  success: boolean;
  message: string;
  dseq?: string;
  transactionHash?: string;
}

export async function takeDownDeployment(dseqs?: string | string[]): Promise<TakeDownResult[]> {
  console.log("Starting deployment takedown process...");
  
  try {
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "akash" });
    console.log("Wallet created successfully.");
    
    const [account] = await wallet.getAccounts();
    console.log(`Using account address: ${account.address}`);

    const myRegistry = new Registry(getAkashTypeRegistry());
    console.log("Registry created with Akash type registry.");

    let client: SigningStargateClient | null = null;
    let rpcEndpoint: string | null = null;

    // Try connecting to RPC endpoints until successful
    for (let i = 0; i < 5; i++) {
      rpcEndpoint = getNextRpcEndpoint();
      console.log(`Attempting to connect to RPC endpoint: ${rpcEndpoint}`);
      try {
        client = await Promise.race([
          SigningStargateClient.connectWithSigner(rpcEndpoint, wallet, { registry: myRegistry }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Connection timeout")), 15000))
        ]) as SigningStargateClient;
        console.log("Connected to RPC endpoint successfully.");
        break;
      } catch (error) {
        console.error(`Failed to connect to ${rpcEndpoint}:`, error);
      }
    }

    if (!client || !rpcEndpoint) {
      throw new Error("Failed to connect to any RPC endpoint");
    }

    console.log("Initializing query client...");
    const queryClient = new QueryClientImpl(await getRpc(rpcEndpoint));
    console.log("Query client initialized.");

    let deploymentsToClose: { dseq: string }[] = [];

    if (dseqs) {
      const dseqArray = Array.isArray(dseqs) ? dseqs : [dseqs];
      for (const dseq of dseqArray) {
        console.log(`Checking existence of deployment with dseq: ${dseq}`);
        const deploymentRequest = QueryDeploymentRequest.fromJSON({
          id: {
            owner: account.address,
            dseq: dseq
          }
        });
        try {
          await queryClient.Deployment(deploymentRequest);
          deploymentsToClose.push({ dseq });
          console.log(`Deployment with dseq ${dseq} exists and will be closed.`);
        } catch (error) {
          console.log(`Deployment with dseq ${dseq} does not exist or cannot be accessed.`);
        }
      }
    } else {
      console.log("Fetching all deployments for the account...");
      const request = QueryDeploymentsRequest.fromJSON({
        filters: {
          owner: account.address
        }
      });
      const response = await queryClient.Deployments(request);
      const deployments = QueryDeploymentsResponse.toJSON(response).deployments;

      if (!deployments || deployments.length === 0) {
        console.log("No deployments found for this account.");
        return [{
          success: false,
          message: "No deployments found for this account."
        }];
      }

      deploymentsToClose = deployments.map(d => ({ dseq: d.deployment.deploymentId.dseq }));
      console.log(`Found ${deploymentsToClose.length} deployments to close.`);
    }

    let results: TakeDownResult[] = [];

    for (const deployment of deploymentsToClose) {
      console.log(`Preparing to close deployment with dseq: ${deployment.dseq}`);

      const message = MsgCloseDeployment.fromPartial({
        id: {
          dseq: deployment.dseq,
          owner: account.address
        }
      });

      const msgAny = {
        typeUrl: getTypeUrl(MsgCloseDeployment),
        value: message
      };

      console.log("Simulating transaction to estimate gas...");
      const simulatedGas = await client.simulate(account.address, [msgAny], "take down deployment");
      const gasWithBuffer = Math.floor(simulatedGas * 1.1); // Add 10% buffer
      console.log(`Estimated gas: ${simulatedGas}, Gas with buffer: ${gasWithBuffer}`);

      const fee = {
        amount: [{ denom: "uakt", amount: "20000" }],
        gas: gasWithBuffer.toString()
      };

      console.log("Signing and broadcasting transaction...");
      try {
        const result = await client.signAndBroadcast(account.address, [msgAny], fee, "take down deployment");
        console.log(`Deployment ${deployment.dseq} taken down. Transaction hash: ${result.transactionHash}`);
        results.push({
          success: true,
          message: `Deployment ${deployment.dseq} taken down successfully.`,
          dseq: deployment.dseq,
          transactionHash: result.transactionHash
        });
      } catch (error) {
        console.error(`Error taking down deployment ${deployment.dseq}:`, error);
        results.push({
          success: false,
          message: `Error taking down deployment ${deployment.dseq}: ${error}`,
          dseq: deployment.dseq
        });
      }
    }

    console.log("Deployment takedown process completed.");
    return results;
  } catch (error) {
    console.error("An error occurred during the takedown process:", error);
    return [{
      success: false,
      message: `An error occurred during the takedown process: ${error}`
    }];
  }
}