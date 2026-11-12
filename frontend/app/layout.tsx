import type { Metadata } from "next";
import { Onest, Unbounded } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { WalletProvider } from "@/components/wallet";
import { TabBar } from "@/components/TabBar";
import { NftWalletProvider } from "@/components/nftWallet";
import { RefCapture } from "@/components/Referral";

const unbounded = Unbounded({ subsets: ["latin", "cyrillic"], weight: ["600", "700"], variable: "--font-unbounded" });
const onest = Onest({ subsets: ["latin", "cyrillic"], variable: "--font-onest" });

export const metadata: Metadata = {
  title: { default: "dolya | your moves, explained", template: "dolya | %s" },
  description: "Sign your rules once. Strategies run your NEAR portfolio, and every move comes with a plain-words reason.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${unbounded.variable} ${onest.variable}`} suppressHydrationWarning>
      <body className="min-h-screen" suppressHydrationWarning>
        <WalletProvider>
          <NftWalletProvider>
            <RefCapture />
            <Nav />
            <div className="pb-20 md:pb-0">{children}</div>
            <TabBar />
          </NftWalletProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
