// AkashDeploymentFetcher.ts
import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { 
  QueryDeploymentsResponse, 
  QueryDeploymentsRequest, 
  QueryClientImpl as QueryDeploymentClient
} from "@akashnetwork/akash-api/akash/deployment/v1beta3";
import { 
  QueryClientImpl as QueryMarketClient,
  QueryLeasesRequest,
  QueryLeasesResponse,
  QueryBidsRequest,
  QueryBidsResponse
} from "@akashnetwork/akash-api/akash/market/v1beta4";
import { getRpc } from "@akashnetwork/akashjs/build/rpc";

export class AkashDeploymentFetcher {
  private wallet: DirectSecp256k1HdWallet;
  private deploymentClient: QueryDeploymentClient;
  private marketClient: QueryMarketClient;
  private rpcEndpoint: string;

  constructor(private mnemonic: string, rpcEndpoint: string) {
    this.rpcEndpoint = rpcEndpoint;
  }

  async initialize(): Promise<void> {
    this.wallet = await DirectSecp256k1HdWallet.fromMnemonic(this.mnemonic, { prefix: "akash" });
    await this.updateRpcEndpoint(this.rpcEndpoint);
  }

  async updateRpcEndpoint(newRpcEndpoint: string): Promise<void> {
    this.rpcEndpoint = newRpcEndpoint;
    const rpc = await getRpc(this.rpcEndpoint);
    this.deploymentClient = new QueryDeploymentClient(rpc);
    this.marketClient = new QueryMarketClient(rpc);
  }

  async fetchActiveDeployments(): Promise<any[]> {
    const [account] = await this.wallet.getAccounts();
    const owner = account.address;

    try {
      const request = QueryDeploymentsRequest.fromPartial({
        filters: {
          owner: owner,
          state: 'active'
        }
      });

      const response = await this.deploymentClient.Deployments(request);
      const data = QueryDeploymentsResponse.toJSON(response);
      return data.deployments;
    } catch (error) {
      console.error("Error fetching active deployments:", error);
      throw error;
    }
  }

  async getLeaseStatus(owner: string, dseq: string): Promise<any | null> {
    try {
      const request = QueryLeasesRequest.fromPartial({
        filters: {
          owner: owner,
          dseq: dseq
        }
      });

      const response = await this.marketClient.Leases(request);
      const data = QueryLeasesResponse.toJSON(response);
      
      if (data.leases && data.leases.length > 0) {
        return data.leases[0];  // Assuming we're interested in the first lease
      } else {
        console.log(`No leases found for deployment ${dseq}`);
        return null;
      }
    } catch (error) {
      console.error(`Error fetching lease status for deployment ${dseq}:`, error);
      return null;
    }
  }

  async checkBidsForDeployment(owner: string, dseq: string): Promise<void> {
    try {
      const request = QueryBidsRequest.fromPartial({
        filters: {
          owner: owner,
          dseq: dseq
        }
      });

      const response = await this.marketClient.Bids(request);
      const data = QueryBidsResponse.toJSON(response);
      
      if (data.bids && data.bids.length > 0) {
        console.log(`Found ${data.bids.length} bid(s) for deployment ${dseq}:`);
        data.bids.forEach((bid, index) => {
          console.log(`Bid ${index + 1}:`);
          console.log(`  Provider: ${bid.bid.bidId.provider}`);
          console.log(`  Price: ${bid.bid.price.amount} ${bid.bid.price.denom}`);
          console.log(`  Created At: ${bid.bid.createdAt}`);
        });
      } else {
        console.log(`No bids found for deployment ${dseq}`);
      }
    } catch (error) {
      console.error(`Error checking bids for deployment ${dseq}:`, error);
    }
  }
}