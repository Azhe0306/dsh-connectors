# @azhe0306/dsh-balance-widget

在 DSH 会话标题栏**右上角**显示当前账户余额，只显示金额：`¥42.55`。

- 充值余额与赠金余额**合并**显示；悬停提示给出拆分：`当前余额 ¥xx（充值 ¥xx + 赠金 ¥xx）`。
- 中英双语跟随界面语言；每 120 秒刷新一次。
- 未登录 / 查询失败 → 不显示（不会显示 0 误导）；余额为 0 → 显示 `¥0.00`。

## 安装

```sh
dsh plugin --profile web add github:Azhe0306/dsh-connectors#path:/packages/balance-widget
```

## 它读什么

`ctx.remote.account.getBalance()` → `{ok:true, value:{status:'ready', value:[{currency,balance}], bonusWallets:[{currency,balance}]}}`。
`value` 是充值钱包，`bonusWallets` 是赠金钱包；只看 `value` 会在只有赠金的账号上什么都显示不出来，因此两者相加。

插件注册在插槽 `conversation.session.header.utilities`（`order: -20`），不修改 DSH 自带文件，卸载即还原。

MIT
