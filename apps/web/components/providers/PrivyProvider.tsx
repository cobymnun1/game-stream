"use client";

import { PrivyProvider as BasePrivyProvider } from "@privy-io/react-auth";

export function PrivyProvider({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

  return (
    <BasePrivyProvider
      appId={appId}
      config={{
        loginMethods: ["discord", "twitter", "wallet"],
        appearance: {
          theme: "dark",
          accentColor: "#3d8bfd",
        },
        embeddedWallets: {
          createOnLogin: "users-without-wallets",
        },
        defaultChain: {
          id: 8453,
          name: "Base",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: { default: { http: ["https://mainnet.base.org"] } },
        },
        supportedChains: [
          {
            id: 8453,
            name: "Base",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: { default: { http: ["https://mainnet.base.org"] } },
          },
        ],
      }}
    >
      {children}
    </BasePrivyProvider>
  );
}
