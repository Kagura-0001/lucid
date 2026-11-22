<p align="center">
  <img src="assets/hero.svg" alt="lucid" width="860" />
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong> · <a href="docs/reference.md">使用参考</a> · <a href="docs/tips.md">SSH、tmux 与 Swarm</a>
</p>

专为 **Google Antigravity（`agy acp`）** 及其他 [ACP](https://agentclientprotocol.com/) 编程 Agent 打造的透明背景、零依赖终端界面，已收录进 [ACP 官方客户端列表](https://agentclientprotocol.com/get-started/clients)。纯 Node.js（`>= 20`）。

<p align="center">
  <img src="assets/preview-main.svg" alt="lucid 预览" width="860" />
</p>

## 特点

- **零不透明底块** — 始终保留终端原生背景（`\x1b[49m`），内置 5 套纯前景配色。
- **为 SSH 与 `tmux` 优化** — 同步行级差分刷新、硬件滚动区域、OSC 52 划词复制，以及不依赖 `tmux` 的后台会话（`lucid bg`）。
- **清爽的工具时间线** — 当前轮按 Codex 风格归并只读探索为 `• Explored`，历史轮自动收成单行摘要（`Ctrl+O` 展开）。
- **底部常驻多 Agent 进度栏** — 在输入框下方实时显示各 Worker/Subagent 进度与耗时，按 `Alt+[` / `Alt+]` 直接切过去看实时步骤流。

## 安装

需要 **Node.js >= 20** 和任一 ACP 后端（`agy`、`gemini`、`opencode`、`goose`、`claude-code-acp`、`codex-acp` 等）。

```bash
npm install -g lucid-acp
# 或免安装直接试用：
npx lucid-acp
```

## 快速开始

```bash
lucid                         # 启动 agy acp 会话
lucid -r                      # 恢复历史或后台运行中的会话
lucid -c                      # 续接当前目录最近一次对话
lucid bg "跑完测试并修复"      # 后台运行任务（随时用 lucid -r 接回）
lucid --theme tokyo-night     # 切换配色
lucid --agent opencode        # 使用其他 ACP 后端
```

在界面里输入 `!命令`（如 `!git status`）可直接本地执行 shell 命令，不走模型。

## 文档

- [使用参考](docs/reference.md) — CLI 参数、快捷键、斜杠命令、权限模式、ACP 后端预设与 `config.json`。
- [SSH、tmux、主题与 Swarm](docs/tips.md) — 5 套主题效果、`tmux` 与 OSC 52 剪贴板设置、鼠标滚动及多 Agent 状态原理。

## 开源协议

[MIT](LICENSE)
