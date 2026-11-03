import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import { createLocalAuth, createSupabaseAuth, type AuthApi } from "./auth";
import { createLocalStore, createSupabaseStore, type VaultStore } from "./storage";
import { cacheKey, clearKeyCache, loadCachedKey } from "./keycache";
import { cacheIdOf, decryptJSON, deriveKey, encryptJSON, fromB64, newKdf } from "./crypto";
import { callAI, type ChatMessage } from "./ai";
import { loadSettings, saveSettings } from "./settings";
import type { AIConfig, AppSettings, DemoRecord, Envelope, SessionUser, VaultPayload } from "./types";

type Phase = "boot" | "login" | "create" | "unlock" | "vault";
type Tab = "records" | "ai" | "settings" | "cipher";

const EMPTY_AI: AIConfig = { provider: "mock", baseUrl: "", model: "claude-opus-5-5", apiKey: "" };

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function App() {
  const [settings] = useState<AppSettings>(loadSettings);
  const [phase, setPhase] = useState<Phase>("boot");
  const [user, setUser] = useState<SessionUser | null>(null);
  const [envelope, setEnvelope] = useState<Envelope | null>(null);
  const [payload, setPayload] = useState<VaultPayload | null>(null);
  const [key, setKey] = useState<CryptoKey | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("records");
  const [syncedAt, setSyncedAt] = useState("");
  const enteredUserRef = useRef<string | null>(null);
  const saveTimer = useRef<number | null>(null);

  const { auth, store } = useMemo<{ auth: AuthApi; store: VaultStore }>(() => {
    if (settings.driver === "supabase" && settings.supabaseUrl && settings.supabaseAnonKey) {
      const client = createClient(settings.supabaseUrl, settings.supabaseAnonKey);
      return { auth: createSupabaseAuth(client), store: createSupabaseStore(client) };
    }
    return { auth: createLocalAuth(), store: createLocalStore() };
  }, [settings]);

  const enterVault = useCallback(
    async (u: SessionUser) => {
      if (enteredUserRef.current === u.id) return;
      enteredUserRef.current = u.id;
      setError("");
      setBusy("读取保险箱…");
      try {
        const env = await store.load(u.id);
        setEnvelope(env);
        if (!env) {
          setPhase("create");
          return;
        }
        const cached = await loadCachedKey(cacheIdOf(u.id, env));
        if (cached) {
          try {
            const p = await decryptJSON<VaultPayload>(cached, env);
            setKey(cached);
            setPayload(p);
            setPhase("vault");
            return;
          } catch {
            // 缓存密钥解不开（可能是换了口令/数据），回退到手动解锁
          }
        }
        setPhase("unlock");
      } catch (e) {
        enteredUserRef.current = null;
        setError(errText(e));
        setPhase("login");
      } finally {
        setBusy("");
      }
    },
    [store],
  );

  // 启动与登录态变化
  useEffect(() => {
    let alive = true;
    setPhase("boot");
    (async () => {
      const u = await auth.getUser();
      if (!alive) return;
      if (u) {
        setUser(u);
        await enterVault(u);
      } else {
        setPhase("login");
      }
    })();
    const unsub = auth.onChange(async (u) => {
      if (!alive) return;
      if (u) {
        setUser(u);
        await enterVault(u);
      } else {
        enteredUserRef.current = null;
        setUser(null);
        setKey(null);
        setPayload(null);
        setPhase("login");
      }
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [auth, enterVault]);

  const persist = useCallback(
    (next: VaultPayload) => {
      if (!user || !key || !envelope) return;
      setPayload(next);
      setError("");
      setBusy("加密并同步…");
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(async () => {
        try {
          const { iv, ct } = await encryptJSON(key, next);
          const env: Envelope = { ...envelope, iv, ct };
          await store.save(user.id, env);
          setEnvelope(env);
          setSyncedAt(new Date().toLocaleTimeString());
        } catch (e) {
          setError(errText(e));
        } finally {
          setBusy("");
        }
      }, 350);
    },
    [user, key, envelope, store],
  );

  async function handleCreate(passphrase: string) {
    if (!user) return;
    setBusy("正在创建保险箱…");
    setError("");
    try {
      const kdf = newKdf();
      const k = await deriveKey(passphrase, fromB64(kdf.salt), kdf.iterations);
      const p: VaultPayload = { version: 1, records: [], ai: null };
      const { iv, ct } = await encryptJSON(k, p);
      const env: Envelope = { v: 1, kdf, iv, ct };
      await store.save(user.id, env);
      await cacheKey(cacheIdOf(user.id, env), k);
      setEnvelope(env);
      setKey(k);
      setPayload(p);
      setSyncedAt(new Date().toLocaleTimeString());
      setPhase("vault");
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy("");
    }
  }

  async function handleUnlock(passphrase: string) {
    if (!user || !envelope) return;
    setBusy("正在解密…");
    setError("");
    try {
      const k = await deriveKey(passphrase, fromB64(envelope.kdf.salt), envelope.kdf.iterations);
      const p = await decryptJSON<VaultPayload>(k, envelope);
      await cacheKey(cacheIdOf(user.id, envelope), k);
      setKey(k);
      setPayload(p);
      setPhase("vault");
    } catch {
      setError("口令不正确，或保险箱数据已损坏。");
    } finally {
      setBusy("");
    }
  }

  function lock() {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    setKey(null);
    setPayload(null);
    setError("");
    setPhase(envelope ? "unlock" : "create");
  }

  async function signOut() {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    await auth.signOut().catch(() => {});
    enteredUserRef.current = null;
    setUser(null);
    setKey(null);
    setPayload(null);
    setEnvelope(null);
    setPhase("login");
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          <strong>Cloud Vault</strong>
          <span className="sub">静态页面 · 端侧加密 · 三方密文 · 浏览器直连 AI</span>
        </div>
        <div className="status">
          {user && <span className="chip">{user.label}</span>}
          <span className={`chip ${settings.driver === "supabase" ? "chip-blue" : ""}`}>
            {settings.driver === "supabase" ? "Supabase" : "本地演示"}
          </span>
          {busy && <span className="chip chip-amber">{busy}</span>}
          {syncedAt && <span className="muted">已加密同步 · {syncedAt}</span>}
        </div>
      </header>

      {error && (
        <div className="banner banner-error">
          {error}
          <button className="icon" onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}

      {phase === "boot" && <div className="center muted">加载中…</div>}

      {phase === "login" && (
        <LoginScreen
          auth={auth}
          settings={settings}
          onSignedIn={async () => {
            const u = await auth.getUser();
            if (u) {
              setUser(u);
              await enterVault(u);
            }
          }}
        />
      )}

      {phase === "create" && user && <CreateScreen onCreate={handleCreate} busy={!!busy} />}
      {phase === "unlock" && envelope && <UnlockScreen onUnlock={handleUnlock} busy={!!busy} />}

      {phase === "vault" && payload && key && user && envelope && (
        <main className="vault">
          <nav className="tabs">
            {(
              [
                ["records", "演示数据"],
                ["ai", "AI 对话"],
                ["cipher", "密文查看"],
                ["settings", "设置"],
              ] as Array<[Tab, string]>
            ).map(([id, label]) => (
              <button key={id} className={tab === id ? "tab active" : "tab"} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
            <div className="spacer" />
            <button className="btn ghost" onClick={lock}>
              锁定
            </button>
            <button className="btn ghost" onClick={signOut}>
              退出登录
            </button>
          </nav>

          {tab === "records" && <RecordsPanel payload={payload} persist={persist} />}
          {tab === "ai" && <AIPanel payload={payload} persist={persist} />}
          {tab === "cipher" && <CipherPanel envelope={envelope} driver={settings.driver} />}
          {tab === "settings" && (
            <SettingsPanel
              settings={settings}
              user={user}
              envelope={envelope}
              onLockAndClearCache={async () => {
                await clearKeyCache();
                lock();
              }}
            />
          )}
        </main>
      )}

      <footer className="foot">
        密文之外的一切（口令、明文字段、AI key）只存在于本页内存。
      </footer>
    </div>
  );
}

/* ---------- 登录 ---------- */

function LoginScreen({
  auth,
  settings,
  onSignedIn,
}: {
  auth: AuthApi;
  settings: AppSettings;
  onSignedIn: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"password" | "link">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const isSupabase = auth.kind === "supabase";

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setErr("");
    setNotice("");
    try {
      await task();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const submitLocal = () =>
    run(async () => {
      await auth.signInLocal(name);
      await onSignedIn();
    });

  const submitPassword = () =>
    run(async () => {
      if (!email.trim() || !password) throw new Error("请输入邮箱和密码");
      await auth.signInWithPassword(email, password);
      await onSignedIn();
    });

  const submitSignUp = () =>
    run(async () => {
      if (!email.trim() || password.length < 6) throw new Error("请输入邮箱，密码至少 6 位");
      const result = await auth.signUpWithPassword(email, password);
      if (result === "signed-in") {
        await onSignedIn();
      } else {
        setNotice(
          `已向 ${email.trim()} 发送确认邮件：点一次链接即完成注册，之后用密码登录即可。不想每次注册都收邮件，可在 Supabase 控制台 Authentication → Providers → Email 关闭 Confirm email。`,
        );
      }
    });

  const submitMagic = () =>
    run(async () => {
      if (!email.trim()) throw new Error("请输入邮箱");
      await auth.sendMagicLink(email);
      setNotice(`已向 ${email.trim()} 发送登录链接。注意：链接只能在本浏览器、本地址（${window.location.host}）打开才有效。`);
    });

  return (
    <div className="center">
      <div className="card auth-card">
        {!isSupabase ? (
          <>
            <h2>本地演示登录</h2>
            <p className="muted">
              输入任意用户名即完成登录；不同用户名 = 不同用户，数据存本机 localStorage。仅用于验证加密流程，不是安全边界。
            </p>
            <label className="field">
              <span>用户名</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如 rainbow"
                onKeyDown={(e) => e.key === "Enter" && submitLocal()}
              />
            </label>
            <button className="btn primary" disabled={busy || !name.trim()} onClick={submitLocal}>
              {busy ? "处理中…" : "进入"}
            </button>
            <p className="hint">想用真实的 Supabase 多用户隔离？去「设置」切换驱动（先登录后才能进设置）。</p>
          </>
        ) : (
          <>
            <h2>登录</h2>
            <div className="mode-switch">
              <button
                className={mode === "password" ? "mode active" : "mode"}
                onClick={() => {
                  setMode("password");
                  setErr("");
                  setNotice("");
                }}
              >
                邮箱 + 密码
              </button>
              <button
                className={mode === "link" ? "mode active" : "mode"}
                onClick={() => {
                  setMode("link");
                  setErr("");
                  setNotice("");
                }}
              >
                魔法链接
              </button>
            </div>
            <label className="field">
              <span>邮箱</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </label>
            {mode === "password" && (
              <label className="field">
                <span>密码</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="至少 6 位"
                  onKeyDown={(e) => e.key === "Enter" && submitPassword()}
                />
              </label>
            )}
            {mode === "password" ? (
              <div className="row">
                <button className="btn primary grow" disabled={busy} onClick={submitPassword}>
                  {busy ? "处理中…" : "登录"}
                </button>
                <button className="btn grow" disabled={busy} onClick={submitSignUp}>
                  首次注册
                </button>
              </div>
            ) : (
              <button className="btn primary" style={{ width: "100%" }} disabled={busy} onClick={submitMagic}>
                {busy ? "发送中…" : "发送魔法链接"}
              </button>
            )}
            {notice && <p className="ok">{notice}</p>}
            {err && <p className="err">{err}</p>}
            <p className="hint">
              登录态保存在当前浏览器、当前地址（{window.location.host}）下：同一地址刷新不用重登；换地址（localhost / 127.0.0.1 /
              Pages）或换浏览器需要重新登录一次。日常建议固定收藏一个入口。
            </p>
            <p className="hint">忘记密码：切到「魔法链接」收一封邮件，点开即可登录。</p>
          </>
        )}
        <p className="hint">当前驱动：{settings.driver === "supabase" ? "Supabase" : "本地演示"}</p>
      </div>
    </div>
  );
}

/* ---------- 创建 / 解锁 ---------- */

function CreateScreen({ onCreate, busy }: { onCreate: (pass: string) => void; busy: boolean }) {
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");

  function submit() {
    if (pass.length < 8) return setErr("口令至少 8 位");
    if (pass !== confirm) return setErr("两次输入不一致");
    setErr("");
    onCreate(pass);
  }

  return (
    <div className="center">
      <div className="card auth-card">
        <h2>创建保险箱</h2>
        <p className="muted">
          这个口令就是唯一的加密 key：数据在你输入口令派生出的 AES-GCM 密钥下加密后才上传。口令不会离开本页，也不会存到三方。
        </p>
        <label className="field">
          <span>加密口令</span>
          <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="至少 8 位，越强越好" />
        </label>
        <label className="field">
          <span>确认口令</span>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </label>
        <button className="btn primary" disabled={busy} onClick={submit}>
          {busy ? "创建中…" : "创建并上传密文"}
        </button>
        {err && <p className="err">{err}</p>}
        <p className="hint">⚠️ 口令丢失 = 数据永久无法解密。三方没有你的口令，任何人都无法帮你恢复。</p>
      </div>
    </div>
  );
}

function UnlockScreen({ onUnlock, busy }: { onUnlock: (pass: string) => void; busy: boolean }) {
  const [pass, setPass] = useState("");
  return (
    <div className="center">
      <div className="card auth-card">
        <h2>解锁保险箱</h2>
        <p className="muted">已从存储读到密文。输入加密口令派生密钥并解密；若本设备缓存过密钥则会自动解锁。</p>
        <label className="field">
          <span>加密口令</span>
          <input
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onUnlock(pass)}
            autoFocus
          />
        </label>
        <button className="btn primary" disabled={busy || !pass} onClick={() => onUnlock(pass)}>
          {busy ? "解密中…" : "解锁"}
        </button>
      </div>
    </div>
  );
}

/* ---------- 演示数据 ---------- */

function RecordsPanel({ payload, persist }: { payload: VaultPayload; persist: (p: VaultPayload) => void }) {
  const [text, setText] = useState("");

  function add() {
    const value = text.trim();
    if (!value) return;
    const record: DemoRecord = { id: crypto.randomUUID(), text: value, createdAt: new Date().toISOString() };
    persist({ ...payload, records: [record, ...payload.records] });
    setText("");
  }

  function remove(id: string) {
    persist({ ...payload, records: payload.records.filter((r) => r.id !== id) });
  }

  return (
    <section className="panel">
      <h3>演示数据（与技术无关，用于验证"明文 → 加密 → 三方 → 解密"）</h3>
      <div className="row">
        <input
          className="grow"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="写点什么，它会以密文形式同步到存储"
        />
        <button className="btn primary" onClick={add} disabled={!text.trim()}>
          添加
        </button>
      </div>
      <ul className="records">
        {payload.records.map((r) => (
          <li key={r.id}>
            <div>
              <div className="record-text">{r.text}</div>
              <div className="muted small">{new Date(r.createdAt).toLocaleString()}</div>
            </div>
            <button className="icon" onClick={() => remove(r.id)} title="删除">
              ×
            </button>
          </li>
        ))}
        {payload.records.length === 0 && <li className="muted">还没有记录。加一条，去「密文查看」看三方实际拿到了什么。</li>}
      </ul>
    </section>
  );
}

/* ---------- AI 面板 ---------- */

function AIPanel({ payload, persist }: { payload: VaultPayload; persist: (p: VaultPayload) => void }) {
  const [draft, setDraft] = useState<AIConfig>(payload.ai ?? EMPTY_AI);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  function saveConfig() {
    persist({ ...payload, ai: draft });
  }

  async function send() {
    const value = input.trim();
    if (!value || busy) return;
    const next: ChatMessage[] = [...messages, { role: "user", content: value }];
    setMessages(next);
    setInput("");
    setBusy(true);
    setErr("");
    try {
      const reply = await callAI(draft, next);
      setMessages([...next, { role: "assistant", content: reply }]);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h3>AI 配置（随保险箱加密保存）</h3>
      <div className="grid">
        <label className="field">
          <span>Provider</span>
          <select value={draft.provider} onChange={(e) => setDraft({ ...draft, provider: e.target.value as AIConfig["provider"] })}>
            <option value="mock">mock（本地模拟，无需 key）</option>
            <option value="anthropic">Anthropic（官方 API，浏览器直连）</option>
            <option value="openai">OpenAI 兼容网关（ZenMux/DeepSeek 等）</option>
          </select>
        </label>
        <label className="field">
          <span>模型</span>
          <input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} placeholder="claude-opus-5-5" />
        </label>
        {draft.provider === "openai" && (
          <label className="field field-wide">
            <span>Base URL</span>
            <input value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} placeholder="https://api.deepseek.com/v1" />
          </label>
        )}
        <label className="field field-wide">
          <span>API Key（不会明文离开本页）</span>
          <input
            type="password"
            value={draft.apiKey}
            onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
            placeholder={draft.provider === "mock" ? "mock 模式无需 key" : "sk-…"}
            disabled={draft.provider === "mock"}
          />
        </label>
      </div>
      <button className="btn" onClick={saveConfig}>
        保存配置到保险箱（加密上传）
      </button>

      <h3 className="mt">对话</h3>
      <div className="chat">
        {messages.length === 0 && <p className="muted">先用 mock 验证链路，再换成真实 key。消息只在本页内存，不写入存储。</p>}
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.content}
          </div>
        ))}
        {busy && <div className="bubble assistant muted">思考中…</div>}
      </div>
      <div className="row">
        <input
          className="grow"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="发一条消息…"
        />
        <button className="btn primary" onClick={send} disabled={busy || !input.trim()}>
          发送
        </button>
      </div>
      {err && <p className="err">{err}</p>}
    </section>
  );
}

/* ---------- 密文查看 ---------- */

function CipherPanel({ envelope, driver }: { envelope: Envelope; driver: string }) {
  return (
    <section className="panel">
      <h3>三方存储实际拿到的全部内容</h3>
      <p className="muted">
        存储驱动：{driver === "supabase" ? "Supabase（表 vaults.envelope）" : "本地 localStorage（模拟三方）"}。
        salt / iterations 是 KDF 参数（不是秘密），iv 每次随机；真正的内容在 ct 里，没有口令无法解密。
      </p>
      <pre className="cipher">{JSON.stringify(envelope, null, 2)}</pre>
    </section>
  );
}

/* ---------- 设置 ---------- */

function SettingsPanel({
  settings,
  user,
  envelope,
  onLockAndClearCache,
}: {
  settings: AppSettings;
  user: SessionUser;
  envelope: Envelope;
  onLockAndClearCache: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<AppSettings>(settings);

  function apply() {
    saveSettings(draft);
    window.location.reload();
  }

  function exportEnvelope() {
    const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vault-envelope-${user.id.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="panel">
      <h3>存储与鉴权</h3>
      <div className="grid">
        <label className="field">
          <span>存储驱动</span>
          <select value={draft.driver} onChange={(e) => setDraft({ ...draft, driver: e.target.value as AppSettings["driver"] })}>
            <option value="local">本地演示（localStorage）</option>
            <option value="supabase">Supabase（云端 + 多用户鉴权）</option>
          </select>
        </label>
        {draft.driver === "supabase" && (
          <>
            <label className="field field-wide">
              <span>Supabase URL</span>
              <input value={draft.supabaseUrl} onChange={(e) => setDraft({ ...draft, supabaseUrl: e.target.value })} placeholder="https://xxxx.supabase.co" />
            </label>
            <label className="field field-wide">
              <span>Supabase anon key（公开可暴露，RLS 负责隔离）</span>
              <input value={draft.supabaseAnonKey} onChange={(e) => setDraft({ ...draft, supabaseAnonKey: e.target.value })} placeholder="eyJ…" />
            </label>
          </>
        )}
      </div>
      <p className="hint">切换驱动会重新加载页面并重新登录。若部署时已由构建注入 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY，这里会自动预填；手填仍可覆盖。Supabase 模式首次使用需要创建项目和 vaults 表（见 README 与 supabase/schema.sql）。</p>
      <button className="btn primary" onClick={apply}>
        保存并重新加载
      </button>

      <h3 className="mt">数据与密钥</h3>
      <div className="row wrap">
        <button className="btn" onClick={exportEnvelope}>
          导出加密信封
        </button>
        <button className="btn danger" onClick={onLockAndClearCache}>
          清除本设备密钥缓存并锁定
        </button>
      </div>
      <p className="hint">
        两把锁：Supabase 登录决定「谁能读写哪一行」，加密口令决定「谁能解密」。两把锁互相独立——数据库管理员也只能看到密文。
      </p>
    </section>
  );
}
