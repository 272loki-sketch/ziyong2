# 本地增强版的上游更新流程

本文说明 VPS 上 `/root/Liyuan` 如何在**不推送本地代码到云端**、不覆盖配置和会话的前提下，持续接收官方 GitHub 更新。

## 1. 分支模型

仓库固定保留两条本地分支：

```text
origin/master  官方 GitHub 的最新版本，只读上游
master         本地的官方基线，跟踪 origin/master
local          VPS 实际运行版本：官方基线 + 本地增强
```

日常开发、运行和更新始终停留在 `local`。不要在 `master` 上编写本地功能，也不要把 `local` 推送到 `origin`。

当前本地增强包括文学工作流、模块化世界引擎、鲜活生态、分步模型路由、日历、NovelAI 和 VPS 运维接线等。它们以普通 Git 提交叠在官方提交之上，因此以后只需合并官方新增的提交，不再把整个部署目录重新猜成一批散落修改。

## 2. 哪些内容不进 Git

以下内容受 `.gitignore` 保护，既不会进入本地提交，也不会被官方合并覆盖：

```text
liyuan.agent.json             模型连接与 API Key
liyuan.config.json            当前角色卡、预设与运行配置
.liyuan/                      世界画像、生态池和其他运行数据
.liyuan-stage-skills/         面板编辑后的文学 Skill 覆盖
.liyuan-memory/               检索记忆
.liyuan-state/                本地状态文件
.liyuan-personas.json         用户画像数据
liyuan-profiles/              本地配置档
data/                         Docker/部署数据
/var/lib/liyuan/agent/        会话树和 Agent 数据（仓库外）
```

`skills/` 是随代码版本维护的内置规则；用户改过的版本应放在 `.liyuan-stage-skills/`，这样更新内置 Skill 时不会覆盖用户副本。

## 3. 一键更新

确认当前没有正在生成的回合，然后运行：

```bash
cd /root/Liyuan
./scripts/update-local.sh
```

脚本依次执行：

1. 确认当前分支是 `local`，且工作区没有未提交修改。
2. 在 `/root/backups/liyuan-update-<时间戳>/` 创建恢复点。
3. 生成包含全部 Git 分支和提交的 `repository.bundle`。
4. 备份项目运行数据与 `/var/lib/liyuan/agent` 会话树。
5. 执行 `git fetch origin --tags`，把 `origin/master` 合并进 `local`。
6. 安装根目录和前端依赖。
7. 运行完整后端测试、前端类型检查和生产构建。
8. 仅在前述步骤全部成功后重启 `liyuan.service`。
9. 请求 `http://127.0.0.1:7620/api/config` 验证服务健康。

可通过环境变量调整两个本地路径：

```bash
LIYUAN_BACKUP_DIR=/另一个备份目录 ./scripts/update-local.sh
LIYUAN_NODE=/其他/node ./scripts/update-local.sh
```

默认 Node 为 `/opt/node22/bin/node`，默认备份根目录为 `/root/backups`。

## 4. 安全边界

- 脚本只从 `origin` 拉取，不执行 `git push`。
- 工作区不干净时立即退出，不会自动 stash 或丢弃修改。
- 合并冲突时立即停止，不安装依赖、不重启服务；旧进程继续运行旧代码。
- 测试或构建失败时不重启服务，但 Git 合并已落在工作区，需要修复或回退。
- API Key、配置、会话和用户 Skill 不受 Git 合并管理，但仍会在更新前另行备份。
- 脚本不会使用 `reset --hard`、强推或自动删除用户数据。

## 5. 遇到合并冲突

查看冲突：

```bash
cd /root/Liyuan
git status
git diff --name-only --diff-filter=U
```

如果本次不准备处理，回到更新前：

```bash
git merge --abort
```

如果要继续整合：

```bash
# 编辑冲突文件后
git add <已解决文件>
git commit

/opt/node22/bin/node --test --experimental-strip-types test/*.test.ts
npm --prefix web run typecheck
npm --prefix web run build
systemctl restart liyuan
curl -fsS http://127.0.0.1:7620/api/config >/dev/null
```

解决原则：

- 官方预设、显示和输出架构采用上游的新形态。
- 本地文学、世界和生态能力迁移到上游新接口，不用旧代码覆盖整个官方文件。
- 提示词规则继续放在 Skill，TypeScript 只做编排、解析和确定性门禁。
- 不引入第二套正文、Session 或 canonical 状态。

## 6. 本地开发和提交

所有本地改动都在 `local` 上完成：

```bash
git switch local
git status

# 修改并验证后
git add <明确要提交的文件>
git commit -m "feat: ..."
```

提交前至少检查：

```bash
git diff --cached --check
git diff --cached --stat
git status
```

不要提交 `liyuan.agent.json`、`liyuan.config.json`、`.liyuan/` 或会话文件。根级诊断脚本和导入的 `regex-*.json` 也默认忽略。

## 6.1 本地 git = 提交在本机 local 分支，不推向公网

VPS 的 git 就是**本机仓库**（`/root/Liyuan/.git`），不是 GitHub 公网备份：

- 所有本地增强（文学工作流、世界/生态、记忆系统等）只提交到 `local` 分支，
  `origin` 仅作只读上游（`git fetch origin` 拉官方更新），**从不 `git push` 回公网**。
- 本机可能没有任何 GitHub 凭据；不要以为能推送 origin。若要共享代码，走
  `repository.bundle` 备份（见 §3）或用户另行拷贝。
- 无法凭 `git remote` 判断「是否已备份」——备份是 bundle 产物，不是远程分支。

**最近一次本地提交**（2026-08-26）：

- `4b2680e feat: 数据库式两级纪要 + 证据召回记忆系统 + zhuzhan 渠道`
  （记忆系统 + zhuzhan 渠道的完整落地，含文档与测试）
- 恢复点与之对齐：`/root/backups/liyuan-update-20260826-200338/repository.bundle`

## 7. 回滚与恢复

### 回退最近一次本地代码提交

优先使用非破坏方式建立一个回滚提交：

```bash
git switch local
git revert <需要回退的提交>
```

### 从更新备份恢复 Git

每次更新生成的 `repository.bundle` 是完整 Git 恢复点，可先在临时目录验证：

```bash
git clone /root/backups/liyuan-update-<时间戳>/repository.bundle /tmp/liyuan-restore
```

### 恢复运行数据

更新备份目录通常包含：

```text
repository.bundle   Git 分支和提交
project-data.tgz    项目内配置、世界/生态、Skill 覆盖等
agent-data.tgz      /var/lib/liyuan/agent 会话树
SHA256SUMS          备份校验值
```

恢复前先停服务，并先保留故障现场。不要把代码回滚和会话回滚混为一件事；多数代码故障只需回退 Git，不应倒退用户最新会话。

## 8. 手工查看上游更新

只查看，不合并：

```bash
git fetch origin --tags
git log --oneline --decorate local..origin/master
git diff --stat local...origin/master
```

确认分支关系：

```bash
git branch -vv
git log --oneline --decorate --graph -20
```

这种结构把“获取官方更新”和“保存 VPS 本地产品版本”分开：`master` 表示官方到了哪里，`local` 表示这台 VPS 实际运行什么。
