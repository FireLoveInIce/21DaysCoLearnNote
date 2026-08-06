# Day 04 学习计划：V3 Swap、报价验证与真实交易复现

## 今日定位

Day03 回答“Pool 当前是什么状态”，Day04 回答“输入一笔交易后，Pool 怎样计算输出并改变状态”。今天的核心不是背完 V3 数学库，而是建立套利程序最重要的验证闭环：

> 链下发现候选机会后，能够使用 Quoter 和完整 `eth_call` 模拟验证结果，并能从真实交易中解释 Swap 的输入、输出和价格变化。

建议投入 5—7 小时。完整、精确的离线逐 Tick 报价器通常需要更多时间，不应作为今天的硬性完成条件。

## 今日目标

- 理解单个 Tick 区间内计算与跨 Tick 执行的整体流程。
- 理解 `zeroForOne`、Exact Input、Exact Output 和 `sqrtPriceLimitX96`。
- 理解 SwapRouter → Pool → Callback 的调用链和安全边界。
- 使用官方 Quoter 获取单池报价，并知道它与最终成交的差别。
- 解码一笔真实 V3 Swap，建立“报价—模拟—成交”的验证思路。

## 一、V3 Swap 的工程流程

先掌握程序执行顺序，再阅读具体数学库：

```text
读取当前 sqrtPrice、tick、liquidity
  → 根据交易方向寻找下一个已初始化 Tick
  → 计算到达目标价格或下一个 Tick 所需的输入
  → 输入不足：在当前区间内结束
  → 输入充足：穿越 Tick
  → 按 liquidityNet 更新有效 liquidity
  → 继续处理剩余输入
  → 得到最终 amount0、amount1、sqrtPrice 和 tick
```

必须说清楚：

- `zeroForOne = true` 与 `false` 分别让价格向哪个方向移动。
- Exact Input 固定输入、求最大输出；Exact Output 固定输出、求所需输入。
- 每一步先处理手续费，再计算可用于推动价格的输入。
- `sqrtPriceLimitX96` 是价格边界，不等同于 Router 的最终 `amountOutMinimum`。
- 跨越初始化 Tick 时改变的是有效 `liquidity`，不是简单读取 Pool Token 余额。

## 二、Router、Pool 与 Callback

以单池 Exact Input 为主线：

```text
用户/执行合约
  → SwapRouter.exactInputSingle
  → Pool.swap
  → Pool 逐 Tick 计算并发送输出 Token
  → uniswapV3SwapCallback
  → Callback 支付正数 Delta
  → Pool 检查余额并完成 Swap
```

需要理解而不是照抄的安全点：

- Callback 必须验证 `msg.sender` 是可信 Factory 创建的真实 Pool。
- 正数 Delta 表示 Callback 必须向 Pool 支付的 Token。
- 直接调用 Pool 不能绕过手续费，也不能省略 Callback 付款。
- 多跳套利执行合约可以用上一池的输出支付下一池，但最终仍需检查净利润。

## 三、三种报价层次

| 层次 | 用途 | 优点 | 局限 |
| --- | --- | --- | --- |
| 自己读取 `slot0` 看瞬时价格 | 快速筛选候选池 | 成本低、速度快 | 不能代表指定数量的可成交价格 |
| Quoter 报价 | 验证单池或路径输出 | 接近协议真实计算 | RPC 调用较重，状态仍可能变化 |
| 对套利执行合约做完整 `eth_call` | 发送前最终验证 | 包含所有 DEX、Callback、费用和利润检查 | 只对模拟使用的状态有效 |

套利程序的合理流程是：

```text
轻量价格筛选
  → 精确路径报价
  → 构造最终套利 calldata
  → 完整 eth_call / estimateGas
  → 满足 minProfit 后才考虑发送
```

Quoter 成功不代表完整套利一定成功；完整模拟成功也不保证交易打包时状态没有变化，所以链上执行合约仍必须保留 `minProfit` 检查。

## 四、今日动手任务

### 必做任务 A：调用 Quoter

对 Day03 选择的 Pool：

- [ ] 使用一个不会影响市场的小额 `amountIn` 获取单池报价。
- [ ] 分别记录 Token0 → Token1 和 Token1 → Token0。
- [ ] 记录调用区块、输入数量、输出数量和 Gas Estimate。
- [ ] 改变输入规模，观察平均成交价格和价格影响的变化。
- [ ] 比较相同币对不同费率 Pool 的净输出，而不是只比较瞬时价格。

至少测试三个输入规模，并回答：费率更低的 Pool 是否一定输出更多？如果不是，原因是什么？

### 必做任务 B：解码真实 Swap

选择一笔 Ethereum 主网 V3 Swap：

- [ ] 定位 Router 调用和目标 Pool。
- [ ] 解码交易 calldata 中的 Token、fee、recipient、amount 和限制参数。
- [ ] 解码 Pool 的 `Swap` 事件。
- [ ] 判断交易方向以及哪个 Token 是输入、哪个是输出。
- [ ] 记录事件后的 `sqrtPriceX96`、liquidity 和 tick。
- [ ] 用交易回执的 Gas Used 计算实际执行成本。

真实交易记录模板：

| 字段 | 结果 |
| --- | --- |
| Transaction Hash |  |
| Block Number |  |
| Pool |  |
| Token In / Amount In |  |
| Token Out / Amount Out |  |
| Fee Tier |  |
| Tick Before / After |  |
| `sqrtPriceX96` Before / After |  |
| Gas Used |  |

如果 RPC 支持历史状态或 Trace，可读取交易前一个状态进行复现；如果当前 RPC 不支持 Archive/Trace，则明确记录限制，不要用最新区块报价冒充历史交易前报价。

### 必做任务 C：整理最小 ABI

按用途拆分，不要把完整 ABI 全部复制进程序：

- [ ] 发现池：Factory `getPool`、Pool 创建事件。
- [ ] 状态监控：`slot0`、`liquidity`、`ticks`、`tickBitmap`、`Swap`。
- [ ] 报价验证：Quoter 单池报价接口。
- [ ] 执行准备：SwapRouter 单池 Exact Input 接口。
- [ ] Callback：`uniswapV3SwapCallback` 及真实 Pool 验证所需字段。

### 进阶任务：简化离线报价

- [ ] 只实现“不跨初始化 Tick”的单区间报价。
- [ ] 与官方 Quoter 对比误差。
- [ ] 再尝试加入 Tick Bitmap 和跨 Tick 流动性变化。

不建议让 AI 一次生成完整 V3 报价器后直接信任。每增加一个能力，都应与官方 Quoter、固定区块状态和边界测试交叉验证。

## 五、今日交付物

- [ ] 一份三个输入规模的 Quoter 报价记录。
- [ ] 一笔真实 V3 Swap 的完整解析。
- [ ] 监控、报价、执行、Callback 四类最小 ABI 清单。
- [ ] 一张从发现候选机会到提交交易的验证流程图。

## 六、完成标准

今天完成后，应当能够回答：

1. 为什么比较两个 Pool 的瞬时价格不能直接得出套利利润？
2. 一笔 Swap 跨过初始化 Tick 后，有效流动性为什么会变化？
3. Quoter 报价与完整套利合约模拟有什么区别？
4. Callback 为什么必须验证真实 Pool？
5. 如何从交易哈希确定实际输入、输出、方向和 Gas 成本？

如果仍无法独立解析真实 Swap，建议增加半天完成交易复现，再进入 Day05。Day05 的 V4 目标可以相应缩减为架构和风险识别，不影响第一阶段核心成果。

## 官方资料

- [Uniswap V3 Core](https://github.com/Uniswap/v3-core)
- [Uniswap V3 Periphery](https://github.com/Uniswap/v3-periphery)
- [Uniswap V3 Swap 示例](https://docs.uniswap.org/contracts/v3/guides/swaps/single-swaps)

