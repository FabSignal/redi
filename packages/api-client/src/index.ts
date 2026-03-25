import { z } from "zod";

const walletSchema = z.object({
  address: z.string(),
  chain: z.string(),
  type: z.string(),
});

const walletBalanceSchema = z.object({
  address: z.string(),
  chain: z.string(),
  type: z.string(),
  nativeToken: z.object({
    amount: z.string(),
    rawAmount: z.string(),
  }),
  customTokens: z.array(z.unknown()),
});

const onboardingSchema = z.object({
  userId: z.string(),
  stellarAddress: z.string().nullish(),
  vaultAddress: z.string().nullish(),
  status: z.string(),
});

const canonicalBufferBalanceSchema = z.object({
  availableShares: z.string(),
  protectedShares: z.string(),
  availableValue: z.string(),
  protectedValue: z.string(),
  totalValue: z.string(),
  totalDeposited: z.string(),
  lastDepositTs: z.number(),
  version: z.number(),
});

const legacyBufferBalanceSchema = z.object({
  shares: z.string(),
  assets: z.string(),
});

type CanonicalBufferBalance = z.output<typeof canonicalBufferBalanceSchema>;

const normalizedBufferBalanceSchema: z.ZodType<CanonicalBufferBalance> = z
  .union([canonicalBufferBalanceSchema, legacyBufferBalanceSchema])
  .transform((balance) => {
    if ("availableShares" in balance) {
      return balance;
    }
    return {
      availableShares: balance.shares,
      protectedShares: "0",
      availableValue: balance.assets,
      protectedValue: "0",
      totalValue: balance.assets,
      totalDeposited: balance.assets,
      lastDepositTs: 0,
      version: 0,
    };
  });

const bufferBalanceSchema = z.object({
  userId: z.string(),
  balance: normalizedBufferBalanceSchema,
});

const preparedTransactionSchema = z.object({
  txId: z.string().uuid(),
  transactionXDR: z.string().min(1),
  walletAddress: z.string().min(1),
  bufferContractId: z.string().min(1).optional(),
  crossmintTransactionId: z.string().uuid().optional(),
  method: z.string().min(1).optional(),
  args: z.record(z.string(), z.unknown()).optional(),
});

const confirmedTransactionSchema = z.object({
  txId: z.string().uuid(),
  transactionHash: z.string().min(1),
  status: z.literal("CONFIRMED"),
});

const createdVaultSchema = z.object({
  txId: z.string().uuid(),
  status: z.literal("PROCESSING"),
});

const onboardingStatusSchema = z.object({
  userId: z.string(),
  status: z.string(),
  stellarAddress: z.string().nullish(),
  vaultAddress: z.string().nullish(),
});

export type WalletResponse = z.infer<typeof walletSchema>;
export type WalletBalanceResponse = z.infer<typeof walletBalanceSchema>;
export type OnboardingResponse = z.infer<typeof onboardingSchema>;
export type BufferBalanceResponse = z.infer<typeof bufferBalanceSchema>;
export type PreparedTransactionResponse = z.infer<typeof preparedTransactionSchema>;
export type ConfirmedTransactionResponse = z.infer<typeof confirmedTransactionSchema>;
export type CreatedVaultResponse = z.infer<typeof createdVaultSchema>;
export type OnboardingStatusResponse = z.infer<typeof onboardingStatusSchema>;

export class ApiError extends Error {
  readonly errorCode: string;
  readonly statusCode: number;
  constructor(message: string, errorCode: string, statusCode: number) {
    super(message);
    this.name = "ApiError";
    this.errorCode = errorCode;
    this.statusCode = statusCode;
  }
}

function getBaseUrl() {
  return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4103";
}

function parseApiErrorPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if ("message" in payload && typeof payload.message === "string" && payload.message.length > 0) {
    return payload.message;
  }
  if ("error" in payload && typeof payload.error === "string" && payload.error.length > 0) {
    return payload.error;
  }
  return null;
}

async function postJson<T>(path: string, payload: unknown, schema: z.ZodSchema<T>): Promise<T> {
  const response = await fetch(`${getBaseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let parsedMessage: string | null = null;
    let parsedCode: string | null = null;
    try {
      const body = (await response.json()) as unknown;
      parsedMessage = parseApiErrorPayload(body);
      if (
        body &&
        typeof body === "object" &&
        "errorCode" in body &&
        typeof (body as Record<string, unknown>).errorCode === "string"
      ) {
        parsedCode = (body as { errorCode: string }).errorCode;
      }
    } catch {
    }
    throw new ApiError(
      parsedMessage ?? `API request failed (${response.status})`,
      parsedCode ?? "API_ERROR",
      response.status,
    );
  }

  const data = (await response.json()) as unknown;
  return schema.parse(data);
}

export function provisionBufferWallet(email: string) {
  return postJson("/api/buffer/wallet/provision", { email }, walletSchema);
}

export function getBufferWalletState(email: string) {
  return postJson("/api/buffer/wallet/state", { email }, walletBalanceSchema);
}

export function onboardUser(userId: string, email: string) {
  return postJson("/api/buffer/onboarding", { userId, email }, onboardingSchema);
}

export function getBufferBalance(userId: string) {
  return postJson("/api/buffer/balance", { userId }, bufferBalanceSchema);
}

export function createVault(userId: string) {
  return postJson("/api/buffer/onboarding/vault/create", { userId }, createdVaultSchema);
}

export function getOnboardingStatus(userId: string) {
  return postJson("/api/buffer/onboarding/status", { userId }, onboardingStatusSchema);
}

export function prepareBufferDeposit(userId: string, amountStroops: string) {
  return postJson(
    "/api/buffer/deposit/prepare",
    { userId, amountStroops },
    preparedTransactionSchema,
  );
}

export function confirmBufferDeposit(userId: string, txId: string, transactionHash: string) {
  return postJson(
    "/api/buffer/deposit/submit",
    { userId, txId, transactionHash },
    confirmedTransactionSchema,
  );
}

export function prepareBufferWithdraw(userId: string, sharesAmount: string) {
  return postJson(
    "/api/buffer/withdraw/prepare",
    { userId, sharesAmount },
    preparedTransactionSchema,
  );
}

export function confirmBufferWithdraw(userId: string, txId: string, transactionHash: string) {
  return postJson(
    "/api/buffer/withdraw/submit",
    { userId, txId, transactionHash },
    confirmedTransactionSchema,
  );
}
