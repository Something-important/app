import { DirectSecp256k1HdWallet, Registry } from "@cosmjs/proto-signing";
import { SigningStargateClient } from "@cosmjs/stargate";
import { getAkashTypeRegistry } from "@akashnetwork/akashjs/build/stargate";
import { certificateManager } from "@akashnetwork/akashjs/build/certificates/certificate-manager";
import * as cert from "@akashnetwork/akashjs/build/certificates";
import * as fs from 'fs';

class CertificateManager {
  private static instance: CertificateManager;
  private certificate: any = null;
  public wallet: DirectSecp256k1HdWallet;
  public client: SigningStargateClient;

  private constructor() {}

  public static getInstance(): CertificateManager {
    if (!CertificateManager.instance) {
      CertificateManager.instance = new CertificateManager();
    }
    return CertificateManager.instance;
  }

  public async initialize(mnemonic: string, rpcEndpoint: string) {
    console.log("Initializing CertificateManager...");
    this.wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, { prefix: "akash" });
    const registry = getAkashTypeRegistry();
    this.client = await SigningStargateClient.connectWithSigner(rpcEndpoint, this.wallet, {
      registry: new Registry(registry)
    });
    console.log("CertificateManager initialized successfully.");
  }

  public async getOrCreateCertificate(): Promise<any> {
    if (this.certificate) {
      console.log("Using existing in-memory certificate:");
      console.log(JSON.stringify(this.certificate, null, 2));
      return this.certificate;
    }

    if (fs.existsSync('./certificate.json')) {
      console.log("Loading certificate from file...");
      const certData = fs.readFileSync('./certificate.json', 'utf8');
      this.certificate = JSON.parse(certData);
      console.log("Certificate loaded from file:");
      console.log(JSON.stringify(this.certificate, null, 2));
      return this.certificate;
    }

    console.log("No existing certificate found. Creating new certificate...");
    const [account] = await this.wallet.getAccounts();
    console.log("Creating new certificate for address:", account.address);
    
    this.certificate = certificateManager.generatePEM(account.address);
    console.log("New certificate generated:");
    console.log(JSON.stringify(this.certificate, null, 2));

    console.log("Broadcasting certificate...");
    const result = await cert.broadcastCertificate(this.certificate, account.address, this.client);
    console.log("Certificate broadcast result:", result);

    if (result.code !== undefined && result.code !== 0) {
      throw new Error(`Could not create certificate: ${result.rawLog}`);
    }

    console.log("Saving new certificate to file...");
    fs.writeFileSync('./certificate.json', JSON.stringify(this.certificate, null, 2));
    console.log("New certificate created, broadcast successfully, and saved to file.");

    return this.certificate;
  }
}

export default CertificateManager;