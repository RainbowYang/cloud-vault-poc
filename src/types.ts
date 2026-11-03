export type Driver = "local" | "supabase";

export interface AppSettings {
  driver: Driver;
  supabaseUrl: string;
  supabaseAnonKey: string;
}

/** 加密信封：这就是三方存储能看到的全部内容。 */
export interface Envelope {
  v: 1;
  kdf: { alg: "PBKDF2-SHA-256"; iterations: number; salt: string };
  iv: string;
  ct: string;
}

export interface DemoRecord {
  id: string;
  text: string;
  createdAt: string;
}

export interface AIConfig {
  provider: "mock" | "anthropic" | "openai";
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** 解密后的明文负载，只在内存中存在。 */
export interface VaultPayload {
  version: 1;
  records: DemoRecord[];
  ai: AIConfig | null;
}

export interface SessionUser {
  id: string;
  label: string;
}
