# Minecraft 接口连接排查

记录日期：2026-10-01（Asia/Shanghai）。Minecraft 真实授权尚未恢复。

## 已修正的请求

- 网站 Microsoft 登录使用 OIDC 身份 scope，游戏授权单独使用 Xbox scope。
- Xbox User Authentication 使用 RPS 用户令牌；XSTS 的 Properties 仅包含 SandboxId 和 UserTokens，不包含 SiteName。
- Minecraft 登录调用 `POST https://api.minecraftservices.com/authentication/login_with_xbox`，请求体为 `identityToken`，对应目前的 User Authentication → XSTS 流程。
- 明确的应用许可错误仅依据已知 JSON 字段中的 Invalid app registration / AppRegInfo 标记，普通 403 不做此结论。

## 实测证据

生产诊断号 `af1ed424-0d0f-4694-a770-68c5bc77763a` 的失败阶段为 minecraft.login，HTTP 403，响应类型 html；Microsoft 访问令牌和刷新令牌均存在，Xbox scope 已授予。

使用固定无效测试值 `invalid-diagnostic-probe`，没有使用任何用户凭据：

| 请求环境 | 应用标识 | 结果 |
| --- | --- | --- |
| 本机网络 | Nexa 自有 User-Agent | HTTP 401，JSON 对象 |
| 独立 Cloudflare Worker | 未设置 User-Agent | HTTP 403，HTML 页面 |
| 独立 Cloudflare Worker | Nexa 自有 User-Agent | HTTP 403，HTML 页面 |

两端请求使用相同 Minecraft 路径、POST 方法与 identityToken 测试值，禁止跟随重定向。临时 Worker 没有秘密、数据库或生产路由，测试后已删除。本机与 Worker 的网络实现和出口不同，因此这里只能确定已测 Worker 请求遭到访问拒绝，不能确定上游具体拦截条件，也不能推断全部 Cloudflare 地址均不可用。

## 当前行为

Minecraft 阶段的 HTML 403 报告 connection_rejected，并显示“Minecraft 接口访问被拒绝，当前无法完成授权，需由管理员处理”。JSON 403 继续依据实际错误分类；其他状态不套用此诊断。审计只保存分类、阶段、状态、数字错误码及令牌存在布尔值，不保存上游正文或令牌。

失败时不会保存本次刷新授权或游戏档案，也不会标记成功；网站 Microsoft 身份关联仍然独立。

## 后续可验证路线

1. 请平台排查上述接口的访问拒绝。提供时间、路径、响应类型和无凭据对照结果；不要提供用户令牌、Cookie 或完整上游正文。
2. 如果已有获准的服务端执行环境，先运行相同无效值对照，确认返回 API JSON，再实现仅限固定 Minecraft 接口的内部连接服务。正式接入前需要测试权限、超时、失败处理和隐私说明。
3. Cloudflare Containers 是候选执行环境，尚未验证其访问结果。官方要求 Workers Paid；当前 OAuth 凭据读取账户订阅返回 403 / 10000，套餐状态未知，尚未创建容器或升级套餐。容器不能被视为已验证的解决办法。

不采用他人的客户端 ID、公开第三方代理，也不让浏览器上传 Xbox 令牌。

参考：[XSTS 官方属性说明](https://learn.microsoft.com/en-us/gaming/gdk/docs/services/fundamentals/s2s-auth-calls/s2s-calls/live-title-service-calls-xbox-live?view=gdk-2604)、[minecraft-launcher-lib 实现](https://github.com/JakobDev/minecraft-launcher-lib/blob/master/minecraft_launcher_lib/microsoft_account.py)、[Cloudflare Containers 计费](https://developers.cloudflare.com/containers/platform/pricing/)。
