import type { AppSettings } from "./types";

const KEY = "vault-poc:settings";

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { driver: "local", supabaseUrl: "", supabaseAnonKey: "", ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    // 忽略损坏的本地配置
  }
  return { driver: "local", supabaseUrl: "", supabaseAnonKey: "" };
}

export function saveSettings(s: AppSettings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}
