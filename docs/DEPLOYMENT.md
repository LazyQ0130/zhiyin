# 本地运行、试测与部署边界

本仓库当前用于受邀成人的封闭工程试测。没有对外发布，没有监护人验证，没有教师审核Gold Set。15道原创验证题只做了确定性算术校验。配置真实模型不代表已完成教育质量与合规审核。

## Windows 本地

Node 24.16.0、Docker Desktop（Linux engine）。首次执行 `npm ci`，然后 `npm run local`。该命令创建本地随机会话secret（已有.env不覆盖）、启动PostgreSQL、生成Prisma Client、应用迁移并启动127.0.0.1:3000。

本地自动生成.env启用成人试测注册，邀请码 `local-study-invite`；用户在注册页自建邮箱密码账号，不存在默认管理员密码。配置已有.env时请使用自己的邀请码。没有邮箱真实投递或密码重置服务。`npm run db:seed`仅接受显式SEED_DEMO_USER_EMAIL/PASSWORD并拒绝production。

## 验证与生产模式预览

`npm run typecheck`、`npm run lint`、`npm test`、`npm run test:service`、`npm run eval`、`npm run build`。生产构建每次写入新的.local/build-时间戳目录，避免清理已有文件；`npm start`启动最近成功构建。首次缺少构建会明确失败。数据库通过`npm run db:migrate`应用已有迁移，不需要破坏式reset。

Playwright安装前必须设置`PLAYWRIGHT_SKIP_BROWSER_GC=1`，本项目浏览器路径`.local/playwright`。运行时设`E2E_BASE_URL=http://127.0.0.1:3000`、`E2E_INVITE_CODE=本地邀请码`、`PLAYWRIGHT_BROWSERS_PATH=项目绝对路径/.local/playwright`，执行`npm run test:e2e`。测试新增隔离工程账户，不清理其他数据；报告每次使用新时间戳目录。仅指向本地专用试测DB。

在项目根目录首次安装浏览器时，先同时设置这两个变量；后续测试沿用相同路径，不要使用未禁用GC的安装命令：

```powershell
$env:PLAYWRIGHT_SKIP_BROWSER_GC='1'
$env:PLAYWRIGHT_BROWSERS_PATH=Join-Path (Get-Location).Path '.local\playwright'
npx playwright install chromium
$env:E2E_BASE_URL='http://127.0.0.1:3000'
$env:E2E_INVITE_CODE='local-study-invite'
npm run test:e2e
```

先在另一个终端运行`npm run local`。已有自己的邀请码时替换上述值。完成`npm run build`后，可扫描最新生产构建：

```powershell
$zhiyinBuild=Get-Content -LiteralPath '.local\latest-build.json' -Raw | ConvertFrom-Json
node scripts/security-scan-client.mjs (Join-Path $zhiyinBuild.directory 'static')
```

## Docker 部署准备（未对外部署）

已提供Dockerfile和compose的app profile。可在本机无服务占用3000时运行`docker compose --profile app up --build -d`，使用`docker compose run web node node_modules/prisma/build/index.js migrate deploy`应用迁移，并保留迁移容器与数据库卷。Web映射仅127.0.0.1，容器内监听0.0.0.0以允许端口映射。当前容器方案还保留开发依赖以支持迁移工具，正式发布前应拆出独立迁移镜像并缩减运行镜像。

发布前须在独立环境验证容器构建、数据库账号最小权限、HTTPS反代、APP_URL真实同源、Secure Cookie、注册频控、供应商地域与数据处理协议、日志轮转、备份恢复、内容审核、教育质量与未成年人准入。不得使用本地邀请码/数据库密码公开服务。当前注册仍硬拒所有未成年人，ENABLE_MINOR_SIGNUP不构成绕过入口。

AI_MODE=live需要服务端ALIYUN_API_KEY。实际端点仅允许阿里云HTTPS域名；使用AI_DEFAULT_MODEL配置模型。真实烟雾入口见scripts/eval/README.md。高价模型自动升级关闭；costEstimate未配置定价时为空，不能伪造费用数字。每人每日诊断30次、每次最多6轮、上传20张/小时且100MiB/账户。单体限流共享PostgreSQL；公网部署尚需可信代理IP频控和独立平台预算上限。

## 数据存储与删除

图片在PostgreSQL私有Bytes字段中，经sharp转码去元信息，GET必须验证所有者。图片不进public目录、不用公网永不过期地址。正式对象存储迁移仍待完成。

单条删除会使诊断及关联训练在普通接口消失；没有其他活动引用时题目和附件一并隐藏。证据和图片尚未物理销毁。全量删除是可追踪申请，需管理员完成；没有后台任务时不能宣称删除完毕。当前本地备份无自动过期策略，正式上线必须确定期限、第三方数据策略和操作审计。

禁止批量删除项目文件或目录。已有QA证据、构建、浏览器缓存、备份保留；需清理时由用户手动处理。

## 已知兼容性与安全审计

生产依赖`npm audit --omit=dev`为0漏洞。完整审计目前5个high均沿开发用eslint-config-next→fast-glob→micromatch→braces链条；公告GHSA-vfj7-8cjw-p6xm尚无兼容修复可用，npm建议回退Next14不适合本项目。保留此阻塞，不执行audit fix --force；lint只接受本仓库可信文件模式。

pg8出现client.query排队弃用警告（Prisma适配器查询路径），当前测试通过；升级pg9前须回归处理。CSP仍允许Next所需inline script，生产强nonce策略、完整渗透测试、真实输入法/软键盘和人工读屏仍须验收。
