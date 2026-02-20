import { Keypair, Networks, Transaction, xdr, StrKey } from "@stellar/stellar-sdk";
import { SupabaseService } from "../supabase/supabase.service.js";
import { CrossmintService } from "../crossmint/crossmint.service.js";
import { DeFindexService } from "../defindex/defindex.service.js";

export interface OnboardingResult {
  userId: string;
  stellarAddress: string;
  vaultAddress: string;
  status: string;
}

interface HorizonTransactionResponse {
  successful: boolean;
  hash: string;
  result_xdr: string;
  extras?: {
    result_codes?: Record<string, unknown>;
  };
}

export class OnboardingService {
  private readonly adminKeypair: Keypair;
  private readonly networkPassphrase: string;
  private readonly horizonUrl: string;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly crossmint: CrossmintService,
    private readonly defindex: DeFindexService,
  ) {
    const adminSecret = process.env.ADMIN_STELLAR_SECRET;
    const network = process.env.STELLAR_NETWORK ?? "testnet";

    if (!adminSecret) {
      throw new Error("[OnboardingService] Required env var: ADMIN_STELLAR_SECRET");
    }

    this.adminKeypair = Keypair.fromSecret(adminSecret);
    this.networkPassphrase = network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
    this.horizonUrl =
      network === "mainnet" ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org";
  }

  async onboardUser(userId: string, email: string): Promise<OnboardingResult> {
    console.info(`[OnboardingService] Starting onboarding for user ${userId}`);

    try {
      const user = await this.supabase.getUser(userId);

      if (user.buffer_onboarding_status === "READY") {
        console.info(`[OnboardingService] User ${userId} already onboarded`);
        return {
          userId,
          stellarAddress: user.stellar_address as string,
          vaultAddress: user.defindex_vault_address as string,
          status: "READY",
        };
      }

      if (!user.stellar_address) {
        await this.createWallet(userId, email);
      }

      const userWithWallet = await this.supabase.getUser(userId);

      if (!userWithWallet.defindex_vault_address) {
        await this.createVault(userId, userWithWallet.stellar_address as string);
      }

      const finalUser = await this.supabase.getUser(userId);

      console.info(`[OnboardingService] Onboarding complete for user ${userId}`);

      return {
        userId,
        stellarAddress: finalUser.stellar_address as string,
        vaultAddress: finalUser.defindex_vault_address as string,
        status: finalUser.buffer_onboarding_status as string,
      };
    } catch (error: any) {
      console.error(`[OnboardingService] Onboarding failed for user ${userId}: ${error.message}`);
      await this.supabase.updateUserOnboardingStatus(userId, "FAILED");
      throw error;
    }
  }

  private async createWallet(userId: string, email: string): Promise<void> {
    console.info(`[OnboardingService] [1/2] Creating Crossmint wallet for user ${userId}`);

    const wallet = await this.crossmint.createWalletForUser(email);

    await this.supabase.updateUserOnboardingStatus(userId, "WALLET_CREATED", {
      stellar_address: wallet.address,
      crossmint_wallet_id: wallet.walletId,
    });

    console.info(`[OnboardingService] Wallet created: ${wallet.address}`);
  }

  private async createVault(userId: string, stellarAddress: string): Promise<void> {
    console.info(`[OnboardingService] [2/2] Creating DeFindex vault for user ${userId}`);

    await this.supabase.updateUserOnboardingStatus(userId, "VAULT_CREATING");

    const vaultResponse = await this.defindex.createVaultForUser({
      userAddress: stellarAddress,
      assetAddress: process.env.XLM_CONTRACT_ADDRESS,
      strategyAddress: process.env.XLM_BLEND_STRATEGY,
    });

    const tx = new Transaction(vaultResponse.transactionXDR, this.networkPassphrase);
    tx.sign(this.adminKeypair);
    const signedXdr = tx.toEnvelope().toXDR("base64");

    const response = await fetch(`${this.horizonUrl}/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ tx: signedXdr }),
    });

    const result = (await response.json()) as HorizonTransactionResponse;

    if (!result.successful) {
      throw new Error(
        `[OnboardingService] Vault tx failed: ${JSON.stringify(result.extras?.result_codes)}`,
      );
    }

    console.info(`[OnboardingService] Vault tx confirmed: ${result.hash}`);

    const vaultAddress = this.extractVaultAddressFromResultXdr(result.result_xdr);

    const confirmed = await this.defindex.waitForVaultConfirmation(vaultAddress);
    if (!confirmed) {
      throw new Error(
        `[OnboardingService] Vault ${vaultAddress} not confirmed by DeFindex API after polling`,
      );
    }

    await this.supabase.updateUserOnboardingStatus(userId, "READY", {
      defindex_vault_address: vaultAddress,
    });

    console.info(`[OnboardingService] Vault persisted: ${vaultAddress}`);
  }

  private extractVaultAddressFromResultXdr(resultXdr: string): string {
    let txResult: xdr.TransactionResult;

    try {
      txResult = xdr.TransactionResult.fromXDR(resultXdr, "base64");
    } catch (e: any) {
      throw new Error(`[OnboardingService] Failed to deserialize result_xdr: ${e.message}`);
    }

    const txResultBody = txResult.result();
    const innerResults = txResultBody.results();

    if (!innerResults || innerResults.length === 0) {
      throw new Error("[OnboardingService] result_xdr contains no operations");
    }

    for (const opResult of innerResults) {
      const opInner = opResult.tr();
      if (!opInner) continue;

      let invokeResult: xdr.InvokeHostFunctionResult;
      try {
        invokeResult = opInner.invokeHostFunctionResult();
      } catch {
        continue;
      }

      let returnValBuffer: Buffer;
      try {
        returnValBuffer = invokeResult.success() as unknown as Buffer;
      } catch {
        throw new Error("[OnboardingService] invokeHostFunction was not successful per XDR");
      }

      let returnVal: xdr.ScVal;
      try {
        returnVal = xdr.ScVal.fromXDR(returnValBuffer);
      } catch (e: any) {
        throw new Error(
          `[OnboardingService] Failed to deserialize ScVal from return value: ${e.message}`,
        );
      }

      if (returnVal.switch().name !== "scvAddress") {
        throw new Error(
          `[OnboardingService] Unexpected return value type: ${returnVal.switch().name}. Expected scvAddress`,
        );
      }

      const scAddress = returnVal.address();
      const addressType = scAddress.switch().name;

      if (addressType !== "scAddressTypeContract") {
        throw new Error(`[OnboardingService] ScAddress is not of type CONTRACT: ${addressType}`);
      }

      const contractHash = Buffer.from(scAddress.contractId().toString(), "hex");
      const vaultAddress = StrKey.encodeContract(contractHash);

      if (!StrKey.isValidContract(vaultAddress)) {
        throw new Error(`[OnboardingService] Extracted address is invalid: ${vaultAddress}`);
      }

      console.info(`[OnboardingService] Vault address extracted from XDR: ${vaultAddress}`);
      return vaultAddress;
    }

    throw new Error(
      "[OnboardingService] No invokeHostFunctionResult with ScAddress found in XDR. " +
        `Verify tx at: https://stellar.expert/explorer/testnet/tx/`,
    );
  }
}
