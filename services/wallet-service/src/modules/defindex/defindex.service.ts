import axios, { AxiosInstance } from "axios";

export interface CreateVaultRequest {
  userAddress: string;
  assetAddress?: string;
  strategyAddress?: string;
}

export interface CreateVaultResponse {
  vaultContractId: string;
  transactionXDR: string;
}

export class DeFindexService {
  private readonly client: AxiosInstance;
  private readonly network: string;

  constructor() {
    const apiUrl = process.env.DEFINDEX_API_URL;
    const apiKey = process.env.DEFINDEX_API_KEY;
    this.network = process.env.STELLAR_NETWORK ?? "testnet";

    if (!apiUrl || !apiKey) {
      throw new Error("[DeFindexService] Required env vars: DEFINDEX_API_URL, DEFINDEX_API_KEY");
    }

    this.client = axios.create({
      baseURL: apiUrl,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 60_000,
    });
  }

  async createVaultForUser(request: CreateVaultRequest): Promise<CreateVaultResponse> {
    const assetAddress = request.assetAddress ?? process.env.XLM_CONTRACT_ADDRESS;
    const strategyAddress = request.strategyAddress ?? process.env.XLM_BLEND_STRATEGY;

    if (!assetAddress || !strategyAddress) {
      throw new Error(
        "[DeFindexService] Required env vars: XLM_CONTRACT_ADDRESS, XLM_BLEND_STRATEGY",
      );
    }

    const strategyName =
      assetAddress === process.env.XLM_CONTRACT_ADDRESS
        ? "XLM_blend_strategy"
        : "USDC_blend_strategy";

    const payload = {
      caller: request.userAddress,
      roles: {
        "0": request.userAddress,
        "1": request.userAddress,
        "2": request.userAddress,
        "3": request.userAddress,
      },
      vault_fee_bps: 25,
      upgradable: true,
      name_symbol: {
        name: `User Vault ${request.userAddress.slice(0, 8)}`,
        symbol: "UVLT",
      },
      assets: [
        {
          address: assetAddress,
          strategies: [
            {
              address: strategyAddress,
              name: strategyName,
              paused: false,
            },
          ],
        },
      ],
    };

    try {
      const response = await this.client.post(
        `/factory/create-vault?network=${this.network}`,
        payload,
      );

      console.info(
        `[DeFindexService] Vault creation initiated for ${request.userAddress}: ${response.data.simulation_result}`,
      );

      return {
        vaultContractId: "", // resolved in onboarding after Horizon submit
        transactionXDR: response.data.xdr,
      };
    } catch (error: any) {
      const msg = error?.response?.data ?? error?.message ?? "unknown error";
      throw new Error(`[DeFindexService] createVaultForUser failed: ${JSON.stringify(msg)}`);
    }
  }

  async waitForVaultConfirmation(
    vaultAddress: string,
    maxAttempts = 20,
    delayMs = 3_000,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await this.client.get(`/vault/${vaultAddress}?network=${this.network}`);

        if (response.data?.name) {
          console.info(`[DeFindexService] Vault confirmed: ${vaultAddress}`);
          return true;
        }
      } catch {
        console.debug(
          `[DeFindexService] waitForVaultConfirmation attempt ${attempt}/${maxAttempts} — retrying in ${delayMs}ms`,
        );
      }

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    console.warn(
      `[DeFindexService] Vault ${vaultAddress} not confirmed after ${maxAttempts} attempts`,
    );
    return false;
  }
}

export { DeFindexService as default };
