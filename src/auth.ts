import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionUser } from "./types";

export interface AuthApi {
  kind: "local" | "supabase";
  /** 启动时恢复已登录用户（Supabase 读持久化 session；本地读 localStorage）。 */
  getUser(): Promise<SessionUser | null>;
  /** local：立即登录并返回 signed-in；supabase：发送魔法链接，返回 sent。 */
  signIn(emailOrName: string): Promise<"sent" | "signed-in">;
  signOut(): Promise<void>;
  onChange(cb: (user: SessionUser | null) => void): () => void;
}

const LOCAL_USER_KEY = "vault-poc:local-user";

/** 本地演示鉴权：输入用户名即"登录"，数据按用户名隔离。仅用于验证流程，不是安全边界。 */
export function createLocalAuth(): AuthApi {
  return {
    kind: "local",
    async getUser() {
      const name = localStorage.getItem(LOCAL_USER_KEY);
      return name ? { id: `local:${name}`, label: `本地用户 · ${name}` } : null;
    },
    async signIn(name) {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("请输入用户名");
      localStorage.setItem(LOCAL_USER_KEY, trimmed);
      return "signed-in";
    },
    async signOut() {
      localStorage.removeItem(LOCAL_USER_KEY);
    },
    onChange() {
      return () => {};
    },
  };
}

/** Supabase 鉴权：邮箱魔法链接（邮箱 OTP），JWT 由 supabase-js 持久化。 */
export function createSupabaseAuth(client: SupabaseClient): AuthApi {
  return {
    kind: "supabase",
    async getUser() {
      const { data } = await client.auth.getSession();
      const u = data.session?.user;
      return u ? { id: u.id, label: u.email ?? u.id } : null;
    },
    async signIn(email) {
      const { error } = await client.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: window.location.origin + window.location.pathname },
      });
      if (error) throw new Error(`发送失败：${error.message}`);
      return "sent";
    },
    async signOut() {
      await client.auth.signOut();
    },
    onChange(cb) {
      const { data } = client.auth.onAuthStateChange((_event, session) => {
        const u = session?.user;
        cb(u ? { id: u.id, label: u.email ?? u.id } : null);
      });
      return () => data.subscription.unsubscribe();
    },
  };
}
