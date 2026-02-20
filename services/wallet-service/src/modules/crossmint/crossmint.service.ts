import { getOrCreateWalletByEmail, signTransaction } from "@redi/crossmint";

export interface CreateWalletResponse {
  walletId: string;
  address: string;
  chain: string;
}

export interface SignTransactionRequest {
  email: string;
  transactionXDR: string;
}

export interface SignTransactionResponse {
  signedXDR: string;
  transactionHash: string;
}

export class CrossmintService {
  async createWalletForUser(email: string): Promise<CreateWalletResponse> {
    try {
      const wallet = await getOrCreateWalletByEmail(email, "stellar-testnet");

      console.info(`[CrossmintService] Wallet created: ${wallet.address}`);

      return {
        walletId: wallet.address,
        address: wallet.address,
        chain: wallet.chain,
      };
    } catch (error: any) {
      throw new Error(`[CrossmintService] createWalletForUser failed: ${error.message}`);
    }
  }

  async signAndSubmitTransaction(
    request: SignTransactionRequest,
  ): Promise<SignTransactionResponse> {
    try {
      const result = await signTransaction(
        request.email,
        request.transactionXDR,
        "stellar-testnet",
      );

      console.info(`[CrossmintService] Transaction signed for ${request.email}: ${result.hash}`);

      return {
        signedXDR: result.signedXDR,
        transactionHash: result.hash,
      };
    } catch (error: any) {
      throw new Error(`[CrossmintService] signAndSubmitTransaction failed: ${error.message}`);
    }
  }
}
