import { Injectable } from "@nestjs/common";
import { RuntimeConfigService } from "../../common/config/runtime-config.service.js";

export interface CreateWalletResponse {
  walletId: string;
  address: string;
  chain: string;
}

export interface SignTransactionRequest {
  walletLocator: string;
  transactionXDR: string;
}

export interface SignTransactionResponse {
  signedXDR: string;
  transactionHash: string;
}

export interface CreateUserTransactionRequest {
  walletAddress: string;
  signerEmail: string;
  transactionXDR?: string;
  contractId?: string;
  method?: string;
  args?: Record<string, unknown>;
}

export interface CreateUserTransactionResponse {
  transactionId: string;
}

@Injectable()
export class CrossmintService {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(private readonly runtimeConfig: RuntimeConfigService) {
    const apiKey = this.runtimeConfig.crossmintApiKey;

    this.baseUrl = this.runtimeConfig.crossmintBaseUrl;
    console.info(`[CrossmintService] Using base URL: ${this.baseUrl}`);
    this.headers = {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json",
    };
  }

  async createWalletForUser(email: string): Promise<CreateWalletResponse> {
    const walletLocator = encodeURIComponent(`email:${email}:stellar`);

    const getResponse = await fetch(`${this.baseUrl}/api/2025-06-09/wallets/${walletLocator}`, {
      headers: this.headers,
    });

    if (getResponse.ok) {
      const data = (await getResponse.json()) as Record<string, unknown>;
      console.info(`[CrossmintService] Wallet retrieved for ${email}: ${data.address}`);
      return {
        walletId: `email:${email}:stellar`,
        address: data.address as string,
        chain: (data.chainType as string) ?? "stellar",
      };
    }

    const createResponse = await fetch(`${this.baseUrl}/api/2025-06-09/wallets`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        chainType: "stellar",
        type: "smart",
        config: { adminSigner: { type: "api-key" } },
        owner: `email:${email}`,
      }),
    });

    const createData = (await createResponse.json()) as Record<string, unknown>;

    if (!createResponse.ok) {
      throw new Error(
        `[CrossmintService] createWalletForUser failed: ${JSON.stringify(createData)}`,
      );
    }

    console.info(`[CrossmintService] Wallet created for ${email}: ${createData.address}`);

    return {
      walletId: `email:${email}:stellar`,
      address: createData.address as string,
      chain: (createData.chainType as string) ?? "stellar",
    };
  }

  async getWalletBalances(email: string): Promise<Record<string, unknown>> {
    const walletLocator = encodeURIComponent(`email:${email}:stellar`);

    const response = await fetch(
      `${this.baseUrl}/api/2025-06-09/wallets/${walletLocator}/balances?tokens=xlm,usdc`,
      { headers: this.headers },
    );

    const data = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      throw new Error(`[CrossmintService] getWalletBalances failed: ${JSON.stringify(data)}`);
    }

    return data;
  }

  async createUserTransaction(
    request: CreateUserTransactionRequest,
  ): Promise<CreateUserTransactionResponse> {
    const walletLocator = encodeURIComponent(request.walletAddress);
    const endpoint = `${this.baseUrl}/api/2025-06-09/wallets/${walletLocator}/transactions`;
    const signer = `email:${request.signerEmail}`;

    const createTx = async (
      transaction:
        | string
        | { type: "serialized-transaction"; serializedTransaction: string; contractId?: string }
        | {
            type: "contract-call";
            contractId: string;
            method: string;
            args: Record<string, unknown>;
          },
    ): Promise<Record<string, unknown>> => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          params: {
            transaction,
            signer,
          },
        }),
      });

      const data = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        const message =
          typeof data.message === "string" && data.message.length > 0
            ? data.message
            : JSON.stringify(data);
        throw new Error(message);
      }

      return data;
    };

    let data: Record<string, unknown>;
    if (request.contractId && request.method && request.args) {
      data = await createTx({
        type: "contract-call",
        contractId: request.contractId,
        method: request.method,
        args: request.args,
      });
      console.info("[CrossmintService] createUserTransaction succeeded payload=contract-call");
    } else if (request.transactionXDR) {
      if (typeof request.transactionXDR !== "string") {
        throw new Error(
          `[CrossmintService] createUserTransaction expected transactionXDR string, received ${typeof request.transactionXDR}`,
        );
      }
      const tx = request.transactionXDR.trim();
      if (tx.length === 0) {
        throw new Error("[CrossmintService] createUserTransaction received empty transactionXDR");
      }

      const serializedTransactionPayload: {
        type: "serialized-transaction";
        serializedTransaction: string;
        contractId?: string;
      } = {
        type: "serialized-transaction",
        serializedTransaction: tx,
      };
      if (request.contractId) {
        serializedTransactionPayload.contractId = request.contractId;
      }

      try {
        data = await createTx(serializedTransactionPayload);
        console.info(
          "[CrossmintService] createUserTransaction succeeded payload=serialized-transaction",
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const expectsString =
          message.includes("Expected string, received object") ||
          message.includes("params.transaction: Expected string");

        if (!expectsString) {
          throw error;
        }

        data = await createTx(tx);
        console.info(
          "[CrossmintService] createUserTransaction succeeded payload=serialized-string-fallback",
        );
      }
    } else {
      throw new Error(
        "[CrossmintService] createUserTransaction requires either contract-call params or transactionXDR.",
      );
    }

    const transactionId = typeof data.id === "string" ? data.id : null;
    if (!transactionId) {
      throw new Error("[CrossmintService] createUserTransaction succeeded without transaction id");
    }

    return { transactionId };
  }

  async signAndSubmitTransaction(
    _request: SignTransactionRequest,
  ): Promise<SignTransactionResponse> {
    throw new Error(
      "[CrossmintService] USER_SIGNATURE_REQUIRED: Server-side signing is disabled for user fund operations.",
    );
  }
}
