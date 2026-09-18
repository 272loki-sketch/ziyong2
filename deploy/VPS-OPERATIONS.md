# Liyuan VPS 部署与运维

本文档记录 Liyuan 在 VPS 上的生产部署信息、连接方式、服务管理、更新步骤和故障排查。

## 1. 环境信息

| 项目 | 值 |
|---|---|
| VPS | `47.98.210.60` |
| SSH 用户 | `root` |
| SSH 端口 | `44272` |
| SSH 私钥 | `C:\Users\86186\Downloads\miyao\47.98.210.60_id_ed25519` |
| 操作系统 | Alibaba Cloud Linux 8（kernel 5.10） |
| Node.js | `/opt/node22/bin/node`（v22.23.2，独立安装，不依赖系统 npm） |
| 服务管理 | systemd `liyuan.service` |
| 源码目录 | `/root/Liyuan` |
| Agent 数据目录 | `/var/lib/liyuan/agent` |
| 应用内部端口 | `127.0.0.1:7620`（仅本机回环，不暴露公网） |
| 公网入口 | `https://47.98.210.60:8788`（Nginx + 自签证书） |
| 上游模型接口 | `https://new.00272.icu/v1` |
| 上游模型 | `deepseek-v4-flash` |
| 搜索代理 | `http://127.0.0.1:7890`（VPS 宿主机 mihomo，仅联网查证使用） |

## 2. SSH 连接

Windows PowerShell 示例：

```powershell
ssh -i "C:\Users\86186\Downloads\miyao\47.98.210.60_id_ed25519" -p 44272 root@47.98.210.60
```

注意事项：

- 不要把私钥内容、API key、Basic Auth 密码写入代码、日志或文档提交记录。
- VPS 上下载东西慢时，使用宿主机 `7890` 代理，例如：

```bash
curl -x http://127.0.0.1:7890 -fsSL https://nodejs.org/dist/...
```

## 3. 部署结构

```text
/root/Liyuan/
├── server/                 Node 服务端
├── src/                    领域层
├── web/dist/               预构建前端
├── node_modules/           生产依赖
├── skills/                 内置文学工作流 Skill（随 GitHub 更新）
├── .liyuan-stage-skills/   用户在面板编辑过的 Skill 覆盖（gitignore）
├── liyuan.config.json      项目配置（角色卡/世界书/文学增强等）
├── liyuan.agent.json       模型配置（含 API key，权限 600）
└── deploy/
    ├── nginx-8788.conf     Nginx 8788 HTTPS 虚拟主机模板
    └── VPS-OPERATIONS.md   本文档

/var/lib/liyuan/agent       会话、模型缓存、认证等运行时数据
/opt/node22                 独立安装的 Node.js 22
/www/server/panel/vhost/nginx/liyuan-8788.conf  实际生效的 Nginx 配置
/www/server/nginx/conf/htpasswd/liyuan-8788      Basic Auth 凭据文件
/www/server/panel/vhost/cert/47.98.210.60/       自签证书（与 Luker 共用）
```

## 4. 访问方式

```text
https://47.98.210.60:8788
```

Nginx 层配置了 Basic Auth：

| 项目 | 值 |
|---|---|
| 账号 | `00272` |
| 密码 | `z123000**` |

修改 Basic Auth 凭据：

```bash
htpasswd -cb /www/server/nginx/conf/htpasswd/liyuan-8788 <账号> <密码>
chown root:www /www/server/nginx/conf/htpasswd/liyuan-8788
chmod 640 /www/server/nginx/conf/htpasswd/liyuan-8788
/etc/init.d/nginx reload
```

如果 `htpasswd` 不可用，先安装：`dnf install -y httpd-tools`。

浏览器访问自签证书会提示风险，需要手动继续访问。证书 SAN 已包含 `47.98.210.60`。

建议在 Liyuan 网页“设置”里再配置一层应用访问密码，避免仅依赖 Nginx Basic Auth。

## 5. 服务管理

```bash
# 查看状态
systemctl status liyuan

# 查看日志
journalctl -u liyuan -n 100 --no-pager
journalctl -u liyuan --since "-10 minutes" --no-pager

# 重启
systemctl restart liyuan

# 启动 / 停止
systemctl start liyuan
systemctl stop liyuan

# 开机自启
systemctl enable liyuan
systemctl disable liyuan
```

服务单元位置：`/etc/systemd/system/liyuan.service`

```ini
[Service]
Type=simple
User=liyuan
Group=liyuan
WorkingDirectory=/root/Liyuan
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=7620
Environment=LIYUAN_CODING_AGENT_DIR=/var/lib/liyuan/agent
Environment=LIYUAN_WEB_RESEARCH_PROXY=http://127.0.0.1:7890
Environment=NO_PROXY=localhost,127.0.0.1
ExecStart=/opt/node22/bin/node server/main.ts
Restart=always
RestartSec=5
```

## 6. 健康检查

```bash
# 本机直连（跳过 Nginx）
curl -fsS http://127.0.0.1:7620/healthz

# 通过公网入口
curl -k -u '00272:z123000**' -sS https://127.0.0.1:8788/healthz
```

正常返回：

```json
{"ok":true,"sessionId":"...","char":"青梧"}
```

## 7. 模型配置

生产模型配置位于 `/root/Liyuan/liyuan.agent.json`（权限 `600`），内容迁移自 Luker Pi 工作流：

```json
{
  "providers": {
    "luker-pi": {
      "baseUrl": "https://new.00272.icu/v1",
      "api": "openai-completions",
      "apiKey": "…",
      "models": [{
        "id": "deepseek-v4-flash",
        "reasoning": false,
        "contextWindow": 410000,
        "maxTokens": 131072
      }]
    }
  },
  "defaultProvider": "luker-pi",
  "defaultModel": "deepseek-v4-flash"
}
```

修改后重启服务：

```bash
systemctl restart liyuan
```

也可以在网页“连接”面板里修改，即时生效。

## 8. 证书

Liyuan 复用了 Luker 的自签证书：

```text
证书：/www/server/panel/vhost/cert/47.98.210.60/fullchain.pem
私钥：/www/server/panel/vhost/cert/47.98.210.60/privkey.pem
SAN：47.98.210.60
有效期：2026-02-25 至 2027-02-25
```

Nginx 8788 虚拟主机配置：

```text
/www/server/panel/vhost/nginx/liyuan-8788.conf
```

修改证书或 Nginx 配置后：

```bash
nginx -t && /etc/init.d/nginx reload
```

## 9. 联网查证与代理

只有 `web_research`（按需联网查证工具）真正发起外部搜索请求时才使用代理，模型调用、文学画像、场记、压缩、预设分拣都不走该代理。

```text
LIYUAN_WEB_RESEARCH_PROXY=http://127.0.0.1:7890
NO_PROXY=localhost,127.0.0.1
```

- 默认代理是宿主机 mihomo 的 `7890` 端口。
- 设置 `LIYUAN_WEB_RESEARCH_PROXY=direct` 可改为直连。
- 无公开作品出处的私人角色名会在发网前被拒绝。

修改代理需编辑 `/etc/systemd/system/liyuan.service` 的 `Environment` 并重启。

## 10. 数据与备份

需要备份的内容：

```text
/root/Liyuan/liyuan.config.json      项目配置
/root/Liyuan/liyuan.agent.json       模型配置（含 key）
/root/Liyuan/.liyuan-*/              运行时数据
/root/Liyuan/.liyuan-stage-skills/   Skill 用户覆盖（编辑过的，别丢）
/root/Liyuan/skills/                 内置 Skill（随仓库，可再拉回）
/var/lib/liyuan/agent                会话、认证、模型缓存
/root/Liyuan/assets/cards            用户导入的角色卡
/root/Liyuan/assets/lorebooks        用户挂载的世界书
```

一键备份示例：

```bash
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p /root/Liyuan-backups/$TS
cp -a /root/Liyuan/liyuan.config.json /root/Liyuan/liyuan.agent.json /root/Liyuan-backups/$TS/
tar -czf /root/Liyuan-backups/$TS/agent-data.tgz -C /var/lib/liyuan agent
```

## 10.1 研究搜索自动任务

普通研究搜索与小说消化的自动选书是两条独立任务：研究搜索读取 `liyuan.config.json` 的 `researchSearchSchedule`，按 VPS 本地时间每日运行；导演室研究搜索页的“自动搜索主题”按钮可立即运行同一主题列表。任务状态保存在 `.liyuan/outline/research/search-schedule.json`，可用以下接口检查：

```bash
curl -fsS http://127.0.0.1:7620/api/outline/research/search/schedule
curl -fsS -X POST http://127.0.0.1:7620/api/outline/research/search/schedule/run
```

默认配置关闭自动任务；开启后建议限制 `maxPerRun` 和主题数量。任务共用运行锁，同日定时任务只执行一次；单个主题失败会记录错误并继续其他主题。

## 11. 更新部署

当前 VPS 使用本地双分支维护，不再通过 tar 覆盖整个源码目录：

```text
origin/master  官方 GitHub 上游
master         官方基线，只跟踪 origin/master
local          VPS 实际运行版本（官方 + 本地增强）
```

正常更新只需：

```bash
cd /root/Liyuan
./scripts/update-local.sh
```

脚本会先备份 Git、配置、世界/生态数据、Skill 覆盖和会话树，再把 `origin/master` 合并到 `local`；完整测试和前端构建通过后才重启服务并执行 HTTP 健康检查。它不会向 GitHub 推送代码。

执行前要求：

1. 没有正在进行的生成。
2. 当前分支是 `local`。
3. `git status --short` 没有输出。

冲突或失败语义：

- 合并冲突：立即停止，服务不重启；可解决冲突后继续，或执行 `git merge --abort`。
- 测试/构建失败：不重启服务，保留现场和更新前备份供修复。
- 工作区不干净：拒绝运行，不自动 stash、不丢弃改动。

用户配置和运行数据均被 `.gitignore` 排除，不参与代码合并；脚本仍会在每次更新前另行备份。完整说明、手工冲突处理和恢复步骤见 `docs/LOCAL-UPSTREAM-UPDATES.md`。

## 12. 故障排查

### 服务起不来

```bash
systemctl status liyuan
journalctl -u liyuan -n 100 --no-pager
```

常见原因：

- `liyuan.agent.json` 权限过宽或 JSON 非法：`chmod 600`、`node -e "JSON.parse(require('fs').readFileSync('/root/Liyuan/liyuan.agent.json','utf8'))"`
- 端口被占：`ss -lntp | grep :7620`

### 外部访问 401

- 确认 Basic Auth 凭据正确。
- 确认 htpasswd 文件权限：`chown root:www ... && chmod 640 ...`

### 外部访问 502/504

- 确认 `liyuan.service` 在运行。
- 确认 `curl -fsS http://127.0.0.1:7620/` 正常；梨园当前没有通用 `/healthz` 接口。
- 查看 `/www/wwwlogs/liyuan-8788.error.log`。

### 联网查证失败

- 确认宿主机 `7890` 代理可用：`curl -x http://127.0.0.1:7890 -fsSL https://duckduckgo.com`
- 检查服务环境变量：`systemctl show liyuan | grep Environment`

### 模型生成失败

- 确认 `liyuan.agent.json` 里的接口、key、模型名正确。
- 在网页“连接”面板测试连接。
- 查看服务日志是否有 provider 错误。

### 小说研究长时间不完成

```bash
curl -fsS http://127.0.0.1:7620/api/outline/corpus
journalctl -u liyuan --since "30 minutes ago" --no-pager | grep -E "\[corpus\]|最终消息无文本|模型调用错误|结构化素材部分降级"
```

重点检查：

- `running` 是否为空；文档是否停在 `mapping`、`reducing` 或 `extracting`。
- `liyuan.config.json` 的 `stepModels.novelDigest` 是否为已验证的模型。模型名称带 `flash` 不代表一定兼容当前中转站的 reasoning/结构化协议。
- `最终消息无文本` 通常表示 provider 返回了空 `content` 或最终消息未从 `stream.result()` 读取，不应盲目等待数小时。
- 当前 Corpus 单次调用最多 4 次、硬超时 60 秒；研究旁路不叠加 SDK 的隐式 9 次重试。增强提炼失败会降级为 ready。
- 详细根因和修复记录见 `docs/INCIDENT-20260901-NOVEL-DIGEST.md`。

## 13. 回滚

保留旧源码的备份目录 ` /root/Liyuan-backups/<时间戳>`：

```bash
cd /root
systemctl stop liyuan
cp -a /root/Liyuan /root/Liyuan-prev-failed
cp -a /root/Liyuan-backups/<时间戳>/. /root/Liyuan/
chown -R liyuan:liyuan /root/Liyuan
systemctl start liyuan
```

数据（`/var/lib/liyuan/agent`、`.liyuan-*`）不回滚，保留最新状态；如需一并回退，从对应备份恢复。

## 14. 相关文档

```text
D:\zhuce\_non_reg\Liyuan\README.md                      项目介绍
D:\zhuce\_non_reg\Liyuan\docs\LOCAL-UPSTREAM-UPDATES.md       本地分支与安全更新流程
D:\zhuce\_non_reg\Liyuan\docs\STANDALONE-INTEGRATION-BASELINE.md  脱离 Luker 整合基线
D:\zhuce\_non_reg\Liyuan\deploy\README.md               官方部署说明
D:\zhuce\_non_reg\Liyuan\deploy\VPS-OPERATIONS.md       本文档
```


## 研究搜索结果异常

研究搜索返回 0 条时，先检查 `GET /api/outline/research/search/schedule` 和服务日志，不要把搜索引擎原始页面直接导入素材库。当前系统会拒绝低相关结果；DuckDuckGo 人机验证或 Bing 兜底异常时，空结果是保护行为。查看完整根因、实战结果和清理范围：[`docs/INCIDENT-20260901-RESEARCH-SEARCH.md`](../docs/INCIDENT-20260901-RESEARCH-SEARCH.md)。
