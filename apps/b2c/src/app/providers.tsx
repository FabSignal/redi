"use client";

import {
  CrossmintAuthProvider,
  CrossmintProvider,
  CrossmintWalletProvider,
} from "@crossmint/client-sdk-react-ui";
import { getPublicEnv } from "@redi/config";

const env = getPublicEnv({
  NODE_ENV: process.env.NODE_ENV,
  NEXT_PUBLIC_CROSSMINT_API_KEY: process.env.NEXT_PUBLIC_CROSSMINT_API_KEY,
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
});

const sessionStorageProvider = {
  get: async (key: string) => sessionStorage.getItem(key) ?? undefined,
  set: async (key: string, value: string) => {
    sessionStorage.setItem(key, value);
  },
  remove: async (key: string) => {
    sessionStorage.removeItem(key);
  },
};

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <CrossmintProvider apiKey={env.NEXT_PUBLIC_CROSSMINT_API_KEY}>
      <CrossmintAuthProvider
        loginMethods={["email"]}
        storageProvider={sessionStorageProvider}
        authModalTitle="Accede a REDI"
        termsOfServiceText={
          <p>
            Al continuar, aceptas nuestros <a href="/terms">Términos</a> y{" "}
            <a href="/privacy">Política de Privacidad</a>.
          </p>
        }
        appearance={{
          spacingUnit: "8px",
          borderRadius: "12px",
          colors: {
            inputBackground: "#FFFFFF",
            buttonBackground: "#fccd04",
            border: "#0D0D0D",
            background: "#f5e6cc",
            textPrimary: "#0D0D0D",
            textSecondary: "#0D0D0D",
            textLink: "#a64ac9",
            danger: "#ffb48f",
            accent: "#17e9e0",
          },
        }}
      >
        <CrossmintWalletProvider
          createOnLogin={{
            chain: "stellar",
            signer: { type: "email" },
          }}
        >
          {children}
        </CrossmintWalletProvider>
      </CrossmintAuthProvider>
    </CrossmintProvider>
  );
}
