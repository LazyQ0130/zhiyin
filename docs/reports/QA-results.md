# QA 运行记录（2026-10-23）

## 已实际执行

1. `node --check scripts/security-scan-client.mjs`：退出码 0；仅证明扫描脚本语法可用，尚未扫描生产构建。
2. `npx playwright test --project=api --list`：成功收集测试。早于依赖安装完成时的第一次尝试曾因 `.bin/playwright` 未就绪失败，依赖由主开发统一安装后正常。
3. `npx playwright test --project=api`：真实运行的 Next.js API + 本机 PostgreSQL，13/13 通过，4.4 秒。未替换 HTTP 响应、未 Mock 数据库；模型明确使用 MockGateway。
4. 增加相同幂等 key 内容冲突、客户端伪造 `assistance`、学科/状态/日期筛选断言后，定向重跑 A09/A11–A14/A15：3/3 通过，3.5 秒。
5. 真实 Chromium 156.0.8078.4 浏览器：375、768、1440 像素各浅/暗主题，六套完整注册→引导→确认题目→追问→刷新→合成 IME→报告→提示后训练→档案→我的流程，最终 6/6 通过，1.3 分钟。每套保存六页已加载截图，共 36 张。
6. 长消息上翻停止跟随、跳至最新、不可信 HTML 作为文本显示：六个 viewport/theme 项目均通过。此用例明确替换了诊断消息响应以提供 36 条长消息，仅验证 UI 滚动与渲染；核心用户闭环和 API 测试没有替换响应。
7. 新增复测/完整导出/可选偏好 API：3/3 通过，2.9 秒。复用已有 QA 账号登录，未新增注册。验证三题 17/9/4 独立完成、未完成组不能复测、三道不同的新题、`retestOfId`、同 key 幂等、跨账号拒绝、导出本人实际训练答案但不暴露标准答案、空学科偏好可完成引导。
8. `npx eslint tests/e2e tests/integration playwright.config.ts scripts/security-scan-client.mjs`：退出码 0。
9. `node scripts/security-scan-client.mjs .local/build-2026-10-23T11-28-29-359Z/static`：最终生产构建存在 `BUILD_ID`，扫描 24 个客户端文件，对 2 个实际配置的秘密值及常见 API/private-key 格式检查，无命中文件，退出码 0。[原始结果](QA-client-scan.json)。当前没有配置 live 模型 Key，因此这不是所有提供商配置组合的完整安全审计。
10. 主开发提供并已读取[真实 PostgreSQL 服务层结果](../../tests/service/latest-results.json)：5/5 完成，覆盖 AI_TIMEOUT/AI_INVALID_OUTPUT 后保存并重试、同一操作只有一条学生消息、已完成重放不增行、结束时故障恢复、活动/过期 lease、模型遗漏发现仍保留证据。该结果是服务层故障注入，不能写成 HTTP/UI 故障 E2E。
11. 主开发实际完成本地 `pg_dump -Fc` → 独立 `zhiyin_restore_20261023` → `pg_restore`，恢复后查询 `User=35`。这是本地工程数据备份恢复演练；未删除原库，不能代替生产灾难恢复验收。

API 报告：[JSON](QA-evidence/2026-10-23T11-15-27-349Z-15252/results.json)、[HTML](QA-evidence/2026-10-23T11-15-27-349Z-15252/html/index.html)。测试新增随机 `@example.test` 成年账户；不清库。只通过本人 API 软隐藏一条该测试刚创建的记录，未删除项目文件。

API 已验证：真实空统计、两个未成年年龄段拒绝且无登录态、跨站修改拒绝、确认版本保留、无步骤先追问、第 2 步引用与回答反证、并发重复诊断/回合幂等、训练 GET 无标准答案/提示、提示持久化且不计独立、不可解析回答 UNKNOWN、档案证据追溯、跨用户 9 个读写入口拒绝、单条软删除查询排除、SVG/魔数伪装/10MiB 以上拒绝、合法空白 PNG 私有访问、Mock OCR 不编造题面、登出旧 Cookie 重放拒绝。

复测/导出报告：[JSON](QA-evidence/2026-10-23T11-25-11-844Z-16872/results.json)。最终浏览器主链路：[JSON](QA-evidence/2026-10-23T11-21-12-734Z-17608/results.json)。早期浏览器失败证据保留：第一次路由断言误把 `/diagnose/new` 当 session，第二次在 reload 后做即时可见判断误点桌面隐藏 tab；修正了测试等待，未删断言或改业务伪装通过。早期首页/档案/确认页截图含 loading，最终补拍增加明确加载完成/确认成功断言。

## 最终截图索引

每一目录下的六张图片为 `01-home-empty.png`、`02-diagnose-new-confirmed.png`、`03-diagnosis-questioning.png`、`04-practice-before-submission.png`、`05-records.png`、`06-me.png`。

| 尺寸/主题 | 六页截图目录 |
|---|---|
| 375 浅色 | [目录](QA-evidence/2026-10-23T11-21-13-129Z-4836/artifacts/e2e-learning-loop-A01-A02--6c76b-plete-visible-learning-loop-chromium-375-light/) |
| 375 暗色 | [目录](QA-evidence/2026-10-23T11-21-25-986Z-20956/artifacts/e2e-learning-loop-A01-A02--6c76b-plete-visible-learning-loop-chromium-375-dark/) |
| 768 浅色 | [目录](QA-evidence/2026-10-23T11-21-37-790Z-22072/artifacts/e2e-learning-loop-A01-A02--6c76b-plete-visible-learning-loop-chromium-768-light/) |
| 768 暗色 | [目录](QA-evidence/2026-10-23T11-21-54-728Z-20864/artifacts/e2e-learning-loop-A01-A02--6c76b-plete-visible-learning-loop-chromium-768-dark/) |
| 1440 浅色 | [目录](QA-evidence/2026-10-23T11-22-06-663Z-26620/artifacts/e2e-learning-loop-A01-A02--6c76b-plete-visible-learning-loop-chromium-1440-light/) |
| 1440 暗色 | [目录](QA-evidence/2026-10-23T11-22-18-109Z-26164/artifacts/e2e-learning-loop-A01-A02--6c76b-plete-visible-learning-loop-chromium-1440-dark/) |

已亲自查看最终 375 首页、375 暗色诊断、768 档案，信息可读且无横向溢出。前端子任务另做六页结构审查。截图仍可见 Next.js 开发浮层；主开发随后关闭 `devIndicators`，生产构建本身不会包含它。

## 浏览器安装与意外副作用

锁定的 Playwright 1.64.1 需要 Chromium revision 1248；已有全局缓存为 1234，实际 `chromium.launch()` 先报缺失可执行文件。主开发授权安装后，首次 `npx playwright install chromium` 自动执行了 Playwright 缓存 GC，输出并移除了全局旧缓存 `chromium-1234`、`chromium_headless_shell-1234`、`ffmpeg-1011`。这不是显式删除命令，但违背了用户不批量删除的意图；发现后立即中止并报告主开发，由主开发告知用户。项目源码、文档与用户学习记录未受该 GC 影响。

随后核查本地 Playwright 实现的 `PLAYWRIGHT_SKIP_BROWSER_GC` 开关，设置为 `1`，改在项目忽略目录 `.local/playwright` 安装 1248 浏览器与其工具。后续安装和测试保持该设置，禁止再次触发缓存 GC。

**原缓存已恢复并实际验证**：通过 Codex 依赖工具定位已有 bundled `playwright-core` 1.62.1，它的 `browsers.json` 明确记录 chromium/headless revision 1234、版本 151.0.7922.34 与 ffmpeg 1011。使用该已安装 CLI、`PLAYWRIGHT_SKIP_BROWSER_GC=1`、原全局浏览器目录重新下载，三个缓存均恢复原路径，没有执行清理。随后从该旧版 core 启动浏览器、打开页面并读取标题，实际输出 `version:151.0.7922.34`、`title:Restored original browser cache`，退出 0。原 `winldd-1007` 保留；项目新版浏览器继续隔离在 `.local/playwright`。

## 尚未验证或仅部分覆盖

- 六页完整操作、375/768/1440 浅暗截图、滚动及合成 IME 已通过；该自动化未覆盖真实系统输入法和真实软键盘。
- A10/A21：网关层超时/非法 JSON/有限重试单测与真实 PostgreSQL 服务层失败保存/恢复均有通过证据；尚未做真实 HTTP/UI 故障回合，不计为 E2E 完整通过。
- A24：最终生产构建客户端秘密扫描通过，扫描无泄漏不等同完整安全审计。
- 8 条诊断种子仅为工程样例；15 道原创数学训练仅经过确定性计算核对，尚无教师正式审核，不能声称诊断准确率已达标。
- A03 当前证明无真实 OCR 时会诚实留空并要求手动输入；未做 live 图像识别准确性评测。
- 真实系统中文输入法、真实移动端软键盘、Firefox/WebKit、浏览器 200% 缩放、人工读屏、上线合规、生产对象存储、生产备份/灾难恢复及真实模型调用未完成。本地工程数据库备份恢复已由主开发执行。

## A01–A24 状态口径

| 场景 | 结果与限制 |
|---|---|
| A01/A02 | 真实 API + 六套浏览器通过 |
| A03 | 合法空白图、私有访问、Mock 不伪造识别通过；live OCR 未验收 |
| A04 | 修正后的确认文本与旧会话快照不变通过；未做 live OCR 端到端 |
| A05/A06/A07 | Mock HTTP + PostgreSQL 证据通过；不代表正式模型准确率 |
| A08/A09 | 浏览器刷新、HTTP 并发幂等及 key 内容冲突通过 |
| A10 | 网关单测与真实 PostgreSQL 服务层覆盖超时保存恢复；HTTP/UI 尚未完整注入验证 |
| A11/A12/A13/A14 | 隐藏答案、提示标记、UNKNOWN、档案与导出证据通过 |
| A15/A16 | 筛选、单条本人软隐藏、跨账号隔离通过；物理删除尚为管理流程 |
| A17 | 合成 composition/Enter/Shift+Enter 自动化通过；真实输入法待人工验收 |
| A18 | 六套长消息 UI fixture 通过，含上翻不追随与跳最新 |
| A19 | 三尺寸×两主题、六页无水平溢出通过；真实 200% 浏览器缩放与读屏未做 |
| A20 | 明确 Mock 标签和无付费模型闭环通过 |
| A21 | 网关非法 JSON/有限重试单测与真实 PostgreSQL 服务层恢复覆盖；HTTP/UI 故障集成未完成 |
| A22/A23 | 上传限制与年龄准入真实 HTTP 通过 |
| A24 | 最终生产客户端 24 文件/2 个现有秘密值检查通过，无泄漏；非完整安全审计 |

## 重跑命令

```powershell
$env:E2E_BASE_URL='http://127.0.0.1:3000'
$env:E2E_INVITE_CODE='local-study-invite'
$env:PLAYWRIGHT_SKIP_BROWSER_GC='1'
$env:PLAYWRIGHT_BROWSERS_PATH='C:\Users\QYF\Desktop\study\.local\playwright'
npx playwright test --project=api
npx playwright test --project=chromium-1440-light
$zhiyinBuild=Get-Content -LiteralPath '.local\latest-build.json' -Raw | ConvertFrom-Json
node scripts/security-scan-client.mjs (Join-Path $zhiyinBuild.directory 'static')
```

每次测试输出使用新时间戳目录，保留先前通过和失败证据。API 和界面矩阵使用专用本地数据，不应指向正式服务。
