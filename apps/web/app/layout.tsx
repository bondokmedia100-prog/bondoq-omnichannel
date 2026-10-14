import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import ServiceWorkerRegistration from "@/components/ServiceWorkerRegistration";

export const metadata: Metadata = {
  title: "حلواني بندق | مركز خدمة العملاء",
  description: "منصة خدمة عملاء حلواني بندق متعددة القنوات",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg", apple: "/icon.svg" }
};

export const viewport = { themeColor: "#d32f2f" };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="ar" dir="rtl"><body>{children}<ServiceWorkerRegistration /></body></html>;
}
