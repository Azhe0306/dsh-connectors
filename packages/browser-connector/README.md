# @azhe0306/dsh-browser-connector

浏览器自动化连接器：agent 直接驱动本机 Edge / Chrome。

- **零依赖**：Node 自带 `WebSocket` 说 DevTools 协议，浏览器发现走它自己的 `GET /json/list`。
- 默认**无头 + 一次性 profile**：不抢焦点、不碰你的登录态；`browser_connect` 可接管你自己用 `--remote-debugging-port=9222` 开的浏览器。

## 安装

```sh
dsh plugin --profile web add github:Azhe0306/dsh-connectors#path:/packages/browser-connector
```

装好后这些工具可用：`browser_launch`、`browser_connect`、`browser_tabs`、`browser_navigate`、
`browser_snapshot`、`browser_eval`、`browser_click`、`browser_type`、`browser_screenshot`、
`browser_close`、`browser_quit`。

典型一轮：`browser_navigate` → `browser_snapshot`（拿到正文与可交互元素）→ `browser_click` / `browser_type` → `browser_screenshot`（看图确认）。

## 实现细节

- `core.mjs` 同时是 MCP stdio 服务端（`node core.mjs`），`index.js` 是原生工具前端；两者共用同一份实现。
- 启动后必须等文档真正就绪（`readyState` 到 interactive/complete 且 URL 不是 `about:blank`），否则会读到浏览器的启动空白页。
- 浏览器命令行开标签时会多开一个 `about:blank`，选页时要跳过。

MIT
