export interface CreateVaultRequest {
  userAddress: string;
  assetAddress?: string;
  strategyAddress?: string;
}

export interface CreateVaultResponse {
  transactionXDR: string;
  predictedVaultAddress?: string;
}

import { structuredLog } from "../../utils/structured-log.js";

interface VaultRoles {
  manager: string | null;
  emergencyManager: string | null;
  rebalanceManager: string | null;
  feeReceiver: string | null;
}

interface VaultStrategyInfo {
  address: string | null;
  name: string | null;
  paused: boolean | null;
}

interface VaultAssetInfo {
  address: string | null;
  name: string | null;
  symbol: string | null;
  strategies: VaultStrategyInfo[];
}

interface VaultStrategyAllocationInfo {
  amount: string | null;
  paused: boolean | null;
  strategy_address: string | null;
}

interface VaultManagedFundsInfo {
  asset: string | null;
  idle_amount: string | null;
  invested_amount: string | null;
  strategy_allocations: VaultStrategyAllocationInfo[];
  total_amount: string | null;
}

interface VaultFeesBps {
  vaultFee: number | null;
  defindexFee: number | null;
}

interface VaultInfoSummary {
  name: string | null;
  symbol: string | null;
  roles: VaultRoles;
  assets: VaultAssetInfo[];
  totalManagedFunds: VaultManagedFundsInfo[];
  feesBps: VaultFeesBps;
  apy: number | null;
}

export class DeFindexService {
  private readonly apiUrl: string;
  private readonly network: string;
  private readonly adminAddress: string;
  private readonly headers: Record<string, string>;

  constructor() {
    const apiUrl = process.env.DEFINDEX_API_URL;
    const apiKey = process.env.DEFINDEX_API_KEY;
    const adminAddress = process.env.ADMIN_STELLAR_ADDRESS;

    this.network = process.env.STELLAR_NETWORK ?? "testnet";

    if (!apiUrl || !apiKey || !adminAddress) {
      throw new Error(
        "[DeFindexService] Required env vars: DEFINDEX_API_URL, DEFINDEX_API_KEY, ADMIN_STELLAR_ADDRESS",
      );
    }

    this.apiUrl = apiUrl;
    this.adminAddress = adminAddress;
    this.headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
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
      caller: this.adminAddress,
      roles: {
        "0": this.adminAddress,
        "1": this.adminAddress,
        "2": request.userAddress,
        "3": this.adminAddress,
      },
      vault_fee_bps: 25,
      upgradable: true,
      name_symbol: {
        name: "REDI Buffer Vault",
        symbol: "RVLT",
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

    let response: Response;
    try {
      response = await fetch(
        `${this.apiUrl}/factory/create-vault?network=${this.network}`,
        {
          method: "POST",
          headers: this.headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(60_000),
        },
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      throw new Error(`[DeFindexService] createVaultForUser network error: ${message}`);
    }

    const data = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      throw new Error(`[DeFindexService] createVaultForUser failed: ${JSON.stringify(data)}`);
    }

    console.info(
      `[DeFindexService] Vault creation initiated for ${request.userAddress}`,
    );

    const transactionXDR = this.extractTransactionXdr(data);
    const predictedVaultAddress = this.extractPredictedVaultAddress(data);

    return { transactionXDR, predictedVaultAddress };
  }

  private extractPredictedVaultAddress(payload: Record<string, unknown>): string | undefined {
    const candidates = [
      payload.predictedVaultAddress,
      payload.vaultAddress,
      payload.vault_address,
      payload.address,
      payload.contractAddress,
      payload.contract_address,
    ];
    for (const candidate of candidates) {
      const asString = this.asNonEmptyString(candidate);
      if (asString) return asString;
    }
    // Not a failure — we'll fall back to parsing the tx return value on-chain.
    console.warn(
      `[DeFindexService] predictedVaultAddress absent from response. Keys present: ${JSON.stringify(Object.keys(payload))}`,
    );
    return undefined;
  }

  private extractTransactionXdr(payload: Record<string, unknown>): string {
    const direct = this.asNonEmptyString(payload.xdr);
    if (direct) return direct;

    const topLevelAlternatives = [
      payload.transactionXDR,
      payload.transaction,
      payload.tx,
    ];
    for (const candidate of topLevelAlternatives) {
      const asString = this.asNonEmptyString(candidate);
      if (asString) return asString;
    }

    if (payload.xdr && typeof payload.xdr === "object") {
      const nested = payload.xdr as Record<string, unknown>;
      const nestedAlternatives = [
        nested.tx,
        nested.transactionXDR,
        nested.transaction,
        nested.xdr,
      ];
      for (const candidate of nestedAlternatives) {
        const asString = this.asNonEmptyString(candidate);
        if (asString) {
          const nestedMethod =
            typeof nested.method === "string" ? ` method=${nested.method}` : "";
          console.info(
            `[DeFindexService] Extracted nested vault tx payload as serialized XDR.${nestedMethod}`,
          );
          return asString;
        }
      }
    }

    throw new Error(
      `[DeFindexService] createVaultForUser invalid xdr payload shape: ${JSON.stringify(
        Object.keys(payload),
      )}`,
    );
  }

  private asNonEmptyString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  private asBoolean(value: unknown): boolean | null {
    return typeof value === "boolean" ? value : null;
  }

  private asNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  private summarizeVaultInfo(payload: Record<string, unknown>): VaultInfoSummary {
    const rolesRecord = this.asRecord(payload.roles);
    const assets = Array.isArray(payload.assets) ? payload.assets : [];
    const totalManagedFunds = Array.isArray(payload.totalManagedFunds) ? payload.totalManagedFunds : [];
    const feesRecord = this.asRecord(payload.feesBps);

    return {
      name: this.asNonEmptyString(payload.name),
      symbol: this.asNonEmptyString(payload.symbol),
      roles: {
        manager: this.asNonEmptyString(rolesRecord?.manager),
        emergencyManager: this.asNonEmptyString(rolesRecord?.emergencyManager),
        rebalanceManager: this.asNonEmptyString(rolesRecord?.rebalanceManager),
        feeReceiver: this.asNonEmptyString(rolesRecord?.feeReceiver),
      },
      assets: assets.map((asset) => {
        const assetRecord = this.asRecord(asset);
        const strategies = Array.isArray(assetRecord?.strategies) ? assetRecord.strategies : [];
        return {
          address: this.asNonEmptyString(assetRecord?.address),
          name: this.asNonEmptyString(assetRecord?.name),
          symbol: this.asNonEmptyString(assetRecord?.symbol),
          strategies: strategies.map((strategy) => {
            const strategyRecord = this.asRecord(strategy);
            return {
              address: this.asNonEmptyString(strategyRecord?.address),
              name: this.asNonEmptyString(strategyRecord?.name),
              paused: this.asBoolean(strategyRecord?.paused),
            };
          }),
        };
      }),
      totalManagedFunds: totalManagedFunds.map((fund) => {
        const fundRecord = this.asRecord(fund);
        const strategyAllocations = Array.isArray(fundRecord?.strategy_allocations)
          ? fundRecord.strategy_allocations
          : [];
        return {
          asset: this.asNonEmptyString(fundRecord?.asset),
          idle_amount: this.asNonEmptyString(fundRecord?.idle_amount),
          invested_amount: this.asNonEmptyString(fundRecord?.invested_amount),
          strategy_allocations: strategyAllocations.map((allocation) => {
            const allocationRecord = this.asRecord(allocation);
            return {
              amount: this.asNonEmptyString(allocationRecord?.amount),
              paused: this.asBoolean(allocationRecord?.paused),
              strategy_address: this.asNonEmptyString(allocationRecord?.strategy_address),
            };
          }),
          total_amount: this.asNonEmptyString(fundRecord?.total_amount),
        };
      }),
      feesBps: {
        vaultFee: this.asNumber(feesRecord?.vaultFee),
        defindexFee: this.asNumber(feesRecord?.defindexFee),
      },
      apy: this.asNumber(payload.apy),
    };
  }

  private async fetchVaultInfo(vaultAddress: string): Promise<Record<string, unknown>> {
    const response = await fetch(
      `${this.apiUrl}/vault/${vaultAddress}?network=${this.network}`,
      { headers: this.headers, signal: AbortSignal.timeout(15_000) },
    );

    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok || !data) {
      throw new Error(
        `[DeFindexService] getVaultInfo failed: status=${response.status} body=${JSON.stringify(data)}`,
      );
    }

    return data;
  }

  async logVaultInfo(vaultAddress: string, context: string): Promise<void> {
    const data = await this.fetchVaultInfo(vaultAddress);
    const summary = this.summarizeVaultInfo(data);
    structuredLog.info("DeFindexService", "vault.info", {
      context,
      vaultAddress,
      info: summary,
    });
  }

  async waitForVaultConfirmation(
    vaultAddress: string,
    maxAttempts = 20,
    delayMs = 3_000,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const data = await this.fetchVaultInfo(vaultAddress);
        if (data?.name) {
          const summary = this.summarizeVaultInfo(data);
          structuredLog.info("DeFindexService", "vault.confirmed", {
            vaultAddress,
            attempt,
            info: summary,
          });
          return true;
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        structuredLog.debug("DeFindexService", "vault.confirmation_retry", {
          vaultAddress,
          attempt,
          maxAttempts,
          delayMs,
          error: message,
        });
      }

      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    structuredLog.warn("DeFindexService", "vault.confirmation_timeout", {
      vaultAddress,
      maxAttempts,
    });
    return false;
  }
}

export { DeFindexService as default };
