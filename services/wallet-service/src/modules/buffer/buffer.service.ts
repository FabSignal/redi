import {
  Address,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  scValToNative,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";

export interface BufferBalance {
  availableShares: string;
  protectedShares: string;
  totalDeposited: string;
  lastDepositTs: number;
  version: number;
}

export class BufferService {
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;
  private readonly adminKeypair: Keypair;

  constructor() {
    const rpcUrl = process.env.STELLAR_RPC_URL;
    const adminSecret = process.env.ADMIN_STELLAR_SECRET;
    const network = process.env.STELLAR_NETWORK ?? "testnet";

    if (!rpcUrl || !adminSecret) {
      throw new Error(
        "[BufferService] Required env vars: STELLAR_RPC_URL, ADMIN_STELLAR_SECRET",
      );
    }

    this.server = new rpc.Server(rpcUrl);
    this.networkPassphrase = network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
    this.adminKeypair = Keypair.fromSecret(adminSecret);
  }

  async getBalance(userAddress: string): Promise<BufferBalance> {
    const bufferContractId = process.env.BUFFER_CONTRACT_ID;

    if (!bufferContractId) {
      throw new Error("[BufferService] Required env var: BUFFER_CONTRACT_ID");
    }

    const contract = new Contract(bufferContractId);
    const account = await this.server.getAccount(this.adminKeypair.publicKey());

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

    return {
      availableShares: native.available_shares.toString(),
      protectedShares: native.protected_shares.toString(),
      totalDeposited: native.total_deposited.toString(),
      lastDepositTs: Number(native.last_deposit_ts),
      version: Number(native.version),
    };
  }

  async buildDepositTransaction(userAddress: string, amountStroops: string): Promise<string> {
    const bufferContractId = process.env.BUFFER_CONTRACT_ID;

    if (!bufferContractId) {
      throw new Error("[BufferService] Required env var: BUFFER_CONTRACT_ID");
    }

    const contract = new Contract(bufferContractId);
    const account = await this.server.getAccount(userAddress);

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

  async buildWithdrawTransaction(userAddress: string, sharesAmount: string): Promise<string> {
    const bufferContractId = process.env.BUFFER_CONTRACT_ID;

    if (!bufferContractId) {
      throw new Error("[BufferService] Required env var: BUFFER_CONTRACT_ID");
    }

    const contract = new Contract(bufferContractId);
    const account = await this.server.getAccount(userAddress);

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
}
