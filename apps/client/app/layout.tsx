import type { Metadata } from "next";
import { PrivyProvider } from "@/components/providers/PrivyProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Game Stream Launch",
  description: "Decentralized game streaming on Akash",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>
        <PrivyProvider>{children}</PrivyProvider>
      </body>
    </html>
  );
}
