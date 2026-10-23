# M6：HTTP / UI 故障注入验收

日期：2026-10-23。最终执行：2026-10-23 19:58（Asia/Shanghai）。

## 结论与证据边界

已实际执行：11 / 11 项通过，0 跳过、0 重试、0 flaky，耗时约 12.9 秒。包含 1 项隔离保护测试、6 项真实 HTTP / PostgreSQL 测试、4 项 Chromium UI 测试。故障及恢复均经过现有 `AliyunGateway`、Next Route Handler、权限 / CSRF / 幂等逻辑和本地 PostgreSQL；UI 未拦截浏览器请求、未伪造业务 API 响应。

上游是**合成 fetch 传输**，并非百炼真实 API。本报告不验证真实模型可用性、教育诊断准确率或教师审核结果。付费调用 **0**；实际费用 **0**。使用量中的 tokens 是明确写入夹具的合成数字，仅验证计量持久化。此次受控恢复不会切换到 Mock：会话保持 live，invocation provider 全部为 aliyun，成功文本明确标记“工程故障恢复夹具”。

最终原始运行证据保留在本机忽略目录：

`C:\Users\QYF\Desktop\study\.local\m6-fault-2026-10-23T11-58-21-183Z-25492\`

包括 `results.json`、`run-summary.json`、`transport.jsonl`、`next-server.log`、各案例 JSON 和 `artifacts/` 下 10 张截图。运行数据不纳入 Git。随机测试账号及关联行保留在本地数据库，没有删除、重置或覆盖历史数据。独立测试服务器已由 runner 停止，已有应用服务不受影响。

## 实际通过的测试

| 测试 | 实际断言 |
| --- | --- |
| 隔离保护 | 子进程加载器拒绝 production、非 loopback APP_URL、非固定假密钥；阻断未允许的外网 fetch。 |
| HTTP 超时 | 上游 Promise 不结束，触发 adapter 的真实 100ms 超时计时器；HTTP 503 / AI_TIMEOUT；输入保存一次，mutation 为 RETRYABLE，无错误的 assistant 消息。 |
| HTTP 非法 JSON | JSON 内容解析失败，503 / AI_INVALID_OUTPUT；ERROR invocation 保存合成 usage 17 / 3。 |
| HTTP 非法 schema | 合法 JSON 但缺少必需字段，被 schema 拒绝；503 / AI_INVALID_OUTPUT；ERROR invocation 保存合成 usage 19 / 5。 |
| HTTP 连接失败 | fetch 抛出连接异常，503 / AI_UNAVAILABLE；不泄露异常堆栈、上游原文或凭证。 |
| HTTP 初始失败恢复 | POST /diagnoses 失败后，GET 能找回原 FAILED_RETRYABLE 会话；同一个创建 key 恢复原会话，重复创建仍仅一个诊断。 |
| HTTP 并发及伪造 Header | 公共请求的故障 Header 无效；两个相同 key 请求最多完成一次；同 key 不同内容返回 409；缓存重放不再调用传输。 |
| UI 超时 | 页面显示“输入已保存”的安全错误；textarea 保留内容；刷新后显示已保存消息和明确的重试入口；重试恢复。 |
| UI 非法 JSON | 同上，数据库 ERROR 分类正确，恢复后用户和 assistant 各仅一条对应消息。 |
| UI 连接失败 | 同上，浏览器运行时错误为 0，恢复状态 INCONCLUSIVE。 |
| UI 同页重试 | 非法 schema 后点击普通错误框“重试”，两个请求复用原 idempotency key，用户消息保存一次。 |

四种回复回合错误分别在真实数据库断言：失败后无该操作的 assistant 消息、输入只保存一次、mutation RETRYABLE；恢复后 mutation 完成、总 invocation 为初始成功 + 故障 ERROR + 恢复成功；相同操作重放不增加消息或模型调用。恢复的 INCONCLUSIVE 仅表示夹具的证据不足降级，不能用于评价教育效果。

## 机制与运行方式

新增文件：

- `scripts/m6/run-fault-tests.mjs`：创建全新 `.local/m6-fault-...` 和 Next 输出目录，选择空闲 loopback 端口，传入随机测试邀请码与 Session Secret；本地 PostgreSQL 地址检查；启动 / 结束自己创建的进程。
- `scripts/m6/fault-fetch-preload.cjs`：仅通过独立 runner 的 Node `--require` 装入，生产代码无 import；Nonce 匹配的服务器本地控制文件选择场景；官方 chat-completions fetch 被拦截，其他外网 fetch 被阻断，绝不透传真实调用。
- `playwright.fault.config.ts`、`tests/fault/helpers.ts`、`http.spec.ts`、`ui.spec.ts`：串行运行，直接查询 PostgreSQL 验证持久化，故障 / 刷新 / 恢复截图写入新目录。

前提是本地数据库及已有隔离 Chromium 已就绪：

```powershell
node scripts/m6/run-fault-tests.mjs
```

runner 强制覆盖真实 API Key 为 `UNIT_TEST_PLACEHOLDER_M6_NOT_A_CREDENTIAL`，AI_MODE=live，model=qwen3.8-flash，timeout=100ms，maxRetries=0；这些配置仅传给测试子进程，不修改 `.env`。加载器实际断言每次请求的 model、enable_thinking=false、stream=false、response_format=json_object、整数 max_completion_tokens、无旧 max_tokens，以及 redirect=error；最终 29 次合成传输均满足这些断言。没有新增业务端点、公共 Header、生产可用的故障开关。设置 PLAYWRIGHT_SKIP_BROWSER_GC=1，使用现有 `.local/playwright`，不会安装或清理浏览器。Docker runtime 已改为仅复制 `scripts/start.mjs`，没有打包故障测试代码；容器构建本身未实际执行。

针对新增文件实际运行 ESLint 和 `npm run typecheck`，均退出 0。最后完整应用回归与构建由 M6 集成报告记录。Next dev 自动产生的类型路径由集成阶段统一生成，不应提交 `.local` 运行路径引用。

## 实施中发现的全部失败

历史证据全部保留在 `.local`，未清理：

1. `m6-fault-2026-10-23T11-53-25-918Z-5576`：独立服务器未启动。Windows NODE_OPTIONS 中反斜杠被 Node 解析器消耗，预加载路径不存在；改用正斜杠绝对路径后解决，未产生模型调用。
2. `m6-fault-2026-10-23T11-53-35-529Z-25324`：10 项失败于注册 403，原因是新 Playwright 配置漏设 Origin。补齐与 APP_URL 一致的 Origin 后通过；CSRF 防护未放宽。
3. `m6-fault-2026-10-23T11-53-49-736Z-21272`：6 项 HTTP 通过、4 项 UI 失败。Next 自带 route-announcer 也具有 role=alert，测试 locator 不唯一 / 误选，造成一次测试提前切换恢复场景及后续超时；改为明确 `.error-state[role=alert]`。另发现 HTTP / UI 文件共享 pg Pool，重复 afterAll.end 导致重复关闭；改为 idle 可退出的池，由测试 worker 生命周期管理。未修改应用界面或业务行为掩盖测试失败。
4. `m6-fault-2026-10-23T11-55-22-819Z-3152`：10 / 10 通过（约 14 秒）；随后增加隔离保护验证。
5. `m6-fault-2026-10-23T11-56-36-541Z-24056`：加入保护测试后 11 / 11 通过（约 12.5 秒）。
6. 初次针对新增文件运行 ESLint：CJS preload 的 require 违反 TypeScript 规则；在该必须由 Node --require 加载的单个文件增加带理由的局部规则说明，再次 lint 退出 0。
7. `m6-fault-2026-10-23T11-58-21-183Z-25492`：将序列化配置统一为本轮审阅的 qwen3.8-flash，并对实际序列化参数增加断言；最终 11 / 11 通过（约 12.9 秒）。
8. 新增保护测试后的一次 typecheck：环境 override 数组把 NODE_ENV 字面量扩展为 string，触发 TS2769；增加 `as const` 保留字面量类型后，typecheck 退出 0。仅类型约束变化，运行行为不变。

## 尚未验证

- 百炼真实网络、鉴权、真实模型输出、真实 token 使用和账单；未获付费调用授权，本次未调用。
- production 打包运行中的故障场景；故障加载器主动拒绝 production。本次 Next dev 使用真实服务链，但不能替代生产构建验收。
- 此新增故障流程的手机 / 平板、Firefox / WebKit、真实软键盘 / 读屏验证；本次 Chromium 1280×900。此前 M0–M5 六视口主题证据仍保留，但不能视为本次故障流程的移动端证据。
- 跨进程并发压测、真实网络断开、代理 / DNS / TLS 故障；此次连接失败发生于合成 fetch，数据库未模拟中断。
- 付费重试放大、每日成本预算、熔断跨进程一致性；此次 maxRetries=0，用例不测重试退避的真实负载。

下一步应先获得有限额、明确模型 / 地域的真实 API 测试授权，采用 M6 受控调用程序；再由教师独立标注和审核诊断质量。该工程故障通过率不应对外表述为教育诊断准确率。
