# M6 发布阻塞与安全复核

审查日期：2026-10-23。审查基线：`9024a78`（`chore: establish verified local MVP baseline`）。范围：当前源码、Prisma 关系、部署文件、配置示例、既有交付记录，以及本轮实际依赖审计。结论仅适用于受邀成年人本地工程测试；未进行公网部署、数据库删除、备份清理或付费模型调用。

## 证据口径

“代码已核验”表示阅读当前实现，不等同生产运行验收。“本轮实际验证”仅用于本次执行且取得结果的检查。“历史证据”引用 M0–M5 报告，未自动升级为 M6 重跑。“尚未验证”保持为发布门槛，不能据此宣称系统安全或教育诊断准确率达标。

| 检查 | 本轮结果 | 范围与限制 |
| --- | --- | --- |
| `npm audit --json` | 实际执行，退出 1；5 high、0 critical | 当前 lockfile；5 个受影响包来自同一依赖链，不是 5 个独立 CVE |
| `npm audit --omit=dev --json` | 实际执行，退出 0；0 漏洞 | npm 公告已知问题扫描；不覆盖操作系统、容器、业务权限、未知漏洞 |
| 本地配置摘要 | 实际读取，仅输出布尔项：应用与数据库均回环地址、会话 secret 满足当前长度/占位符检查、Mock、无真实模型 key、邀请码已配置、未成年开关 false | 未打印凭据原值。文档中的本地默认口令/邀请码仍用于本地，不能复用到公网。`ALLOW_MOCK_IN_PRODUCTION=true` 是本地生产构建预览例外 |
| 注册和会话 | 代码已核验：成年硬限制、邀请码、注册开关、Argon2id、随机会话 token 的 HMAC、DB 撤销、HttpOnly/SameSite | 新一轮真实 HTTPS Secure Cookie、代理和生产注册门禁尚未验证 |
| HTTP 安全头 | `next.config.ts` 已配置 nosniff、DENY、Referrer/Permissions Policy、CSP，关闭 powered-by | 本轮最初只读请求 3000/3001 均连接失败，不能把配置阅读计作 HTTP 运行验证。后续 M6 故障测试的独立结果见交付报告 |
| 删除与备份 | 代码已核验为软隐藏/登记申请；未执行任何物理清理 | 既有本地备份恢复演练不证明删除完成；备份没有自动到期机制 |

原始审计结果留在忽略目录 `.local/m6-audit-20261023T194939667/full.json` 和 `production.json`，不进入 Git。纯统计摘要同目录 `summary.json`。没有运行 `npm audit fix`、破坏性升级、清库、数据库 reset、目录删除或浏览器安装。

## 阻塞优先级与退出标准

P0：必须先解决对应门槛才能开展目标活动。P1：正式试测/生产发布前必须关闭或经责任人明确接受并限制范围。P2：有明确实施与验收安排的后续改进。此处优先级是项目发布优先级，不替代依赖公告的 CVSS。

| 编号/优先级 | 已有证据与风险 | 阻塞活动 | 责任角色 / 退出标准 |
| --- | --- | --- | --- |
| R01 / P0 | 教师审核 Gold Set、双人独立标注和争议仲裁尚未完成；现有工程样例不能证明教育有效性 | 面向学习者宣传诊断准确率、扩大真实学习试测 | 教育负责人：完成分层标注、冻结独立评测集、报告各指标分母/失败案例，并书面确定试测门槛 |
| R02 / P0 | 本轮审查开始时无 live key，未发起付费调用；供应商地域、模型授权、实际 structured output、真实费用/延迟尚未验收 | 付费调用和“真实模型已通过”结论 | 模型负责人/账户持有人：明确模型/地域/密钥配置、最大请求与金额、人工授权；受控 runner 结果与账单核对，失败不得回退 Mock 冒充成功 |
| R03 / P0 | 注册虽然拒绝未成年并要求邀请码，但年龄为用户自报，没有监护同意或未成年人审核流程 | 未成年人接入、开放公网注册 | 产品/合规负责人：保持受邀成年人本地限制；未来另立准入方案及审核，本阶段不开放 |
| R04 / P1 | `DELETE /api/v1/records/:id` 设置 `deletedAt`；`DELETE /api/v1/me/data` 仅建 `DeletionRequest(REQUESTED)`。没有物理删除执行器、完成态/失败态审计或 SLA | 向真实参与者承诺彻底删除；扩大数据收集/正式发布 | 数据负责人：先审批覆盖范围/保留期限，再在独立合成数据环境验证逐用户全关系清理、会话撤销、供应商副本及备份过期；严守不批量删除现存工作区的限制 |
| R05 / P1 | 完整 npm audit 5 high，当前 Dockerfile 复制全部 node_modules，因此开发依赖也进入运行镜像。`omit=dev=0` 不代表该镜像没有受影响包 | 当前镜像的正式发布 | 工程/安全负责人：取得兼容上游修复或有测试的最小依赖变更；构建与迁移镜像分离、移除开发依赖后重新 audit/SBOM/镜像扫描；保持 Next 16 回归，不采用 force 回退 |
| R06 / P1 | 没有统一 production fail-fast。`Secure` 仅由 APP_URL 的 https 决定；HTTP production/local 例外不会自动阻止非回环部署；本地默认 DB 口令/邀请码需人工替换 | 非本地生产环境 | 运维/安全负责人：独立部署配置检查拒绝弱凭据/非 HTTPS/不当 Mock 例外，验证可信代理、APP_URL 同源、Secure Cookie/HSTS、无公开 DB 端口；测试失败须启动失败 |
| R07 / P1 | per-user 次数限制不是平台费用预算；并发新诊断不同 attempt 的日统计不在同一 user lock 下，上传配额 aggregate/create 也非同一配额锁。模型失败/重试可能产生费用 | 无人值守或更大规模 live 调用 | 模型/后端负责人：平台和账户预算、并发预留与原子配额、供应商账单告警；受控 runner 只授权有限样本，任何未知 token 成本保持 unknown 而非 0 |
| R08 / P1 | CSP 脚本允许 unsafe-inline（development 另允许 unsafe-eval）；没有 nonce 生产策略/HSTS。图片通过私有 DB 接口且已转码，不能替代整体渗透测试 | 公网部署 | 前端/安全负责人：按安装版本 Next 文档完成 nonce 或经验证的替代方案；真实生产响应头、注入、代理和 Cookie 验收 |
| R09 / P1 | 本地 Docker PostgreSQL 固定 volume，有旧备份与独立恢复库。尚无自动保留期限、加密/密钥轮转、最小权限和独立灾备验收 | 正式个人数据托管 | 数据/运维负责人：明确保留/访问策略，独立环境恢复演练、最小权限迁移/运行账户、删除申请覆盖备份到期；不对现有文件/数据库执行清理 |
| R10 / P2 | 基线 Docker runtime 未复制 public，而 Logo 位于 public/brand。只完成 compose 配置核验，未完整构建运行容器 | 使用容器交付时 | 工程负责人：最小补齐 public，实际容器启动后检查 Logo/页面/API/迁移；源码修复不等于镜像运行已验收 |
| R11 / P2 | RateLimitBucket、会话/幂等记录、构建、截图和备份均持续保留，无到期运维流程；既有真实测试输出包含隔离测试 ID/邮箱等运行数据 | 长期维护与证据共享 | 工程/数据负责人：运行数据继续忽略 Git，只提交去标识统计/合成样本；审批容量与保留方案，清理现存批量文件由用户手工处理 |

## 删除关系清单（代码核验，未执行删除）

读取 `src/server/services/api.ts` 与 `prisma/schema.prisma` 可复现。软隐藏记录后普通查询带 `deletedAt:null`，关联训练、无其他活动引用的题目/图片也被隐藏。物理 Bytes、历史题面、步骤、消息、证据、训练答案仍在数据库。全量请求既不会删除 User，也不会自动撤销现有登录态；响应诚实提示“当前数据尚未彻底删除”。管理员流程尚待实现。

未来物理删除至少须明确以下范围，并先在独立合成测试库做全量行计数与访问验证，不能直接在现有库试删：

- User 的 FK cascade 子图：UserProfile、Session、Upload、Problem/ProblemRevision、Attempt/AttemptStep、DiagnosisSession/Message/Finding/Evidence、PracticeSet/Item/Submission/Finding、ReviewTask、UserFeedback、ModelInvocation、MutationKey、DeletionRequest。当前 cascade 是数据库关系能力，不是已上线的删除执行流程。
- PracticeSet 自引用 `retestOfId` 和 Attempt→ProblemRevision 的默认限制关系，需要明确删除顺序并验证完整链；不可未经测试地推断“一次删 User 就全部安全完成”。
- `AuditEvent.actorId/subjectId` 没有 User FK；`RateLimitBucket.key` 是应用散列键、没有 User FK；`ReviewTask.userId` 没有独立 User FK但有set关联。删除策略需分别决定匿名化、到期或审计保留，并记录必要性与期限。
- `Problem.imageIds`、`ProblemRevision.imageIds`、`FindingEvidence.sourceId`、`DiagnosisMessage.referencedStepIds`、`Problem.currentRevisionId` 是标量/数组弱关联；清理必须检查孤立引用和跨记录共享图片，不能只依赖 FK。
- 备份、手工导出、本地历史测试证据、供应商接收的上下文属于其他副本，需要单独规则。不能以数据库查询查不到代替“所有副本已物理删除”。

## 依赖审计复现与限制

实际链条：`eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch → braces`。官方公告 [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) 标识 braces ≤3.0.3 的深层 pattern 栈耗尽问题，审查时未列出已修复版本。npm 结果建议重大回退 `eslint-config-next@14.2.35`，不适用于本次稳定 Next 16 基线；未采用该建议。公告本身不证明当前应用存在远程可利用入口，当前源码也未将学生材料传给 lint glob。这里保留为供应链与镜像交付阻塞，避免夸大实际可利用性。

重跑时每次创建新的忽略目录保存完整 JSON，记录退出码与 metadata；不要用 `audit fix --force`。npm 对 `omit` 和修复行为的定义见 [npm audit 官方文档](https://docs.npmjs.com/cli/v11/commands/npm-audit/)。生产依赖 0 是这一次公告扫描结果，不能作为“无安全风险”证明。

## 下一步验证顺序

1. 保持成人受邀本地边界；完成 M6 受控调用入口与故障注入证据，先验证预算/授权拒绝路径，再考虑明确授权后的少量真实调用。
2. 教师审核评测协议和样例，以未审核合成样例演练程序，以冻结独立人工标注集评估真实能力；输出所有失败和 unknown。
3. 在独立合成环境验证物理删除和备份到期流程；明确责任人与参与者可理解的处理时限后，再扩大收集真实学习数据。
4. 修复/隔离依赖链，补 production preflight、HTTPS/Cookie/CSP、数据库最小权限和容器真实运行验收。任何一项尚未验证，都不解锁公网注册或生产发布。

本清单不提供公开发布批准。后续代码修复与实测结果应追加到 M6 交付报告，保留上述基线发现与原始失败证据。

## M6 增量修复复核

以下为基线之后的代码复核，不抹去基线发现；具体测试命令与通过数量由 M6 总交付报告记录。

| 改动 | 已核验状态 | 仍未验证/保留阻塞 |
| --- | --- | --- |
| Docker runtime 复制 public | 已读最终 Dockerfile，Logo 静态文件进入镜像构建规则；仅复制 `scripts/start.mjs`，未复制故障注入 preload | 尚未实际构建运行容器。开发依赖仍整体复制，R05 保留 |
| 诊断环境额度 | `boundedInteger` 限定每日 1–30、回合 1–6；非法字符串、NaN、越界拒绝 | 原子配额与平台金额预算仍未实现，R07 保留 |
| Aliyun endpoint | 读取允许的 legacy 域/工作空间域、固定 compatible-mode path、禁止 URL 凭据/查询/端口；请求 `redirect:error` | 供应商账户/地域兼容性与真实 API 尚未验证 |
| 模型回复 | `max_completion_tokens` 上限、`finish_reason==='stop'` 后再验证 JSON/schema/引用；受控 runner 关闭自动重试、失败不转 Mock | 真实模型格式支持与实际费用仍未验证 |

受控调用入口进行了额外独立代码审查，没有执行 live runner 的付费分支。发现并反馈两项代码问题，修复后再次读取最终实现与回归用例，均已关闭：

- 逐请求许可到期：修复前纯函数复现过期许可仍被 guard 接受，网络请求 0；现在每次 fetch 发出前重新检查 `issuedAt <= now < expiresAt`，到期边界抛出 `PERMIT_EXPIRED_AT_REQUEST_BOUNDARY`。`tests/unit/evaluation-live-control.test.ts` 包含对应回归断言。
- 地域价格上界：美国同地域存在全球/美国部署范围价格差异，修复后非北京采用较高的 1.094/3.427 元每百万输入/输出 token 下限，香港因缺少该页明确原价而禁止受控调用；价格来源必须使用 `https://help.aliyun.com`。测试覆盖美国低价拒绝与香港禁用。该保守费率可能高于实际账单，不能把预算预留额当实际消费。

主开发提供本轮 72 项单测全部通过的执行结果；此独立复核未重跑全量测试。价格依据见 [Qwen3.8-Flash 官方模型说明](https://help.aliyun.com/zh/model-studio/qwen3-8-flash)。真实供应商计费、账户部署范围、发票对账仍未验证。不得用缓存折扣或缺失 usage 推定免费。CSP、production preflight、平台原子金额预算和物理删除仍保留为发布门槛，本次未宣称已修复。
