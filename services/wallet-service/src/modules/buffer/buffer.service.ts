import { Injectable } from "@nestjs/common";
import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
  BASE_FEE,
  Horizon,
  scValToNative,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";
import { RuntimeConfigService } from "../../common/config/runtime-config.service.js";
import { adminMutex } from "../../utils/admin-mutex.js";

export interface BufferBalance {
  availableShares: string;
  protectedShares: string;
  availableValue: string;
  protectedValue: string;
  totalValue: string;
  totalDeposited: string;
  lastDepositTs: number;
  version: number;
}

@Injectable()
export class BufferService {
  private readonly server: rpc.Server;
  private readonly horizonServer: Horizon.Server;
  private readonly networkPassphrase: string;
  private readonly adminKeypair: Keypair;

  constructor(private readonly runtimeConfig: RuntimeConfigService) {
    const rpcUrl = this.runtimeConfig.stellarSorobanRpcUrl;
    const adminSecret = this.runtimeConfig.adminStellarSecret;
    const horizonUrl = this.runtimeConfig.stellarHorizonUrl;
    const network = this.runtimeConfig.stellarNetwork;

    if (!rpcUrl || !adminSecret || !horizonUrl) {
      throw new Error(
        "[BufferService] Required env vars: STELLAR_SOROBAN_RPC_URL, STELLAR_HORIZON_URL, ADMIN_STELLAR_SECRET",
      );
    }

    this.server = new rpc.Server(rpcUrl);
    this.horizonServer = new Horizon.Server(horizonUrl);
    this.networkPassphrase = network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
    this.adminKeypair = Keypair.fromSecret(adminSecret);
  }

  async getBalance(bufferContractId: string, userAddress: string): Promise<BufferBalance> {
    if (!bufferContractId) {
      throw new Error("[BufferService] Missing buffer contract id");
    }

    const contract = new Contract(bufferContractId);
    const account = await this.getSourceAccount(this.adminKeypair.publicKey());

    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call("get_balance", Address.fromString(userAddress).toScVal()))
      .setTimeout(30)
      .build();

    const simulation = await this.server.simulateTransaction(transaction);

    if (rpc.Api.isSimulationError(simulation)) {
      throw new Error(`[BufferService] getBalance simulation failed: ${simulation.error}`);
    }

    const result = simulation.result?.retval;
    if (!result) {
      throw new Error("[BufferService] getBalance: no result from simulation");
    }

    const native = scValToNative(result);

    const valuesTransaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call("get_values", Address.fromString(userAddress).toScVal()))
      .setTimeout(30)
      .build();

    const valuesSimulation = await this.server.simulateTransaction(valuesTransaction);

    if (rpc.Api.isSimulationError(valuesSimulation)) {
      throw new Error(`[BufferService] getValues simulation failed: ${valuesSimulation.error}`);
    }

    const valuesResult = valuesSimulation.result?.retval;
    if (!valuesResult) {
      throw new Error("[BufferService] getValues: no result from simulation");
    }

    const valuesNative = scValToNative(valuesResult) as [
      bigint | number | string,
      bigint | number | string,
      bigint | number | string,
    ];

    return {
      availableShares: native.available_shares.toString(),
      protectedShares: native.protected_shares.toString(),
      availableValue: valuesNative[0].toString(),
      protectedValue: valuesNative[1].toString(),
      totalValue: valuesNative[2].toString(),
      totalDeposited: native.total_deposited.toString(),
      lastDepositTs: Number(native.last_deposit_ts),
      version: Number(native.version),
    };
  }

  async buildDepositTransaction(
    bufferContractId: string,
    userAddress: string,
    amountStroops: string,
  ): Promise<string> {
    if (!bufferContractId) {
      throw new Error("[BufferService] Missing buffer contract id");
    }

    const contract = new Contract(bufferContractId);
    const source = userAddress.startsWith("C") ? this.adminKeypair.publicKey() : userAddress;
    const account = await this.getSourceAccount(source);

    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        contract.call(
          "deposit",
          Address.fromString(userAddress).toScVal(),
          nativeToScVal(BigInt(amountStroops), { type: "i128" }),
        ),
      )
      .setTimeout(300)
      .build();

    const prepared = await this.server.prepareTransaction(transaction);
    return prepared.toXDR();
  }

  async buildWithdrawTransaction(
    bufferContractId: string,
    userAddress: string,
    sharesAmount: string,
  ): Promise<string> {
    if (!bufferContractId) {
      throw new Error("[BufferService] Missing buffer contract id");
    }

    const contract = new Contract(bufferContractId);
    const source = userAddress.startsWith("C") ? this.adminKeypair.publicKey() : userAddress;
    const account = await this.getSourceAccount(source);

    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        contract.call(
          "withdraw_available",
          Address.fromString(userAddress).toScVal(),
          nativeToScVal(BigInt(sharesAmount), { type: "i128" }),
          Address.fromString(userAddress).toScVal(),
        ),
      )
      .setTimeout(300)
      .build();

    const prepared = await this.server.prepareTransaction(transaction);
    return prepared.toXDR();
  }

  async setUserVault(
    bufferContractId: string,
    userAddress: string,
    vaultAddress: string,
  ): Promise<string> {
    if (!bufferContractId) {
      throw new Error("[BufferService] Missing buffer contract id");
    }
    if (!userAddress || !vaultAddress) {
      throw new Error("[BufferService] setUserVault requires userAddress and vaultAddress");
    }

    const contract = new Contract(bufferContractId);
    const account = await this.getSourceAccount(this.adminKeypair.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        contract.call(
          "set_user_vault",
          Address.fromString(userAddress).toScVal(),
          Address.fromString(vaultAddress).toScVal(),
        ),
      )
      .setTimeout(300)
      .build();

    const prepared = await this.server.prepareTransaction(tx);

    return adminMutex.run("setUserVault", async () => {
      prepared.sign(this.adminKeypair);

      const sendResult = await this.server.sendTransaction(prepared);
      if (sendResult.status === "ERROR") {
        throw new Error(
          `[BufferService] setUserVault sendTransaction failed: ${sendResult.errorResult?.toXDR("base64") ?? "unknown error"}`,
        );
      }

      if (!sendResult.hash || sendResult.hash.length === 0) {
        throw new Error("[BufferService] setUserVault missing transaction hash");
      }

      await this.waitForTransactionSuccess(sendResult.hash, 15, 2_000);
      return sendResult.hash;
    });
  }

  /**
   * Sign and submit a pre-built Soroban transaction XDR with the admin keypair.
   *
   * Use this for externally-prepared transactions (e.g. from DeFindex factory API)
   * that already include resource fees and footprint. Do NOT call
   * server.prepareTransaction() on DeFindex-returned XDRs — DeFindex has already
   * called simulate on their end.
   *
   * The admin signing block is wrapped in adminMutex to prevent txBAD_SEQ when
   * multiple admin transactions are attempted concurrently.
   */
  async createVaultFromXdr(
    transactionXDR: string,
  ): Promise<{ hash: string; vaultAddress: string | null }> {
    return adminMutex.run("createVaultFromXdr", async () => {
      const tx = new Transaction(transactionXDR, this.networkPassphrase);
      tx.sign(this.adminKeypair);

      const sendResult = await this.server.sendTransaction(tx);
      if (sendResult.status === "ERROR") {
        throw new Error(
          `[BufferService] createVaultFromXdr sendTransaction failed: ${sendResult.errorResult?.toXDR("base64") ?? "unknown error"}`,
        );
      }

      if (!sendResult.hash || sendResult.hash.length === 0) {
        throw new Error("[BufferService] createVaultFromXdr missing transaction hash");
      }

      await this.waitForTransactionSuccess(sendResult.hash, 15, 2_000);

      // Try to extract the new vault address from the factory's Soroban return value.
      // create_defindex_vault returns Address — scValToNative gives the C... string.
      let vaultAddress: string | null = null;
      try {
        const rpcResult = await this.server.getTransaction(sendResult.hash);
        if (rpcResult.status === rpc.Api.GetTransactionStatus.SUCCESS && rpcResult.returnValue) {
          const native = scValToNative(rpcResult.returnValue);
          if (typeof native === "string" && native.length > 0) {
            vaultAddress = native;
            console.info(
              `[BufferService] createVaultFromXdr resolved vault address from tx return value: ${vaultAddress}`,
            );
          }
        }
      } catch (err: unknown) {
        console.warn(
          `[BufferService] createVaultFromXdr could not parse return value: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return { hash: sendResult.hash, vaultAddress };
    });
  }

  private async waitForTransactionSuccess(
    transactionHash: string,
    maxAttempts = 12,
    delayMs = 2_000,
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const tx = await this.server.getTransaction(transactionHash);
      if (tx.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return;
      }
      if (tx.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`[BufferService] Transaction failed on-chain: ${transactionHash}`);
      }
      if (attempt < maxAttempts) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw new Error(
      `[BufferService] Transaction not confirmed after ${maxAttempts} attempts: ${transactionHash}`,
    );
  }

  private async getSourceAccount(accountId: string): Promise<Account> {
    try {
      return await this.server.getAccount(accountId);
    } catch (error: unknown) {
      const rpcMessage = error instanceof Error ? error.message : String(error);

      try {
        const horizonAccount = await this.horizonServer.loadAccount(accountId);
        return new Account(horizonAccount.accountId(), horizonAccount.sequence);
      } catch (horizonError: unknown) {
        const horizonMessage =
          horizonError instanceof Error ? horizonError.message : String(horizonError);
        throw new Error(
          `[BufferService] Unable to load source account ${accountId}. rpc=${rpcMessage}; horizon=${horizonMessage}`,
        );
      }
    }
  }
}
