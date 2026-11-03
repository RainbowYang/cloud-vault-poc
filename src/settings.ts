import type { AppSettings } from "./types";

const KEY = "vault-poc:settings";

/** 构建期注入的非敏感配置（VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY），见 README。 */
function envDefaults(): AppSettings {
  const url = import.meta.env.VITE_SUPABASE_URL ?? "";
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";
  return { driver: url && anon ? "supabase" : "local", supabaseUrl: url, supabaseAnonKey: anon };
}

export function loadSettings(): AppSettings {
  const env = envDefaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<AppSettings>;
      return {
        driver: saved.driver ?? env.driver,
        supabaseUrl: saved.supabaseUrl || env.supabaseUrl,
        supabaseAnonKey: saved.supabaseAnonKey || env.supabaseAnonKey,
      };
    }
  } catch {
    // 忽略损坏的本地配置
  }
  return env;
}

export function saveSettings(s: AppSettings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}
