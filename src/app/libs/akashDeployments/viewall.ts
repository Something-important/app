import { DirectSecp256k1HdWallet } from "@cosmjs/proto-signing";
import { 
  QueryDeploymentsResponse, 
  QueryDeploymentsRequest, 
  QueryClientImpl as QueryDeploymentClient,
  QueryDeploymentRequest,
  QueryDeploymentResponse
} from "@akashnetwork/akash-api/akash/deployment/v1beta3";
import { getRpc } from "@akashnetwork/akashjs/build/rpc";

class AkashDeploymentFetcher {
  private wallet: DirectSecp256k1HdWallet;
  private queryClient: QueryDeploymentClient;

  constructor(private mnemonic: string, private rpcEndpoint: string) {}

  async initialize() {
    this.wallet = await DirectSecp256k1HdWallet.fromMnemonic(this.mnemonic, { prefix: "akash" });
    const rpc = await getRpc(this.rpcEndpoint);
    this.queryClient = new QueryDeploymentClient(rpc);
  }

  async fetchDeployments() {
    const [account] = await this.wallet.getAccounts();
    const owner = account.address;

    try {
      const request = QueryDeploymentsRequest.fromJSON({
        filters: {
          owner: owner
        }
      });

      const response = await this.queryClient.Deployments(request);
      const data = QueryDeploymentsResponse.toJSON(response);
      return data.deployments;
    } catch (error) {
      console.error("Error fetching deployments:", error);
      throw error;
    }
  }

  async getDeploymentDetails(dseq: string) {
    const [account] = await this.wallet.getAccounts();
    const owner = account.address;

    try {
      const request = QueryDeploymentRequest.fromJSON({
        id: {
          owner: owner,
          dseq: dseq
        }
      });

      const response = await this.queryClient.Deployment(request);
      const data = QueryDeploymentResponse.toJSON(response);
      return data.deployment;
    } catch (error) {
      console.error(`Error fetching details for deployment ${dseq}:`, error);
      throw error;
    }
  }
}

async function main() {
  const mnemonic = "unusual daring umbrella wealth castle embrace staff end expose because core move hamster old boost sense tonight million concert pond once assault brief viable";
  const rpcEndpoint = "https://rpc.akash.forbole.com:443";

  const fetcher = new AkashDeploymentFetcher(mnemonic, rpcEndpoint);
  await fetcher.initialize();

  try {
    const deployments = await fetcher.fetchDeployments();
    console.log("All deployments:", deployments);

    if (deployments && deployments.length > 0) {
      for (const deployment of deployments) {
        if (deployment.deployment && deployment.deployment.deploymentId) {
          const details = await fetcher.getDeploymentDetails(deployment.deployment.deploymentId.dseq);
          console.log(`Details for deployment ${deployment.deployment.deploymentId.dseq}:`, details);
        } else {
          console.log("Deployment or deploymentId is undefined:", deployment);
        }
      }
    } else {
      console.log("No deployments found.");
    }
  } catch (error) {
    console.error("Error in fetching process:", error);
  }
}

main().catch(console.error);