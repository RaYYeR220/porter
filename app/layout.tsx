import type { ReactNode } from "react";

export const metadata = { title: "Porter", description: "The front desk of an open-source repo." };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
