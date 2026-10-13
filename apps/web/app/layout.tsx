import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = { title: "بندق | مركز خدمة العملاء", description: "منصة خدمة عملاء حلواني بندق متعددة القنوات" };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="ar" dir="rtl"><body>{children}</body></html>;
}
