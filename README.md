# Nexa Auth

独立 Cloudflare Worker，入口 `auth.pcln.top/auth/v1`，D1 管理账户、OAuth 身份、MFA、角色资格和会话。Web 提供界面，API 承担商店、工单、计费与遥测，通过 AUTH service binding 实时验证身份。

Node.js 24+、pnpm；`pnpm install --frozen-lockfile`、`pnpm dev`（5733）、`pnpm check`。CI 只检查本项目，部署使用 `pnpm deploy`，不再复制 Web 到 GitHub Pages。

上线前应用 D1 迁移。生产必须配置 `MFA_ENC_KEY`（TOTP/恢复码）、`TOKEN_ENC_KEY`（Microsoft 刷新令牌），均使用高熵随机密钥；不提交到 Git。`SERVICE_TOKEN` 仅供可信服务传递经验事件与资格证据，不能使用用户 Bearer 令牌替代。公开遥测不能直接授予经验或角色。OAuth provider 需要相应 CLIENT_ID / CLIENT_SECRET；安全邮件可配置 RESEND_API_KEY。

Web 在 auth 域使用 HttpOnly Cookie 会话，换取仅存内存的 API Bearer 令牌。管理权限由 Auth 当前 staff 状态确定，API 每次验证。生产设置 WEB_ORIGIN=https://pcln.top；本地 passkey 使用 localhost 与匹配的 RP_ID/WEB_ORIGIN。

## 账户身份与两步验证（migration 0006）

账户管理逻辑全部在本 Worker：身份绑定/解绑、注销生命周期、数据导出、隐私请求，
以及新增的用户名 / 用户 ID / 密码登录与强制 2FA。所有敏感变更写 `auth_audit` 并触发安全邮件。

### 用户名与用户 ID

- `PATCH /auth/v1/account/name` — 修改用户名（展示名，1–60 字符，剔除控制符）。
- `PUT /auth/v1/account/handle` — 设置 / 修改用户 ID（类微信号：6–20 位、字母开头、
  `[a-z0-9_-]`、大小写不敏感、全库唯一、保留名单拦截；修改后 30 天冷却，409 表示被占用）。
- `GET /auth/v1/account/handle/availability?handle=` — 登录后可查询占用情况。

### 密码与强制 2FA

- `POST /auth/v1/account/password` — 设置 / 修改密码（scrypt N=32768；修改需 `currentPassword`）。
  设置密码后，密码登录**强制**两步验证：未注册任何 2FA 因子时登录返回
  `403 mfa_enrollment_required`，需先经第三方登录注册因子。
- `POST /auth/v1/login` `{handle,password}` — 第一段。限流：每 ID 10 次/15 分钟、
  每 IP 30 次/15 分钟；用户 ID 不存在时也执行等时 scrypt。成功返回 5 分钟一次性
  `challenge` 与可用 `factors`（passkey/totp/recovery）。
- `POST /auth/v1/login/passkey/options` → `POST /auth/v1/login/passkey` — WebAuthn 断言
  （ES256/RS256，rpId 默认 `pcln.top`，origin 白名单，签名计数器防克隆）。
- `POST /auth/v1/login/totp` `{challenge,code}` — 验证器 6 位码（±1 步窗口 + 步数防重放），
  同端点接受一次性恢复码（用后作废并返回剩余数量）。
- 登录成功签发与 OAuth 相同的 `nexa_console` 会话 Cookie。

### 2FA 因子管理（需登录）

- `GET /auth/v1/mfa/factors` — 因子清单（passkey 列表 / TOTP 设备列表 / 恢复码余量 / 是否已设密码）。
- `POST /auth/v1/mfa/totp/enroll` → `confirm {id,code,name?}` — 注册验证器应用，**支持多设备**
  （每账户至多 10 个，各自命名、独立停用；secret 在生产使用 `MFA_ENC_KEY` AES-GCM 静态加密；
  15 分钟未确认由 cron 清理）。确认时记录时间步，同一窗口的码不可重放。
- `POST /auth/v1/mfa/passkey/register/options` → `register` — 注册 passkey（attestation
  'none'，每账户至多 10 个）。
- `POST /auth/v1/mfa/recovery/generate` — 重新生成 10 个一次性恢复码（要求已有 passkey 或 TOTP）。
  登录核销仅依据 SHA-256 哈希；同时保存可解密副本（`MFA_ENC_KEY` AES-GCM），供账户主复核后查看。
- `POST /auth/v1/mfa/recovery/reveal` — 身份复核后返回未使用的恢复码明文（用于查看/打印），写审计。
- `DELETE /auth/v1/mfa/totp/:id`、`DELETE /auth/v1/mfa/passkey/:credentialId` — 移除单个因子；
  已设密码时要求复核当前密码，且必须保留至少一种因子。

部署顺序：先 `wrangler d1 migrations apply pcln-production --remote`，再 `wrangler deploy`。
本地开发 `pnpm dev`（端口 5733，与 Web 仓库 vite 代理一致）；单元测试 `pnpm test`（零依赖，
覆盖 RFC 6238 向量、CBOR 往返、真实 P-256 密钥的 WebAuthn 注册/断言全流程）。

## Microsoft 身份与 Xbox / Minecraft 独立授权（migration 0016）

- Microsoft 网站登录及身份关联均只请求 `openid profile email`，使用 Graph UserInfo；不会请求游戏权限，也不会把资料令牌发给 Xbox。
- `POST /auth/v1/minecraft/authorizations` — 关联 Microsoft 后另行授权游戏能力；返回 201 `{url,expiresAt}`。使用 `/consumers/` 端点和 `XboxLive.signin XboxLive.offline_access`，不混入 OIDC / Graph scope。复用已登记的 Microsoft callback，无需增加回调地址。
- 游戏账户独立授权给当前 Nexa 账户，可以与网站 Microsoft 登录身份不同。`prompt=select_account` 供用户选择；游戏授权不能替代网站登录身份。
- OAuth state 有 10 分钟有效期、单次消费和 S256 PKCE，绑定原 Nexa 会话；回调前及最终 D1 写入重新检查会话、账户及身份。重新发起、退出、撤销或移除 Microsoft 登录身份会使旧游戏授权失效。
- 游戏授权后服务端执行 MSA → Xbox User Token → XSTS → Minecraft 令牌 → 权益与档案读取；各阶段只使用对应资源的令牌，不将 Xbox 令牌用于 Graph。不保存短时访问令牌。
- User Authentication 的 `SiteName` 只在第一步传递；XSTS 的用户授权属性仅包含 `SandboxId` / `UserTokens`，避免混用两个请求格式。属性依据 [Microsoft XSTS 契约](https://learn.microsoft.com/en-us/gaming/gdk/docs/services/fundamentals/s2s-auth-calls/s2s-calls/live-title-service-calls-xbox-live?view=gdk-2604)。
- Minecraft 换取使用 `POST /authentication/login_with_xbox` 的 `identityToken`，与当前 User Authentication → XSTS 流程一致；依据 [minecraft-launcher-lib 维护者实现](https://github.com/JakobDev/minecraft-launcher-lib/blob/master/minecraft_launcher_lib/microsoft_account.py)。遇到明确应用许可拒绝时停止，不改用其他应用 ID 或追加登录请求。
- `GET /auth/v1/account/minecraft` 读取拥有状况、档案及 `xboxAuthorized`；`DELETE /auth/v1/minecraft/authorization` 单独清除游戏令牌、档案和待完成授权，返回 204，保留网站登录身份。移除 Microsoft 身份及注销也会清除游戏授权。
- 关联或游戏授权失败回到账户页显示安全提示；普通登录失败仍返回登录页，不把上游错误正文、令牌或应用密钥带入 URL。
- Microsoft、Xbox User / XSTS、Minecraft 登录 / 权益 / 档案分别诊断，每次上游请求独立限时 12 秒。只有 XSTS 明确返回 `2148916233` 才提示创建 Xbox 资料；普通 HTTP 403 不推断账户或应用权限原因。
- Minecraft 接口返回 HTML 403 时报告 `connection_rejected`，提示管理员处理；这只能确定访问被拒绝，不能确定账户、应用许可或全部 Cloudflare 出口的状态。当前实测及后续排查见 [连接排查记录](docs/minecraft-connectivity.md)。
- 游戏授权失败返回诊断号，并在 `auth_audit` 的 `minecraft.authorization.failed` 记录同号的阶段、原因、HTTP 状态、已知数字错误码、响应类型分类和令牌存在 / 已知 scope 布尔值。Minecraft 的已知错误字段（包括 `developerMessage`）仅在内存中识别明确的应用许可标记。排障按诊断号查询，禁止记录或索取令牌、Cookie、上游错误正文；历史通用提示不足以判定失败原因。

接口与资源范围依据 [Microsoft Xbox 网站授权说明](https://learn.microsoft.com/en-us/gaming/gdk/docs/services/fundamentals/s2s-auth-calls/service-authentication/live-website-authentication)。真实第三方授权仍需用户交互，测试使用实际 Worker/D1 与隔离的上游响应，不能替代真实 Microsoft / Minecraft 应用权限验证。

## 注册与 Microsoft 令牌保管（migration 0009）

- **注册必须经第三方身份验证**（GitHub / Google / Microsoft）。OAuth 首登创建的账户
  `confirmed_at` 为空（未激活），回调后强制重定向 `/register?setup=1` 完善资料；
  24 小时未完善的账户由 cron 级联清理。会话响应携带 `setupRequired` 标记。
- `POST /auth/v1/register/complete` `{name,handle,password?,totpId?,totpCode?}` —
  仅未激活账户可用：设置用户名与用户 ID（唯一性校验、回收他人废弃同名注册）；
  **设置密码时必须同时完成验证器绑定**（密码 ⇔ 2FA 不变量），成功后账户激活。
  不提供纯密码直连注册。
- Xbox 独立授权请求 `XboxLive.offline_access`：刷新令牌以 AES-GCM（`TOKEN_ENC_KEY`）加密存入
  `microsoft_tokens`；未配置密钥则拒绝开始。旧混合权限令牌保留但不再使用，用户需在账户页重新授权游戏能力。
- `POST /auth/v1/minecraft/token` — 启动器端点：用保管的刷新令牌重新派生 XSTS，
  实时返回经过 Minecraft 服务交换的短时令牌与档案（不存令牌本体），限流 10 次/小时，写审计。刷新采用 Xbox-only scope；最终写入检查授权版本和会话，撤销中的请求不能恢复档案或取得令牌。

## 等级、经验与铭牌（migration 0013）

- Lv0→1 需当前登录账户通过受信启动器首次启动 MC。Lv2～7 累计经验为 2000 / 5000 / 10000 / 20000 / 50000 / 100000。
- 每日登录启动器 +20、每日首次启动 MC +30、MC 在线每分钟 +1、启动器在线每 5 分钟 +1；上海时间按日合计最多 500。所有时间由服务器计算，不接受客户端金额、用户 ID、时间或经验值。
- `GET /auth/v1/account/level` 返回普通等级、Exp、在线时长、连续天数、铭牌与展示选择；`PUT /auth/v1/account/level-display` 的 `{badgeId:null}` 恢复普通等级。
- Lv-1 随当前管理员身份即时变化；LvMC 需要曾连续 100 天启动 MC；Lv∞ 需要 Lv7、MC 100h 和∞答题，题库未开放时不能授予。
- B站 Lv6、百万粉丝及累计无偿捐赠严格超过 1000 元的铭牌由管理员用 `PUT /auth/v1/users/{id或handle}/badge-verifications/{badgeId}` 核验，金额单位分。提交 `{value,sourceAccount,evidence}`，禁止审核自己，结果及更正写审计。订阅付款与爱发电 OAuth 绑定不等于无偿捐赠证明。
- 已退役 `POST /internal/v1/xp` 返回 410。新的可信接口是 `POST /internal/v1/launcher/activity-events` 与 `GET /internal/v1/launcher/activity-events/{UUID}`：SERVICE_TOKEN + `x-nexa-account-token` 真实用户会话 + `x-nexa-client-certificate` 已由 Web 验证的证书指纹。只能由 API 调用，原始匿名遥测不进入此通道。
- 请求 `{id:UUID,type}`，type 为 launcher.login / launcher.heartbeat / launcher.logout / game.start / game.heartbeat / game.stop；创建返回 201 和 Location，重复相同事件返回 200，冲突返回 409。最长心跳间隔 120 秒、每次最多计 90 秒，离线不补时，多设备不重叠累计。事件回执保留 30 天，累计时间、按日经验与铭牌随账户保存；注销清除。
- 启动器接口当前仅预留，未修改启动器。证书验证与吊销交由 Cloudflare Client Certificates；Web 仅采用 Cloudflare TLS 校验结果，缺少有效证书就拒绝。启用流程见 API `nexa/README.md`。
- 资格申请保留原有要求：developer Lv2，trusted_developer 需 developer + Lv3 + popular_plugin，admin Lv4；管理员不得审批自己，批准/拒绝有审计。

## 社区绑定（migration 0014）

爱发电绑定独立于登录身份：`GET /auth/v1/connections`，`POST /auth/v1/connections/afdian/authorizations`，授权回调 `GET /auth/v1/connections/afdian/callback`，解绑 `DELETE /auth/v1/connections/afdian`。绑定不能直接用于登录 Nexa。

客户端 ID 与密钥只保存在 Cloudflare Secrets，可在此仓库运行：

```powershell
pnpm exec wrangler secret put AFDIAN_CLIENT_ID
pnpm exec wrangler secret put AFDIAN_CLIENT_SECRET
```

代码在授权及换取身份时传递 redirect_uri=https://auth.pcln.top/auth/v1/connections/afdian/callback。只请求 basic，接受官方只返回 user_id 的响应，不强求 access_token、邮箱或昵称，不保存第三方访问令牌。10 分钟单次 state 同时绑定当前 Nexa 会话与 HttpOnly Cookie；退出、解绑、过期或重放都会拒绝。数据库唯一约束防止跨账户抢占第三方身份。

B站签名绑定暂未开放：2026-10-01 本机公开资料读取成功，但 Cloudflare 实测返回 412。公开资料适配层和 80-bit 文学编码器作为原型保留；词库仍待人工审校，不收集 Cookie/SESSDATA、不模拟扫码登录。需公开资料读取稳定、签名更新延迟测试和词库审校通过后，才推进挑战与绑定页面。编码容量与证明见 `docs/bilibili-encoder.md`。

## 政策版本与隐私记录

服务条款接受与隐私告知分别存储，隐私状态读取 privacy_notice_receipts，不依赖条款审计语句是否新插入。migration 0012 只修复已知 v1.0 联合确认流程的漏记，不推断新版本已接受。政策版本更新时必须同步 Web 版本常量、文本哈希和 Auth policy_documents；旧版本及接受记录保留，新版本不自动代签。
