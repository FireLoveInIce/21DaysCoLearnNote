# Day 01 学习记录：Uniswap 演进与 V2 AMM 基础

## 今日目标

- 建立 Uniswap V1—V4 的整体演进视图。
- 理解 Uniswap V2 的恒定乘积模型 `x * y = k`。
- 能够说明价格、流动性、滑点、价格影响和手续费之间的关系。

## 学习框架

1. Uniswap 各版本分别试图解决什么问题？
2. V2 中 LP、交易者和套利者分别扮演什么角色？
3. 储备量变化如何影响报价与实际成交结果？
4. `Factory`、`Pair`、`Router` 三类合约如何协作？

## 重点接口与事件

- `Factory.getPair`、`Factory.createPair`
- `Pair.getReserves`、`Pair.swap`
- `Router.getAmountsOut`、`Router.swapExactTokensForTokens`
- `Swap`、`Sync`、`Mint`、`Burn` 事件

## 动手任务

- [ ] 阅读 V2 白皮书或核心文档并记录关键结论。
- [ ] 找到一个 V2 池，读取 token 地址、储备量和区块高度。
- [ ] 使用储备量手算一次报价，再与链上查询结果比较。
- [ ] 在 `../src/` 中保存读取池状态的 Python 示例。

## 学习记录

| 概念 | 我的理解 | 待确认问题 |
| --- | --- | --- |
| 恒定乘积 |  |  |
| 滑点与价格影响 |  |  |
| 套利恢复价格 |  |  |

## 今日复盘

- 最重要的三个收获：
- 仍然不理解的地方：
- 明天需要继续验证的假设：

