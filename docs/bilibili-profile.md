# Bilibili 公开资料读取与 WBI 请求审计

本模块是只读 Provider 原型。B站绑定入口仍未开放，公开接口可用性与文学签名词库审校通过后，才可进入挑战与账户绑定阶段。

## 两条资料读取路径

- `card`：`GET https://api.bilibili.com/x/web-interface/card?mid={uid}`，读取 UID、昵称、头像、签名、等级和粉丝数。
- `wbi`：先读取 `/x/web-interface/nav` 的公开 `wbi_img`，再签名请求 `/x/space/wbi/acc/info`。公开 nav 的 `code=-101` 在包含有效 key 时可以使用。WBI 资料没有粉丝数时返回 `null`，不虚构数据；粉丝资料由独立的 `readFollowers()` 读取。

两条路径均不发送 Cookie、SESSDATA、账户凭据或 Authorization，不模拟扫码登录。没有在失败后切换路径的自动逻辑。

## 请求配置修复

对原实现的实际 Worker 运行时测试定位到两个错误：

1. `redirect: 'error'` 抛 `TypeError: Invalid redirect value`。现使用 `manual` 并明确拒绝 3xx，避免跟随意外跳转。
2. `cache: 'no-store'` 同时带 `cf.cacheTtl: 0` 抛 `TypeError: CacheTtl ... is not compatible`。现仅使用标准 `cache: 'no-store'`，没有冲突的 `cf` 缓存选项。

这些错误发生在请求配置阶段，不能当作 B站返回了风控错误。测试使用当前 `compatibility_date=2026-09-26` 的真实 workerd，且证明两种旧配置在调用上游前失败、新配置能够调用上游。

Cloudflare 的 [`fetch` 文档](https://developers.cloudflare.com/workers/runtime-apis/fetch/) 解释了 `no-store` 的缓存旁路行为。接口声明的 redirect 值仍需实际运行时验证，不能仅凭类型定义判断支持。

## WBI 编码约束

`src/bilibili-wbi.mjs` 从 nav 图片 URL 提取两个 32 位 key，按固定混排顺序取得 32 位 mixin；清理参数值中的 `!'()*` 后按参数名排序，加入当前服务器 Unix 秒时间 `wts`，对规范化查询串与 mixin 拼接执行 MD5，得到 `w_rid`。

最终发送的 URL 使用同一个已签名查询串，禁止签名后增删参数或重新序列化。资料请求参数恰为 `mid`、`wts`、`w_rid`，不会额外附加未签名随机参数。核验模式每次取得新的 nav key；并发请求只共用正在进行的 key 获取。展示模式的 key 最多复用 30 秒。

实现参考用户提供的 [`Miuzarte/Wbi` 的 `Wbi.go`](https://github.com/Miuzarte/Wbi/blob/main/Wbi.go)，并用固定公开向量及实际 URL 重新计算校验。WBI 是上游协议校验值，不能替代 Nexa 登录身份、挑战随机性或账户所有权证明。用户提供的 [yt-dlp issue 16571](https://github.com/yt-dlp/yt-dlp/issues/16571) 涉及播放接口的一次失败报告；不能直接推导资料接口的失败原因。

## 缓存、并发与熔断

```js
const reader = createBilibiliProfileReader({ onDiagnostic: safeDiagnosticHandler });

// 仅用于资料确认或展示，成功结果最多缓存 60 秒，最多保留 128 个 UID/路径。
const displayed = await reader.read(uid, { mode: 'display', source: 'card' });

// 所有权验证必须显式使用此模式，绝不读取或降级使用展示缓存。
const current = await reader.read(uid, { mode: 'verify-signature', source: 'card' });

// WBI 是独立选择的原型路径，不是被封锁后的自动回退。
const wbi = await reader.read(uid, { mode: 'verify-signature', source: 'wbi' });
```

同 UID、路径和模式的正在进行请求合并为一次上游读取。核验请求不能共用此前启动的展示读取。`fetchedAt` 表示实际获取时间，缓存命中不更新此时间；旁路 Nexa 与 Cloudflare 缓存不能保证 B站自身立即传播签名更新。

HTTP 412、429 或 JSON `code=-412/-352` 触发默认 10 分钟的熔断。较长的数字 `Retry-After` 可延长至最多 1 小时。熔断覆盖该 reader 中的所有 UID 和路径；没有自动重试、后台轮询或换端点补救。已有展示缓存可以继续用于展示，核验一律失败。

当前熔断与缓存是 reader/Worker 隔离实例内状态，不是全服务跨地区状态。接入公开挑战 API 前必须同时实现创建/验证限流与共享熔断状态；本原型没有提前开放生产绑定功能。

## 诊断与失败处理

HTTP 状态、响应 Content-Type 与 JSON 业务 code 单独记录。例如 HTTP 412 的 HTML 响应没有 JSON code；HTTP 200 的 JSON `code=-412` 则是业务层限制。响应最多读取 128 KiB，非 JSON、超限、超时、跳转、缺失签名或返回错误 UID 全部失败，不能判定绑定成功。

诊断只包含端点代号、HTTP 状态、Content-Type、响应字节数、业务 code、安全白名单中的 message，以及 fetch 错误名称/分类。不记录请求完整 URL、WBI 校验值、昵称、签名、头像、Cookie、凭据或响应正文。未知 message 返回 `null` 并标记 `businessMessageRedacted=true`，不把已遮盖误认为上游没有 message。诊断处理器异常不改变验证结果，也不触发重试。

## 2026-10-01 云端探测

修正配置后，临时 `nexa-bilibili-public-probe` Worker 对用户指定 UID `689985040` 发出 **一次** card 请求，结果为：

| 项目 | 结果 |
| --- | --- |
| HTTP 状态 | 412 |
| Content-Type | `application/json` |
| JSON 业务 code | -412 |
| 响应字节数 | 52 |
| fetch 配置/网络异常 | 无 |
| 后续 nav / WBI 请求 | 因明确限制响应而停止，未发送 |

业务 message 当时不在安全白名单，未保存原文；没有为了取得 message 再次请求。该次结果与先前 HTML 风控响应、旧配置产生的 TypeError 应分别看待。

可以确认此次请求受到限制；不能断言所有 Cloudflare 出口被封，也不能宣称 WBI 已在该云端出口可用。临时 Worker 已删除；探测脚本与非敏感结果留在忽略的 `.tmp/bilibili-public-probe/`，无数据库、生产路由或 Secrets。

## 验证

运行 `node --test tests/bilibili-profile.test.mjs tests/bilibili-wbi.test.mjs`。覆盖签名固定向量、最终 URL 参数一致性、未登录 nav、key 更新、严格 UID、公开资料解析、核验缓存隔离、同 UID 并发、HTTP/JSON 限制分类、全路径停止请求、诊断不泄露资料以及真实 Worker 运行时兼容性。
