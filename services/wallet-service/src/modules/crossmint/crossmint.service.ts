import axios, { AxiosInstance } from "axios";

export interface CreateWalletResponse {
  walletId: string;
  address: string;
  chain: string;
}

export interface SignTransactionRequest {
  walletId: string;
  transactionXDR: string;
}

export interface SignTransactionResponse {
  signedTransactionXDR: string;
  transactionHash: string;
}

export class CrossmintService {
  private readonly client: AxiosInstance;

  constructor() {
    const apiKey = process.env.CROSSMINT_API_KEY;
    const environment = process.env.CROSSMINT_ENVIRONMENT ?? "staging";

    if (!apiKey) {
      throw new Error("[CrossmintService] Required env var: CROSSMINT_API_KEY");
    }

    const baseURL =
      environment === "production" ? "https://api.crossmint.com" : "https://staging.crossmint.com";

    this.client = axios.create({
      baseURL,
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      timeout: 30_000,
    });
  }

  async createWalletForUser(email: string): Promise<CreateWalletResponse> {
    try {
      const response = await this.client.post("/api/v1-alpha1/wallets", {
        chain: "stellar:testnet",
        config: {
          email,
          type: "custodial",
        },
      });

      console.info(`[CrossmintService] Wallet created: ${response.data.address}`);

      return {
        walletId: response.data.id,
        address: response.data.address,
        chain: response.data.chain,
      };
    } catch (error: any) {
      const msg = error?.response?.data ?? error?.message ?? "unknown error";
      throw new Error(`[CrossmintService] createWalletForUser failed: ${JSON.stringify(msg)}`);
    }
  }

  async signAndSubmitTransaction(
    request: SignTransactionRequest,
  ): Promise<SignTransactionResponse> {
    try {
      const response = await this.client.post(
        `/api/v1-alpha1/wallets/${request.walletId}/transactions/sign`,
        {
          transactionXDR: request.transactionXDR,
          submit: true,
        },
      );

      console.info(
        `[CrossmintService] Transaction signed and submitted for wallet ${request.walletId}: ${response.data.transactionHash}`,
      );

      return {
        signedTransactionXDR: response.data.signedTransactionXDR,
        transactionHash: response.data.transactionHash,
      };
    } catch (error: any) {
      const msg = error?.response?.data ?? error?.message ?? "unknown error";
      throw new Error(`[CrossmintService] signAndSubmitTransaction failed: ${JSON.stringify(msg)}`);
    }
  }
}
