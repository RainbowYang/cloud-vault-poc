# Cloud Vault POC

静态页面（GitHub Pages）+ 端侧加密 + 三方存密文 + 浏览器直连 AI 的技术验证。**与财务业务无关**，只验证这条技术路线：

- 页面托管在 GitHub Pages，没有任何自建服务器；
- 数据在浏览器里用「口令 → PBKDF2 → AES-GCM 密钥」加密后才上传；
- 三方（Supabase 或本地模拟）只拿到密文信封；
- AI key 和其他配置一起放进加密负载，用同一个口令加密保存；
- 页面上只需输入**一个加密口令**，即可解密数据并直接连 AI（Anthropic 官方 API / OpenAI 兼容网关）；
- 多用户通过 Supabase Auth（邮箱 + 密码为主，魔法链接为辅）+ RLS 区分；加密口令与账号体系是两把独立的锁。登录态按站点 origin 持久化：同一浏览器、同一地址刷新无需重登；换地址或换浏览器需重登一次。

## 运行

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm run build      # 产物在 dist/
```

## 两种存储驱动

| 驱动 | 用途 | 说明 |
| --- | --- | --- |
| 本地演示（默认） | 立即验证全流程 | 数据存 localStorage，按用户名隔离；不是安全边界 |
| Supabase | 真实三方 + 多用户鉴权 | 见下方 5 分钟配置 |

### Supabase 配置（5 分钟）

1. 在 [supabase.com](https://supabase.com) 创建项目（区域选东京/新加坡）。
2. SQL Editor 里执行 [`supabase/schema.sql`](supabase/schema.sql)（建表 + RLS 策略）。

3. Project Settings → API 里复制 Project URL 和 anon key。
4. 页面「设置」里切换驱动、填入 URL/anon key，保存并重新加载。
5. Authentication → URL Configuration：Site URL 填 GitHub Pages 地址（如 `https://rainbowyang.github.io/cloud-vault-poc/`），并把同一地址加进 Redirect URLs，魔法链接才能跳回来。

## 安全模型（两把锁）

```
Supabase Auth（邮箱+密码，魔法链接为辅）──决定：谁能读写哪一行（RLS）
口令（PBKDF2-SHA256, 600k 次）──────────决定：谁能解密（AES-GCM-256）
```

日常用「邮箱 + 密码」登录，只在首次注册验证或忘记密码时用魔法链接。Supabase 新项目默认开启 Confirm email：注册会收一封确认邮件，点一次即可；想跳过可在 Authentication → Providers → Email 关闭。免费内置 SMTP 有低频率限制，不适合当日常登录通道。

- 三方数据库里只有 `{kdf 参数, iv, ct}`，没有口令、没有明文、没有 AI key 明文。
- 派生出的 CryptoKey 以 **non-extractable** 形式缓存在 IndexedDB（本设备免重复输入），JS 无法导出密钥材料。
- 解锁后口令/密钥只存在于页面内存；「锁定」或关闭标签页即消失。
- AI key 位于加密负载内：解锁后自动可用，保存时重新加密上传。

### 诚实边界

- **被托管的代码本身是信任根**：页面由 GitHub Pages 下发，若账号/仓库被攻破、或恶意脚本被注入，攻击者可以让浏览器把密钥用在恶意代码里。端侧加密保证的是「三方存储零知识」，不是「XSS 免疫」。
- 典型 XSS 场景下，攻击脚本虽然导不出 CryptoKey，但可以调用页面的解密逻辑读取明文——所以不要引入第三方脚本、不要用 `innerHTML` 渲染用户内容（本项目如此）。
- 口令丢失 = 数据永久无法解密；没有找回渠道。
- 这是 POC：单条目录、无审计、无重放保护、无版本合并；多人同时编辑会互相覆盖。
- OpenAI 兼容网关能否直连取决于对方是否允许浏览器 CORS；Anthropic 官方 API 支持浏览器直连（SDK 的 `dangerouslyAllowBrowser` 模式）。

## 部署到 GitHub Pages

1. 推送到 `main` 后 `Deploy to GitHub Pages` 工作流自动构建发布；首次需在仓库 Settings → Pages 把 Source 设为「GitHub Actions」。
2. Supabase 的两个公开值通过仓库 Variables 注入（Settings → Secrets and variables → Actions → Variables）：

   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`

   这样任何终端打开页面即自带后端配置，无需手填。本地开发用 `.env.local`（参考 `.env.example`）。

**计划限制：** 私有仓库开启 GitHub Pages 需要 GitHub Pro/Team 计划；免费计划的 Pages 仅支持公开仓库，API 会返回 `Your current plan does not support GitHub Pages for this repository`。另外注意：Pages 站点本身总是公开可访问的，私有仓库只保护源码与历史记录，不保护构建产物（前端代码本来就会下发到浏览器）。

## 目录

```
src/
  crypto.ts    PBKDF2 + AES-GCM 信封
  keycache.ts  IndexedDB 里的非导出 CryptoKey 缓存
  auth.ts      本地演示 / Supabase 邮箱魔法链接
  storage.ts   localStorage / Supabase vaults 表
  ai.ts        mock / Anthropic（浏览器直连）/ OpenAI 兼容
  App.tsx      三段式界面：登录 → 创建/解锁 → 保险箱
supabase/
  schema.sql   vaults 表 + RLS 策略
.env.example   构建期注入的 Supabase 公开配置示例
```

## 接下一步（正式财务系统）

这个 POC 验证的是「静态 PWA + 三方密文 + 单口令解锁 + 浏览器直连 AI」。正式系统在此基础上替换业务层：确定性引擎在浏览器里计算、市场数据由 GitHub Actions 定时抓取写入、Percento 快照由 Mac 上的同步代理推送。数据模型从单条目录扩展为快照/行情/分析/计划四类记录，鉴权与加密模型保持不变。
