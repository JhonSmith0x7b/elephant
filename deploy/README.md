# 自有服务器与自动部署

运行环境：Linux ARM64、Docker Engine / Compose、Git、curl、flock、Tailscale。应用镜像使用 Node.js 24，web 和 worker 分开运行，PostgreSQL 17 使用独立持久卷。

## 自动部署流程

推送到 `main` 后，GitHub Actions 在 ARM64 runner 上执行依赖安装、类型检查、全部数据库测试和生产构建。通过后，`production` 环境的专用 SSH 密钥调用服务器上的固定部署脚本。

服务器只接受 `deploy <commit SHA>`，并确认 SHA 是远端 `main` 的最新提交。随后构建该提交的镜像，停止写入服务、备份数据库、运行迁移、启动 web / worker，检查 HTTP 健康状态及新 worker 的心跳，最后记录当前版本。构建期间旧版继续服务，迁移和切换期间有短暂停机。

Pull request 仅运行验证，不接触生产凭据。SSH 密钥禁止端口转发、PTY 和任意命令；固定入口由 root 持有。工作流中的服务器地址、用户名、私钥与 SSH 主机公钥均放在 GitHub Environment Secrets 中。

| Secret | 用途 |
| --- | --- |
| `DEPLOY_HOST` | GitHub runner 可达的 SSH 地址 |
| `DEPLOY_USER` | 配有受限授权公钥的 SSH 用户 |
| `DEPLOY_SSH_KEY` | 此项目专用私钥 |
| `DEPLOY_KNOWN_HOSTS` | 经可信连接核对的主机公钥；不在运行时盲目扫描信任 |

`production` 环境仅允许 `main` 分支部署。工作流支持手动重新运行。

## 服务器文件

```text
/opt/elephant/
  runtime.env              # 生产配置，root 0600
  bin/deploy.sh            # 固定部署入口，root 0700
  repository/             # 公开仓库的专用 checkout
  releases/<SHA>/compose.yaml
  backups/<time>-<SHA>.dump
  current-revision
```

`runtime.env` 包含 `POSTGRES_PASSWORD`、`DATABASE_URL`（主机名 postgres）、`BETTER_AUTH_URL`、`BETTER_AUTH_SECRET`、`ADMIN_EMAIL`。不得放入 Git。生产容器不启用本地开发免登录。

首次初始化时，可临时创建 root 0600 的 `/opt/elephant/bootstrap.env`，仅含 `ADMIN_PASSWORD`（至少 12 位）。部署脚本创建管理员后删除该文件。已有管理员不会被重置密码；应用日常运行不持有初始化密码。

首次安装需将 `deploy/deploy.sh` 安装到固定入口，并初始化 `repository` 的 origin。后续修改固定部署脚本本身时，需要通过管理 SSH 显式更新服务器入口；一般应用、Compose、迁移修改会随每次部署更新。

## 私有访问与同步

网页仅绑定服务器 `127.0.0.1:3100`；数据库没有宿主机公开端口。通过 Tailscale Serve 为这个本地端口提供私有 HTTPS，例如：

```sh
sudo tailscale serve --bg --https=10000 http://127.0.0.1:3100
```

`BETTER_AUTH_URL` 必须与实际 Tailscale HTTPS 访问地址（含端口）一致。不要为这个入口启用 Funnel；它应该只在 tailnet 内可访问。新增配置时保留机器上其他服务已有的 Serve / Funnel 设置。

同步 worker 随容器启动，每分钟检查页面中保存的计划。关闭浏览器或本机电脑不影响服务器同步。默认自动同步关闭，可在「管理来源」中开启。容器设置自动重启，服务器重启后由 Docker 恢复。

## 备份与故障恢复

每次更新前备份 PostgreSQL；数据库卷不会因重新构建或替换应用容器而删除。旧镜像和发布配置保留。部署失败会尝试恢复上一版应用容器，数据库不会自动回写旧备份，因此自动回滚仅适用于向后兼容的迁移。涉及破坏性迁移时应另外安排恢复方案。

如需要恢复数据库，先停止 web / worker，再核对备份并手动执行 `pg_restore`。不要运行 `docker compose down -v`。备份与旧镜像目前没有自动清理或异地复制，需要按磁盘占用自行管理。

排查时可通过管理员 SSH 检查：

```sh
sudo cat /opt/elephant/current-revision
sudo docker ps --filter name=elephant
sudo docker logs --tail 100 elephant-web-1
sudo docker logs --tail 100 elephant-worker-1
curl -f http://127.0.0.1:3100/api/health
tailscale serve status
```

健康接口只返回通用状态；文章、设置等接口仍需要管理员登录。

## 同机 RSS 服务

当前应用容器接入已有 `any2rss_default` 网络（可用 `RSS_DOCKER_NETWORK` 指定），web 和 worker 的 `RSS_LOCAL_FEED_HOSTS` 默认只允许 `any2rss-web-1`。订阅地址使用 `http://any2rss-web-1:8000/订阅路径`，无需公开宿主 8200 端口。重新部署自动恢复连接。部署到其他机器时需配置实际 RSS 网络和主机名。
