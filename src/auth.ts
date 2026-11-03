import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionUser } from "./types";

export interface AuthApi {
  kind: "local" | "supabase";
  supportsPassword: boolean;
  /** 启动时恢复已登录用户（Supabase 读持久化 session；本地读 localStorage）。 */
  getUser(): Promise<SessionUser | null>;
  /** 本地演示模式：用户名即登录。 */
  signInLocal(name: string): Promise<void>;
  /** 邮箱 + 密码登录（日常主路径）。 */
  signInWithPassword(email: string, password: string): Promise<void>;
  /** 注册：项目开启邮箱确认时返回 confirm-email；否则直接 signed-in。 */
  signUpWithPassword(email: string, password: string): Promise<"signed-in" | "confirm-email">;
  /** 魔法链接（辅助路径：首次注册验证 / 忘记密码）。 */
  sendMagicLink(email: string): Promise<void>;
  signOut(): Promise<void>;
  onChange(cb: (user: SessionUser | null) => void): () => void;
}

const LOCAL_USER_KEY = "vault-poc:local-user";

/** 把 Supabase 的英文错误翻译成可执行的中文提示。 */
function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login credentials")) return "邮箱或密码不正确";
  if (m.includes("email not confirmed"))
    return "邮箱还未确认：请点注册时收到的确认邮件链接（或在 Supabase 控制台关闭 Confirm email 后重试）";
  if (m.includes("user already registered")) return "该邮箱已注册，请直接登录（忘记密码可用魔法链接）";
  if (m.includes("password should be at least")) return "密码太短：Supabase 默认要求至少 6 位";
  if (m.includes("rate limit")) return "操作过于频繁，触发了频率限制，请稍后再试";
  return message;
}

/** 本地演示鉴权：输入用户名即"登录"，数据按用户名隔离。仅用于验证流程，不是安全边界。 */
export function createLocalAuth(): AuthApi {
  const notSupported = async () => {
    throw new Error("本地演示模式不支持邮箱登录，请切换到 Supabase 驱动");
  };
  return {
    kind: "local",
    supportsPassword: false,
    async getUser() {
      const name = localStorage.getItem(LOCAL_USER_KEY);
      return name ? { id: `local:${name}`, label: `本地用户 · ${name}` } : null;
    },
    async signInLocal(name) {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("请输入用户名");
      localStorage.setItem(LOCAL_USER_KEY, trimmed);
    },
    signInWithPassword: notSupported,
    signUpWithPassword: notSupported,
    sendMagicLink: notSupported,
    async signOut() {
      localStorage.removeItem(LOCAL_USER_KEY);
    },
    onChange() {
      return () => {};
    },
  };
}

/** Supabase 鉴权：密码为主、魔法链接为辅；session 由 supabase-js 持久化并按站点 origin 隔离。 */
export function createSupabaseAuth(client: SupabaseClient): AuthApi {
  return {
    kind: "supabase",
    supportsPassword: true,
    async getUser() {
      const { data } = await client.auth.getSession();
      const u = data.session?.user;
      return u ? { id: u.id, label: u.email ?? u.id } : null;
    },
    async signInLocal() {
      throw new Error("Supabase 模式不支持用户名登录");
    },
    async signInWithPassword(email, password) {
      const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw new Error(friendlyAuthError(error.message));
    },
    async signUpWithPassword(email, password) {
      const { data, error } = await client.auth.signUp({ email: email.trim(), password });
      if (error) throw new Error(friendlyAuthError(error.message));
      return data.session ? "signed-in" : "confirm-email";
    },
    async sendMagicLink(email) {
      const { error } = await client.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: window.location.origin + window.location.pathname },
      });
      if (error) throw new Error(`发送失败：${friendlyAuthError(error.message)}`);
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
