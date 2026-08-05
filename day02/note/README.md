# Day 02 学习记录：Uniswap V2 合约结构与 ABI

## 今日目标

- 从交易入口追踪一次 V2 Swap 的完整调用链。
- 熟悉 V2 核心合约与外围合约的职责边界。
- 能够挑选监控和构造交易所需的最小 ABI。

## 学习框架

1. 用户调用 Router 后，代币如何进入 Pair 并完成交换？
2. Pair 如何通过余额差值判断输入数量？
3. `amount0Out`、`amount1Out` 和回调数据分别表示什么？
4. 多跳路径、授权、截止时间和最小输出量如何生效？

## 重点接口与事件

- ERC-20：`approve`、`allowance`、`balanceOf`、`decimals`
- Router：`getAmountsOut`、`swapExactTokensForTokens`
- Pair：`token0`、`token1`、`getReserves`、`swap`
- Factory：`allPairsLength`、`allPairs`、`getPair`

## 动手任务

- [ ] 画出 Router → Pair → Token 的调用流程。
- [ ] 整理只读监控 ABI 与交易执行 ABI。
- [ ] 用 Python 解码一笔历史 `Swap` 事件。
- [ ] 记录失败交易中常见的 deadline、allowance 和 slippage 问题。

## 产出记录

- 合约地址与网络：
- 最小 ABI 文件位置：
- 历史交易链接：
- 调用链结论：

## 今日复盘

- 哪些接口适合监控？
- 哪些接口涉及资产安全？
- V2 套利程序最少需要哪些链上数据？

