# 诊断工程回归

运行 `npm run eval`。它使用显式服务器运行条件加载 MockGateway，检查 `tests/诊断评测_种子案例.json` 的 8 个工程案例，并核对 15 道原创训练题的计算结果，写入 `latest-results.json`。

这不是教师标注的 Gold Set。通过这些测试不能推出诊断准确率、成绩提升或真实模型可用性。训练题由工程实现自主编写并做确定性算术检查，尚未经过教师审核；公开试测前仍需要题目审核与学科评测。

`tests/unit/domain-gateway.test.ts` 通过注入 fetch 覆盖模型超时、非法 JSON、一次有限重试、401/429、usage 与不泄漏错误正文。所有测试使用明显的占位凭证，不调用付费模型。

M6 已用受控入口替代仅靠环境变量的烟雾测试。`npm run eval:plan` 零网络；`npm run eval:live -- --permit .local/live-permit.json --case sign-error` 必须同时具备一次性、限时、绑定数据集/模型/地域/费用的人工授权文件与显式 live/key 配置，缺条件时拒绝，绝不静默退回 Mock。旧 `npx tsx scripts/eval/live-smoke.ts` 也转至相同门禁，不能绕过授权。完整说明见 [受控调用说明](../../docs/M6-真实模型受控测试.md)。

正式格式与评分见 [教师规范](../../docs/M6-评测与教师标注规范.md)。`eval:validate` 校验 inputs 与独立标签，`eval:demo` 仅运行六条合成 Mock；`eval:score` 按输入/输出hash与审核信息评分。工程标签、教师金标、人工输出质量评分独立存储；未审核指标不计分。所有新运行结果放忽略目录 `.local`，不得提交私人学习数据。

2026-10-23 核验的官方接口资料：

- [Qwen3.8-Flash 模型信息](https://help.aliyun.com/zh/model-studio/qwen3-8-flash)：明确 `qwen3.8-flash` 模型 ID、图文输入和结构化输出支持。
- [阿里云 OpenAI 兼容 Chat API](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)：支持 `/chat/completions`、`response_format`、多模态 Data URL 和 usage。业务空间专属新域名推荐使用；文档仍保留旧域名兼容。

实现默认沿用可配置旧域名 `https://dashscope.aliyuncs.com/compatible-mode/v1`，可通过 `ALIYUN_BASE_URL` 切换到账号业务空间域名。真实账号的地域、模型授权、延迟、OCR 质量、成本及最终诊断质量尚未实测。没有配置定价时 `costEstimate` 为 `null`，不伪造费用。
