import { Injectable } from "@nestjs/common";
import { Horizon } from "@stellar/stellar-sdk";
import { RuntimeConfigService } from "../../common/config/runtime-config.service.js";
import { CrossmintService } from "../crossmint/crossmint.service.js";

interface WalletBalanceTokenLike {
  amount?: unknown;
  rawAmount?: unknown;
  symbol?: unknown;
  code?: unknown;
  ticker?: unknown;
  token?: { symbol?: unknown; code?: unknown; ticker?: unknown } | null;
}

interface NormalizedWalletState {
  address: string;
  chain: string;
  type: string;
  nativeToken: {
    amount: string;
    rawAmount: string;
  };
  customTokens: unknown[];
}

@Injectable()
export class WalletService {
  constructor(
    private readonly runtimeConfig: RuntimeConfigService,
    private readonly crossmintService: CrossmintService,
  ) {}

  async provisionWallet(email: string) {
    const wallet = await this.crossmintService.createWalletForUser(email);
    return {
      address: wallet.address,
      walletLocator: wallet.walletId,
      chain: wallet.chain,
      type: "smart",
    };
  }

  async getWalletState(email: string) {
    const raw = await this.crossmintService.getWalletBalances(email);
    return this.normalizeWalletBalances(email, raw);
  }

  async getNativeState(publicKey: string) {
    const server = new Horizon.Server(this.runtimeConfig.stellarHorizonUrl);

    try {
      const account = await server.loadAccount(publicKey);
      const nativeBalance = account.balances.find((item) => item.asset_type === "native");
      const issuedAssets = account.balances
        .filter(
          (item) =>
            item.asset_type === "credit_alphanum4" || item.asset_type === "credit_alphanum12",
        )
        .map((item) => ({
          assetCode: "asset_code" in item ? item.asset_code : "",
          assetIssuer: "asset_issuer" in item ? item.asset_issuer : "",
          balance: item.balance,
        }));

      return {
        publicKey,
        nativeToken: {
          code: "XLM",
          balance: nativeBalance?.balance ?? "0",
        },
        issuedAssets,
        sequence: account.sequence,
      };
    } catch (error: unknown) {
      const err = error as { response?: { status?: number } };
      if (err.response?.status === 404) {
        return {
          publicKey,
          nativeToken: {
            code: "XLM",
            balance: "0",
          },
          issuedAssets: [],
          sequence: "",
        };
      }

      throw error;
    }
  }

  private normalizeWalletBalances(email: string, raw: unknown): NormalizedWalletState {
    const defaultState: NormalizedWalletState = {
      address: `email:${email}:stellar`,
      chain: "stellar",
      type: "smart-wallet",
      nativeToken: {
        amount: "0",
        rawAmount: "0",
      },
      customTokens: [],
    };

    if (!raw || typeof raw !== "object") {
      return defaultState;
    }

    if (Array.isArray(raw)) {
      const nativeToken = this.extractNativeTokenFromArray(raw);
      return {
        ...defaultState,
        nativeToken,
        customTokens: raw.filter((entry) => !this.isNativeToken(entry)),
      };
    }

    const record = raw as Record<string, unknown>;
    const nativeTokenRecord =
      record.nativeToken && typeof record.nativeToken === "object"
        ? (record.nativeToken as Record<string, unknown>)
        : null;
    const customTokens = Array.isArray(record.customTokens)
      ? record.customTokens
      : Array.isArray(record.tokens)
        ? record.tokens
        : [];

    return {
      address:
        typeof record.address === "string" && record.address.length > 0
          ? record.address
          : defaultState.address,
      chain:
        typeof record.chain === "string" && record.chain.length > 0
          ? record.chain
          : defaultState.chain,
      type:
        typeof record.type === "string" && record.type.length > 0 ? record.type : defaultState.type,
      nativeToken: {
        amount:
          typeof nativeTokenRecord?.amount === "string" && nativeTokenRecord.amount.length > 0
            ? nativeTokenRecord.amount
            : "0",
        rawAmount:
          typeof nativeTokenRecord?.rawAmount === "string" &&
          nativeTokenRecord.rawAmount.length > 0
            ? nativeTokenRecord.rawAmount
            : typeof nativeTokenRecord?.amount === "string" && nativeTokenRecord.amount.length > 0
              ? nativeTokenRecord.amount
              : "0",
      },
      customTokens,
    };
  }

  private extractNativeTokenFromArray(entries: unknown[]): { amount: string; rawAmount: string } {
    const nativeEntry = entries.find((entry) => this.isNativeToken(entry)) as
      | WalletBalanceTokenLike
      | undefined;

    if (!nativeEntry) {
      return { amount: "0", rawAmount: "0" };
    }

    const amount =
      typeof nativeEntry.amount === "string" && nativeEntry.amount.length > 0
        ? nativeEntry.amount
        : "0";
    const rawAmount =
      typeof nativeEntry.rawAmount === "string" && nativeEntry.rawAmount.length > 0
        ? nativeEntry.rawAmount
        : amount;

    return { amount, rawAmount };
  }

  private isNativeToken(entry: unknown): boolean {
    if (!entry || typeof entry !== "object") {
      return false;
    }

    const token = entry as WalletBalanceTokenLike;
    const candidates = [
      token.symbol,
      token.code,
      token.ticker,
      token.token?.symbol,
      token.token?.code,
      token.token?.ticker,
    ];

    return candidates.some(
      (value) => typeof value === "string" && value.trim().toUpperCase() === "XLM",
    );
  }
}
