# Day 09 学习记录：三角套利、稳定币套利与可执行性验证

## 今日目标

- 理解三角路径价格不一致与闭环收益计算。
- 理解稳定币偏离锚定价格时的套利和风险。
- 能够过滤表面盈利但实际不可执行的路径。

## 核心结论

1. 套利不能只比较展示价格，而要比较指定交易规模下的真实 `amountIn/amountOut`。
2. 三角套利必须从某种资产出发，完成多跳兑换后回到同一种资产，并扣除所有成本。
3. 稳定币可以作为主要计价资产，但不能把任何单一稳定币永久视为 1 美元。
4. 对税币、限制卖出的代币，静态代码检查只能做初筛，最终应通过真实路径模拟和余额差确认。
5. 同一条链内可以把完整路径放进一笔交易，并通过最终余额检查实现利润不足时原子回滚；跨链和 CEX 操作不能获得这种全局原子性。
6. Uniswap V3 的跨 Tick 报价可以在 Python 中精确计算；V4 无 Hook 的标准池也可以，但会修改费率、Delta 或定价曲线的 Hook 必须执行真实 Hook 逻辑后确认。

## 一、三角路径价格不一致与闭环收益

### 1. 为什么会出现三角套利

假设存在三个池子：

```text
USDC / ETH
ETH / TOKEN
TOKEN / USDC
```

理论上三个交易对的隐含汇率应该一致，但每个池子的交易、流动性和价格变化是独立发生的。例如有人在 `USDC/ETH` 池大额买入 ETH，而另外两个池子暂时没有被套利者修正，就可能短暂形成闭环价差。

### 2. 不能只把三个展示价格相乘

`priceA × priceB × priceC > 1` 只能用于发现候选机会，不能证明能够盈利。真实计算必须让上一跳的实际输出成为下一跳的输入：

```python
amount_1 = quote(usdc_eth_pool, 10_000)
amount_2 = quote(eth_token_pool, amount_1)
amount_3 = quote(token_usdc_pool, amount_2)
```

示例：

```text
第 1 跳：10,000 USDC → 2.4925 ETH
第 2 跳：2.4925 ETH → 49,700 TOKEN
第 3 跳：49,700 TOKEN → 10,080 USDC
```

如果每一跳的真实报价已经包含池子手续费和价格影响，则：

```text
毛利润 = 10,080 - 10,000 = 80 USDC

Gas                        18 USDC
Builder 或私有通道小费       5 USDC
安全缓冲                    10 USDC

净利润 = 80 - 18 - 5 - 10 = 47 USDC
净收益率 = 47 / 10,000 = 0.47%
```

不要在 Quoter 的真实 `amountOut` 上再次扣除已经包含的 LP 手续费，否则会重复计算。

### 3. 交易规模决定是否真正盈利

同一条路径在不同规模下可能得到完全不同的结果：

| 输入规模 | 毛利润 | Gas | 净利润 | 判断 |
| ---: | ---: | ---: | ---: | --- |
| 100 USDC | 1.2 | 18 | -16.8 | 不执行 |
| 1,000 USDC | 12 | 18 | -6 | 不执行 |
| 5,000 USDC | 55 | 18 | 37 | 可能执行 |
| 10,000 USDC | 80 | 18 | 62 | 相对合适 |
| 50,000 USDC | -300 | 18 | -318 | 价格影响过大 |

监控系统应该为每条候选路径计算多个规模，例如 `100`、`1,000`、`5,000`、`10,000` 和 `50,000 USDC`，而不是只保存一个 Spot Price。

### 4. 闭环的实际判断

真正的问题不是“三个价格之间有没有差异”，而是：

> 一笔真实资金依次通过所有池子，最终能否以更多的同一种资产回来？

如果最后得到的是 USDT 而起点是 USDC，还必须继续计算 `USDT → USDC` 的真实兑换成本，不能默认二者永远等值。

## 二、稳定币偏离锚定价格时的套利与风险

### 1. 稳定币价差不一定是无风险套利

假设：

```text
1 USDT = 0.98 USDC
```

表面上可以用 `98,000 USDC` 买入 `100,000 USDT`，并期待按 1 美元卖出或赎回。但市场愿意以 0.98 卖出，可能只是短期流动性失衡，也可能是在反映真实的信用、储备或赎回风险。

如果只是买入后等待恢复到 1 美元，本质上是在承担方向和信用风险：

```text
买入成本：98,000 USDC
若继续跌到 0.90，当前价值：90,000 USDC
浮亏：8,000 USDC
```

### 2. 什么情况下更接近套利

以下条件同时成立时，才更接近可执行套利：

- 发行方仍正常铸造和赎回，且自己确实能使用该渠道。
- CEX、DEX 或赎回渠道有足够的退出深度。
- 充值提现、跨链桥和目标网络都处于正常状态。
- 两边可以同时成交，或者已经提前分配好库存。
- 完整计算交易费、Gas、资金费率、提现费和再平衡成本。
- 交易后不会留下无法承受的稳定币敞口。

例如：

```text
DEX：用 99,000 USDC 买入 100,000 USDT
CEX：同时以 0.997 卖出 100,000 USDT

卖出所得       99,700 USDC
买入成本       99,000 USDC
交易手续费        200 USDC
Gas                30 USDC
净利润约           470 USDC
```

关键在于两边同时锁定，而不是先买入再等待价格恢复。

### 3. 稳定币应作为计价单位，而不是固定常量

监控系统应保留三类价格：

1. 原始报价，例如 `ETH/USDC`、`ETH/USDT`、`USDC/USDT`。
2. 稳定币自己的美元估值，例如 `USDC/USD`、`USDT/USD`。
3. 归一化后的资产美元价格。

```text
ETH/USD via USDC = ETH/USDC × USDC/USD
ETH/USD via USDT = ETH/USDT × USDT/USD
```

`USDC/USDT = 1.02` 只能说明二者相对价格偏离，不能单独说明是哪一种稳定币出了问题。需要同时参考：

- CEX 的稳定币/USD 或稳定币/法币订单簿。
- 深度较好的链上稳定币池。
- Chainlink 等独立预言机。
- 发行方赎回、铸造和储备状态。
- CEX 的充值提现状态。

更合理的方法是为每种稳定币维护独立估值和置信度，再构造动态的合成 USD 基准：

```text
synthetic_usd = weighted_median(
    USDC/USD,
    USDT/USD,
    其他合格稳定币/USD,
    独立预言机
)
```

稳定币发生明显偏离、赎回异常或充值提现暂停时，应降低权重或移出锚点篮子，而不是继续强制按 1 美元计算。

### 4. 稳定币风险白名单

建议记录：

```text
chain_id
contract_address
canonical_asset_id
是否原生发行或桥接资产
是否正常铸造和赎回
当前美元价格和偏离幅度
链上与 CEX 流动性
充值提现状态
最大单次交易额
最大总敞口
数据时间和置信度
```

`USDC`、`USDC.e` 和第三方桥接 USDC 不能只因为 Symbol 相同就当作同一种可交付资产。

## 三、过滤表面盈利但实际不可执行的路径

### 1. 使用可执行价格而不是展示价格

DEX 当前 Tick、池子中间价和 CEX 最新成交价只能用于发现候选机会。真正应比较的是：

```text
effective_buy_price(size)
effective_sell_price(size)
```

例如表面价格为：

```text
池 A：ETH = 4,000 USDC
池 B：ETH = 4,050 USDC
表面价差：1.25%
```

但交易 10 ETH 后可能变成：

```text
池 A 平均买入价：4,030
池 B 平均卖出价：4,020
```

这时还没有计算 Gas 就已经亏损。

CEX 也必须读取订单簿并计算指定数量的 VWAP，不能使用 Last Price。最优买价可能只有很小数量，大额卖出会吃到多档更差的价格。

### 2. 机会判断公式

```text
net_profit =
    sell_proceeds
    - buy_cost
    - dex_fees
    - cex_fees
    - gas_cost
    - expected_slippage
    - bridge_or_rebalance_cost
    - funding_or_borrow_cost
    - risk_buffer
```

一个候选机会至少还要满足：

- 所有池子状态来自同一区块或同一个可靠快照。
- CEX 订单簿序号连续，数据没有过期。
- 完整路径模拟成功。
- 账户余额、授权和 Gas 充足。
- 代币不存在不可接受的税、黑名单或交易限制。
- 稳定币锚点和资产映射正常。
- 最坏滑点下仍有正收益。

### 3. 数据时间一致性

每条信号至少记录：

```text
block_number
block_hash
chain_timestamp
cex_sequence
cex_event_time
local_receive_time
data_age_ms
```

如果池 A 来自区块 N，池 B 来自区块 N-2，CEX 又是数秒前的价格，所谓价差很可能只是数据不同步。

## 四、如何确认代币能够卖出以及是否存在买卖税

### 1. 静态检查只能作为初筛

需要检查代币合约是否存在：

```text
buyTax / sellTax / fee
setFee / setTax
blacklist / whitelist
tradingEnabled / pause
maxTxAmount / maxWalletAmount
cooldown
owner / upgradeTo
```

以下情况应直接标记为高风险：

- 管理员可以把卖出税改到非常高。
- 管理员可以随时添加黑名单或暂停交易。
- 合约未验证或代理实现不明。
- 卖出逻辑依赖可修改的外部合约。

代码检查不能给出最终保证，因为税率可能按金额、地址、区块或交易方向动态变化。

### 2. 通过真实余额差判断

不要只相信 Router 返回值，应比较执行地址交易前后的余额：

```text
actual_received = balance_after - balance_before
```

买入后比较理论输出和实际收到的 TOKEN，卖出后比较理论输出和实际收到的基础资产。系统真正关心的是完整闭环：

```text
投入多少 USDC
最终实际取回多少 USDC
```

不必强行区分损耗究竟来自买入税、卖出税、转账税、Hook 费还是其他非标准逻辑，只要真实余额不足，就不能按理论报价执行。

Uniswap V2 Router02 提供支持 fee-on-transfer token 的路径，其核心也是根据 Pair 或接收方的实际余额差处理；Uniswap V3 官方明确不支持 fee-on-transfer 和 rebasing token，因此检测到这类代币时，V3 路径应直接过滤或使用经过审计的专用包装与 Router。

### 3. 使用链上模拟确认完整路径

最有价值的模拟不是分别调用 Quoter，而是使用真实执行地址、Router、路径和金额模拟完整闭环：

```text
USDC → TOKEN → USDC
```

可以通过 `eth_call` 调用一个会修改状态的执行方法，节点执行完逻辑后丢弃状态修改。模拟必须尽量与最终交易一致：

- 相同 `from` 和执行合约。
- 相同 Router、池子和 calldata。
- 相同交易规模、方向和价格限制。
- 相同授权和余额条件。
- 指定 `latest`、`pending` 或具体区块。

若需要定位失败原因，可以使用 `debug_traceCall` 查看内部调用和回滚位置。余额不足或授权不足时，可以使用已准备好的执行账户、本地 fork，或节点支持的 state override。

### 4. 用执行合约提供最终原子保护

同链套利应把买入、卖出和利润检查放在同一笔交易：

```solidity
uint256 balanceBefore = BASE.balanceOf(address(this));

_buyTarget();
uint256 actualTarget = TARGET.balanceOf(address(this));
require(actualTarget > 0, "BUY_FAILED");

_sellTarget(actualTarget);

uint256 balanceAfter = BASE.balanceOf(address(this));
require(balanceAfter >= balanceBefore + minProfit, "NO_PROFIT");
```

任何一步失败或最终利润不足，整笔交易回滚；但已经消耗的 Gas 不会退回。因此：

- 合约负责保证基础资产余额不亏并达到 `minProfit`。
- Python 程序负责把 Gas、Builder 小费和风险缓冲纳入净利润判断。
- 每一跳还要设置 `amountOutMinimum`、`amountInMaximum` 和较短的 deadline。

模拟只能证明当前状态下可执行，不能保证管理员不会在打包前修改税率，也不能保证其他交易不会先改变池子状态。应在新区块出现后重新报价和模拟，并尽量通过私有交易通道提交。

## 五、DEX、CEX 与跨链执行边界

### 1. CEX 有 API，但 API 不能消除到账时间

主流 CEX 通常提供：

- 获取充值地址。
- 查询充值和提现记录。
- 发起提现。
- 查询网络是否开放、确认数、手续费和限额。

API 只能自动提交和查询，不能加快 CEX 风控、提现批次、链上确认和目标 CEX 入账。

### 2. 跨 CEX 套利应预存库存

不建议采用：

```text
在便宜的 CEX 买入
→ 提现到贵的 CEX
→ 到账后卖出
```

价差通常会在到账前消失。更合理的方式是：

```text
A 所提前持有 USDT，在 A 买入 ETH
B 所提前持有 ETH，同时在 B 卖出 ETH
→ 价差成交时锁定
→ 事后统一再平衡库存
```

提现和跨链只负责库存再平衡，不应位于实时利润锁定的关键路径。

### 3. 跨链不能获得通用的全局原子性

同一条 EVM 链内，一笔交易失败可以整体回滚。独立链之间至少包含：

```text
链 A：锁定或销毁并发送消息
→ 等待确认、验证和转发
链 B：铸造、释放并执行目标交易
```

链 A 一旦最终确认，链 B 执行失败不能让链 A 自动回滚。跨链协议可以提供局部原子性、托管、超时退款或 Solver 垫资，但不能保证两条独立链像一笔 EVM 交易一样同步回滚，也不能保证价格和利润不变。

因此，多链套利同样应采用多链预存库存、两边独立成交、事后再平衡的方式，并设置单边最大敞口和失败后的对冲方案。

## 六、V3/V4 池子的本地 Python 精确报价

### 1. V3 可以精确计算跨多个 Tick

V3 Swap 的核心流程是：

1. 从当前 `slot0.sqrtPriceX96`、Tick 和有效流动性开始。
2. 从 TickBitmap 找到交易方向上的下一个初始化 Tick。
3. 使用 `SwapMath.computeSwapStep` 计算当前 Tick 区间的 `amountIn`、`amountOut` 和手续费。
4. 如果输入没有耗尽且到达下一个 Tick，则使用该 Tick 的 `liquidityNet` 更新有效流动性。
5. 继续循环，直到输入耗尽或达到 `sqrtPriceLimitX96`。

Python 需要同步：

```text
token0 / token1
fee / tickSpacing
slot0.sqrtPriceX96 / slot0.tick
当前 liquidity
相关 tickBitmap words
所有可能跨过的 initialized ticks 及 liquidityNet
amountSpecified / zeroForOne / sqrtPriceLimitX96
```

必须使用 Python 任意精度整数，逐项复刻 Solidity 的：

```text
FullMath
SqrtPriceMath
TickMath
SwapMath
LiquidityMath
BitMath
TickBitmap
```

不能使用 `float` 或简单的 `1.0001 ** tick` 来计算真实报价，因为 Q64.96、Exact Input/Output 和向上/向下取整会产生最小单位误差，并在跨 Tick 和多跳后累积。

### 2. 多池路径必须逐跳传递整数结果

```python
amount = quote_v3_pool(usdc_weth_pool, usdc_amount)
amount = quote_v3_pool(weth_token_pool, amount)
amount = quote_v3_pool(token_usdt_pool, amount)
```

所有池子的状态必须使用相同 `block_identifier` 读取。Subgraph 可用于发现池子和历史分析，但不应作为精确执行报价的最终状态来源。

### 3. V4 的分类处理

| V4 池类型 | 本地 Python 处理 |
| --- | --- |
| 无 Hook、固定费率 | 可以复刻集中流动性数学并精确计算 |
| 不修改 Swap 结果的观察型 Hook | 本地计算后用 IV4Quoter 验证 |
| 动态费率 Hook | 本地只能条件性计算，本次费率应以 Hook 执行为准 |
| before/afterSwap 修改 Delta | 通用本地公式不能保证精确 |
| 自定义曲线或 AsyncSwap | 必须执行真实 Hook 模拟 |

V4 Hook 可能根据交易方向、数量、调用者、区块时间、外部预言机和 `hookData` 修改费率或实际 Delta，甚至完全替换默认集中流动性定价。因此不能只读取 Tick 和 Liquidity 就假设能精确报价任意 V4 池。

### 4. 推荐的分层报价流程

```text
本地 Python 快速计算
→ 扫描全部 V3 和简单 V4 池
→ 筛出理论利润超过阈值的路径
→ 调用 QuoterV2 / IV4Quoter
→ eth_call 模拟真实执行 calldata
→ 检查最终余额、Gas 和最坏利润
→ 满足 minProfit 后才考虑提交
```

本地 Python 负责吞吐量，Quoter 负责校验池子数学，真实执行交易模拟负责校验 Router、授权、代币行为、Hook 和执行合约逻辑。

## 七、监控系统的建议结构

### 1. 数据层

- 链上：区块、池状态、Tick、流动性、Swap/Mint/Burn 事件和 Gas。
- CEX：WebSocket Level 2 订单簿、序号、事件时间和交易状态。
- 风险数据：预言机、稳定币状态、CEX 充值提现、桥和网络状态。

### 2. 资产标准化层

不要只按 Symbol 识别资产，应使用：

```text
chain_id
contract_address
canonical_asset_id
bridge_provider
redemption_path
decimals
token_behavior
```

### 3. 报价与路径层

把每一个池子或 CEX 交易对建模为有向报价函数：

```text
quote(edge, direction, amount, block)
→ amount_out
→ fee
→ gas
→ price_impact
→ confidence
```

第一版限制最多三跳，只使用白名单中间资产并过滤低流动性池，避免路径数量爆炸。

### 4. 信号与风控层

每条信号保存：

```text
path
amount_in
amount_out
gross_spread_bps
net_spread_bps
gas_cost
expected_profit
max_executable_size
block_number
data_age_ms
anchor_confidence
simulation_status
execution_confidence
```

建议先完成监控、历史记录和回放，不直接连接真实资金执行。

## 八、Day 09 动手任务完成情况

- [x] 构造 `A → B → C → A` 的收益计算示例。
- [x] 比较不同交易规模下三角路径的净收益。
- [x] 明确稳定币脱锚套利与方向性押注的区别。
- [x] 定义稳定币白名单和最大敞口的核心字段。
- [x] 形成表面机会到可执行机会的过滤清单。
- [x] 明确税币检测、链上模拟与最终原子回滚方案。
- [x] 明确 V3/V4 本地 Python 报价的能力边界。

## 九、后续实现优先级

1. 先选择一条链、一个主流代币、两个 DEX 池和一个 CEX。
2. 实现 V2/V3 单池指定规模报价，并与链上 Quoter 对比。
3. 实现最多三跳的候选路径扫描和净利润计算。
4. 增加稳定币动态锚点、资产映射和数据置信度。
5. 增加真实执行 calldata 的 `eth_call` 模拟与余额差检查。
6. 增加 CEX Level 2 订单簿和预存库存模型。
7. 最后再扩展到 V4 Hook、多链和自动执行。

## 参考资料

- [Uniswap V3 Pool](https://github.com/Uniswap/v3-core/blob/main/contracts/UniswapV3Pool.sol)
- [Uniswap V3 SwapMath](https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/SwapMath.sol)
- [Uniswap V3 Quoter 指南](https://developers.uniswap.org/docs/sdks/v3/guides/swapping/quoting)
- [Uniswap V3 非标准代币限制](https://developers.uniswap.org/docs/protocols/v3/concepts/unsupported-tokens)
- [Uniswap V2 Router02](https://github.com/Uniswap/v2-periphery/blob/master/contracts/UniswapV2Router02.sol)
- [Uniswap V4 架构](https://developers.uniswap.org/docs/protocols/v4/concepts/architecture)
- [Uniswap V4 Hooks](https://developers.uniswap.org/docs/protocols/v4/concepts/hooks)
- [Uniswap V4 动态费率](https://developers.uniswap.org/docs/protocols/v4/concepts/dynamic-fees)
- [Uniswap V4 AsyncSwap](https://developers.uniswap.org/docs/protocols/v4/guides/hooks/async-swap)
- [Geth eth_call](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth)
- [Geth debug_traceCall](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-debug)
- [Flashbots Bundle 模拟](https://docs.flashbots.net/flashbots-auction/advanced/rpc-endpoint#eth_callbundle)
- [Binance Wallet API](https://developers.binance.com/en/docs/catalog/core-trading-wallet/api/rest-api/capital)
- [Coinbase Exchange WebSocket](https://docs.cdp.coinbase.com/exchange/websocket-feed/channels)
- [Kraken Withdraw API](https://docs.kraken.com/api-reference/funding/withdraw-funds)
