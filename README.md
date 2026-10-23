# 知因 AI — Codex 开发交付包

> 2026-10-23 开发更新：现已包含可运行的本地 Web MVP；下方原始交付包说明予以保留。

## 运行已实现的应用

要求 Node.js 24.16.0、Docker Desktop Linux engine。首次安装 `npm ci`，之后运行：

```powershell
npm run local
```

打开 [本地知因AI](http://127.0.0.1:3000)。在注册页自建账号，本地自动配置的邀请码为 `local-study-invite`，当前仅允许成年受邀测试者。无内置管理员和默认密码。setup只在不存在.env时生成本地配置，不覆盖已有设置。

登录后可选择“填入内置演示题”完成：确认题目 → 留下步骤 → AI追问 → 证据报告 → 新题作答 → 学习档案。默认Mock会明显标注“演示模式”；未知题保留待确认。图片在Mock模式要求手动输入，不伪造OCR。

六页固定为：首页、开始诊断、学习诊断、针对训练、学习档案、我的。支持浅色/暗色/系统主题、手机题目与对话切换、真实私有图片、反馈、导出、单条隐藏和删除申请。训练完成后可手动换一组未做过的新题，不据此宣布长期掌握。

## 开发与验收命令

M7 增加40条未审数学候选（调试24/盲测候选16）、会话级评分与教师模板。`npm run eval:m7-data` 校验数据与hash；`npm run eval:conversation -- simulate` 仅演练调试集Mock。已按用户一次授权完成1次真实协议检查，出现需教师审阅的归因和追问风险，不能据此宣称教育质量通过。Key仅本地配置，网页仍为Mock。见 [M7交付报告](docs/reports/M7-delivery.md)、[案例集说明](docs/M7-案例集说明.md)、[会话评测规范](docs/M7-会话评测规范.md)、[单次真实检查](docs/M7-单次真实协议检查.md)。

M6 已增加教师标注/离线评分与受控真实测试基础：`npm run eval:validate`、`npm run eval:demo`、`npm run eval:plan`、`npm run test:faults`。真实调用必须另有明确人工授权与配置；默认不调用付费模型。见 [教师评测规范](docs/M6-评测与教师标注规范.md)、[受控调用说明](docs/M6-真实模型受控测试.md)、[M6交付报告](docs/reports/M6-delivery.md) 和 [发布阻塞清单](docs/reports/M6-release-blockers.md)。

```powershell
npm run typecheck
npm run lint
npm test
npm run test:service
npm run eval
npm run build
npm start
```

浏览器测试、模型接入、迁移、Docker准备及数据删除限制见 [部署与运维说明](docs/DEPLOYMENT.md)。完整修改、命令输出、截图、失败记录和M0–M5状态见 [阶段交付报告](docs/reports/2026-10-23-delivery.md) 与 [QA实测报告](docs/reports/QA-results.md)。数据库迁移位于prisma/migrations，UI原稿仍在references。

当前是本地封闭工程试测版本。真实模型/真实OCR尚未验收；题库和工程种子未经教师Gold Set审核；未成年人机制、正式数据清理及公网发布评审未完成。完整依赖审计仍有开发工具链告警，详情见部署说明。

## 交付内容

- `docs/知因AI_完整产品开发文档_PRD_v1.0.md`：唯一业务与工程开发基线；六页、流程、数据库、API、AI、合规、测试、分阶段任务。
- `docs/知因AI_Codex_启动提示词.md`：直接复制给 Codex 的开发指令。
- `references/zhiyin_ui_six_pages.png`：此前确认的六页 UI 总览。
- `references/知因AI_01_首页.png` … `references/知因AI_06_我的.png`：单页图片，用于视觉审查。
- `references/zhiyin_ui_six_pages.html`：静态参考页面（**非真实前端应用**）。
- `tests/诊断评测_种子案例.json`：工程流程/边界测试样例，**不是老师审核的准确率基准数据集**。

## 交给 Codex 的最简方式

1. 解压 ZIP 到准备开发的仓库根目录。
2. 打开 `docs/知因AI_Codex_启动提示词.md`，将全文粘贴给 Codex。
3. 让 Codex 阅读文档后真正实现代码、数据库迁移、测试、Docker 环境。
4. 前期不配置 API Key 可以通过 `AI_MODE=mock` 完成流程和 E2E；配置真实 Key 后切换 `AI_MODE=live` 并运行模型评测。

## 本次默认但可调整的关键决策

- 账号：邮箱+密码、邀请制封闭试测；手机号和验证码后置。
- 平台：Next.js 响应式 Web；不做原生 App。
- AI：阿里云百炼模型为主，DeepSeek 作为可替换备选；高价模型自动升级默认关闭。
- 题库：优先人工审核种子题；不承诺自动精准批改全部学科。
- 发布：本地开发不被合规审批阻塞，正式面向未成年人开放需额外评审。

## 原始交付包口径（开发前历史说明）

原始交付包只有开发规范与参考素材，不包含业务代码。2026-10-23 已新增本地实现；当前范围和验收状态以上方运行说明、阶段交付报告为准。
