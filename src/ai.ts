import Anthropic from "@anthropic-ai/sdk";
import type { AIConfig } from "./types";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export async function callAI(cfg: AIConfig, messages: ChatMessage[]): Promise<string> {
  switch (cfg.provider) {
    case "mock":
      return mockReply(messages);
    case "anthropic":
      return callAnthropic(cfg, messages);
    case "openai":
      return callOpenAICompatible(cfg, messages);
    default:
      throw new Error(`未知的 AI provider：${String(cfg.provider)}`);
  }
}

/** 无需任何密钥的本地模拟，用来验证"解密后的 AI 配置驱动对话"这条链路。 */
async function mockReply(messages: ChatMessage[]): Promise<string> {
  const last = messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
  await new Promise((r) => setTimeout(r, 400));
  return [
    "[mock] 这条回复来自本地模拟 provider，没有走任何网络。",
    `你刚才说：「${last}」`,
    "",
    "在设置里把 provider 换成 Anthropic 或 OpenAI 兼容网关、填入 API key（会随保险箱一起加密上云），就能真正连到模型。",
  ].join("\n");
}

/** Anthropic 官方 API：浏览器直连（SDK 的 dangerouslyAllowBrowser 模式）。 */
async function callAnthropic(cfg: AIConfig, messages: ChatMessage[]): Promise<string> {
  if (!cfg.apiKey) throw new Error("尚未配置 Anthropic API Key");
  const client = new Anthropic({
    apiKey: cfg.apiKey,
    // 这是 POC：key 由用户输入、只在本页内存中解密使用；正式产品应评估此模式的风险。
    // SDK 在该模式下自动携带 anthropic-dangerous-direct-browser-access 头。
    dangerouslyAllowBrowser: true,
  });
  try {
    const res = await client.messages.create({
      model: cfg.model || "claude-opus-5-5",
      max_tokens: 1024,
      // 聊天场景用低 effort，减少思考耗时与花费
      output_config: { effort: "low" },
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });
    return (
      res.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n") || "（模型没有返回文本）"
    );
  } catch (e) {
    if (e instanceof TypeError) {
      throw new Error("请求失败：网络或 CORS 被拦截。Anthropic 官方 API 支持浏览器直连，请检查网络。");
    }
    throw e;
  }
}

/** OpenAI 兼容网关（ZenMux / DeepSeek / OpenRouter 等）：纯 fetch。 */
async function callOpenAICompatible(cfg: AIConfig, messages: ChatMessage[]): Promise<string> {
  if (!cfg.apiKey) throw new Error("尚未配置 API Key");
  if (!cfg.baseUrl) throw new Error("尚未配置 Base URL（例如 https://api.deepseek.com/v1）");
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 1024,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });
  } catch {
    throw new Error("请求失败：网络错误或该网关不允许浏览器跨域（CORS）。可换支持 CORS 的网关，或在正式架构里加一层函数代理。");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`网关返回 ${res.status}：${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };
  if (data.error?.message) throw new Error(`网关错误：${data.error.message}`);
  return data.choices?.[0]?.message?.content ?? "（网关没有返回文本）";
}
