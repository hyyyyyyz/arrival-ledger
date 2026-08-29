# OpenDesign 集成说明

本项目使用 [nexu-io/open-design](https://github.com/nexu-io/open-design) 的设计契约与证据化评审流程，但业务运行不依赖 OpenDesign。生产服务不需要安装 OpenDesign，也不会把订单或照片发送给 OpenDesign。

## 当前配置

- Codex marketplace：`nexu-io/open-design-agent-plugins`
- Codex plugin：`open-design@open-design` 0.5.3
- 项目设计契约：根目录 `DESIGN.md`
- 可执行语义令牌：`frontend/src/styles/tokens.css`
- 逐版评审记录：`docs/ui-refresh/visual-review.md`

插件与本地 MCP 是两层独立配置。插件只教 Codex 如何调用 OpenDesign；签名的 OpenDesign Desktop 运行时负责本地 daemon 和 MCP bridge。新安装 MCP 后需要新开 Codex 任务，工具才会出现在任务上下文中。

## macOS 安装约束

本机 `/usr/bin/od` 是 macOS 自带的八进制工具，不是 OpenDesign CLI，禁止执行裸命令 `od ...`。当前源码要求 Node `~24` 与 pnpm `10.33.2`，不应把 OpenDesign 源码或 workspace 依赖安装到业务仓库。

推荐使用官方签名的 Apple Silicon Desktop 发布包。当前核验版本为 `open-design-v0.21.0`：

- 文件：`open-design-0.21.0-mac-arm64.dmg`
- GitHub 发布页 SHA-256：`b553f49c1fbdc7dcca4ca225d682ad5d672e0a1363653ce953eceecd76e53326`

下载后必须先校验：

```bash
shasum -a 256 /path/to/open-design-0.21.0-mac-arm64.dmg
```

## 隐私配置（必须先于项目导入）

首次启动后，在 `Settings → Privacy/Telemetry` 同时关闭：

- Anonymous metrics
- Conversation/tool content

OpenDesign 的可选内容遥测默认可能包含提示词、回复、工具输入输出和附件/产物清单。到货管家包含真实业务订单，因此在两项关闭并复核前，不导入项目、不启动生成任务。

## Codex MCP

在 Desktop 的 `Settings → MCP server → Codex` 复制官方生成的绝对路径命令。配置形态应类似：

```bash
codex mcp add open-design \
  --env OD_DATA_DIR=/absolute/open-design/data/path \
  -- /absolute/path/to/node /absolute/path/to/open-design-cli.js mcp
```

不要手写固定 localhost 端口，也不要把 `/usr/bin/od` 注册为 MCP。验证：

```bash
codex plugin list --json
codex mcp get open-design --json
```

可逆移除：

```bash
codex mcp remove open-design
```

本地 MCP 暴露写文件、删除文件、创建项目和运行代理等能力，并非只读。仅在单用户本机 loopback 环境使用，不设置 `OD_CODEX_SANDBOX=danger-full-access`。

## 本项目工作流

```text
DESIGN.md + tokens.css
→ 实现一个版本
→ frontend typecheck/test/build
→ 320/360/390/430/1440 真实浏览器截图
→ 视觉评分与 must-fix
→ 下一版本
→ 最终部署与真实页面复验
```

OpenDesign 官方 code-migration 流程会写文件并执行子进程，只允许在干净分支或独立 worktree 使用；不得直接对生产部署目录运行。
