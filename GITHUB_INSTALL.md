# GitHub 一键安装发布说明

这个目录已经整理成 GitHub 仓库根目录结构。上传到 GitHub 后，仓库根目录应直接包含：

```text
skill.yaml
schema.json
handlers/
README.md
GITHUB_INSTALL.md
```

## 1. 创建 GitHub 仓库

在 GitHub 新建公开仓库，建议命名：

```text
solobox-agent-bridge
```

公开仓库更适合 OpenClaw/OpenHub 直接拉取。私有仓库需要 OpenClaw 支持 GitHub token 或授权安装。

## 2. 推送本目录

在 PowerShell 中进入本目录：

```powershell
cd D:\工作\项目\solobox\readme\github-skill-release
git init
git add .
git commit -m "Release SoloBox Agent Bridge skill"
git branch -M main
git remote add origin https://github.com/你的用户名/solobox-agent-bridge.git
git push -u origin main
```

如果你使用 GitHub CLI，也可以：

```powershell
cd D:\工作\项目\solobox\readme\github-skill-release
gh repo create solobox-agent-bridge --public --source=. --remote=origin --push
```

## 3. 一键安装链接

如果 OpenClaw 支持 zip 导入：

```text
openclaw://skill/install?url=https://github.com/你的用户名/solobox-agent-bridge/archive/refs/heads/main.zip
```

如果 OpenClaw 支持直接读取 `skill.yaml`：

```text
openclaw://skill/install?url=https://raw.githubusercontent.com/你的用户名/solobox-agent-bridge/main/skill.yaml
```

OpenHub 市场发布时，推荐包名：

```text
solobox-agent-bridge
```

推荐安装链接：

```text
openhub://install/solobox/solobox-agent-bridge
```

实际 deep link 以 OpenClaw/OpenHub 官方支持格式为准。

## 4. 用户安装后的配置流程

1. 用户在 SoloBox 平台注册账号。
2. 用户登录后生成 API Key。
3. 用户点击一键安装链接导入 Skill。
4. Skill 首次启动时自动检查 `SOLOBOX_API_KEY`。
5. 如果没有配置，Skill 会询问用户输入 API Key。
6. Skill 保存 API Key 后连接 SoloBox WebSocket。
7. 平台返回 `auth.ok` 与 `profile.schema`，用户自己的 Agent 开始信息采集。

