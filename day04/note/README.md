# Day 04：Uniswap V3 Swap、报价验证与真实交易复现

## 今日目标

Day03 解决“Pool 当前是什么状态”，Day04 继续解决“输入一笔交易后，Pool 如何计算输出并改变状态”。今天的重点不是背诵全部数学库，而是建立套利程序需要的验证闭环：

```text
固定区块读取状态
  → 轻量筛选候选机会
  → Quoter 精确报价
  → 对最终执行 calldata 做 eth_call
  → estimateGas 并计算净利润
  → 链上 minProfit 再校验
  → 发送或放弃
```

需要掌握：

- 单个 Tick 区间内如何计算，以及 Swap 如何跨越初始化 Tick。
- `zeroForOne`、Exact Input、Exact Output 和 `sqrtPriceLimitX96` 的含义。
- Router → Pool → Callback 的调用链与 Callback 的安全边界。
- 瞬时价格、Quoter 报价和完整执行模拟之间的区别。
- 如何从交易、回执和 Pool 的 `Swap` 事件还原真实成交。

## 一、Swap 的状态机

`UniswapV3Pool.swap()` 先把当前 `slot0` 和有效流动性复制到内存中的 Swap 状态，然后循环处理剩余数量：

```text
读取 sqrtPriceX96、tick、liquidity
  → 按方向从 tickBitmap 找下一候选 Tick
  → 取“下一 Tick 价格”和“sqrtPriceLimitX96”中更近的目标价格
  → SwapMath.computeSwapStep 计算本步 amountIn、amountOut、feeAmount
  → 输入未耗尽且到达初始化 Tick：执行 Tick.cross
  → 按 liquidityNet 更新当前有效 liquidity
  → 继续处理剩余数量，直到数量耗尽或触及价格边界
  → 写回 slot0、liquidity、手续费增长并结算 Token
```

循环的停止条件只有两个：`amountSpecifiedRemaining == 0`，或者当前价格到达 `sqrtPriceLimitX96`。一次 Swap 可以经过多个未初始化 Tick 和多个初始化 Tick；只有跨过初始化 Tick 才会改变当前区间的有效流动性。

### 方向与数量符号

Pool 的 Token 顺序由地址排序确定，方向不能根据 Symbol 或“买入/卖出”的口语猜测。

| 条件 | 输入 / 输出 | 价格移动 | Tick 移动 |
| --- | --- | --- | --- |
| `zeroForOne = true` | token0 → token1 | `sqrtPriceX96` 下降 | 下降 |
| `zeroForOne = false` | token1 → token0 | `sqrtPriceX96` 上升 | 上升 |

`amountSpecified` 的符号决定 Swap 类型：

| `amountSpecified` | 类型 | 已知量 | 求解量 |
| --- | --- | --- | --- |
| `> 0` | Exact Input | 输入上限 | 最大输出 |
| `< 0` | Exact Output | 目标输出 | 所需输入 |

Pool 返回值和 `Swap` 事件中的 `amount0`、`amount1` 都以 **Pool 为观察主体**：

- 正数：Pool 收到该 Token，也是交易者的输入。
- 负数：Pool 发出该 Token，也是交易者的输出。
- 正常的两 Token Swap 中，二者应一正一负。

因此方向也可以由事件验证：

```text
amount0 > 0 且 amount1 < 0 → token0 输入，token1 输出，zeroForOne = true
amount0 < 0 且 amount1 > 0 → token1 输入，token0 输出，zeroForOne = false
```

展示给用户时再分别除以 Token 的 `10 ** decimals`，不能直接把事件中的原始整数当成人类可读数量。

### 手续费与单步计算

Exact Input 的每一步先从可用输入中计提手续费，剩余部分才推动价格。核心关系可以概括为：

```text
本步总输入 = amountIn + feeAmount
本步输出   = amountOut
```

当剩余输入足以到达本步目标价格时，价格移动到目标；否则根据剩余输入求出区间内的新价格并结束。最终输出不是“输入数量 × 当前现货价格”，因为它同时受手续费、当前有效流动性、价格影响和沿途 Tick 流动性变化影响。

### 跨 Tick 后为何改变流动性

每个初始化 Tick 保存 `liquidityNet`。从低 Tick 向高 Tick 穿越时，将它加到当前有效流动性；反方向穿越时先取反再相加：

```text
向右（Tick 上升）跨越：L_next = L_current + liquidityNet
向左（Tick 下降）跨越：L_next = L_current - liquidityNet
```

原因是 LP 仓位只在 `[tickLower, tickUpper)` 内活跃。跨过仓位边界时，一部分流动性进入或离开当前价格区间。Pool 的 Token 总余额包含各个价格区间对应的资产，不能当作 V2 reserves 套用 `x * y = k`。

## 二、价格限制与滑点保护

`sqrtPriceLimitX96` 是 **单个 Pool 内的价格边界**：

- `zeroForOne = true` 时必须低于当前价格且高于协议最小值。
- `zeroForOne = false` 时必须高于当前价格且低于协议最大值。
- Router 收到 0 时，会替换成对应方向的协议极限附近值。

它与 Router 的数量保护不是同一件事：

| 参数 | 保护对象 | 典型用途 |
| --- | --- | --- |
| `sqrtPriceLimitX96` | 单池价格不能越过某边界 | 限制单池价格移动 |
| `amountOutMinimum` | Exact Input 最终至少收到多少 | 防止输出过少 |
| `amountInMaximum` | Exact Output 最多支付多少 | 防止输入过多 |
| `minProfit` | 整条套利路径的最低净收益 | 扣除各跳费用和执行成本后仍盈利 |

套利执行不能只设置宽松的 `sqrtPriceLimitX96`，也不能只相信链下报价；最终执行合约必须检查 `minProfit`，条件不满足时让整笔交易原子回滚。

## 三、Router、Pool 与 Callback

以单池 Exact Input 为例：

```text
用户或套利合约
  → SwapRouter.exactInputSingle(params)
  → UniswapV3Pool.swap(...)
  → Pool 逐步计算 amount0Delta / amount1Delta
  → Pool 先转出输出 Token
  → 调用发起方的 uniswapV3SwapCallback(...)
  → Callback 向 Pool 支付正数 Delta 对应的 Token
  → Pool 比较付款前后余额，不足则整笔交易 revert
```

Callback 是普通的同步外部调用，不是 EVM 特殊语法。直接调用 Pool 可以省去通用 Router 的路径处理成本，但不能绕过 Pool 手续费，也不能省略 Callback 付款。

### Callback 的安全边界

Callback 中不能相信调用参数携带的 Pool 地址，也不能用 `tx.origin` 鉴权。推荐的验证过程是：

1. 从可信上下文解码 `tokenA`、`tokenB` 和 `fee`。
2. 对 Token 地址排序。
3. 用规范 Factory 的 `getPool(token0, token1, fee)` 查询，或使用 Factory、salt 和 init code hash 确定性计算 Pool 地址。
4. 要求计算结果等于 `msg.sender`。
5. 只支付正数 Delta 对应的 Token，付款人和最大付款额也应受执行上下文约束。

否则攻击者可以直接调用 Callback，伪造 Delta，并尝试消耗执行合约自身余额或用户给 Router 的授权。

多跳时，上一池输出可以在同一调用栈中用于下一池付款；Exact Output 多跳还可能形成嵌套 Callback。无论路径如何组织，最终都必须满足每个 Pool 的余额检查以及执行合约的净利润检查。

## 四、三层报价验证

### 第一层：状态快照与轻量筛选

读取同一 `blockTag` 下的 `slot0`、`liquidity` 和必要的 Tick 数据，用于快速排除明显无利润的候选路径。`slot0` 只代表边际价格，不能代表指定数量的平均成交价格。

适合批量扫描，不适合作为发送交易的最终依据。

### 第二层：Quoter 精确报价

Quoter 使用真实 Pool Swap 路径做模拟，再从 revert data 中取出结果。它比只看 `slot0` 更接近真实成交，但仍有以下边界：

- 报价只对调用使用的区块状态有效。
- Quoter 调用较重，不适合在链上作为常规报价器。
- 单池报价成功不代表多 DEX 套利的 Callback、授权和利润检查都能成功。
- QuoterV2 还返回估算 Gas、Swap 后价格、跨越的初始化 Tick 数等诊断信息；这些不是最终交易回执。

对同一 Pool 至少比较三个输入规模，并记录：

| blockTag | 方向 | amountIn | amountOut | 平均成交价 | Gas Estimate | 价格影响 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 待实测 | USDC → WETH | 小额 |  |  |  |  |
| 待实测 | USDC → WETH | 中额 |  |  |  |  |
| 待实测 | USDC → WETH | 大额 |  |  |  |  |
| 待实测 | WETH → USDC | 小额 |  |  |  |  |
| 待实测 | WETH → USDC | 中额 |  |  |  |  |
| 待实测 | WETH → USDC | 大额 |  |  |  |  |

平均成交价必须用经 decimals 归一化后的实际输入和输出计算；价格影响应与 **Swap 前同一区块的边际价格** 比较。

费率更低的 Pool 不一定输出更多。另一个 Pool 可能拥有更有利的起始价格、更高的当前有效流动性、更密集的沿途流动性，或者更少的跨 Tick 价格影响。比较相同币对的池时，必须以同一 `blockTag`、同一方向、同一输入量的净输出为准。

### 第三层：模拟最终执行交易

发送前应使用与真实交易相同的 `to`、`from`、`value` 和 `data` 对最终套利合约执行 `eth_call`，随后再 `estimateGas`。这一步应覆盖：

- 所有 DEX 和所有跳数。
- Token 授权、余额、Callback 付款与还款。
- `amountOutMinimum` / `amountInMaximum`。
- 闪电贷或闪电兑换费用。
- 执行合约的 deadline、allowlist 和 `minProfit`。

净利润至少按以下口径判断：

```text
netProfit
  = finalAssetOut
  - initialAssetIn
  - protocolOrFlashFees
  - estimatedGas × maxFeePerGas（折算为同一计价资产）
  - safetyBuffer
```

`eth_call` 成功不保证打包时仍成功，因为 pending Swap、流动性变化、抢跑、区块重组和 base fee 变化都可能使模拟失效。

## 五、真实 Swap 的解析方法

### 需要收集的原始数据

给定交易哈希，固定保存：

1. 交易对象、发送者、`value`、input calldata 和 block number。
2. 交易回执的 `status`、logs、`gasUsed`、`effectiveGasPrice`。
3. Router 函数和参数；如果通过 Universal Router、聚合器或自定义合约进入，还要继续解析内部调用或 trace。
4. 每个目标 Pool 的 `Swap` 事件。
5. 交易前状态：优先读取 `blockNumber - 1`，更严谨时使用交易级 trace/state diff 获取同一区块内该交易执行前的状态。

### 解码 `Swap` 事件

事件定义为：

```solidity
event Swap(
    address indexed sender,
    address indexed recipient,
    int256 amount0,
    int256 amount1,
    uint160 sqrtPriceX96,
    uint128 liquidity,
    int24 tick
);
```

- 发出日志的合约地址就是 Pool 地址，不能只相信 Router calldata 中的路径。
- `sender` 是调用 Pool 并接收 Callback 的地址，通常是 Router 或执行合约，不一定是交易发起 EOA。
- `recipient` 是本跳输出接收者，多跳时可能是下一个 Pool、Router 或执行合约。
- `sqrtPriceX96`、`liquidity`、`tick` 都是 **本次 Swap 结束后的值**。
- 事件没有直接给出交易前 Tick 和价格；必须从交易前状态或 trace 获取。

实际执行成本：

```text
gasCostWei = receipt.gasUsed × receipt.effectiveGasPrice
```

如果是 EIP-1559 交易，不能用 `maxFeePerGas` 代替实际的 `effectiveGasPrice`。若要计算用户的完整经济成本，还要区分 L1/L2 的额外数据费、私有交易支付和 Builder/Validator bribe。

### 真实交易记录模板

| 字段 | 结果 |
| --- | --- |
| Transaction Hash | 待选择并固定 |
| Block Number / Block Hash |  |
| Transaction Status |  |
| Entry Contract / Function |  |
| Pool |  |
| token0 / token1 / Fee Tier |  |
| Token In / Amount In |  |
| Token Out / Amount Out |  |
| `zeroForOne` |  |
| Tick Before / After |  |
| `sqrtPriceX96` Before / After |  |
| Liquidity Before / After |  |
| Gas Used / Effective Gas Price |  |
| Actual Gas Cost |  |
| 数据限制 | Archive / Trace 是否可用 |

如果 RPC 不支持 Archive 或 Trace，应明确把交易前状态标为不可用；不能用最新区块的 Quoter 结果冒充历史交易前报价。

## 六、按用途拆分最小 ABI

程序只保留实际调用和解析需要的片段，避免复制整份 ABI。

### Pool 发现

```solidity
function getPool(address tokenA, address tokenB, uint24 fee)
    external view returns (address pool);

event PoolCreated(
    address indexed token0,
    address indexed token1,
    uint24 indexed fee,
    int24 tickSpacing,
    address pool
);
```

### 状态监控与事件

```solidity
function token0() external view returns (address);
function token1() external view returns (address);
function fee() external view returns (uint24);
function tickSpacing() external view returns (int24);
function liquidity() external view returns (uint128);
function slot0() external view returns (
    uint160 sqrtPriceX96,
    int24 tick,
    uint16 observationIndex,
    uint16 observationCardinality,
    uint16 observationCardinalityNext,
    uint8 feeProtocol,
    bool unlocked
);
function ticks(int24 tick) external view returns (
    uint128 liquidityGross,
    int128 liquidityNet,
    uint256 feeGrowthOutside0X128,
    uint256 feeGrowthOutside1X128,
    int56 tickCumulativeOutside,
    uint160 secondsPerLiquidityOutsideX128,
    uint32 secondsOutside,
    bool initialized
);
function tickBitmap(int16 wordPosition) external view returns (uint256);

event Swap(
    address indexed sender,
    address indexed recipient,
    int256 amount0,
    int256 amount1,
    uint160 sqrtPriceX96,
    uint128 liquidity,
    int24 tick
);
```

### QuoterV2 单池 Exact Input

```solidity
struct QuoteExactInputSingleParams {
    address tokenIn;
    address tokenOut;
    uint256 amountIn;
    uint24 fee;
    uint160 sqrtPriceLimitX96;
}

function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
    external returns (
        uint256 amountOut,
        uint160 sqrtPriceX96After,
        uint32 initializedTicksCrossed,
        uint256 gasEstimate
    );
```

不同版本的 Quoter 参数布局和返回值不同，编码 calldata 前必须核对目标地址实际部署的 ABI，不能混用 Quoter 与 QuoterV2。

### SwapRouter 单池 Exact Input

```solidity
struct ExactInputSingleParams {
    address tokenIn;
    address tokenOut;
    uint24 fee;
    address recipient;
    uint256 deadline;
    uint256 amountIn;
    uint256 amountOutMinimum;
    uint160 sqrtPriceLimitX96;
}

function exactInputSingle(ExactInputSingleParams calldata params)
    external payable returns (uint256 amountOut);
```

Router02、Universal Router 与旧版 `SwapRouter` 的入口和 tuple 布局可能不同。解析真实交易时先用 4-byte selector 确认目标函数，再按目标合约版本解码。

### 直接调用 Pool 与 Callback

```solidity
function swap(
    address recipient,
    bool zeroForOne,
    int256 amountSpecified,
    uint160 sqrtPriceLimitX96,
    bytes calldata data
) external returns (int256 amount0, int256 amount1);

function uniswapV3SwapCallback(
    int256 amount0Delta,
    int256 amount1Delta,
    bytes calldata data
) external;
```

## 七、离线报价器的合理边界

第一版只实现“不跨初始化 Tick”的单区间报价器是合理的，但必须明确它的拒绝条件：当计算出的目标价格将越过下一初始化 Tick 时，返回“不支持”，而不是继续给出看似精确的错误结果。

推荐迭代顺序：

1. 整数实现单区间 Exact Input，覆盖两个方向。
2. 固定 `blockTag` 与官方 Quoter 逐例比较。
3. 加入 Exact Output、极小输入、极端 decimals 和向上取整测试。
4. 加入 `tickBitmap` 搜索。
5. 加入 `liquidityNet` 和跨 Tick 更新。
6. 再处理多跳路径、Gas 与缓存优化。

金额、Q64.96 价格和 Tick 数学必须使用整数或高精度十进制，不能使用二进制 `float`。每增加一种能力，都应使用固定区块状态、官方 Quoter 和边界测试交叉验证。

## 八、完成标准与结论

1. **为什么瞬时价格不能直接得出套利利润？** 交易本身会移动价格，还要扣除每个池的手续费、跨 Tick 深度变化、Gas、闪电贷费用和安全缓冲。
2. **跨过初始化 Tick 后有效流动性为何变化？** 集中流动性仓位只在指定价格范围内活跃，穿越边界会让仓位进入或离开当前区间。
3. **Quoter 与完整套利模拟有何区别？** Quoter 验证某个 V3 池或路径的协议报价；完整 `eth_call` 还验证其他 DEX、Callback、余额、授权、费用和 `minProfit`。
4. **Callback 为何必须验证真实 Pool？** Callback 会付款；不验证 `msg.sender` 会让伪造调用者尝试盗取合约余额或滥用授权。
5. **如何从交易哈希确定实际成交？** 解码入口 calldata 和 trace，用 Pool 日志地址确定池，由 `Swap.amount0/amount1` 的符号确定输入输出，再结合 decimals、交易前状态和回执计算价格变化与 Gas 成本。

## 完成情况

- [x] 梳理单区间计算、跨 Tick 与流动性更新流程。
- [x] 梳理 `zeroForOne`、Exact Input / Output 和三类价格/数量保护。
- [x] 梳理 Router → Pool → Callback 调用链与真实 Pool 校验。
- [x] 区分状态筛选、Quoter 与完整 `eth_call` 三层验证。
- [x] 整理发现、监控、报价、执行和 Callback 的最小 ABI。
- [x] 整理真实 Swap 解码步骤、符号规则和 Gas 成本公式。
- [ ] 在固定区块对 Day03 的 WETH/USDC 0.05% Pool 完成双向、三个输入规模的 Quoter 实测。
- [ ] 固定一笔主网 V3 Swap，填写完整交易记录并与交易前状态复核。
- [ ] 实现并测试不跨初始化 Tick 的离线报价器。

未完成的三项依赖可复现的 RPC/Archive/Trace 数据或新增实现，当前文档不填造数据，也不把最新状态当作历史状态。

## 官方源码与资料

- [Uniswap V3 Pool.swap 源码](https://github.com/Uniswap/v3-core/blob/main/contracts/UniswapV3Pool.sol)
- [SwapMath 源码](https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/SwapMath.sol)
- [Pool 事件接口](https://github.com/Uniswap/v3-core/blob/main/contracts/interfaces/pool/IUniswapV3PoolEvents.sol)
- [SwapRouter 源码](https://github.com/Uniswap/v3-periphery/blob/main/contracts/SwapRouter.sol)
- [QuoterV2 接口](https://github.com/Uniswap/v3-periphery/blob/main/contracts/interfaces/IQuoterV2.sol)
- [CallbackValidation 源码](https://github.com/Uniswap/v3-periphery/blob/main/contracts/libraries/CallbackValidation.sol)
