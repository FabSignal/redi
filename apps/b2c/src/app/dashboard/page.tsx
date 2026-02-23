"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth, useWallet } from "@crossmint/client-sdk-react-ui";
import {
  onboardUser,
  getBufferBalance,
  prepareVaultCreation,
  submitVaultCreation,
  prepareBufferDeposit,
  confirmBufferDeposit,
  prepareBufferWithdraw,
  confirmBufferWithdraw,
} from "@redi/api-client";
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
          transaction: {
            type: "serialized-transaction";
            serializedTransaction: string;
            contractId?: string;
          };
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
  const { user, logout, status: authStatus } = useAuth();
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
  const didBootstrap = useRef(false);
  const didAutoActivateVault = useRef(false);

  const userId = user?.id ?? null;
  const email = user?.email ?? null;
  const walletAddress = onboarding?.stellarAddress ?? wallet?.address ?? null;

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

  const refreshAll = useCallback(async () => {
    if (!userId || !email) return;
    const ob = await onboardUser(userId, email);
    setOnboarding(ob);
    if (ob.status === "READY") {
      await loadBalance(userId);
    }
  }, [userId, email, loadBalance]);

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

      if (typeof resolvedWallet.experimental_apiClient !== "function") {
        throw new Error("No pudimos abrir el flujo de confirmación de operación.");
      }

      const signerLocator =
        typeof resolvedWallet.signer?.locator === "function"
          ? resolvedWallet.signer.locator()
          : undefined;

      const apiClient = resolvedWallet.experimental_apiClient();

      const created = await apiClient.createTransaction("me:stellar:smart", {
        params: {
          transaction: {
            type: "serialized-transaction",
            serializedTransaction: transactionXDR,
            contractId: bufferContractId,
          },
          ...(signerLocator ? { signer: signerLocator } : {}),
        },
      });

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
      const preparedVault = await prepareVaultCreation(userId);
      const vaultTransactionHash = await executeUserSignedTransaction(preparedVault.transactionXDR);
      await submitVaultCreation(userId, preparedVault.txId, vaultTransactionHash);
      await refreshAll();
      setFlowMessage("Plan activado. Ya puedes operar tus aportes.");
      return true;
    } catch (err: unknown) {
      const message = sanitizeSensitive(
        err instanceof Error ? err.message : "No pudimos activar tu plan.",
      );
      setAppError(message);
      return false;
    } finally {
      setIsVaultLoading(false);
    }
  }, [userId, onboarding, executeUserSignedTransaction, refreshAll]);

  useEffect(() => {
    if (!userId || !walletAddress || !onboarding) return;
    if (didAutoActivateVault.current) return;
    if (onboarding.status === "READY" && onboarding.vaultAddress) return;
    didAutoActivateVault.current = true;
    void ensureVaultReady();
  }, [userId, walletAddress, onboarding, ensureVaultReady]);

  const handleDeposit = useCallback(async () => {
    if (!userId) return;
    setFlowMessage(null);
    setAppError(null);
    setIsDepositLoading(true);
    try {
      const vaultReady = await ensureVaultReady();
      if (!vaultReady) {
        setFlowMessage("No se pudo activar tu plan. Reintenta para continuar.");
        return;
      }

      const amountStroops = xlmToStroops(depositAmount);
      const prepared = await prepareBufferDeposit(userId, amountStroops);
      const transactionHash = await executeUserSignedTransaction(
        prepared.transactionXDR,
        prepared.bufferContractId,
      );
      await confirmBufferDeposit(userId, prepared.txId, transactionHash);
      await loadBalance(userId);
      setFlowMessage("Aporte confirmado y balance actualizado.");
    } catch (err: unknown) {
      const message = sanitizeSensitive(
        err instanceof Error ? err.message : "No pudimos completar el aporte.",
      );
      setAppError(message);
    } finally {
      setIsDepositLoading(false);
    }
  }, [userId, depositAmount, ensureVaultReady, executeUserSignedTransaction, loadBalance]);

  const handleWithdraw = useCallback(async () => {
    if (!userId) return;
    setFlowMessage(null);
    setAppError(null);
    setIsWithdrawLoading(true);
    try {
      const sharesAmount = xlmToStroops(withdrawAmount);
      const prepared = await prepareBufferWithdraw(userId, sharesAmount);
      const transactionHash = await executeUserSignedTransaction(
        prepared.transactionXDR,
        prepared.bufferContractId,
      );
      await confirmBufferWithdraw(userId, prepared.txId, transactionHash);
      await loadBalance(userId);
      setFlowMessage("Rescate confirmado y balance actualizado.");
    } catch (err: unknown) {
      const message = sanitizeSensitive(
        err instanceof Error ? err.message : "No pudimos completar el rescate.",
      );
      setAppError(message);
    } finally {
      setIsWithdrawLoading(false);
    }
  }, [userId, withdrawAmount, executeUserSignedTransaction, loadBalance]);

  const handleSignOut = async () => {
    localStorage.removeItem("redi_user");
    await logout();
    router.replace("/");
  };

  const totalShares = useMemo(() => {
    if (!balance) return "0";
    return (parseToBigInt(balance.availableShares) + parseToBigInt(balance.protectedShares)).toString();
  }, [balance]);

  const isOnboardingReady = onboarding?.status === "READY";
  const hasVaultAddress =
    typeof onboarding?.vaultAddress === "string" && onboarding.vaultAddress.length > 0;

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

          <section className="mt-4 grid grid-cols-2 gap-3">
            <article className="rounded-2xl bg-[#17e9e0] p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#0D0D0D]">Total depositado</p>
              <p className="mt-2 text-lg font-black text-[#0D0D0D]">
                {balance ? `${stroopsToXlm(balance.totalDeposited)} XLM` : "0 XLM"}
              </p>
            </article>
            <article className="rounded-2xl bg-[#a64ac9] p-3 text-[#FFFFFF]">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em]">Disponibles</p>
              <p className="mt-2 text-lg font-black">{balance ? stroopsToXlm(balance.availableShares) : "0"}</p>
            </article>
            <article className="rounded-2xl bg-[#fccd04] p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#0D0D0D]">Protegidas</p>
              <p className="mt-2 text-lg font-black text-[#0D0D0D]">
                {balance ? stroopsToXlm(balance.protectedShares) : "0"}
              </p>
            </article>
            <article className="rounded-2xl bg-[#ffb48f] p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#0D0D0D]">Totales</p>
              <p className="mt-2 text-lg font-black text-[#0D0D0D]">{stroopsToXlm(totalShares)}</p>
            </article>
          </section>

          <section className="mt-4 rounded-3xl bg-[#FFFFFF] p-4">
            <p className="text-[10px] font-black uppercase tracking-[0.14em] text-[#a64ac9]">Último depósito</p>
            <p className="mt-2 text-sm font-semibold text-[#0D0D0D]">
              {balance ? formatDate(balance.lastDepositTs) : "Sin registros"}
            </p>
            {!isOnboardingReady ? (
              <p className="mt-2 text-xs font-semibold text-[#a64ac9]">
                Estamos activando tu plan para habilitar operaciones.
              </p>
            ) : null}
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
              {isDepositLoading
                ? isVaultLoading
                  ? "Activando plan y procesando"
                  : "Procesando aporte"
                : "Confirmar aporte"}
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
              disabled={!isOnboardingReady || !hasVaultAddress || isWithdrawLoading}
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
