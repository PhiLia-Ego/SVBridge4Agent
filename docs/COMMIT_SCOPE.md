# 首次提交边界

首个提交收录可独立运行的原子文件队列实现及其维护材料。参考项目不提交，不引入 submodule。

## 纳入首个提交

| 路径 | 内容 |
| --- | --- |
| `.gitignore` | 本地文件与参考项目排除规则 |
| `package.json`、`package-lock.json` | 运行入口、依赖声明与锁定版本 |
| `src/` | Node.js 文件队列、MCP 服务与接口定义 |
| `lua/` | Studio 桥接、结构化操作和 JSON 编解码 |
| `tests/` | 不依赖真实 Studio 工程或参考项目的自动测试 |
| `scripts/install-bridge.mjs` | 通信目录准备和 Studio 加载器安装 |
| `scripts/agent-client.mjs` | 独立 MCP 调用客户端 |
| `scripts/live-queue-test.mjs` | 使用本地样例工程的实机联调脚本 |
| `README.md`、`README.zhcn.md`、`docs/` | 英文与中文使用说明、协议与提交边界 |
| `mcp-config.example.json` | 通用配置示例，使用占位绝对路径 |

建议首次提交主题：`feat: add Synthesizer V agent bridge over atomic file queue`。

## 留在本机

| 路径 | 原因 |
| --- | --- |
| `vendor/` | 参考项目的独立 checkout，含第三方代码、依赖和 Git 元数据 |
| `test_proj/` | 原始与复制的 Studio 工程、伴奏音频、旧 Harmony 运行文件 |
| `test_results/` | 探测输出、请求回复、工程快照、日志及本机验证报告 |
| `.sv-agent/` | 活动会话、队列、执行记录和本机路径加载器 |
| `.codex/` | 本机 Node.js 与项目绝对路径配置 |
| `node_modules/` | 可由锁文件重建的依赖 |
| `.gitignore` 中列出的 8 个历史脚本 | Harmony 评估和通信路线探测，不是当前桥接的维护入口 |

这些文件只被 Git 忽略，保留原位。实机联调脚本会使用本地 `test_proj/og.svp` 和 `test_proj/agent_queue_test.svp`，输出到 `test_results/atomic-queue/`；新 checkout 运行自动测试不需要这些素材，但实机联调须自行准备已验证的样例。

## 提交前检查

- `git status --short --untracked-files=all` 应只列出上表中的实现与维护文件。
- 使用明确路径暂存，随后用 `git diff --cached --stat`、`git diff --cached` 审查。
- `git ls-files --stage` 不应包含 `vendor/`、测试素材、本机运行目录，或模式为 `160000` 的 submodule 条目。
- 正式提交前运行 `npm test`，确认自动测试通过。

## 后续 macOS 音频扩展

源码继续按同一边界维护：`native/macos/` 收录 Swift 和 Info.plist，`scripts/build-audio-helper.mjs` 收录本机编译入口，`src/audio.mjs` 收录采集协调，新增实机脚本与自动测试纳入源码。`.build/` 编译产物、`.sv-agent/recordings/` 录音和 `test_results/macos/` 证据留在本机，不提交。参考项目仍不提交或引入 submodule。
