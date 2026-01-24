// app/layout.tsx
import "./globals.css";
import type { Metadata } from "next";
import PasskeyGate from "@/components/PasskeyGate";

export const metadata: Metadata = {
  title: "Tools Dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <PasskeyGate>{children}</PasskeyGate>
      </body>
    </html>
  );
}
