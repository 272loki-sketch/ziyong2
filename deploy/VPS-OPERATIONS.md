# Liyuan VPS 部署与运维

本文档只保留通用流程与模板占位符，不保存现网公网 IP、端口、用户名、密码、私钥路径、上游接口或其他真实凭据。

## 1. 占位符说明

以下占位符需要按实际环境替换：

| 占位符 | 说明 |
|---|---|
| `<PUBLIC_HOST_OR_IP>` | 对外访问的域名或公网 IP |
| `<PUBLIC_HTTPS_PORT>` | Nginx 对外 HTTPS 端口 |
| `<SSH_USER>` | SSH 登录用户 |
| `<SSH_PORT>` | SSH 端口 |
| `<SSH_PRIVATE_KEY_PATH>` | SSH 私钥文件路径 |
| `<APP_ROOT>` | 应用源码目录 |
| `<APP_NAME>` | 应用或站点名称 |
| `<APP_SERVICE_NAME>` | systemd 服务名 |
| `<APP_RUNTIME_USER>` | systemd 运行用户 |
| `<APP_RUNTIME_GROUP>` | systemd 运行组 |
| `<NODE_BIN>` | Node 可执行文件绝对路径 |
| `<AGENT_DATA_DIR>` | Agent 运行数据目录 |
| `<APP_UPSTREAM_HOST>` | Nginx 反代上游主机 |
| `<APP_UPSTREAM_PORT>` | Nginx 反代上游端口 |
| `<HEALTHCHECK_PATH>` | 应用健康检查路径 |
| `<MODEL_BASE_URL>` | 上游模型接口 |
| `<MODEL_ID>` | 上游模型 ID |
| `<WEB_RESEARCH_PROXY_URL>` | 联网查证代理地址 |
| `<BASIC_AUTH_USER>` | Nginx Basic Auth 用户名 |
| `<BASIC_AUTH_PASSWORD>` | Nginx Basic Auth 密码 |
| `<BASIC_AUTH_REALM>` | Nginx Basic Auth 提示文案 |

## 2. 环境信息

| 项目 | 值 |
|---|---|
| VPS | `<PUBLIC_HOST_OR_IP>` |
| SSH 用户 | `<SSH_USER>` |
| SSH 端口 | `<SSH_PORT>` |
| SSH 私钥 | `<SSH_PRIVATE_KEY_PATH>` |
| 操作系统 | Alibaba Cloud Linux 8（按实际环境调整） |
| Node.js | `<NODE_BIN>` |
| 服务管理 | systemd `<APP_SERVICE_NAME>.service` |
| 源码目录 | `<APP_ROOT>` |
| Agent 数据目录 | `<AGENT_DATA_DIR>` |
| 应用内部端口 | `http://<APP_UPSTREAM_HOST>:<APP_UPSTREAM_PORT>`（仅内网或本机回环） |
| 公网入口 | `https://<PUBLIC_HOST_OR_IP>:<PUBLIC_HTTPS_PORT>` |
| 上游模型接口 | `<MODEL_BASE_URL>` |
| 上游模型 | `<MODEL_ID>` |
| 搜索代理 | `<WEB_RESEARCH_PROXY_URL>`（仅联网查证使用） |

## 3. SSH 连接

Windows PowerShell 示例：

```powershell
ssh -i "<SSH_PRIVATE_KEY_PATH>" -p <SSH_PORT> <SSH_USER>@<PUBLIC_HOST_OR_IP>
```

注意事项：

- 不要把私钥内容、API key、Basic Auth 密码写入代码、日志或文档提交记录。
- 服务器上下载东西慢时，可按实际环境使用代理，例如：

```bash
curl -x <WEB_RESEARCH_PROXY_URL> -fsSL https://nodejs.org/dist/...
```

## 4. 部署结构

```text
<APP_ROOT>/
├── server/                 Node 服务端
├── src/                    领域层
├── web/dist/               预构建前端
├── node_modules/           生产依赖
├── skills/                 内置 Skill
├── .liyuan-stage-skills/   用户在面板编辑过的 Skill 覆盖（gitignore）
├── liyuan.config.json      项目配置
├── liyuan.agent.json       模型配置（含 API key，权限 600）
└── deploy/
    ├── nginx-8788.conf     Nginx 8788 HTTPS 虚拟主机模板（server 片段）
    └── VPS-OPERATIONS.md   本文档

<AGENT_DATA_DIR>            会话、模型缓存、认证等运行时数据
<NGINX_SERVER_FRAGMENT_PATH>  实际生效的 Nginx server 片段
<HTPASSWD_PATH>             Basic Auth 凭据文件
<TLS_CERT_DIR>/             证书目录
```

## 5. 访问方式与 Nginx

### 5.1 公网访问

```text
https://<PUBLIC_HOST_OR_IP>:<PUBLIC_HTTPS_PORT>
```

Nginx 层可配置 Basic Auth：

| 项目 | 值 |
|---|---|
| 账号 | `<BASIC_AUTH_USER>` |
| 密码 | `<BASIC_AUTH_PASSWORD>` |

修改 Basic Auth 凭据：

```bash
htpasswd -cb <HTPASSWD_PATH> <BASIC_AUTH_USER> <BASIC_AUTH_PASSWORD>
chown root:www <HTPASSWD_PATH>
chmod 640 <HTPASSWD_PATH>
/etc/init.d/nginx reload
```

如果 `htpasswd` 不可用，先安装：`dnf install -y httpd-tools`。

浏览器访问自签证书会提示风险，需要手动继续访问。若使用自签证书，请确保 SAN 与 `<PUBLIC_HOST_OR_IP>` 一致。

建议在应用网页“设置”里再配置一层应用访问密码，避免仅依赖 Nginx Basic Auth。

### 5.2 `$connection_upgrade` 前置要求

`deploy/nginx-8788.conf` 保持 **server 片段** 模式，不应把 `http {}` 直接写进该文件。

在主 `nginx.conf` 的 `http {}` 上下文中，先定义一次 `map`，再 `include` 站点 `server` 片段：

```nginx
http {
    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      close;
    }

    include /www/server/panel/vhost/nginx/*.conf;
}
```

说明：

- 如果主配置里已经有同名 `map`，不要重复定义。
- `deploy/nginx-8788.conf` 只负责 `server {}` 内容。
- 修改主配置或站点片段后，先验证，再重载：

```bash
nginx -t && /etc/init.d/nginx reload
```

### 5.3 证书与模板路径

- `deploy/nginx-8788.conf` 中的 `server_name`、证书路径、日志路径已改为占位符。
- 使用前请按现网替换 `server_name`、`ssl_certificate`、`ssl_certificate_key`、`auth_basic_user_file`、`access_log`、`error_log`。

## 6. 服务管理

```bash
# 查看状态
systemctl status <APP_SERVICE_NAME>

# 查看日志
journalctl -u <APP_SERVICE_NAME> -n 100 --no-pager
journalctl -u <APP_SERVICE_NAME> --since "-10 minutes" --no-pager

# 重启
systemctl restart <APP_SERVICE_NAME>

# 启动 / 停止
systemctl start <APP_SERVICE_NAME>
systemctl stop <APP_SERVICE_NAME>

# 开机自启
systemctl enable <APP_SERVICE_NAME>
systemctl disable <APP_SERVICE_NAME>
```

服务单元位置：`/etc/systemd/system/<APP_SERVICE_NAME>.service`

```ini
[Service]
Type=simple
User=<APP_RUNTIME_USER>
Group=<APP_RUNTIME_GROUP>
WorkingDirectory=<APP_ROOT>
Environment=NODE_ENV=production
Environment=HOST=<APP_UPSTREAM_HOST>
Environment=PORT=<APP_UPSTREAM_PORT>
Environment=LIYUAN_CODING_AGENT_DIR=<AGENT_DATA_DIR>
Environment=LIYUAN_WEB_RESEARCH_PROXY=<WEB_RESEARCH_PROXY_URL>
Environment=NO_PROXY=localhost,127.0.0.1
ExecStart=<NODE_BIN> server/main.ts
Restart=always
RestartSec=5
```

## 7. 健康检查

```bash
# 本机直连（跳过 Nginx）
curl -fsS http://<APP_UPSTREAM_HOST>:<APP_UPSTREAM_PORT><HEALTHCHECK_PATH>

# 通过公网入口
curl -k -u '<BASIC_AUTH_USER>:<BASIC_AUTH_PASSWORD>' -sS https://<PUBLIC_HOST_OR_IP>:<PUBLIC_HTTPS_PORT><HEALTHCHECK_PATH>
```

如果项目没有独立健康检查接口，请把 `<HEALTHCHECK_PATH>` 替换为已确认存在的只读接口。

## 8. 模型配置

生产模型配置位于 `<APP_ROOT>/liyuan.agent.json`（权限 `600`）：

```json
{
  "providers": {
    "primary": {
      "baseUrl": "<MODEL_BASE_URL>",
      "api": "openai-completions",
      "apiKey": "<API_KEY>",
      "models": [{
        "id": "<MODEL_ID>",
        "reasoning": false,
        "contextWindow": 410000,
        "maxTokens": 131072
      }]
    }
  },
  "defaultProvider": "primary",
  "defaultModel": "<MODEL_ID>"
}
```

修改后重启服务：

```bash
systemctl restart <APP_SERVICE_NAME>
```

也可以在网页“连接”面板里修改，即时生效。

## 9. 证书

如使用自签或自管证书，请按实际路径填写：

```text
证书：<TLS_CERT_DIR>/fullchain.pem
私钥：<TLS_CERT_DIR>/privkey.pem
SAN：<PUBLIC_HOST_OR_IP>
有效期：<CERT_VALID_FROM> 至 <CERT_VALID_TO>
```

Nginx 8788 虚拟主机配置：

```text
<NGINX_SERVER_FRAGMENT_PATH>
```

修改证书或 Nginx 配置后：

```bash
nginx -t && /etc/init.d/nginx reload
```

## 10. 联网查证与代理

只有 `web_research` 真正发起外部搜索请求时才使用代理。模型调用与其他本地流程不应默认复用该代理，除非你已明确这样配置。

```text
LIYUAN_WEB_RESEARCH_PROXY=<WEB_RESEARCH_PROXY_URL>
NO_PROXY=localhost,127.0.0.1
```

- 默认是否走代理，以当前服务环境变量为准。
- 设置 `LIYUAN_WEB_RESEARCH_PROXY=direct` 可改为直连。
- 无公开作品出处的私人角色名会在发网前被拒绝。

修改代理需编辑 `/etc/systemd/system/<APP_SERVICE_NAME>.service` 的 `Environment` 并重启。

## 11. 数据与备份

需要备份的内容：

```text
<APP_ROOT>/liyuan.config.json      项目配置
<APP_ROOT>/liyuan.agent.json       模型配置（含 key）
<APP_ROOT>/.liyuan-*/              运行时数据
<APP_ROOT>/.liyuan-stage-skills/   Skill 用户覆盖
<APP_ROOT>/skills/                 内置 Skill
<AGENT_DATA_DIR>                   会话、认证、模型缓存
<APP_ROOT>/assets/cards            用户导入的角色卡
<APP_ROOT>/assets/lorebooks        用户挂载的世界书
```

一键备份示例：

```bash
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p <BACKUP_ROOT>/$TS
cp -a <APP_ROOT>/liyuan.config.json <APP_ROOT>/liyuan.agent.json <BACKUP_ROOT>/$TS/
tar -czf <BACKUP_ROOT>/$TS/agent-data.tgz -C <AGENT_DATA_DIR_PARENT> $(basename <AGENT_DATA_DIR>)
```

## 11.1 研究搜索自动任务

普通研究搜索与小说消化的自动选书是两条独立任务。研究搜索读取 `liyuan.config.json` 的 `researchSearchSchedule`，按服务器本地时间每日运行；研究搜索页的“自动搜索主题”按钮可立即运行同一主题列表。任务状态保存在 `.liyuan/outline/research/search-schedule.json`，可用以下接口检查：

```bash
curl -fsS http://<APP_UPSTREAM_HOST>:<APP_UPSTREAM_PORT>/api/outline/research/search/schedule
curl -fsS -X POST http://<APP_UPSTREAM_HOST>:<APP_UPSTREAM_PORT>/api/outline/research/search/schedule/run
```

默认配置关闭自动任务。开启后建议限制 `maxPerRun` 和主题数量。任务共用运行锁，同日定时任务只执行一次；单个主题失败会记录错误并继续其他主题。

## 12. 更新部署

当前 VPS 如使用本地双分支维护，可按以下约定：

```text
origin/main  官方 GitHub 上游
main         官方基线，只跟踪 origin/main
local        VPS 实际运行版本（官方 + 本地增强）
```

正常更新：

```bash
cd <APP_ROOT>
./scripts/update-local.sh
```

脚本应先备份 Git、配置、世界/生态数据、Skill 覆盖和会话树，再把 `origin/main` 合并到 `local`；完整测试和前端构建通过后才重启服务并执行 HTTP 健康检查。它不应自动向 GitHub 推送代码。

执行前要求：

1. 没有正在进行的生成。
2. 当前分支是 `local`。
3. `git status --short` 没有输出。

冲突或失败语义：

- 合并冲突：立即停止，服务不重启；解决后继续，或执行 `git merge --abort`。
- 测试或构建失败：不重启服务，保留现场和更新前备份供修复。
- 工作区不干净：拒绝运行，不自动 stash，不丢弃改动。

用户配置和运行数据应被 `.gitignore` 排除，不参与代码合并；脚本仍可在每次更新前另行备份。完整说明、手工冲突处理和恢复步骤见 `docs/LOCAL-UPSTREAM-UPDATES.md`。

## 13. 故障排查

### 服务起不来

```bash
systemctl status <APP_SERVICE_NAME>
journalctl -u <APP_SERVICE_NAME> -n 100 --no-pager
```

常见原因：

- `liyuan.agent.json` 权限过宽或 JSON 非法：`chmod 600 <APP_ROOT>/liyuan.agent.json`、`node -e "JSON.parse(require('fs').readFileSync('<APP_ROOT>/liyuan.agent.json','utf8'))"`
- 端口被占：`ss -lntp | grep :<APP_UPSTREAM_PORT>`

### 外部访问 401

- 确认 Basic Auth 凭据正确。
- 确认 htpasswd 文件权限：`chown root:www <HTPASSWD_PATH> && chmod 640 <HTPASSWD_PATH>`

### 外部访问 502/504

- 确认 `<APP_SERVICE_NAME>` 在运行。
- 确认 `curl -fsS http://<APP_UPSTREAM_HOST>:<APP_UPSTREAM_PORT>/` 正常。
- 查看 Nginx 错误日志：`tail -n 100 /www/wwwlogs/<APP_NAME>-8788.error.log`
- 若出现 `unknown "connection_upgrade" variable`，说明主 `nginx.conf` 的 `http {}` 中未定义上文的 `map`。

### 联网查证失败

- 确认代理可用：`curl -x <WEB_RESEARCH_PROXY_URL> -fsSL https://duckduckgo.com`
- 检查服务环境变量：`systemctl show <APP_SERVICE_NAME> | grep Environment`

### 模型生成失败

- 确认 `liyuan.agent.json` 里的接口、key、模型名正确。
- 在网页“连接”面板测试连接。
- 查看服务日志是否有 provider 错误。

### 小说研究长时间不完成

```bash
curl -fsS http://<APP_UPSTREAM_HOST>:<APP_UPSTREAM_PORT>/api/outline/corpus
journalctl -u <APP_SERVICE_NAME> --since "30 minutes ago" --no-pager | grep -E "\[corpus\]|最终消息无文本|模型调用错误|结构化素材部分降级"
```

重点检查：

- `running` 是否为空；文档是否停在 `mapping`、`reducing` 或 `extracting`。
- `liyuan.config.json` 的 `stepModels.novelDigest` 是否为已验证模型。
- `最终消息无文本` 常表示 provider 返回空 `content` 或最终消息未从 `stream.result()` 读取。
- 当前 Corpus 单次调用最多 4 次、硬超时 60 秒；研究旁路不叠加 SDK 的隐式重试。增强提炼失败会降级为 ready。
- 详细根因和修复记录见 `docs/INCIDENT-20260901-NOVEL-DIGEST.md`。

## 14. 回滚

保留旧源码的备份目录 `<BACKUP_ROOT>/<TIMESTAMP>`：

```bash
cd /
systemctl stop <APP_SERVICE_NAME>
cp -a <APP_ROOT> <APP_ROOT>-prev-failed
cp -a <BACKUP_ROOT>/<TIMESTAMP>/. <APP_ROOT>/
chown -R <APP_RUNTIME_USER>:<APP_RUNTIME_GROUP> <APP_ROOT>
systemctl start <APP_SERVICE_NAME>
```

数据（`<AGENT_DATA_DIR>`、`<APP_ROOT>/.liyuan-*`）默认不回滚，保留最新状态；如需一并回退，从对应备份恢复。

## 15. 相关文档

```text
README.md
/docs/LOCAL-UPSTREAM-UPDATES.md
/docs/STANDALONE-INTEGRATION-BASELINE.md
/deploy/README.md
/deploy/VPS-OPERATIONS.md
```

## 研究搜索结果异常

研究搜索返回 0 条时，先检查 `GET /api/outline/research/search/schedule` 和服务日志，不要把搜索引擎原始页面直接导入素材库。当前系统会拒绝低相关结果；DuckDuckGo 人机验证或 Bing 兜底异常时，空结果是保护行为。查看完整根因、实战结果和清理范围：[`docs/INCIDENT-20260901-RESEARCH-SEARCH.md`](../docs/INCIDENT-20260901-RESEARCH-SEARCH.md)。
