# Day 05 学习记录：Uniswap V4 与版本对比总结

## 今日目标

- 理解 V4 的 Singleton、Hooks、Flash Accounting 等设计。
- 对比 V2、V3、V4 的状态结构和交易路径。
- 完成第一阶段核心接口与 ABI 清单。

## 学习框架

1. Singleton 如何改变建池、路由和跨池交易成本？
2. PoolManager、PoolKey 和 PoolId 分别承担什么职责？
3. Hooks 可以在哪些生命周期节点扩展逻辑？
4. Flash Accounting 与 transient storage 如何减少资产转移？
5. 自定义 Hook 会引入哪些新的安全和报价风险？

## 重点接口与事件

- `PoolManager.initialize`、`modifyLiquidity`、`swap`、`unlock`
- PoolKey 的 currency、fee、tickSpacing、hooks
- Hook 权限与回调入口
- 初始化、流动性修改和 Swap 相关事件

## 动手任务

- [ ] 画出 V4 单池和多池 Swap 的调用流程。
- [ ] 选择一个 Hook 案例并说明它改变了什么行为。
- [ ] 建立 V2/V3/V4 合约、状态、报价和风险对比表。
- [ ] 汇总后续监控系统需要的接口与事件 ABI。

## 版本对比

| 维度 | V2 | V3 | V4 |
| --- | --- | --- | --- |
| 流动性模型 |  |  |  |
| 核心架构 |  |  |  |
| 报价难点 |  |  |  |
| 可扩展性 |  |  |  |
| 主要风险 |  |  |  |

## 阶段复盘

- 我是否能从交易哈希定位核心调用和事件？
- 我是否能列出监控与执行所需的最小 ABI？
- 下一阶段仍需补齐的基础知识：

