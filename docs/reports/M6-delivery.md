# M6：真实诊断能力验证的准备与工程验收

日期：2026-10-23。范围：既有六页和完整学习闭环保持不变；增加评测与测试基础设施，未公开发布，仍限受邀成年人本地工程试测。

**本轮结论：评测协议、教师标注流程、受控真实调用入口及 HTTP/UI 故障恢复已实现。真实 AI 诊断能力尚未验证。** 真实供应商调用0次、费用0元、教师审核0条；没有 Key 或明确单次授权，因此没有发起付费请求。不能从工程样例通过推出教育准确率。

## 1. 仓库现状、基线与实现顺序

开始时 Git `main` 无提交，代码、设计原稿、Logo及报告均未跟踪；两条数据库迁移已在本地 PostgreSQL 应用。先复跑 typecheck/lint/build、27项单测、5项真实数据库服务测试和 migrate status，均通过；扫描暂存121文件，实际已配置秘密值检查未命中，建立基线 **`9024a78a05507a8f3d492ccba007d891acf5512d`**。

优先顺序实际执行为：安全基线 → 教师评测格式/程序与故障验证并行 → 官方协议/授权/费用控制 → 发布阻塞审查 → 最终生产构建与回归 → 提交扫描。依赖没有升级；未使用 audit fix/reset/清库或浏览器安装。

历史运行证据、截图、模型结果、生成类型、.env、依赖、构建和缓存留在本机并从Git排除。`next-env.d.ts` 是Next自动生成物，本轮只从Git索引移除，磁盘文件仍在；规范化tsconfig和构建脚本，避免提交当前机器的时间戳运行类型路径。原始题库样例、设计图和用户提供Logo仍跟踪。没有新增数据库迁移。

## 2. 实际代码与文件

- 评测：`src/evaluation/schemas.ts`、`score.ts`；`tests/evaluation/engineering.inputs.json`、独立的 `engineering.annotations.json`、空 `teacher.annotations.template.json`；`scripts/eval/offline.ts`、`demo.ts`。
- 受控调用：`src/evaluation/live-control.ts`、`scripts/eval/controlled.ts`；旧 `live-smoke.ts` 统一转入同一授权门禁。`docs/evaluation/live-permit.example.json` 默认未批准，无法直接发请求。
- 网关：`src/server/ai/configuration.ts` 官方endpoint/path校验和严格整数限额；Aliyun请求改用max_completion_tokens，禁止重定向，只接受stop完成后进行结构/引用验证；createGateway支持有界timeout/retry服务器参数。未添加Mock回退。
- HTTP/UI：`scripts/m6` 的隔离runner与preload、`playwright.fault.config.ts`、`tests/fault`。生产业务代码没有故障Header或端点；Docker runtime只复制start脚本，不复制测试preload。
- 最小修正：Docker补public；诊断额度拒绝NaN/负值/超范围；构建后规范化tsconfig。`test:production`提供独立全新数据库的生产构建回归runner，保留数据库和证据；不清理原库或修改频控。
- 新测试：`tests/unit/evaluation-score.test.ts`、`evaluation-live-control.test.ts`，扩充既有网关单测；README、评测说明、[教师规范](../M6-评测与教师标注规范.md)、[真实调用说明](../M6-真实模型受控测试.md)、[故障报告](M6-fault-tests.md)、[发布阻塞清单](M6-release-blockers.md)。

## 3. 评测数据与质量口径

inputs只含待诊断context；金标、人工输出评分独立存储，模型不接触金标。版本、整个数据集、每条context与输出均绑定SHA-256，防止换题或用另一轮输出评分。六条synthetic工程案例覆盖错步、无过程、正确过程、反证、未知与注入材料，仅作程序演练。

自动指标覆盖步骤集合精确匹配/F1、错因粗类匹配、动作/弃答、引用有效性和要求证据召回；类别一致不能代替错因语义正确。错因语义、追问有效性、证据相关性另用教师0–2分盲审。教师标签必须两位独立审核一致，或第三人仲裁；输出评分再绑定该轮outputHash。当前全部标注均为工程provisional，教师对比和人工质量项为null。

缺失输出、格式错误、调用失败保留在已选样本分母中；缺标、不适用或零分母为null。费用/延迟同时报告已知数量、未知数量和分位值；失败响应缺usage不算免费。未指定正式教育阈值，需教育负责人冻结数据与阈值后才能判断试测准入。

## 4. 实际命令、结果与证据

| 实际执行 | 结果 | 边界 |
|---|---|---|
| `npm run typecheck`、`npm run lint` | 最终均退出0 | 当前完整源码与测试 |
| `npm test` | 72/72，通过 | 包含评分、授权边界和网关；无付费请求 |
| `npm run test:service` | 5/5，通过 | 真实原有本地PostgreSQL，隔离工程用户；pg8弃用警告仍在 |
| `npx prisma migrate status` | 两条迁移全部已应用 | 未reset、未新增/改写迁移 |
| `npm run eval` | 旧工程种子8/8，15题算术核对通过 | 非教师评测 |
| `npm run eval:validate` | 六例格式通过、teacherReviewed=0 | hash为 `e2769d53d58bda9e2464c94471d0dab39766cb17950373b239352001ff9cb74b` |
| `npm run eval:demo` | 6/6生成合法Mock输出，teacherComparison=null | 本地模拟，供应商费用0 |
| 离线CLI validate/prepare-teacher/prepare-output-reviews/score | 通过 | 创建DRAFT，不自动签收教师标签 |
| `npm run eval:plan` | NOT_RUN、networkRequests=0、费用0 | 只生成计划 |
| controlled与旧live-smoke缺permit | 子进程实际退出2、BLOCKED、networkRequests=0 | 不因仅配置环境变量自动付费；npm/PowerShell外层可能包装退出码 |
| `node scripts/m6/run-fault-tests.mjs` | 11/11、约12.9秒，10张截图 | 真实HTTP/DB/Chromium，合成fetch上游；真实百炼未测 |
| 旧API开发实例回归 | 16/16、6.7秒 | Mock + 真实原库 |
| 最终生产构建独立库回归 | 18/18、7.9秒 | 16API+1440浅色完整闭环/滚动两项，真实生产构建与新PostgreSQL库，Mock |
| `npm run build` | 编译/类型/14静态页成功，退出0 | `.local/build-2026-10-23T12-01-54-667Z` |
| 最终生产客户端秘密扫描 | 24文件/2个现有秘密值，0泄漏，退出0 | 非完整安全审计；无live Key配置 |
| 完整/生产依赖audit | 完整5 high、生产依赖子集0 | 没有force升级；现Docker仍含开发依赖 |

工程评测结果：`.local/m6-evaluation/mock-bff75b44-1bc1-4a3b-a2a1-0d421f59450f/{run,score}.json`。故障证据：`.local/m6-fault-2026-10-23T11-58-21-183Z-25492/`（results、transport、案例JSON及10张截图，29次合成fetch逐次检查参数）。已人工查看代表性失败和恢复页面，精确说明见故障报告。

最终生产回归证据：`.local/m6-production-regression-2026-10-23T12-03-34-221Z/` 中迁移、服务器与测试日志及summary。创建全新 `m6_regression_时间戳` 数据库、应用现有迁移，未克隆个人资料、未删除原库或新库、未放宽频控。所有证据仅本地保留，不纳入Git。重跑可先build，再 `npm run test:production`；会再次创建独立新库，需要本地账户CREATEDB权限。

## 5. 真实调用结果及成本

本轮 **真实请求0、供应商消费0、真实延迟/真实token/真实模型质量均未验证**。计划与拒绝记录位于 `.local/evaluations/2026-10-23T11-56-40-...` 及 `11-57-20/21-...` 新目录；真实结果文件没有伪造。故障夹具中的17/3、19/5等tokens是合成计量测试值，不用于费用或模型质量结论。

未来runner需显式live模式、Key与未过期的一次授权：绑定数据集hash/选定case/model/endpoint/地域/定价，1–3请求、最多24小时、预算不超过10元。每次fetch重验时间/地址/参数/字节/次数；无自动重试。授权独占文件在首请求前消费，不能重放。失败即停止，未知usage保留null，费用估算与供应商账单分开。保守预留基于整个模型输入上限和输出上限，不将缓存优惠假设为保证；它不替代供应商账户硬额度与账单核对。

## 6. 失败案例与修复

1. **既有UI补跑2项失败**：原本地数据库累积注册测试触发429，注册页未跳转。证据留在 `docs/reports/QA-evidence/2026-10-23T12-01-55-182Z-22780/` 和 `12-02-10-764Z-26284/`。没有清空频控或放宽业务规则；改为独立新数据库+最终生产构建，18项全部通过。原失败不从记录中移除。
2. **故障设施早期失败**：Windows预加载路径转义、缺Origin导致403、Next route-announcer和应用alert定位歧义、测试池重复关闭、CJS lint和NODE_ENV字面量类型问题；均修正测试设施，完整时间线/目录见[故障报告](M6-fault-tests.md)。未修改CSRF/UI业务掩盖失败。
3. **授权安全复核两项问题**：最初仅批次开始验到期、美国地域价格部署范围差异。修正为逐请求验时，非北京保守较高费率、香港价格未核验禁用；补回归单测。独立审查复核关闭代码问题，真实账单能力仍未验证。
4. **预期拒绝分支**：缺许可/Key、未批准、过期/未来时间、错误数据集/样本、重用许可、预算不足、地域/价格错误、重定向/超大小/参数漂移/超次数等均有拒绝用例。拒绝成功不计真实模型调用成功。
5. **真实模型失败案例**：没有实际请求，因此没有可报告的真实模型成功或失败；未审核教师输出，不能写成“零失败准确率100%”。

## 7. 未完成事项与发布阻塞

详情与责任/退出标准见[清单](M6-release-blockers.md)。仍未完成：正式教师标注和输出盲审、真实API/OCR与账单/延迟验收、物理删除执行器及备份到期、完整Docker镜像构建/扫描、开发依赖high修复或隔离、production统一fail-fast/HTTPS/Secure Cookie/CSP、平台级原子费用配额与监控、真实输入法/软键盘/读屏/其他浏览器及未成年人机制。

记录删除仍为软隐藏、账户删除仍为申请。本轮只审查关系和风险，没有尝试物理清理。Docker补public与排除故障代码仅有源码证据；镜像仍复制开发依赖。六页保留，Mock可用，成人邀请限制不变；没有任何公开注册/部署动作。

## 8. 下一阶段建议

P0：教育负责人审核标注规范、独立双标并仲裁，冻结分层评测集和准入门槛。账户持有人明确地域、Key、数据范围与一次小额授权后，先1条真实协议检查，再逐步在限额内跑冻结集，记录每个失败与供应商账单；当前不自动发起。

P1：独立合成环境实现并验证逐用户物理删除、备份保留和管理员审计；处理依赖与运行镜像、生产配置预检、HTTPS与平台预算。完成设备和人工无障碍验收后，才能安排教师监督下的受邀成人封闭试测。未完成这些门槛前不扩大服务范围。
