# @azhe0306/dsh-desktop-connector

让 agent 真正操控这台 Windows 电脑：**看得见**（截屏）也**动得了**（鼠标、键盘）。

- 用 `koffi` 直接调 Win32（`user32` / `gdi32`）：无编译器、无每次调用的子进程。
- 自带 GDI 截图 + PNG 编码（`zlib` + 手写 chunk），不需要任何图像库。
- `PrintWindow` 优先：被遮挡或半出屏的窗口也能截；现代窗口画出空白时自动改用屏幕拷贝。
- 后台进程置顶被拒的问题用 `AttachThreadInput` 解决。

## 安装

```sh
dsh plugin --profile web add github:Azhe0306/dsh-connectors#path:/packages/desktop-connector
```

工具：`desktop_screen_info`、`desktop_windows_list`、`desktop_screen_shot`、`desktop_window_focus`、
`desktop_mouse_move`、`desktop_mouse_click`、`desktop_mouse_drag`、`desktop_mouse_scroll`、
`desktop_key_press`、`desktop_type_text`。

> Windows 专用（`os: ["win32"]`）。`desktop_key_press` / `desktop_type_text` 可以带 `window` 参数：
> 给了就先置顶并确认成功，失败就拒绝执行——不会盲打到你没预期的窗口。

## 安全

这组工具会真实操作你的鼠标键盘。先 `desktop_screen_shot` 看清屏幕再动手；不要用它操作支付、删除确认这类高风险窗口。

MIT
