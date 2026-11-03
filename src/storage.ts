import type { SupabaseClient } from "@supabase/supabase-js";
import type { Envelope } from "./types";

export interface VaultStore {
  load(userId: string): Promise<Envelope | null>;
  save(userId: string, env: Envelope): Promise<void>;
}

/** 本地演示存储：localStorage，按用户隔离。数据同样是密文，方便对比三方存储。 */
export function createLocalStore(): VaultStore {
  const keyOf = (id: string) => `vault-poc:vault:${id}`;
  return {
    async load(userId) {
      const raw = localStorage.getItem(keyOf(userId));
      return raw ? (JSON.parse(raw) as Envelope) : null;
    },
    async save(userId, env) {
      localStorage.setItem(keyOf(userId), JSON.stringify(env));
    },
  };
}

/**
 * Supabase 存储：表 vaults(user_id pk, envelope jsonb, updated_at)。
 * 行级安全（RLS）保证每个用户只能读写 auth.uid() = user_id 的那一行；
 * 数据库里只有密文信封，Supabase 本身无法解密。
 */
export function createSupabaseStore(client: SupabaseClient): VaultStore {
  return {
    async load(userId) {
      const { data, error } = await client.from("vaults").select("envelope").eq("user_id", userId).maybeSingle();
      if (error) throw new Error(`读取失败：${error.message}`);
      return (data?.envelope as Envelope | undefined) ?? null;
    },
    async save(userId, env) {
      const { error } = await client
        .from("vaults")
        .upsert({ user_id: userId, envelope: env, updated_at: new Date().toISOString() });
      if (error) throw new Error(`写入失败：${error.message}`);
    },
  };
}
