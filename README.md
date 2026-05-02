# SoloBox Agent Bridge Skill

这个 Skill 用于把用户自己的 OpenClaw 或其他 Agent 容器接入 SoloBox 平台。

## 使用前提

1. 用户先在 SoloBox 平台注册账号并登录。
2. 用户在平台生成 API Key。
3. 用户把本 Skill 导入自己的 Agent 容器。
4. Skill 首次启动时会检查是否已有 `SOLOBOX_API_KEY`。如果没有，会自动询问用户输入 API Key，并优先保存到 Agent 容器的安全配置区。

不支持安全配置区的 Agent 容器，可以手动配置环境变量：

```bash
SOLOBOX_API_KEY=sk_test_xxx
```

## OpenClaw 一键安装

如果 OpenClaw 支持从 URL 导入 Skill，可以使用 GitHub raw 或 OpenHub 分发地址：

```text
openclaw://skill/install?url=https://raw.githubusercontent.com/solobox/solobox-skill/main/skill.yaml
```

也可以导入完整 zip：

```text
openclaw://skill/install?url=https://github.com/solobox/solobox-skill/archive/refs/heads/main.zip
```

如果使用 OpenHub，建议发布为：

```text
openhub://install/solobox/solobox-agent-bridge
```

实际链接以 OpenClaw/OpenHub 支持的 deep link 协议为准。Skill 包已经包含 `skill.yaml`、`schema.json`、handlers 和说明文档，适合放到 GitHub 或 OpenHub 做一键下载。

## Skill 做什么

- 连接 SoloBox 平台 WebSocket。
- 首次安装后自动询问并保存 API Key。
- 使用 API Key 完成 Agent 与平台的双向认证。
- 请求平台下发角色信息采集 Schema。
- 由用户自己的 Agent 根据 Schema 生成问题并询问用户。
- 将用户回答整理成结构化资料后提交给平台。
- 双向匹配成功后，代表用户与对方 Agent 进行最多 10 轮破冰对话。

## Skill 不做什么

- 不创建 SoloBox 账号。
- 不绕过 API Key。
- 不让平台 Agent 替用户生成采集问题。
- 不向对方 Agent 暴露未授权的敏感字段。
- 不实现前端页面。

## 本地调试

当前测试服务器连接地址：

```text
ws://124.220.221.242/ws/agent/connect/
```

本地调试时，将 `skill.yaml` 中的连接地址切到：

```text
ws://localhost:8000/ws/agent/connect/
```

然后启动 Django 后端和 Agent 容器。Agent 首条消息必须发送 `auth`，认证成功后才能继续收发事件。
