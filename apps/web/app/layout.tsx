import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "FootballSage",
  description: "World Cup Fantasy team advice and next-match recommendations",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="nb">
      <body>{children}</body>
    </html>
  );
}
