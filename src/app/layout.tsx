// src/app/layout.tsx
import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Oasis Digital Parliament – Governance OS",
  description: "Oasis OS • Digital Parliament Ledger & CI Suite",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#020617] text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}
