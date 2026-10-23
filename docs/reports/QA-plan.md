# QA 验收基线（2026-10-23）

本文件是测试准备和覆盖映射，不是通过报告。运行证据将保存在 `docs/reports/QA-evidence/<时间戳>/`；每次使用新目录，不删除既有文件。测试仅创建独立本地测试账户与数据，不清库、不操作既有学生记录。测试中涉及删除的仅为刚创建的测试业务记录，须通过本人 API 完成，禁止文件系统批量删除。

## 已查阅与环境

- 完整 PRD、启动提示词、六页总览、六张单页 PNG、HTML 设计参考、8 条工程种子案例。
- 本机为 Windows 11 专业版，Node v24.16.0，npm 11.13.0；缓存存在 Chromium/headless shell revision 1234。
- 2026-10-23 的 npm registry 查询：`@playwright/test` 稳定版 1.64.1，包要求 Node >=20；版本由主开发统一锁定。
- [Playwright 官方安装要求](https://playwright.dev/docs/intro)：当前支持 Node 22/24/26、Windows 11+。本机满足；缓存存在不能等同于浏览器启动已通过，仍须实际运行。
- [Playwright 官方配置](https://playwright.dev/docs/test-configuration)：使用项目隔离 viewport/主题、API 测试独立项目，失败保留 trace 与截图。
- 种子数据明确标注 `ENGINEERING_SEED_CASES_NOT_TEACHER_VERIFIED`，8 条不得报告为教师 Gold Set 或真实准确率。

## A01–A24 覆盖与证据要求

| ID | 实际验证目标 | 层级与证据 | 初始状态 |
|---|---|---|---|
| A01 | 注册、学段、真实零记录 | 浏览器表单 + dashboard API | 未执行 |
| A02 | 题目确认后创建不可变快照/Attempt | 浏览器闭环 + DB API | 未执行 |
| A03 | 模糊/空白图识别不得编造题面 | 真实合法图上传 + OCR 不足响应 | 未执行 |
| A04 | OCR 修改以确认文本为准 | problem confirm 后查询会话快照 | 未执行 |
| A05 | 无步骤先追问、不过度归因 | Mock API 场景 | 未执行 |
| A06 | 符号错误引用第 2 步且为候选 | 种子 API + 报告证据 | 未执行 |
| A07 | 新回答推翻原假设时更新/反证 | Mock 多轮 + Evidence | 未执行 |
| A08 | 刷新恢复且消息数量不变 | 浏览器 reload + API 数量 | 未执行 |
| A09 | 同 key 双提交幂等或 SESSION_BUSY | 并发真实 HTTP + 持久数据数量 | 未执行 |
| A10 | 超时有限重试，保存原答 | 故障网关 + DB API，禁止静默伪成功 | 未执行 |
| A11 | 训练关联发现、GET 不泄答案 | 真实 API 全 JSON 键与内容扫描 | 未执行 |
| A12 | 请求提示后不能伪造独立 | hint→submission + 重开详情 | 未执行 |
| A13 | 无法核验答案为 UNKNOWN/PENDING | 不可自动核验提交 + 状态 | 未执行 |
| A14 | 档案追溯原题、步骤、消息、训练 | 浏览器详情 + 真实 API | 未执行 |
| A15 | 筛选、删除本人刚创建记录 | 测试数据 API + 列表排除 | 未执行 |
| A16 | 第二账户读取/修改第一账户资源拒绝 | 两个独立 Cookie jar + IDOR 矩阵 | 未执行 |
| A17 | composition Enter 不发送、普通 Enter/Shift Enter | 浏览器合成 composition 事件；系统 IME 需另做人工验收 | 未执行 |
| A18 | 上翻不抢滚动，提供跳至最新 | 真实长消息 + 滚动坐标及焦点 | 未执行 |
| A19 | 六页 375/768/1440 浅/暗、缩放、无溢出 | Playwright 截图 + DOM 溢出检查；200% 单独验收 | 未执行 |
| A20 | 无 key 标识演示且闭环可用 | 浏览器演示标签 + Mock mode | 未执行 |
| A21 | 非法 JSON 受控失败，不原样泄漏 | 本地 live-provider stub 或网关单元 + 集成 | 未执行 |
| A22 | SVG/伪装魔数/10MiB+ 拒绝 | multipart 真实 HTTP 响应 | 未执行 |
| A23 | 不符合年龄准入无法获得登录态 | 注册 API + 私有 API 再检查 | 未执行 |
| A24 | 客户端无密钥或私密配置 | 生产 `.next/static` 精确秘密值与格式扫描 | 未执行 |

## 附加高风险验证

跨站写入 Origin/Fetch Metadata、匿名私有 API、登出吊销、未知字段、无确认题目、重复 key 内容冲突、跨用户图片引用、训练客户端伪造 assistance、无 evidence 的完成报告、不可信 HTML/脚本安全显示、失败后相同回合重试、同用户并发写入。

## 当前限制

尚无运行中的应用、数据库及已稳定 DTO，不能认定任何功能通过。浏览器自动化的合成 composition 事件不等同于微软拼音/第三方输入法的真实系统事件。Mock 行为正确不等同于 live 模型质量；本地 stub 只验证失败处理。未完成教师评测、付费模型实测、生产对象存储、监护人机制、真实多用户负载、备份恢复或公开发布审查。
