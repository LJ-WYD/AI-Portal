# 安全策略

## 支持范围

项目处于公开测试准备阶段。安全修复优先应用于最新代码和最新发布版本。

## 报告安全问题

请不要在公开 Issue 中提交包含以下内容的安全报告：

- 登录 Cookie、Token 或账号信息
- 私人提示词或模型回答
- 本机路径、聊天记录或其他个人数据
- 可以直接复现未修复漏洞的敏感细节

仓库启用 GitHub Private Vulnerability Reporting 后，请优先使用私密漏洞报告。若该入口暂未启用，请先提交不包含敏感信息的简短 Issue，请求维护者提供私密联系方式。

## 本地机密

- `.portal-mcp.local.json` 只应保留在本机。
- 不要把 Token 写入源码、截图、Issue、聊天记录或构建产物。
- 怀疑 Token 泄露时，删除本地配置并重新执行 `npm run setup:mcp:secure`。

## 公开贡献

提交代码前请确认：

- 没有新增 Cookie 导入、浏览器凭据导出或绕过服务商登录验证的逻辑。
- 远程模型页面保持 `contextIsolation: true`、`sandbox: true` 和 `nodeIntegration: false`。
- 本地 Bridge 不监听公网地址。
- 新增 IPC 只暴露完成任务所需的最小能力。
- 测试素材不包含真实账号、提示词、回答或个人路径。
