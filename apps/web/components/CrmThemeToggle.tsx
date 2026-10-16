"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

type Theme = "light" | "dark";
const themeKey = "bondoq_crm_theme";

export default function CrmThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const saved = localStorage.getItem(themeKey) === "dark" ? "dark" : "light";
    document.documentElement.dataset.crmTheme = saved;
    setTheme(saved);
  }, []);

  function toggleTheme() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.crmTheme = next;
    localStorage.setItem(themeKey, next);
    setTheme(next);
  }

  const label = theme === "dark" ? "تفعيل الوضع الفاتح" : "تفعيل الوضع الداكن";
  return <button type="button" onClick={toggleTheme} aria-label={label} aria-pressed={theme === "dark"} title={label} className="crm-theme-toggle grid h-9 w-9 place-items-center rounded-lg text-stone-500 hover:bg-stone-100">
    {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
  </button>;
}
