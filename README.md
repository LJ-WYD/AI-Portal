# AI Portal

AI Portal 是一个运行在本地电脑上的多模型工作台。问题只输入一次，即可同时发送给所选模型，并在同一窗口中并排查看原始回答；需要时，还可以指定一个模型对最多四份回答进行综合提炼。

> 当前仓库处于公开测试准备阶段。第三方模型页面变化可能影响输入、回复提取或汇总流程。

## 下载

Windows 安装版和便携版将随版本发布到本仓库的 Releases 页面。测试版本尚未进行代码签名，请只从本仓库下载，并使用随版本提供的 `SHA256SUMS.txt` 校验文件完整性。

## 核心能力

- 一次输入，同时发送给多个模型。
- 每页最多并排显示三个模型，模型数量更多时自动分页。
- 保留各服务商的原版网页体验和独立登录状态。
- 新建会话不会改变其他模型的当前会话。
- 最多选择四份回答进行综合提炼。
- 支持浅色和深色主题。
- 可选 Hermes MCP Bridge，用于从 Telegram 等移动端入口提交任务。

## 支持的模型

当前适配器包含：

- ChatGPT
- Claude
- Gemini
- Grok
- Zhipu AI
- Qwen
- DeepSeek
- Doubao
- Hailuo AI
- Kimi

模型页面由各服务商维护。某个模型的网页结构变化后，Portal 的自动输入或回答提取可能需要更新。

## 本地运行

### 环境要求

- Windows
- Node.js 22 或更高版本（仅从源码运行或构建时需要）
- npm
- 需要使用的模型账号

### 启动

```powershell
npm install
npm start
```

首次打开后，直接在各模型的官方页面完成正常登录。Portal 不要求安装浏览器扩展，也不支持从浏览器导入 Cookie。

登录状态保存在 Electron 为每个模型创建的本地持久化分区中。点击“重置登录”会清除 Portal 内的模型登录状态。

## Windows 构建

安装依赖后，可生成 Windows x64 安装版和便携版：

```powershell
npm run make:win
```

构建产物位于：

- `out/make/squirrel.windows/x64/AI-Portal-Setup.exe`：Windows 安装版。
- `out/make/zip/win32/x64/AI Portal-win32-x64-<version>.zip`：解压即用的便携版。

当前测试版本尚未进行代码签名，Windows 可能显示未知发布者或网络访问提示。公开分发前建议为安装包和可执行文件配置可信代码签名证书。

## Hermes / Telegram（可选）

核心桌面功能不依赖 Hermes。需要从移动端提交 Portal 任务时：

```powershell
npm run setup:mcp:secure
npm run start:mcp:secure
```

第一条命令会创建仅供本机使用的 `.portal-mcp.local.json`，其中包含随机 Token。该文件已经被 Git 忽略，不要上传、截图或发送给其他人。

完整流程见 [Hermes Portal Bridge](docs/hermes-portal-bridge.md)。

## 安全边界

- 模型网页运行在独立、持久化的 Electron Session 中。
- 远程模型页面启用上下文隔离和渲染进程沙箱，并关闭 Node.js 集成。
- Portal Bridge 默认只监听 `127.0.0.1`。
- 移动端任务提交需要本地 Bearer Token。
- Portal 没有额外的云端账号系统；提示词仍会发送给用户主动选择的模型服务商。

更多信息见 [隐私说明](PRIVACY.md) 和 [安全策略](SECURITY.md)。

## 项目状态

当前重点是提高不同模型页面变化下的稳定性、登录体验、综合提炼质量和 Windows 发布体验。Windows 安装版与便携版已经可以构建；代码签名计划在项目积累一定公开发布记录后申请。

## 开源许可

AI Portal 使用 [MIT License](LICENSE) 开源。

## 免责声明

AI Portal 是独立开发项目，与上述模型服务商不存在隶属或官方合作关系。使用者需要自行遵守各服务商的条款。模型输出可能不准确，涉及投资、医疗、法律等重要事项时请独立核实。
