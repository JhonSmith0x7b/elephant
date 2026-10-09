# 大象

私人资讯阅读 Web 项目。白底黑字、原色图片，按文学、二次元、时事或自定义分类组织信息流。使用 Next.js、PostgreSQL，支持本机运行和 Vercel 部署。

自有服务器部署使用 Docker Compose，GitHub Actions 在 `main` 推送后验证并部署；网页通过 Tailscale 私有 HTTPS 访问。详见 [服务器部署与 CI/CD](deploy/README.md)。公开仓库仅包含源代码，运行配置和阅读数据独立保存。

## 内容与阅读

- RSS 2.0 / Atom / RDF：粘贴订阅地址，预览、命名、选择分类后确认入库。
- 只保存来源提供的标题、摘要、正文、语言、作者、发布时间和图片地址。站内优先阅读已存内容，另有原站入口。
- 正文按不可变版本保存；相同内容重复刷新不会重复创建版本。只有摘要时明确标注，不把摘要当全文。
- 按规范化文章 URL 跨来源去重，并保留所有来源关联；无链接时才在来源内按 GUID 回退。旧文章链接在合并后仍能打开。
- 收藏、已读状态持久化。可新增分类、改名、调整来源分类。删除来源停止后续同步，保留已存文章及阅读状态；重新导入同一地址恢复订阅。
- 信息流先按分类、来源查询，再展示该范围最新 100 篇；收藏独立分页。分类、来源、布局记录在 URL，阅读后返回保留筛选。
- 当前标签页缓存最近打开的 20 个分类/来源列表，切回时先显示缓存。页面可见时每分钟、切换分类或重新获得焦点时检查已入库内容；有更新仅提示，点击后显示，已读和收藏即时更新。整页刷新或关闭标签页清空这层内存缓存，不影响数据库中保存的文章。
- 正文划词可跳转 Google AI Mode。默认只发送选中文字，用户可以选择附带标题和短上下文。

文章页面不区分原文与译文，不提供语言切换或翻译任务。上游提供什么内容，大象就收录什么内容。图片仍使用来源地址，没有下载图片存档；目前不补抓网页正文，也没有 OPML 导入或普通信息流历史分页。

## 周期同步

在页面右上角「管理来源」中设置：

- 开启或关闭自动同步。
- 选择间隔并保存：本机可选 15 分钟、30 分钟、1 小时、2 小时、6 小时、12 小时、24 小时。
- 查看上次执行结果、下次计划时间及后台最近检查时间。
- 「立即同步」刷新全部有效来源；单个来源的手动刷新仍然可用。

初始关闭，默认间隔 1 小时。设置保存在 PostgreSQL，首次开启或改变周期后从保存时间开始计时；关闭仅停止之后的周期任务。后台检查已到期的任务，不依赖浏览器保持打开。页面轮询只用于展示执行状态，不负责触发抓取。

同一轮同步通过数据库租约防止重复执行，异常退出后可以恢复。一个来源失败不影响其他来源，旧文章保留；已删除来源不会继续收录。同步沿用原有请求校验、去重和版本保存逻辑。

## 本机启动

需要 Node.js 22 或更新版本、npm 和运行中的 Docker。现有工作区已配置本地环境文件。

```sh
npm ci
npm run db:up
npm run db:migrate
npm run dev:local
```

打开 <http://127.0.0.1:3000>。`dev:local` 同时启动网页和后台同步进程，每分钟检查一次是否到期，适用于当前 macOS 文件监听环境。普通环境可使用 `npm run dev`。关闭这个进程或电脑休眠期间不能执行同步，恢复运行后会继续检查到期任务。

```sh
npm run build -- --webpack
npm start                    # 本机生产运行，同时启动同步进程
npm run sync:worker          # 仅启动后台同步；网页由其他方式运行时使用
npm run db:down              # 停止数据库，保留数据卷
```

不要使用 `docker compose down -v`，它会删除数据库卷。

## 新环境配置

1. 复制 `.env.example` 为 `.env.local`，填写 PostgreSQL 的 `DATABASE_URL`。
2. 本机 Docker 另需 `.env` 中的 `LOCAL_DB_PASSWORD`，与数据库 URL 中的密码一致。数据库只绑定 `127.0.0.1:55432`。
3. 执行 `npm run db:up`、`npm run db:migrate`。
4. 本机开发可设置 `LOCAL_DEV_AUTH_BYPASS=1`；只有非 Vercel 的 development 环境且环回地址才生效。
5. 生产环境填写 `BETTER_AUTH_URL`、随机的 `BETTER_AUTH_SECRET`、`ADMIN_EMAIL` 和初始化用 `ADMIN_PASSWORD`，执行 `npm run auth:setup`。随后移除运行环境中的 `ADMIN_PASSWORD`。生产环境要求管理员登录，公开注册关闭。

`.env` / `.env.local` 被忽略，不能提交或分享。当前本机代理使用 Fake-IP DNS，因此本机使用 `RSS_DNS_MODE=cloudflare`；普通网络与 Vercel 默认 `system`。两种方式均保留内网/保留地址校验。

本机测试自己提供的 RSS 时，可在 `.env.local` 设置 `RSS_LOCAL_FEED_HOSTS=localhost,127.0.0.1,::1` 并重启开发服务。随后可导入 `http://localhost:端口/feed` 等地址；局域网服务可追加确切的 IP 或域名（不写协议和端口）。仅开发环境生效，允许名单内的主机使用系统 DNS，并可访问回环、私有局域网地址；生产环境、Vercel 及未列入名单的地址继续执行公开地址校验，重定向也逐次校验。

## Vercel 部署与定时触发

Vercel 构建使用 Next.js Route Handlers；本机常驻 worker 不会在 Vercel 部署中启动，由 Cron 请求 `/api/cron/sync` 唤醒相同的同步逻辑。

1. 准备独立 PostgreSQL，本机 Docker 地址不能供 Vercel 使用；执行数据库迁移和管理员初始化。
2. 配置 `DATABASE_URL`、`BETTER_AUTH_SECRET`、`BETTER_AUTH_URL`、`ADMIN_EMAIL`。
3. 另配置随机的 `CRON_SECRET`。定时接口要求 `Authorization: Bearer <CRON_SECRET>`，未配置或不匹配会拒绝请求。Vercel 会使用此环境变量发送鉴权头。
4. 导入仓库并部署，再从页面开启周期同步。这是可选方案；自有服务器方案使用常驻 worker，不受 Vercel Cron 限制。

仓库自带的 `vercel.json` 每日 UTC 00:00 唤醒一次，以兼容 Hobby；Vercel 环境默认只允许选择 24 小时周期。Hobby 不支持小时级 Cron，且每日调用时间有小时级偏差；这是平台限制，页面配置不能提高底层触发频率。

如果之后使用 Pro / Enterprise，可把 `vercel.json` 的 schedule 改为 `*/5 * * * *`，同时设置 `SYNC_TRIGGER_INTERVAL_MINUTES=5` 并重新部署。页面随后可以选择 15 分钟及以上的同步周期，日常改周期只需在页面保存。环境变量必须与实际触发间隔保持一致。

参考：[Vercel Cron 限制](https://vercel.com/docs/cron-jobs/usage-and-pricing)、[Cron 管理和鉴权](https://vercel.com/docs/cron-jobs/manage-cron-jobs)。

## 数据结构与接口

| 表 | 用途 |
| --- | --- |
| `channels` | 分类名称与稳定 ID |
| `sources` | 订阅地址、分类、最近同步时间/错误；`deleted_at` 标记取消订阅 |
| `articles` | 原始文章信息、去重标识、当前内容版本指针 |
| `article_sources` | 文章与多个订阅源的关联 |
| `article_aliases` | 合并前的文章 ID 到保留文章的映射 |
| `article_versions` | 不可变内容版本、内容哈希、语言、保存时间 |
| `article_bookmarks` / `article_reads` | 收藏、阅读状态 |
| `preview_records` | 有效期 20 分钟的导入预览 |
| `sync_settings` | 全局同步设置、执行租约、计划时间与最近结果 |
| Better Auth 表 | 管理员与会话 |

| 接口 | 用途 |
| --- | --- |
| `GET /api/library?channel=...&source=...` | 分类、有效来源、全局/筛选计数和该范围最新 100 篇文章 |
| `POST /api/feeds/preview` / `POST /api/feeds` | 预览、确认导入 |
| `POST /api/feeds/:id/refresh` | 手动刷新一个来源 |
| `PATCH /api/feeds/:id` / `DELETE /api/feeds/:id` | 调整来源分类、删除订阅 |
| `GET /api/sync` / `PUT /api/sync` | 查询、保存周期同步设置 |
| `POST /api/sync/run` | 管理员立即执行全量同步 |
| `GET /api/cron/sync` | 密钥保护的后台到期任务入口 |
| `POST /api/channels` / `PATCH /api/channels/:id` | 新增、重命名分类 |
| `GET /api/bookmarks?cursor=...` | 收藏分页 |
| `PUT /api/articles/:id/bookmark` / `PUT /api/articles/:id/read` | 收藏与已读状态 |

写入页面接口检查管理员会话和请求来源。RSS 单次下载上限 15 秒、2 MB、3 次跳转、150 篇；逐跳检查 DNS 并固定经过验证的公网连接地址。源站安全验证页会明确报错。只显示提取后的纯文本，不执行抓取的 HTML。

## 已有数据升级

升级前建议备份数据库，再执行 `npm run db:migrate`。旧的 `article_translations` 表会改名为 `retired_article_translations`，解除与活跃版本表的外键关联，作为历史备份保留；运行代码不再读取它，新安装不会创建它。原始内容、版本、收藏、已读和旧链接保持不变，不会把旧译文覆盖到来源正文中。

## 验证

```sh
npm run typecheck
npm run test:db
npm run build -- --webpack
```

数据库测试只使用各自创建的随机 schema，不修改实际阅读数据。覆盖导入、跨来源去重、内容版本、来源删除、分类筛选、收藏/阅读状态、旧数据迁移与周期同步行为。
