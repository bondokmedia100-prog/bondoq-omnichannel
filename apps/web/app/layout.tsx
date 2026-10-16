import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import DeveloperCredit from "@/components/DeveloperCredit";
import ServiceWorkerRegistration from "@/components/ServiceWorkerRegistration";

export const metadata: Metadata = {
  title: "مركز خدمة العملاء - CRM",
  description: "منصة خدمة عملاء حلواني بندق متعددة القنوات",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" }
    ],
    apple: { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }
  }
};

export const viewport = { themeColor: "#d32f2f", viewportFit: "cover" as const };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <html lang="ar" dir="rtl"><body>{children}<ServiceWorkerRegistration /><DeveloperCredit /></body></html>;
}
