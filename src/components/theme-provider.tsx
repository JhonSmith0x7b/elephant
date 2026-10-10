"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { resolvedTheme, themePreference, THEME_STORAGE_KEY, type ThemePreference } from "@/lib/theme";

const ThemeContext = createContext<{ preference: ThemePreference; choose: (value: ThemePreference) => void }>({ preference: "light", choose: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>("light");
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (value: ThemePreference) => {
      document.documentElement.dataset.themePreference = value;
      document.documentElement.dataset.theme = resolvedTheme(value, media.matches);
      setPreference(value);
    };
    apply(themePreference(document.documentElement.dataset.themePreference));
    const onSystemChange = () => apply(themePreference(document.documentElement.dataset.themePreference));
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) apply(themePreference(event.newValue));
    };
    media.addEventListener("change", onSystemChange);
    window.addEventListener("storage", onStorage);
    return () => { media.removeEventListener("change", onSystemChange); window.removeEventListener("storage", onStorage); };
  }, []);

  const choose = (value: ThemePreference) => {
    setPreference(value);
    document.documentElement.dataset.themePreference = value;
    document.documentElement.dataset.theme = resolvedTheme(value, window.matchMedia("(prefers-color-scheme: dark)").matches);
    try { localStorage.setItem(THEME_STORAGE_KEY, value); } catch { /* Keep the current choice when storage is unavailable. */ }
  };
  return <ThemeContext.Provider value={{ preference, choose }}>{children}</ThemeContext.Provider>;
}

export function ThemeSelect() {
  const { preference, choose } = useContext(ThemeContext);
  const Icon = preference === "system" ? Monitor : preference === "dark" ? Moon : Sun;
  return <label className="theme-select"><Icon size={14} aria-hidden="true" />
    <select aria-label="外观主题" value={preference} onChange={event => choose(themePreference(event.target.value))}>
      <option value="light">浅色</option><option value="dark">暗色</option><option value="system">跟随系统</option>
    </select>
  </label>;
}
