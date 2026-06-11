import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "FootballSage",
  description: "Self-hosted World Cup Fantasy helper",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
