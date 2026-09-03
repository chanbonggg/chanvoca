import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { PwaRegistrar } from "@/components/pwa-registrar";

import "./globals.css";

export const metadata: Metadata = {
  title: "ChanVoca",
  description: "매일 누적해서 복습하는 개인 영단어 암기장",
  applicationName: "ChanVoca",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "ChanVoca",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#080b12",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ko">
      <body>
        <PwaRegistrar />
        {children}
      </body>
    </html>
  );
}

