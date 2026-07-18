# Hermes 与 AI Portal 的本地 MCP 连接

目前提供三项 MCP 工具：

- `portal_get_health`：读取 Portal 中已打开模型的健康状态；不改变任何状态。
- `portal_submit_question`：将问题放入隔离后台任务队列，最多选择四个模型。
- `portal_get_job`：读取任务进度和各模型的原始回答，供 Hermes 在原移动端会话中汇总回复。

后台任务会为每个模型创建独立、可见的原版 BrowserWindow，使用同一模型的登录分区。窗口会先并行加载，再按顺序获得焦点注入问题，随后并行生成；取得回答后自动关闭。该过程不会改动 Portal 当前可见会话或模型选择。

## 启动 Portal Bridge

正常使用仍执行 `npm start`。仅使用只读健康检查时，在 Portal 目录执行：

```powershell
npm run start:mcp
```

如需启用受令牌保护的后台提交，先创建一次本地机密配置，再使用安全启动命令：

```powershell
npm run setup:mcp:secure
npm run start:mcp:secure
```

生成的 `.portal-mcp.local.json` 已被 Git 忽略，不应提交或发送到聊天中。

Bridge 只监听 `127.0.0.1:28365`。健康检查可无令牌运行；后台任务必须设置 `PORTAL_BRIDGE_TOKEN`，且 Portal 与 Hermes MCP 进程必须使用相同令牌。未配置令牌时，提交接口会明确返回“未启用”。

## MCP 客户端配置

在 Hermes 或其他支持 stdio MCP 的客户端中注册本地服务：

- 命令：`node`
- 参数：`<AI Portal 绝对路径>\portal-mcp-server.js`
- 环境变量 `PORTAL_BRIDGE_PORT`：与 `.portal-mcp.local.json` 中的 `port` 一致
- 环境变量 `PORTAL_BRIDGE_TOKEN`：与 `.portal-mcp.local.json` 中的 `token` 一致

不要把真实 Token 写入公开文档、Issue 或源码。不同 MCP 客户端的环境变量配置方式不同，请使用对应客户端提供的本地机密配置。

重新启动 MCP 客户端会话后即可发现工具。客户端应先调用 `portal_submit_question`，再轮询 `portal_get_job`；在状态为 `complete` 或 `partial` 时，综合 `results` 中的原始回答并发送回原移动端会话。
