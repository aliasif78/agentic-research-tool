import type { Metadata } from "next";
import { Space_Grotesk, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  weight: ["500", "700"],
});

const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Research Agent",
  description: "Durable, resumable AI research runs.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${spaceGrotesk.variable} ${plexSans.variable} ${plexMono.variable} h-full antialiased`}>
      <body className="relative flex min-h-full flex-col overflow-x-hidden bg-ink text-text font-body" suppressHydrationWarning>
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 -z-10 opacity-40"
          style={{
            background: "radial-gradient(600px circle at 20% 20%, color-mix(in srgb, var(--color-signal) 18%, transparent), transparent 60%), radial-gradient(500px circle at 80% 70%, color-mix(in srgb, var(--color-checkpoint) 16%, transparent), transparent 60%)",
            animation: "ambient-drift 18s ease-in-out infinite",
          }}
        />
        {children}
      </body>
    </html>
  );
}
