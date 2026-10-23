import type { ReactNode } from "react";

export const metadata = { title: "VPS Telegram Bot" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fa" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
