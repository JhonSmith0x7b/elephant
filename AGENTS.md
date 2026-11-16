# 大象 · 项目上下文

## 产品与范围
- RSS 信息流，分类可自行新增和改名。
- 本项目负责 RSS/Atom 导入、周期同步、文章存储和阅读。网页爬取与翻译由独立项目 any2rss 等上游负责，不在大象内恢复翻译模块。
- UI 延续报刊风格：默认白底黑字，图片保留原色；支持浅色、暗色、跟随系统。避免首页中央大图和右侧延伸阅读。

## 已确定的行为
- 优先阅读已保存的正文版本，同时保留原文跳转；详情支持封面、正文图片、可点击链接，正文末尾也可收藏。
- 正文版本用 `content_format` 区分 `legacy` 与经过清洗的 `html`；新富文本保留语义结构，前端只渲染白名单节点。旧版本不猜测 Markdown、不覆盖删除；重新同步可生成富文本新版本，保留文章 ID、来源关联、收藏和已读。
- 分类/来源选择写入 URL，文章返回后恢复原筛选。信息流首批 30 篇，触底追加；切换分类时直接应用新内容，停留当前分类时提示更新，避免阅读中跳动。
- 左侧标题刻度贴近视口左边（桌面约 12px），覆盖全部已加载文章并随追加增长；首刻度回到页顶。手机用紧凑标题导航。不要恢复跨次访问的阅读位置记忆；文章返回位置保留。
- 收藏和已读状态持久化。编辑来源保留 ID、文章、收藏、已读记录；删除来源为软删除，保留内容。文章链接用于跨源去重，同时保留来源关联及各来源的正文版本。
- 标题、摘要或正文含替换字符乱码时只跳过该条，其余正常条目照常保存；同步统计显示部分成功。修改来源 URL 后，进行中的旧地址请求不得写回内容或错误。
- 同步历史保留 30 天，页面展示最近 20 轮；“处理已有”不代表正文实际变更。历史不记录订阅 URL、token 或原始错误载荷。

## 开发与验证
- 登录 session 有效期为 365 天，通过认证 HTTP 接口续期 Cookie；服务端权限检查不续期，已过期会话须重新登录。
- 技术栈：Next.js App Router、React、TypeScript、PostgreSQL/Drizzle、Better Auth。以 package.json 和实际代码为准；入口见 src/components/reader-app.tsx，数据逻辑见 src/lib/library.ts，同步见 src/lib/sync.ts。
- 本地数据库：npm run db:up（127.0.0.1:55432）；开发：npm run dev:local（含 worker，使用 polling 避免 EMFILE）。配置见 README.md；不要输出或提交 .env、密码、Cookie、订阅 token。
- 根据改动运行 typecheck、相关测试和必要的构建；涉及数据保留/同步时使用 npm run test:db，测试必须使用隔离 schema。生产构建：npm run build -- --webpack。
- 独立并行能节省时间或提高质量时可主动委派子代理；否则自行完成。

## 隐私与部署
- 本仓库可公开：只保留通用项目规则和虚构示例，不写入个人偏好、账户、实际主机/域名/IP、网络标识及本机路径。
- 私人部署信息保存在 `.agents/private/`，该目录已被 Git 和 Docker 忽略；不得将其内容复制到提交、PR 或公开日志。
- 生产配置从服务器私有环境文件注入；部署流程见 `deploy/README.md`。
- 每日备份脚本和 systemd 单元见 `deploy/backup.sh`、`deploy/elephant-backup.*`，需在服务器安装启用；每日副本保留 30 天，部署备份不自动清理，异机备份尚未配置。
- 检查提交内容是否包含个人信息；忽略规则不会清除已跟踪文件或历史记录。

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
