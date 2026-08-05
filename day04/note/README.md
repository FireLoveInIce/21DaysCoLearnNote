# Day 04 学习记录：Uniswap V3 工作流程与核心接口

## 今日目标

- 理解 V3 Swap 跨 Tick 执行的过程。
- 熟悉 Pool、Factory、Quoter、SwapRouter 的关键接口。
- 明确链上报价、离线模拟和实际交易之间的差异。

## 学习框架

1. Swap 如何逐段消耗区间内的流动性？
2. Tick bitmap 如何帮助定位下一个已初始化 Tick？
3. Quoter 为什么通常通过模拟回滚返回报价？
4. Oracle observation 能提供哪些历史价格信息？

## 重点接口与事件

- Pool：`slot0`、`liquidity`、`ticks`、`tickBitmap`、`observe`、`swap`
- Factory：`getPool`
- Quoter：单池与多跳报价接口
- SwapRouter：`exactInputSingle`、`exactInput`、`exactOutputSingle`
- `Initialize`、`Mint`、`Burn`、`Swap` 事件

## 动手任务

- [ ] 解码一笔 V3 Swap 的 calldata 和事件日志。
- [ ] 查询当前 Tick 两侧的已初始化 Tick。
- [ ] 比较 Quoter 报价与历史交易实际结果。
- [ ] 整理监控、报价、执行三类最小 ABI。

## 接口记录

| 合约/接口 | 输入 | 输出 | 用途 | 风险点 |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## 今日复盘

- V3 相比 V2 增加了哪些监控难点？
- 哪些状态必须在同一区块读取？
- 哪些数据适合缓存，哪些必须实时获取？

