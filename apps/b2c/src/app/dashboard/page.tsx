"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { StellarWallet, useAuth, useWallet } from "@crossmint/client-sdk-react-ui";
import {
  onboardUser,
  getBufferBalance,
  getBufferWalletState,
  createVault,
  getOnboardingStatus,
  prepareBufferDeposit,
  confirmBufferDeposit,
  prepareBufferWithdraw,
  confirmBufferWithdraw,
} from "@redi/api-client";
import { ApiError } from "@redi/api-client";
import type { OnboardingResponse, BufferBalanceResponse } from "@redi/api-client";

const STROOPS_PER_XLM = BigInt("10000000");

function stroopsToXlm(stroops: string): string {
  const n = Number(stroops);
  if (Number.isNaN(n)) return "0";
  return (n / Number(STROOPS_PER_XLM)).toLocaleString("es-AR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 7,
  });
}

function parseToBigInt(value: string | null | undefined): bigint {
  if (!value) return BigInt("0");
  try {
    return BigInt(value);
  } catch {
    return BigInt("0");
  }
}

function xlmToStroops(input: string): string {
  const normalized = input.trim().replace(",", ".");
  if (!/^\d+(\.\d{0,7})?$/.test(normalized)) {
    throw new Error("Ingresa un monto válido con hasta 7 decimales.");
  }
  const [intPartRaw, fracPartRaw = ""] = normalized.split(".");
  const intPart = BigInt(intPartRaw);
  const fracPart = (fracPartRaw + "0000000").slice(0, 7);
  const frac = BigInt(fracPart);
  return (intPart * STROOPS_PER_XLM + frac).toString();
}

function formatDate(ts: number): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString("es-AR");
}

type WalletWithApi = {
  address?: string;
  alias?: string;
  chain?: string;
  approve: (params: { transactionId: string }) => Promise<{ hash?: string }>;
  signer?: { locator?: () => string };
  experimental_apiClient: () => {
    createTransaction: (
      walletLocator: string,
      body: {
        params: {
          transaction:
            | string
            | { type: "serialized-transaction"; serializedTransaction: string; contractId?: string }
            | { type: "contract-call"; contractId: string; method: string; args: Record<string, unknown> };
          signer?: string;
        };
      },
    ) => Promise<{ id?: string; message?: unknown; error?: unknown }>;
  };
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "string" && error.length > 0) return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

function sanitizeSensitive(input: string): string {
  return input
    .replace(/\bsk_[A-Za-z0-9_]+\b/g, "sk_[REDACTED]")
    .replace(/\bck_[A-Za-z0-9_]+\b/g, "ck_[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9\-_.]+\b/gi, "Bearer [REDACTED]");
}

export default function DashboardPage() {
  const router = useRouter();
  const { user, logout, status: authStatus, jwt } = useAuth();
  const { wallet, getOrCreateWallet } = useWallet();

  const [onboarding, setOnboarding] = useState<OnboardingResponse | null>(null);
  const [balance, setBalance] = useState<BufferBalanceResponse["balance"] | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [appError, setAppError] = useState<string | null>(null);
  const [isBalanceLoading, setIsBalanceLoading] = useState(false);
  const [isVaultLoading, setIsVaultLoading] = useState(false);
  const [isDepositLoading, setIsDepositLoading] = useState(false);
  const [isWithdrawLoading, setIsWithdrawLoading] = useState(false);
  const [depositAmount, setDepositAmount] = useState<string>("10");
  const [withdrawAmount, setWithdrawAmount] = useState<string>("1");
  const [flowMessage, setFlowMessage] = useState<string | null>(null);
  const [xlmBalance, setXlmBalance] = useState<string | null>(null);
  const didBootstrap = useRef(false);
  const userId = user?.id ?? null;
  const email = user?.email ?? null;
  const walletAddress = onboarding?.stellarAddress ?? wallet?.address ?? null;
  const isOnboardingReady = onboarding?.status === "READY";
  const hasVaultAddress =
    typeof onboarding?.vaultAddress === "string" && onboarding.vaultAddress.length > 0;

  const loadBalance = useCallback(async (targetUserId: string) => {
    setIsBalanceLoading(true);
    setBalanceError(null);
    try {
      const result = await getBufferBalance(targetUserId);
      setBalance(result.balance);
    } catch (err: unknown) {
      const message = sanitizeSensitive(
        err instanceof Error ? err.message : "No pudimos cargar tu balance.",
      );
      setBalance(null);
      setBalanceError(message);
    } finally {
      setIsBalanceLoading(false);
    }
  }, []);

  const loadXlmBalance = useCallback(async () => {
    if (!wallet && !email) return;
    try {
      if (wallet) {
        const balances = await wallet.balances();
        setXlmBalance(balances.nativeToken?.amount ?? null);
      } else if (email) {
        const state = await getBufferWalletState(email);
        setXlmBalance(state.nativeToken?.amount ?? null);
      }
    } catch (err: unknown) {
      console.warn(`[Dashboard] loadXlmBalance SDK failed: ${sanitizeSensitive(toErrorMessage(err))}`);
      if (email) {
        try {
          const state = await getBufferWalletState(email);
          setXlmBalance(state.nativeToken?.amount ?? null);
        } catch (fallbackErr: unknown) {
          console.warn(`[Dashboard] loadXlmBalance:fallback failed: ${sanitizeSensitive(toErrorMessage(fallbackErr))}`);
        }
      }
    }
  }, [wallet, email]);

  const refreshAll = useCallback(async () => {
    if (!userId || !email) return;
    const ob = await onboardUser(userId, email);
    setOnboarding(ob);
    if (ob.status === "READY") {
      await loadBalance(userId);
    }
    await loadXlmBalance();
  }, [userId, email, loadBalance, loadXlmBalance]);

  useEffect(() => {
    if (authStatus === "logged-out") {
      router.replace("/");
    }
  }, [authStatus, router]);

  useEffect(() => {
    if (didBootstrap.current) return;
    if (!userId || !email) return;
    didBootstrap.current = true;

    const run = async () => {
      try {
        await refreshAll();
      } catch (err: unknown) {
        const message = sanitizeSensitive(
          err instanceof Error ? err.message : "No pudimos inicializar tu dashboard.",
        );
        setAppError(message);
      }
    };

    void run();
  }, [userId, email, refreshAll]);

  const executeUserSignedTransaction = useCallback(
    async (transactionXDR: string, bufferContractId?: string): Promise<string> => {
      if (!email) {
        throw new Error("Cuenta no disponible. Vuelve a iniciar sesión.");
      }

      let resolvedWallet: WalletWithApi | undefined;
      try {
        resolvedWallet = (await getOrCreateWallet({
          chain: "stellar",
          signer: { type: "email", email },
        })) as unknown as WalletWithApi;
      } catch (error: unknown) {
        throw new Error(`Crossmint getOrCreateWallet failed: ${toErrorMessage(error)}`);
      }

      if (!resolvedWallet) {
        throw new Error("No pudimos resolver la cuenta activa para confirmar la operación.");
      }

      if (typeof resolvedWallet.approve !== "function") {
        throw new Error("No pudimos confirmar la operación desde la cuenta.");
      }

      const signerLocator =
        typeof resolvedWallet.signer?.locator === "function"
          ? resolvedWallet.signer.locator()
          : `email:${email}`;

      const crossmintApiKey = process.env.NEXT_PUBLIC_CROSSMINT_API_KEY;
      const crossmintBaseUrl =
        process.env.NEXT_PUBLIC_CROSSMINT_BASE_URL ?? "https://staging.crossmint.com";
      if (!crossmintApiKey || crossmintApiKey.length === 0) {
        throw new Error("Falta NEXT_PUBLIC_CROSSMINT_API_KEY para crear transacciones de firma.");
      }
      if (!jwt || jwt.length === 0) {
        throw new Error("No hay JWT de sesión Crossmint. Reautentica y vuelve a intentar.");
      }

      const createTx = async (
        transaction:
          | string
          | { type: "serialized-transaction"; serializedTransaction: string; contractId?: string },
      ): Promise<{ id?: string; message?: unknown; error?: unknown }> => {
        const response = await fetch(
          `${crossmintBaseUrl}/api/2025-06-09/wallets/me:stellar:smart/transactions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${jwt}`,
              "X-API-KEY": crossmintApiKey,
            },
            body: JSON.stringify({
              params: {
                transaction,
                signer: signerLocator,
              },
            }),
          },
        );

        const body = (await response.json().catch(() => null)) as
          | { id?: string; message?: unknown; error?: unknown }
          | null;
        if (!response.ok) {
          const errMessage =
            body && typeof body === "object" && "message" in body && body.message
              ? toErrorMessage(body.message)
              : `HTTP ${response.status}`;
          throw new Error(sanitizeSensitive(errMessage));
        }
        return body ?? {};
      };

      let created: { id?: string; message?: unknown; error?: unknown };
      try {
        created = await createTx(transactionXDR);
      } catch (error: unknown) {
        const message = toErrorMessage(error);
        const expectedObjectError =
          message.includes("Expected object, received string") ||
          message.includes("params.transaction: Expected object");
        if (!expectedObjectError) {
          throw new Error(`Crossmint createTransaction failed: ${sanitizeSensitive(message)}`);
        }

        created = await createTx({
          type: "serialized-transaction",
          serializedTransaction: transactionXDR,
          contractId: bufferContractId,
        });
      }

      if (!created || typeof created !== "object") {
        throw new Error("Crossmint createTransaction returned an invalid response.");
      }

      if ("message" in created && created.message) {
        throw new Error(`Crossmint createTransaction failed: ${toErrorMessage(created.message)}`);
      }

      const transactionId = typeof created.id === "string" ? created.id : null;
      if (!transactionId) {
        throw new Error("Crossmint createTransaction did not return transaction id.");
      }

      let approved: { hash?: string };
      try {
        approved = await resolvedWallet.approve({ transactionId });
      } catch (error: unknown) {
        throw new Error(`Crossmint approve failed: ${toErrorMessage(error)}`);
      }

      if (!approved.hash || approved.hash.length === 0) {
        throw new Error("No recibimos hash on-chain de la transacción.");
      }

      return approved.hash;
    },
    [getOrCreateWallet, email, jwt],
  );

  const executeBufferTransaction = useCallback(
    async (transactionXDR: string, bufferContractId: string): Promise<string> => {
      if (!email) {
        throw new Error("Cuenta no disponible. Vuelve a iniciar sesión.");
      }

      const resolvedWallet = await getOrCreateWallet({
        chain: "stellar",
        signer: { type: "email", email },
      });

      if (!resolvedWallet) {
        throw new Error("No pudimos obtener la cuenta activa.");
      }

      let stellarWallet: StellarWallet;
      try {
        stellarWallet = StellarWallet.from(resolvedWallet);
      } catch (error: unknown) {
        throw new Error(`No es una wallet Stellar válida: ${toErrorMessage(error)}`);
      }

      try {
        const result = await stellarWallet.sendTransaction({
          transaction: transactionXDR,
          contractId: bufferContractId,
        });

        if (!result.hash || result.hash.length === 0) {
          throw new Error("No recibimos hash on-chain de la transacción.");
        }

        return result.hash;
      } catch (error: unknown) {
        const message = toErrorMessage(error);
        const expectedStringError =
          message.includes("Expected string, received object") ||
          message.includes("params.transaction: Expected string");

        if (!expectedStringError) {
          throw new Error(`Crossmint sendTransaction failed: ${sanitizeSensitive(message)}`);
        }

        // Compatibility fallback for API validators that still expect params.transaction as string.
        const crossmintApiKey = process.env.NEXT_PUBLIC_CROSSMINT_API_KEY;
        const crossmintBaseUrl =
          process.env.NEXT_PUBLIC_CROSSMINT_BASE_URL ?? "https://staging.crossmint.com";
        if (!crossmintApiKey || crossmintApiKey.length === 0) {
          throw new Error(
            "Falta NEXT_PUBLIC_CROSSMINT_API_KEY para fallback string de Crossmint.",
          );
        }
        if (!jwt || jwt.length === 0) {
          throw new Error(
            "No hay JWT de sesión Crossmint para fallback string. Reautentica y vuelve a intentar.",
          );
        }

        const createdResponse = await fetch(
          `${crossmintBaseUrl}/api/2025-06-09/wallets/me:stellar:smart/transactions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${jwt}`,
              "X-API-KEY": crossmintApiKey,
            },
            body: JSON.stringify({
              params: {
                transaction: transactionXDR,
                signer: `email:${email}`,
              },
            }),
          },
        );

        const created = (await createdResponse.json().catch(() => null)) as
          | { id?: string; message?: unknown; error?: unknown }
          | null;

        if (!createdResponse.ok) {
          const fallbackMessage =
            created && typeof created === "object" && "message" in created && created.message
              ? toErrorMessage(created.message)
              : `HTTP ${createdResponse.status}`;
          throw new Error(
            `Crossmint createTransaction (fallback string) failed: ${sanitizeSensitive(
              fallbackMessage,
            )}`,
          );
        }

        if (!created || typeof created !== "object") {
          throw new Error("Crossmint createTransaction (fallback string) respondió inválido.");
        }

        if ("message" in created && created.message) {
          throw new Error(
            `Crossmint createTransaction (fallback string) failed: ${sanitizeSensitive(
              toErrorMessage(created.message),
            )}`,
          );
        }

        const transactionId = typeof created.id === "string" ? created.id : null;
        if (!transactionId) {
          throw new Error(
            "Crossmint createTransaction (fallback string) no devolvió transactionId.",
          );
        }

        const walletWithApi = resolvedWallet as unknown as WalletWithApi;
        const approved = await walletWithApi.approve({ transactionId });
        if (!approved.hash || approved.hash.length === 0) {
          throw new Error("No recibimos hash on-chain de la transacción.");
        }

        return approved.hash;
      }
    },
    [getOrCreateWallet, email, jwt],
  );

  const approveBufferTransaction = useCallback(
    async (transactionId: string): Promise<string> => {
      if (!email) {
        throw new Error("Cuenta no disponible. Vuelve a iniciar sesión.");
      }

      const resolvedWallet = (await getOrCreateWallet({
        chain: "stellar",
        signer: { type: "email", email },
      })) as unknown as WalletWithApi | undefined;

      if (!resolvedWallet || typeof resolvedWallet.approve !== "function") {
        throw new Error("No pudimos obtener la cuenta para aprobar la transacción.");
      }

      const approved = await resolvedWallet.approve({ transactionId });
      if (!approved.hash || approved.hash.length === 0) {
        throw new Error("No recibimos hash on-chain de la transacción.");
      }
      return approved.hash;
    },
    [getOrCreateWallet, email],
  );

  const ensureVaultReady = useCallback(async (): Promise<boolean> => {
    if (!userId) return false;
    if (
      typeof onboarding?.vaultAddress === "string" &&
      onboarding.vaultAddress.length > 0 &&
      onboarding.status === "READY"
    ) {
      return true;
    }

    setIsVaultLoading(true);
    try {
      try {
        await createVault(userId);
      } catch (err: unknown) {
        // If the vault is already active (stale local state), treat as success.
        if (err instanceof ApiError && err.errorCode === "ALREADY_READY") {
          await refreshAll();
          return true;
        }
        throw err;
      }

      setFlowMessage("Activando tu plan de ahorro…");

      // Poll until backend background job finishes (READY or FAILED).
      // Max ~60s at 3s intervals (20 attempts).
      for (let i = 0; i < 20; i++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 3_000));
        const s = await getOnboardingStatus(userId);
        if (s.status === "READY") {
          await refreshAll();
          setFlowMessage("Plan activado. Ya puedes operar tus aportes.");
          return true;
        }
        if (s.status === "FAILED") {
          throw new Error("La activación del plan falló. Por favor, intenta nuevamente.");
        }
      }

      throw new Error("Tiempo de espera agotado activando tu plan. Por favor, intenta nuevamente.");
    } catch (err: unknown) {
      const message = sanitizeSensitive(
        err instanceof Error ? err.message : "No pudimos activar tu plan.",
      );
      setAppError(message);
      setFlowMessage(null);
      return false;
    } finally {
      setIsVaultLoading(false);
    }
  }, [userId, onboarding, refreshAll]);

  const handleDeposit = useCallback(async () => {
    if (!userId) return;
    setFlowMessage(null);
    setAppError(null);
    setIsDepositLoading(true);
    try {
      const vaultReady = await ensureVaultReady();
      if (!vaultReady) {
        return;
      }

      const amountStroops = xlmToStroops(depositAmount);
      const prepared = await prepareBufferDeposit(userId, amountStroops);

      if (!prepared.transactionXDR || !prepared.bufferContractId) {
        throw new Error("Transaction XDR or bufferContractId not returned by server.");
      }
      const transactionHash = prepared.crossmintTransactionId
        ? await approveBufferTransaction(prepared.crossmintTransactionId)
        : await executeBufferTransaction(prepared.transactionXDR, prepared.bufferContractId);
      await confirmBufferDeposit(userId, prepared.txId, transactionHash);
      await Promise.all([loadBalance(userId), loadXlmBalance()]);
      setFlowMessage("Aporte confirmado y balance actualizado.");
    } catch (err: unknown) {
      const message = sanitizeSensitive(
        err instanceof Error ? err.message : "No pudimos completar el aporte.",
      );
      setAppError(message);
    } finally {
      setIsDepositLoading(false);
    }
  }, [
    userId,
    depositAmount,
    ensureVaultReady,
    approveBufferTransaction,
    executeBufferTransaction,
    loadBalance,
    loadXlmBalance,
  ]);

  const handleWithdraw = useCallback(async () => {
    if (!userId) return;
    setFlowMessage(null);
    setAppError(null);
    setIsWithdrawLoading(true);
    try {
      const sharesAmount = xlmToStroops(withdrawAmount);
      const prepared = await prepareBufferWithdraw(userId, sharesAmount);

      if (!prepared.transactionXDR || !prepared.bufferContractId) {
        throw new Error("Transaction XDR or bufferContractId not returned by server.");
      }
      const transactionHash = prepared.crossmintTransactionId
        ? await approveBufferTransaction(prepared.crossmintTransactionId)
        : await executeBufferTransaction(prepared.transactionXDR, prepared.bufferContractId);
      await confirmBufferWithdraw(userId, prepared.txId, transactionHash);
      await Promise.all([loadBalance(userId), loadXlmBalance()]);
      setFlowMessage("Rescate confirmado y balance actualizado.");
    } catch (err: unknown) {
      const message = sanitizeSensitive(
        err instanceof Error ? err.message : "No pudimos completar el rescate.",
      );
      setAppError(message);
    } finally {
      setIsWithdrawLoading(false);
    }
  }, [
    userId,
    withdrawAmount,
    approveBufferTransaction,
    executeBufferTransaction,
    loadBalance,
    loadXlmBalance,
  ]);

  const handleSignOut = async () => {
    localStorage.removeItem("redi_user");
    await logout();
    router.replace("/");
  };

  const totalBalanceValue = useMemo(() => {
    if (!balance) return "0";
    if (balance.totalValue) return balance.totalValue;
    return (parseToBigInt(balance.availableValue) + parseToBigInt(balance.protectedValue)).toString();
  }, [balance]);

  return (
    <main className="min-h-svh bg-[#ffb48f] px-4 py-6 text-[#0D0D0D] md:py-10">
      <div className="mx-auto w-full max-w-[430px] rounded-[42px] border-4 border-[#0D0D0D] bg-[#0D0D0D] p-2 shadow-[0_24px_90px_rgba(13,13,13,0.35)]">
        <section className="min-h-[88svh] rounded-[34px] bg-[#f5e6cc] px-4 pb-6 pt-5">
          <header className="rounded-3xl bg-[#FFFFFF] p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="inline-flex rounded-full bg-[#fccd04] px-3 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-[#0D0D0D]">
                  REDI
                </p>
                <h1 className="mt-3 text-[30px] font-black leading-none text-[#0D0D0D]">Dashboard</h1>
                <p className="mt-2 text-xs font-medium text-[#a64ac9]">Plan financiero personal</p>
              </div>
              <button
                type="button"
                onClick={() => void handleSignOut()}
                className="inline-flex h-10 items-center rounded-xl bg-[#a64ac9] px-3 text-xs font-bold uppercase tracking-[0.08em] text-[#FFFFFF]"
              >
                Salir
              </button>
            </div>
          </header>

          <section className="mt-4 rounded-2xl bg-[#FFFFFF] p-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#0D0D0D]">
              Saldo Wallet XLM
            </p>
            <p className="mt-2 text-lg font-black text-[#0D0D0D]">
              {xlmBalance !== null
                ? `${Number(xlmBalance).toLocaleString("es-AR", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 7,
                  })} XLM`
                : "—"}
            </p>
          </section>

          <section className="mt-4 grid grid-cols-2 gap-3">
            <article className="rounded-2xl bg-[#17e9e0] p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#0D0D0D]">Total depositado</p>
              <p className="mt-2 text-lg font-black text-[#0D0D0D]">
                {balance ? `${stroopsToXlm(balance.totalDeposited)} XLM` : "0 XLM"}
              </p>
            </article>
            <article className="rounded-2xl bg-[#a64ac9] p-3 text-[#FFFFFF]">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em]">Disponibles</p>
              <p className="mt-2 text-lg font-black">
                {balance ? `${stroopsToXlm(balance.availableValue)} XLM` : "0 XLM"}
              </p>
            </article>
            <article className="rounded-2xl bg-[#fccd04] p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#0D0D0D]">Protegidas</p>
              <p className="mt-2 text-lg font-black text-[#0D0D0D]">
                {balance ? `${stroopsToXlm(balance.protectedValue)} XLM` : "0 XLM"}
              </p>
            </article>
            <article className="rounded-2xl bg-[#ffb48f] p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#0D0D0D]">Totales</p>
              <p className="mt-2 text-lg font-black text-[#0D0D0D]">
                {`${stroopsToXlm(totalBalanceValue)} XLM`}
              </p>
            </article>
          </section>

          <section className="mt-4 rounded-3xl bg-[#FFFFFF] p-4">
            <p className="text-[10px] font-black uppercase tracking-[0.14em] text-[#a64ac9]">Último depósito</p>
            <p className="mt-2 text-sm font-semibold text-[#0D0D0D]">
              {balance ? formatDate(balance.lastDepositTs) : "Sin registros"}
            </p>
          </section>

          <section className="mt-4 rounded-3xl bg-[#17e9e0] p-4">
            <p className="text-[10px] font-black uppercase tracking-[0.14em] text-[#0D0D0D]">Aporte</p>
            <label className="mt-3 block text-[11px] font-bold uppercase tracking-[0.1em] text-[#0D0D0D]">
              Monto en XLM
            </label>
            <input
              value={depositAmount}
              onChange={(event) => setDepositAmount(event.target.value)}
              inputMode="decimal"
              placeholder="10.0"
              className="mt-2 h-12 w-full rounded-xl border-2 border-[#0D0D0D] bg-[#f5e6cc] px-4 text-sm font-semibold text-[#0D0D0D] outline-none"
            />
            <button
              type="button"
              disabled={!walletAddress || isDepositLoading || isVaultLoading}
              onClick={() => void handleDeposit()}
              className="mt-3 inline-flex h-12 w-full items-center justify-center rounded-xl bg-[#0D0D0D] text-sm font-black uppercase tracking-[0.09em] text-[#FFFFFF] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isVaultLoading ? "Creando vault..." : isDepositLoading ? "Procesando aporte" : "Confirmar aporte"}
            </button>
          </section>

          <section className="mt-4 rounded-3xl bg-[#a64ac9] p-4 text-[#FFFFFF]">
            <p className="text-[10px] font-black uppercase tracking-[0.14em]">Rescate</p>
            <label className="mt-3 block text-[11px] font-bold uppercase tracking-[0.1em]">
              Monto a retirar
            </label>
            <input
              value={withdrawAmount}
              onChange={(event) => setWithdrawAmount(event.target.value)}
              inputMode="decimal"
              placeholder="1.0"
              className="mt-2 h-12 w-full rounded-xl border-2 border-[#FFFFFF] bg-[#f5e6cc] px-4 text-sm font-semibold text-[#0D0D0D] outline-none"
            />
            <button
              type="button"
              disabled={!walletAddress || isWithdrawLoading}
              onClick={() => void handleWithdraw()}
              className="mt-3 inline-flex h-12 w-full items-center justify-center rounded-xl bg-[#fccd04] text-sm font-black uppercase tracking-[0.09em] text-[#0D0D0D] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isWithdrawLoading ? "Procesando rescate" : "Confirmar rescate"}
            </button>
          </section>

          <section className="mt-4 rounded-3xl bg-[#FFFFFF] p-4">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-black uppercase tracking-[0.14em] text-[#a64ac9]">Estado</p>
              <button
                type="button"
                onClick={() => void refreshAll()}
                className="inline-flex h-8 items-center rounded-lg bg-[#ffb48f] px-3 text-[11px] font-black uppercase tracking-[0.1em] text-[#0D0D0D]"
              >
                Sincronizar
              </button>
            </div>
            <div className="mt-3 space-y-2">
              {isBalanceLoading ? <p className="text-xs font-semibold text-[#0D0D0D]">Actualizando balance...</p> : null}
              {flowMessage ? <p className="text-xs font-semibold text-[#17a19d]">{flowMessage}</p> : null}
              {balanceError ? <p className="text-xs font-semibold text-[#a64ac9]">{balanceError}</p> : null}
              {appError ? <p className="text-xs font-semibold text-[#a64ac9]">{appError}</p> : null}
              <p className="text-[11px] font-semibold text-[#0D0D0D]">{email ?? "Sin correo"}</p>
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}
