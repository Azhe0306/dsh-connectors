# DSH 连接器三件套（余额 · 浏览器 · 桌面）

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）用的三个插件，一个仓库三个包：

| 包 | 一句话 | 类别 |
|---|---|---|
| [`@azhe0306/dsh-balance-widget`](packages/balance-widget) | 会话标题栏右上角显示账户余额（充值+赠金合并） | 用量与计费 |
| [`@azhe0306/dsh-browser-connector`](packages/browser-connector) | 浏览器自动化：agent 直接驱动无头 Edge/Chrome | 浏览器与网页 |
| [`@azhe0306/dsh-desktop-connector`](packages/desktop-connector) | 操控 Windows 桌面：截屏、窗口、鼠标、键盘 | 工具与能力 |

三个包都只依赖 DSH 自带的机制，**不往你的机器上拖第三方运行时**：浏览器包零依赖（Node 自带 `WebSocket` 讲 DevTools 协议），桌面包只依赖 `koffi`（Node-API FFI，预编译、无需编译器），余额包是纯前端插件。

## 安装

```sh
# 逐个安装（按需选）
dsh plugin --profile web add github:Azhe0306/dsh-connectors#path:/packages/balance-widget
dsh plugin --profile web add github:Azhe0306/dsh-connectors#path:/packages/browser-connector
dsh plugin --profile web add github:Azhe0306/dsh-connectors#path:/packages/desktop-connector
```

DSH Desktop 用户也可以在设置 →「插件」里从本仓库安装；或在会话里让 agent 用 `plugin_manager` 的 `install_bundle` 指向本地目录。

装完**不需要额外配置路径**：补丁用包名挂载，loader 自己解析包位置。

## 一、余额小组件

- 位置：会话标题栏右侧工具区最左边，只显示金额：`¥42.55`（CNY）/ `$12.34`（USD）。
- 悬停：`当前余额 ¥42.55`；含赠金时显示 `当前余额 ¥xx（充值 ¥xx + 赠金 ¥xx）`。
- 未登录或查询失败：**什么都不显示**（绝不显示 0 误导）；余额真为 0 时显示 `¥0.00`。
- 每 120 秒刷新，随消费变化；中英双语跟随界面语言。

实现要点：金额来自 `ctx.remote.account.getBalance()`，**充值桶与赠金桶合并**（只读充值桶会在"只有赠金"的账号上什么都看不到）；`inject` 必须含嵌套键 `remote.account`，否则读取会被服务守卫拦下。

## 二、浏览器接入（11 个工具）

默认**无头 + 一次性 profile**：不抢你的焦点，也不碰你的登录态。想用自己带登录的浏览器，就用 `--remote-debugging-port=9222` 启动它，再调 `browser_connect`。

| 工具 | 作用 |
|---|---|
| `browser_launch` | 启动无头 Edge/Chrome 并连接（`headless:false` 可看窗口） |
| `browser_connect` | 接管用户自己开的调试端口浏览器 |
| `browser_tabs` / `browser_close` / `browser_quit` | 标签清单 / 关标签 / 关实例并清理临时 profile |
| `browser_navigate` | 打开 URL 或切换标签，等文档就绪 |
| `browser_snapshot` | 标题/URL/可见正文 + 可交互元素清单（比读 HTML 省 token） |
| `browser_eval` | 页面里跑 JS 取 JSON |
| `browser_click` | 按 CSS 选择器或可见文字点击 |
| `browser_type` | 按选择器或 label/placeholder 填值，`submit` 回车提交 |
| `browser_screenshot` | 视口或整页截图，`inline` 直接回图 |

## 三、操控电脑（10 个工具，Windows）

| 工具 | 作用 |
|---|---|
| `desktop_screen_info` | 主屏尺寸 + 光标位置 |
| `desktop_windows_list` | 可见窗口：id / 标题 / pid / 矩形 / 是否聚焦 |
| `desktop_screen_shot` | 截屏：指定窗口或整屏，`region` 裁剪、`scale` 缩放、`settle_ms` 等待、`inline` 回图 |
| `desktop_window_focus` | 置顶窗口（先还原最小化） |
| `desktop_mouse_move` / `desktop_mouse_click` / `desktop_mouse_drag` / `desktop_mouse_scroll` | 移动 / 点击 / 拖拽 / 滚轮 |
| `desktop_key_press` | 按键与组合键：`enter`、`ctrl+c`、`alt+tab`、`f5` |
| `desktop_type_text` | 输入任意 Unicode 文字（含中文），可指定目标窗口 |

`desktop_key_press` / `desktop_type_text` 支持 `window` 参数：给了就先置顶并**确认置顶成功**，失败就拒绝执行——不盲打。

### 五个踩过的坑（都已在代码里修掉）

1. `SendInput` 的 `cbSize` 在 x64 上是 **40**（union 由 `MOUSEINPUT` 定尺），不是 32；
2. 键盘 `INPUT` 结构要按 x64 布局展平（`type+pad+KEYBDINPUT+tail` = 40 字节）；
3. 输入必须**分批投递**（每 64 个 input 一批），逐字符发会把消息队列打爆、丢掉尾巴；
4. DIB 的 alpha 是未定义值，抓到 BGRA 后必须统一写 255，否则 PNG 带随机透明、空白检测也会失效；
5. 现代窗口（新记事本、UWP）会「`PrintWindow` 返回成功但画出空白」——所以要做空白判定，窗口完全在屏内时改用屏幕 `BitBlt`。

另外：后台进程置顶会被 Windows 拒绝，代码里用 `AttachThreadInput` 先附着前台输入队列再置顶。

## 想要 MCP 连接器形态？

两个连接器的核心文件同时也是 **MCP stdio 服务端**（`node core.mjs` 即启动，协议为标准 JSON-RPC over stdio）。想挂到 DSH 的 MCP 客户端上：

```yaml
- insert:
    - id: desktop-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: desktop
        transport: stdio
        command: node
        args: ['<本包目录>/core.mjs']
        failOnStartupError: true
```

这种写法需要把 `<本包目录>` 换成实际绝对路径（MCP 客户端的 `args` 不解析包名），所以默认安装走的是原生工具插件这条路。

## 安全声明

- **桌面连接器真的会动你的鼠标和键盘**：先用 `desktop_screen_shot` 看清当前屏幕再操作；批量输入务必带 `window` 参数；不要拿它去点你不确定后果的窗口（支付、删除确认框等）。
- **浏览器连接器**默认用一次性 profile（无你的登录态）；`browser_connect` 会接管你自己开的浏览器，用完关掉即撤销。
- 余额小组件只读账号余额并显示金额，不写任何数据。

## 许可

MIT
