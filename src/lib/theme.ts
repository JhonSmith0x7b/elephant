export const THEME_STORAGE_KEY = "elephant-theme";
export type ThemePreference = "light" | "dark" | "system";
export function themePreference(value: unknown): ThemePreference {
  return value === "dark" || value === "system" ? value : "light";
}
export function resolvedTheme(preference: ThemePreference, systemDark: boolean): "light" | "dark" {
  return preference === "dark" || (preference === "system" && systemDark) ? "dark" : "light";
}

// Runs before the body paints, so a saved dark preference does not flash white.
export const THEME_INIT_SCRIPT = `(function(){var p='light';try{var s=localStorage.getItem('elephant-theme');if(s==='dark'||s==='system')p=s;}catch(e){}var d=p==='dark'||(p==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light';document.documentElement.dataset.themePreference=p;})();`;
