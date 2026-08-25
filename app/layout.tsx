import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Shanghainese TTS",
  description: "Shanghainese text to speech, powered by Qwen3-TTS.",
};

/**
 * The interface is written in English; the Chinese content inside it is marked
 * up where it appears (`lang="wuu"` for the Shanghainese, which is what the
 * voice actually speaks). Declaring the whole document as Chinese, as this did
 * before, makes a screen reader read the English UI with a Mandarin voice.
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
