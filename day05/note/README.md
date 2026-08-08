# Day 05：V4 架构与套利系统学习记录

## 今日学习结论

今天的主线不是继续堆叠 V4 接口，而是把 V2、V3、V4 的演进和套利系统的实际分工串起来：

```text
V2 Pair：每个币对一个独立合约，使用全范围 x*y=k
  → V3 Pool：每个币对/费率一个独立合约，引入集中流动性和 Tick
  → V4 PoolId：不再为每个 Pool 部署合约，全部逻辑 Pool 由 PoolManager 管理
```

V4 删除的不是 Pool 这个经济概念，而是“每个 Pool 必须对应一个独立合约”的部署模式。V4 Pool 仍然有独立的价格、Tick、流动性、Position 和费用状态，只是通过 `PoolId` 在 Singleton `PoolManager` 中索引。

套利系统也不是 Python 和 Solidity 二选一：

```text
Python：发现 Pool、维护状态、搜索循环、筛选和模拟
Solidity：原子执行、Callback 付款、还款和 minProfit 保护
Uniswap Pool/PoolManager：执行最终权威的 Swap 数学
```

## 一、Day04 前置知识回顾

### `sqrtPriceX96` 与 Tick

- `sqrtPriceX96` 是 Pool 当前精确价格的 Q64.96 表示。
- Tick 是当前价格所在的离散对数坐标，用于定位流动性区间和搜索边界。
- 快速比较 Pool 的边际价格应使用 `sqrtPriceX96` 并处理 Token 顺序和 decimals。
- 计算指定数量能否套利，不能只看 `sqrtPriceX96` 或 Tick，必须处理手续费、价格影响、跨 Tick 流动性和 Gas。

```text
rawPrice(token1/token0) = (sqrtPriceX96 / 2^96)^2
tickPrice(token1/token0) = 1.0001^tick
```

新 V3/V4 Pool 的 Core 初始化接口必须接收 `sqrtPriceX96`。普通用户通常只在前端输入或确认人类价格、Token 数量和价格范围，前端/SDK 再计算底层整数；已有 Pool 添加流动性时不重新初始化价格。

### 当前 Tick 对谁“当前”

当前 Tick 属于某个具体 Pool 在某个区块状态下的价格坐标，不属于某个 LP 或某笔交易：

- Swap 从当前 Tick 开始，执行中移动价格，成功后写回新 Tick。
- 添加/移除流动性读取当前 Tick 判断 Position 是否活跃，通常不改变价格和 Tick。
- Quoter 模拟会计算 Swap 后 Tick，但 `eth_call` 结束后不持久化。

### V3 Observation

V3 `slot0` 中的 `observationIndex`、`observationCardinality` 和 `observationCardinalityNext` 属于 Pool 内置的历史累计值环形缓冲区，用来计算 TWAP。它记录本 Pool 的 `tickCumulative` 和 `secondsPerLiquidityCumulativeX128`，不是 Chainlink 等外部喂价。

## 二、V2 Pair、V3 Pool、V4 PoolId 的演进

| 维度 | V2 Pair | V3 Pool | V4 逻辑 Pool |
| --- | --- | --- | --- |
| 身份 | 排序后的 Token 对 | Token 对 + fee | 完整 PoolKey 的哈希 PoolId |
| 是否独立合约 | 是 | 是 | 否，共用 PoolManager |
| 创建方式 | Factory 部署 Pair | Factory 部署 Pool | PoolManager 初始化内部状态 |
| 价格状态 | reserves | `sqrtPriceX96`、Tick、L | V3 类状态 + 动态 LP Fee |
| 流动性范围 | 全范围 | 集中流动性 | 集中流动性 |
| Token 托管 | Pair 合约 | Pool 合约 | PoolManager 集中托管 |
| 多跳结算 | Pair 间转 Token | 每个 Pool Callback 付款 | unlock 内累计 Delta，最后净额结算 |
| 扩展方式 | Fork/外围合约 | Fork/外围合约 | Hooks |
| 原生 ETH | 通常使用 WETH | 通常使用 WETH | `Currency(address(0))` |

### 为什么 V2 升级到 V3

V2 流动性分布在价格从 0 到无穷大的全部范围，资金利用率低。V3 允许 LP 选择 `[tickLower, tickUpper)`，让资金集中在更可能成交的价格范围，并允许同一币对存在多个费率 Pool。

代价是引入 `sqrtPriceX96`、Tick、Tick Bitmap、逐 Tick Swap、NFT Position 和 Callback，报价与集成明显更复杂。

### 为什么 V3 升级到 V4

V3 仍然为每个 Token 对和费率部署独立 Pool 合约，存在三个主要限制：

1. 每个新 Pool 都要重复部署 Core 字节码。
2. 多跳需要在多个 Pool 合约间转移 Token，并逐池 Callback 结算。
3. 动态费率、限价单、特殊 Oracle 等功能通常需要 Fork Core 或增加复杂外围合约。

V4 通过 Singleton、Flash Accounting、Hooks 和原生 ETH 支持降低创建与多跳成本，并把自定义逻辑从 Core Fork 转为生命周期 Hook。

## 三、PoolKey 与 PoolId

V4 PoolKey 是逻辑 Pool 的完整配置：

```solidity
struct PoolKey {
    Currency currency0;
    Currency currency1;
    uint24 fee;
    int24 tickSpacing;
    IHooks hooks;
}
```

PoolId 是 PoolKey 的标准 ABI 编码哈希：

```text
PoolId = keccak256(abi.encode(PoolKey))
```

关键规则：

- `currency0 < currency1`，按底层地址值排序。
- fee、tickSpacing 或 Hook 任一不同，都是不同 Pool。
- PoolId 是 `bytes32` 状态索引，不是合约地址。
- 实际 `swap` 仍传完整 PoolKey；PoolManager 从中计算 PoolId，同时使用 Currency、Fee、Tick Spacing 和 Hook。
- 相同 PoolKey 在不同链或不同 PoolManager 下可能得到相同 PoolId，因此全局唯一键应为：

```text
chainId + PoolManager + PoolId
```

V4 没有每池独立合约，核心状态概念上保存在：

```solidity
mapping(PoolId => Pool.State) internal pools;
```

发现 V4 Pool 应监听 PoolManager 的 `Initialize` 事件，保存 PoolId 和构造 PoolKey 所需的全部字段。

## 四、V3 与 V4 多跳的区别

假设路径为：

```text
USDC → WETH → DAI
```

### V3

```text
Router
  → USDC/WETH Pool.swap
      → Callback 支付 USDC
  → WETH/DAI Pool.swap
      → Callback 支付 WETH
  → 得到 DAI
```

两跳调用两个独立 Pool 合约，每个 Pool 独立持有 Token、更新 Storage 并检查 Callback 付款。

### V4

```text
Router/执行合约
  → PoolManager.unlock
      → unlockCallback
          → PoolManager.swap(PoolKey A)
          → PoolManager.swap(PoolKey B)
          → settle USDC
          → take DAI
      → 所有 Currency Delta 必须归零
```

PoolManager 不会自动搜索路径。Router、套利合约或 Python 必须明确决定每一跳并依次调用 `swap`。

中间 Currency 可以通过会计抵消：

```text
第一跳：USDC -1000，WETH +0.5
第二跳：WETH -0.5，DAI +990

净额：USDC -1000，WETH 0，DAI +990
```

最终只需支付 USDC、提取 DAI，中间 WETH 通常不需要在 Router 和 PoolManager 间重复转移。

## 五、Unlock、Delta 与 Hooks

### Unlock 和 Flash Accounting

```text
PoolManager.unlock(data)
  → 调用 msg.sender.unlockCallback(data)
  → Callback 中执行 swap/modifyLiquidity 等操作
  → 累计调用者的 Currency Delta
  → settle 负 Delta，take 正 Delta
  → Callback 返回
  → 非零 Delta 数不为零则整笔交易回滚
```

| Delta | 含义 | 处理方式 |
| --- | --- | --- |
| `> 0` | PoolManager 欠调用者 | `take` 或继续净额结算 |
| `< 0` | 调用者欠 PoolManager | 转入资产并 `settle` |
| `= 0` | 已结清 | 可以结束 unlock |

ERC-20 一般先 `sync(currency)` 记录余额基准，再转入 Token 并 `settle()`；原生 ETH 使用 payable `settle{value: amount}()`。Callback 必须验证：

```solidity
require(msg.sender == address(poolManager));
```

### Hooks

Hook 可以在 Initialize、增减流动性、Swap 和 Donate 前后执行。权限由 Hook 地址低位标志决定，但权限位只说明“哪些入口可能被调用”，不能说明业务一定安全。

Hook 可能：

- 动态覆盖 LP Fee。
- 返回额外 Delta，改变最终输入或输出。
- 根据 `hookData`、Oracle 或自己的 Storage 改变行为。
- 调用外部协议、消耗额外 Gas 或 revert。
- 是代理或依赖可升级合约。

第一版自动执行策略：

```text
无 Hook → 可进入 Quoter 和完整模拟
已审查 Hook → 使用真实 hookData 模拟后白名单接入
未知 Hook → 只发现和监控，不自动执行
```

## 六、闪电贷与套利原子性

闪电贷资金来自 Aave、Balancer、Uniswap Pool/PoolManager 等协议已有流动性，不是凭空创建。借款、使用、偿还必须发生在同一笔交易；无法偿还本金和费用时整笔交易回滚，但已经执行的计算仍然消耗 Gas。

| 协议 | 闪电能力 |
| --- | --- |
| Aave V3 | `flashLoan` / `flashLoanSimple` |
| Uniswap V2 | Flash Swap，通过 `uniswapV2Call` 结算 |
| Uniswap V3 | `flash()` / `uniswapV3FlashCallback` |
| Uniswap V4 | unlock 内 `take` 资产并在结束前 `settle` Delta |

同链多步套利需要在一笔 EVM 交易中执行，通常由自定义 Solidity 合约负责：

```text
请求闪电流动性
  → 执行多个 Swap
  → 偿还本金和费用
  → 检查 finalBalance >= initialBalance + minProfit
  → 不满足则 revert
```

Python Bot 不能替代链上原子性，它负责发现、模拟、构造和发送交易。合约不能主动发起顶层交易，仍需要 EOA/Bot 触发。CEX-DEX、跨链和延迟赎回不在同一 EVM 状态机中，无法获得相同的全流程原子性。

## 七、池发现与循环套利系统评估

### 池发现是必要基础

输入必须包含 `chainId + tokenAddress`。在已登记的 DEX 部署范围内：

- V2：扫描 Factory `PairCreated`，或已知另一 Token 时调用 `getPair`。
- V3：扫描 Factory `PoolCreated`，或已知另一 Token 和 fee 时调用 `getPool`。
- V4：扫描 PoolManager `Initialize`，保存 PoolKey 和 PoolId。

Factory/Router 地址还不够。每个部署还应配置：

```text
chainId、协议族、Factory/PoolManager、deploymentBlock
Quoter、StateView、Router、Multicall、wrappedNative
费用规则、ABI 版本和允许的 Hook
```

Curve、Balancer、DODO 等不是 V2/V3/V4 的简单别名，需要独立 Adapter 和报价数学。

### 路径搜索适合 Python

按链建立有向图：

```text
Token = 节点
Pool 的每个方向 = 一条边
```

循环示例：

```text
USDC → WETH → DAI → USDC
```

第一版应限制在同链 2～4 跳，禁止重复 Pool，过滤低流动性、危险 Token 和未知 Hook。跨链路径不是原子循环，应独立建模。

### 报价采用混合方案

| Pool 类型 | 第一版报价策略 |
| --- | --- |
| 标准 V2 | Python 使用 reserves、fee 和整数公式精确计算 |
| V3 | Python 做边际价和粗筛，候选路径交给 QuoterV2 |
| 无 Hook V4 | 本地粗筛 + V4 Quoter |
| Hook V4 | 必须使用真实 PoolKey、hookData 和 Hook 状态执行 Quoter/`eth_call` |
| 其他 DEX | 每个协议单独 Adapter |

最终必须对真实套利执行合约的完整 calldata 做：

```text
eth_call
+ estimateGas
+ minProfit
```

利润口径：

```text
netProfit
  = finalAmount - initialAmount
  - flashLoanFee
  - gasCost
  - builderPayment
  - safetyBuffer
```

## 八、主网套利的现实边界

以太坊主网热门池的简单 DEX-DEX 原子套利已经高度专业化。竞争优势更多来自本地节点、Pending 状态模拟、私有订单流、Builder 连接和竞价，而不只是会写价格公式。

“长尾”指交易量、流动性和关注度较低的大量资产、Pool 或协议。长尾机会可能持续更久、竞争更少，但通常伴随低流动性、转账税、黑名单、恶意 Hook、无法卖出和管理员权限等风险。长尾不等于无风险机会。

当前合理目标是先运行影子模式：记录理论机会、精确模拟利润、下一块存活率、实际竞争者和失败成本，再决定是否投入真实资金和低延迟基础设施。

## 九、Python 与 Solidity 的职责

| 工作 | Python | Uniswap/DEX 合约 | 自定义 Solidity 执行器 |
| --- | --- | --- | --- |
| 扫描 Factory/Manager 事件 | 是 | 发出事件 | 否 |
| 维护 Token/Pool 图 | 是 | 否 | 否 |
| 搜索循环和输入规模 | 是 | 否 | 否 |
| 快速边际价格计算 | 是 | 提供状态 | 否 |
| V2 本地报价 | 是 | 最终复算 | 否 |
| V3/V4 Quoter | 发起 `eth_call` | EVM 中执行 | 否 |
| 最终完整模拟 | 发起 `eth_call` | 被调用 | 提供执行入口 |
| 逐 Tick 最终成交 | 可预测 | 是 | 不重复实现 |
| Callback 鉴权和付款 | 否 | 发起 Callback | 是，直接调用 Pool 时 |
| 闪电贷还款 | 否 | 检查还款 | 是 |
| 原子 `minProfit` | 事前估算 | 否 | 是 |
| 历史交易和事件解析 | 是 | 发出事件 | 否 |

推荐系统结构：

```text
Pool Indexer
  → State Reader
  → Quote Adapters
  → Route Graph
  → Opportunity Evaluator
  → Execution Simulator
  → Solidity Executor
```

## 十、自测问题与答案

### 1. 为什么 V4 不能只用 PoolManager 地址标识一个 Pool？

一个 PoolManager 同时管理大量逻辑 Pool，所有 Swap 日志也可能由同一 Manager 发出。必须使用 `PoolId` 区分内部状态；跨链数据库中应使用 `chainId + PoolManager + PoolId`。

### 2. PoolKey 中为什么必须包含 Hook 和 tickSpacing？

Tick Spacing 决定可初始化边界和流动性网格，Hook 决定生命周期扩展、动态费率和额外 Delta。相同 Currency 和 fee、但 Tick Spacing 或 Hook 不同的市场，执行行为和状态都不同，必须是不同 Pool。

### 3. PoolId 如何计算，为什么执行 Swap 时仍需完整 PoolKey？

```text
PoolId = keccak256(abi.encode(PoolKey))
```

PoolId 只适合索引状态。执行时还需要 PoolKey 中的 Currency、fee、tickSpacing 和 Hook 来完成结算、逐 Tick Swap 和 Hook 调用，所以 `PoolManager.swap` 接收完整 PoolKey。

### 4. unlock 结束前为什么所有 Currency Delta 必须归零？

unlock 允许调用者暂时欠 PoolManager 资产或拥有应收资产。如果允许非零 Delta 离开交易，就会形成无抵押坏账或未领取权益。归零检查使 Flash Accounting 只在本次原子交易内有效。

### 5. 正 Delta 和负 Delta 分别代表谁欠谁？

以调用者为观察主体：正 Delta 表示 PoolManager 欠调用者，可 `take`；负 Delta 表示调用者欠 PoolManager，必须转入资产并 `settle`。

### 6. ERC-20 结算为什么通常要先 `sync`，原生 ETH 有何不同？

ERC-20 转账不会把到账数量作为函数返回给 PoolManager，`sync` 先保存余额基准，转账后 `settle` 才能用余额差确认到账。原生 ETH 可以随 payable `settle{value: amount}` 一起发送，因此不走相同的 ERC-20 基准流程。

### 7. V3 和 V4 的 `amountSpecified` 符号语义有什么差异？

| 入口 | Exact Input | Exact Output |
| --- | --- | --- |
| V3 `Pool.swap` | 正数 | 负数 |
| V4 `PoolManager.swap` | 负数 | 正数 |

方向 `zeroForOne` 的含义不变，但共用执行代码时必须显式隔离数量符号。

### 8. Hook 地址权限位说明什么，为什么仍然需要阅读 Hook 代码？

权限位只说明 PoolManager 会调用哪些 Hook 生命周期函数，以及是否允许返回 Delta；它不说明费率算法、外部依赖、管理员权限、代理升级、重入行为和失败条件。自动执行前必须审查实际代码和状态依赖。

### 9. 为什么带 Hook Pool 的报价必须使用真实 `hookData` 执行 Hook？

Hook 可能根据 `hookData` 选择费率、用户规则或自定义 Delta。使用空数据或不同数据得到的报价不一定对应最终交易，可信报价必须复现相同 PoolKey、调用者、hookData 和区块状态。

### 10. 为什么 `Swap` 事件可能不足以解释 Hook Pool 的最终资产变化？

PoolManager 的 Swap 事件主要描述基础 Pool 变化和 Swap 后状态。Hook 可能返回额外 Delta、转移 Token 或执行外部调用，所以最终调用者余额还要结合 Hook 事件、trace、Router 返回值和实际 Token Transfer。

### 11. StateView、Hook 状态和 Quoter 为什么必须固定在同一 blockTag？

如果价格来自区块 N、流动性来自 N+1、Hook 费率来自 N+2，就会构造出链上从未同时存在的虚假状态和利润。相同 blockTag 保证所有输入属于同一状态快照。

### 12. 未知 Hook 为什么不能直接进入自动套利执行器？

未知 Hook 可能改变费率和输入输出、依赖可操纵状态、恶意转账、升级、消耗异常 Gas 或直接 revert。完整模拟只能证明某个区块状态下成功，不能替代代码审查和白名单边界。

## 十一、今日总结

1. V4 仍然有 Pool，但它是 PoolManager 内部由 PoolId 索引的逻辑状态，而不是独立合约。
2. V3 多跳跨多个 Pool 合约逐池结算；V4 在一次 unlock 中修改多个 PoolId 状态，并用 Currency Delta 抵消中间资产。
3. PoolManager 不负责寻找路径，路径搜索仍由 Router、执行合约或 Python 完成。
4. 闪电贷和原子执行必须依赖同一笔 EVM 交易；失败时状态回滚，但 Gas 不返还。
5. Python 适合做 Pool 索引、图搜索、报价筛选和 `eth_call` 编排；Solidity 负责 Callback、还款和最终 `minProfit`。
6. 第一版系统应先支持单链 Uniswap V2/V3：V2 本地精确报价，V3 使用 Quoter；稳定后再接 V4 无 Hook Pool、白名单 Hook 和其他 DEX。
7. 主网热门池简单套利竞争激烈，学习目标应先是准确发现、复现和模拟，而不是直接假设可以稳定盈利。

## 后续实践

- [ ] 建立按链配置的 DEX Deployment Registry。
- [ ] 扫描 V2 `PairCreated`、V3 `PoolCreated`、V4 `Initialize` 并保存统一 PoolDescriptor。
- [ ] 使用 SQLite 保存索引游标、blockHash 和 Pool 元数据，处理增量同步与重组。
- [ ] 构建 Token 有向图，搜索同链 2～3 跳循环。
- [ ] 实现标准 V2 整数报价 Adapter。
- [ ] 接入 V3 QuoterV2，并对三个输入规模做固定区块报价。
- [ ] 部署最小 Solidity Executor，对完整路径执行 `eth_call + estimateGas + minProfit`。
- [ ] V4 第一版仅支持无 Hook Pool，未知 Hook 只发现、不执行。

## 官方源码与资料

- [Uniswap V2 Core](https://github.com/Uniswap/v2-core)
- [Uniswap V3 Core](https://github.com/Uniswap/v3-core)
- [Uniswap V3 Periphery](https://github.com/Uniswap/v3-periphery)
- [Uniswap V4 Core](https://github.com/Uniswap/v4-core)
- [PoolManager](https://github.com/Uniswap/v4-core/blob/main/src/PoolManager.sol)
- [IPoolManager](https://github.com/Uniswap/v4-core/blob/main/src/interfaces/IPoolManager.sol)
- [PoolKey](https://github.com/Uniswap/v4-core/blob/main/src/types/PoolKey.sol)
- [PoolId](https://github.com/Uniswap/v4-core/blob/main/src/types/PoolId.sol)
- [Hooks](https://github.com/Uniswap/v4-core/blob/main/src/libraries/Hooks.sol)
- [StateLibrary](https://github.com/Uniswap/v4-core/blob/main/src/libraries/StateLibrary.sol)
- [Aave V3 Flash Loan Receiver](https://github.com/aave-dao/aave-v3-origin/blob/main/src/contracts/misc/flashloan/interfaces/IFlashLoanSimpleReceiver.sol)
