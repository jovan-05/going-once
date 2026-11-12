import type { Metadata, Viewport } from "next";
import { Big_Shoulders, Newsreader } from "next/font/google";
import "./globals.css";

const display = Big_Shoulders({ subsets: ["latin"], weight: ["700", "800", "900"], variable: "--font-big-shoulders" });
const serif = Newsreader({ subsets: ["latin"], weight: ["400", "600"], style: ["normal", "italic"], variable: "--font-newsreader" });

export const metadata: Metadata = {
  title: "Going Once",
  description: "A live charity auction called by an AI auctioneer, with PayPal holds.",
};

export const viewport: Viewport = { themeColor: "#2B0A1D", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${serif.variable}`}>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
