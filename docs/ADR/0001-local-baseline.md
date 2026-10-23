# ADR 0001 — 本地纵向切片基线

日期：2026-10-23。状态：采用。

初始工作区只有用户提供的PRD、设计稿和工程种子，无Git和业务代码。保留全部原文件，在原目录初始化Git。按PRD业务规则优先；六页导航保持不变。

使用本机 Node 24.16.0 LTS；锁 Next 16.4.2、React 19.3.1、Prisma 7.10.1、Tailwind 4.3.3、Zod 4.6.7。其余依赖由npm save-exact和package-lock锁定。Prisma使用prisma-client生成器、自定义输出路径、PrismaPg驱动和prisma.config.ts。不会混用旧版本实例化API。PostgreSQL 17 Docker镜像锁digest。

核验来源：[Node LTS](https://nodejs.org/en/about/previous-releases)、[Next安装与Node要求](https://nextjs.org/docs/app/getting-started/installation)、[Prisma7客户端](https://www.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/introduction)、[Tailwind PostCSS](https://tailwindcss.com/docs/installation/using-postcss)、[shadcn手动安装](https://ui.shadcn.com/docs/installation/manual)。安装时另用npm registry核对精确版本。实际兼容性以本仓库typecheck/build/test结果为准。

只在127.0.0.1运行；本地setup生成独立随机会话secret，邀请码仅是本地试测参数。生产默认禁注册、禁未成年人、禁mock隐式回退。本地production build验收可显式ALLOW_MOCK_IN_PRODUCTION=true，始终显示演示数据，不能等价公开发布许可。

图片在封闭MVP存入PostgreSQL私有Bytes字段（STORAGE_DRIVER=database），通过鉴权代理读。理由：当前无私有对象存储账号；避免公开静态文件和遗留磁盘文件。后端魔数/MIME/解码校验，sharp移除EXIF并限制像素，100MiB/账号上限。正式扩容迁移到私有S3；本地替代有性能与备份体积代价，不能无界扩展。

原题和步骤分离，确认生成不可变Revision。题目识别在mock下明确不识图并让用户手填，不给图片捏造文字。数据库MutationKey和会话锁负责幂等；所有读取按owner过滤。训练标准答案只保留后端。

训练种子由工程原创并规则校验，尚无教师审核，界面保留演示边界；提供的8例也不是Gold Set。不对真实教育准确率作声明。删除记录先隐藏，账户全量清理通过可追踪申请；未完成物理清理/备份清除不声称彻底删除。未成年人准入在后端硬性拒绝，监护流程未实现。
