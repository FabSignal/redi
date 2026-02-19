import { CrossmintWallets, createCrossmint, StellarWallet } from "@crossmint/wallets-sdk";
import { getServerEnv } from "@redi/config";

export type SupportedChain = "stellar-testnet" | "stellar";

export interface WalletSummary {
  address: string;
  chain: string;
  type: string;
}

export interface WalletBalance {
  address: string;
  chain: string;
  type: string;
  nativeToken: {
    amount: string;
    rawAmount: string;
  };
  customTokens: unknown[];
}

function getClient() {
  const env = getServerEnv();
  const crossmint = createCrossmint({ apiKey: env.CROSSMINT_API_KEY });
  return CrossmintWallets.from(crossmint);
}

function toSdkChain(_chain: SupportedChain): "stellar" {
  // wallets-sdk@0.19 only exposes "stellar" as chain identifier.
  return "stellar";
}

export async function getOrCreateWalletByEmail(
  email: string,
  chain: SupportedChain = "stellar-testnet",
): Promise<WalletSummary> {
  const client = getClient();
  const wallet = await client.getOrCreateWallet({
    chain: toSdkChain(chain),
    signer: { type: "email", email },
  });

  return {
    address: wallet.address,
    chain,
    type: "smart-wallet",
  };
}

export async function getWalletBalanceByEmail(
  email: string,
  chain: SupportedChain = "stellar-testnet",
): Promise<WalletBalance> {
  const client = getClient();
  const wallet = await client.getOrCreateWallet({
    chain: toSdkChain(chain),
    signer: { type: "email", email },
  });

  const balances = await wallet.balances();

  return {
    address: wallet.address,
    chain,
    type: "smart-wallet",
    nativeToken: {
      amount: balances.nativeToken?.amount ?? "0",
      rawAmount: balances.nativeToken?.rawAmount ?? "0",
    },
    customTokens: balances.tokens ?? [],
  };
}

export async function signTransaction(
  email: string,
  transactionXDR: string,
  chain: SupportedChain = "stellar-testnet",
): Promise<{ signedXDR: string; hash: string }> {
  const client = getClient();
  const wallet = await client.getOrCreateWallet({
    chain: toSdkChain(chain),
    signer: { type: "email", email },
  });

  const stellarWallet = StellarWallet.from(wallet);

  const result = await stellarWallet.sendTransaction({
    transaction: transactionXDR,
    contractId: "",
  });

  return {
    signedXDR: transactionXDR,
    hash: result.hash,
  };
}
