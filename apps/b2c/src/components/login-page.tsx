"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { EmbeddedAuthForm, useAuth, useWallet } from "@crossmint/client-sdk-react-ui";
import { provisionBufferWallet } from "@redi/api-client";

export function LoginPage() {
  const router = useRouter();
  const { status: authStatus, user, logout } = useAuth();
  const { wallet } = useWallet();
  const isProvisioning = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const run = async () => {
      if (authStatus !== "logged-in") return;
      if (isProvisioning.current) return;
      const email = user?.email;
      if (!email) return;

      isProvisioning.current = true;
      try {
        const serverWallet = await provisionBufferWallet(email);
        const walletAddress = wallet?.address ?? serverWallet.address;

        localStorage.setItem(
          "redi_user",
          JSON.stringify({ email, walletAddress, loginDate: new Date().toISOString() }),
        );

        router.push("/dashboard");
      } catch {
        setError("No pudimos inicializar tu sesión. Intenta nuevamente.");
        isProvisioning.current = false;
      }
    };

    void run();
  }, [authStatus, user?.email, wallet?.address, router]);

  const handleSignOut = async () => {
    isProvisioning.current = false;
    setError(null);
    localStorage.removeItem("redi_user");
    await logout();
  };

  if (authStatus === "logged-in") {
    return (
      <main className="min-h-svh bg-[#ffb48f] px-4 py-6 text-[#0D0D0D] md:py-10">
        <div className="mx-auto w-full max-w-[430px] rounded-[42px] border-4 border-[#0D0D0D] bg-[#0D0D0D] p-2 shadow-[0_24px_90px_rgba(13,13,13,0.35)]">
          <section className="min-h-[88svh] rounded-[34px] bg-[#f5e6cc] px-5 pb-6 pt-8">
            <div className="rounded-3xl bg-[#FFFFFF] p-6">
              <p className="inline-flex rounded-full bg-[#fccd04] px-3 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-[#0D0D0D]">
                REDI
              </p>
              <h1 className="mt-4 text-3xl font-black leading-none text-[#0D0D0D]">Inicializando</h1>
              <p className="mt-3 text-sm font-semibold text-[#a64ac9]">Estamos preparando tu dashboard.</p>
              <button
                type="button"
                onClick={() => void handleSignOut()}
                className="mt-6 inline-flex h-11 items-center rounded-xl bg-[#a64ac9] px-4 text-sm font-black uppercase tracking-[0.08em] text-[#FFFFFF]"
              >
                Cerrar sesión
              </button>
            </div>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-svh bg-[#ffb48f] px-4 py-6 text-[#0D0D0D] md:py-10">
      <div className="mx-auto w-full max-w-[430px] rounded-[42px] border-4 border-[#0D0D0D] bg-[#0D0D0D] p-2 shadow-[0_24px_90px_rgba(13,13,13,0.35)]">
        <section className="min-h-[88svh] rounded-[34px] bg-[#f5e6cc] px-5 pb-6 pt-8">
          <div className="rounded-3xl bg-[#FFFFFF] p-6">
            <p className="inline-flex rounded-full bg-[#fccd04] px-3 py-1 text-[10px] font-black uppercase tracking-[0.16em] text-[#0D0D0D]">
              REDI
            </p>
            <h1 className="mt-4 text-3xl font-black leading-none text-[#0D0D0D]">Bienvenida</h1>
            <p className="mt-3 text-sm font-semibold text-[#a64ac9]">
              Ingresa con tu correo para acceder a tu experiencia financiera.
            </p>
          </div>

          <div className="mt-4 rounded-3xl border-2 border-[#17e9e0] bg-[#FFFFFF] p-4">
            <EmbeddedAuthForm />
          </div>

          {error ? (
            <p className="mt-4 rounded-2xl bg-[#a64ac9] px-4 py-3 text-sm font-semibold text-[#FFFFFF]">
              {error}
            </p>
          ) : null}
        </section>
      </div>
    </main>
  );
}
