# Day 03：Uniswap V3 结构与 Pool 状态

## 今日目标

给定 Ethereum 主网 V3 Pool，在同一固定区块输出币对、费率、当前价格、Tick 和有效流动性，并理解报价与执行链路。

## 一、V3 合约分层

V3 分为 Core 和 Periphery：

```text
用户/程序
  ├─ SwapRouter ───────────────→ Pool.swap
  ├─ Quoter ───────────────────→ Pool.swap（模拟后 revert）
  └─ NonfungiblePositionManager → Pool.mint/burn/collect

Factory ── createPool/getPool ─→ Pool
```

| 合约 | 层级 | 核心职责 |
| --- | --- | --- |
| `UniswapV3Factory` | Core | 创建、登记 Pool，管理 `fee → tickSpacing` |
| `UniswapV3Pool` | Core | 持有 Token 和全部 AMM 状态，执行逐 Tick Swap、流动性与 Oracle 记账 |
| `SwapRouter` | Periphery | 组织单跳/多跳交易、检查期限和滑点、在 Callback 中付款 |
| `Quoter` | Periphery | 调用真实 `Pool.swap` 模拟报价，通过 revert 返回结果，不适合链上高频调用 |
| `NonfungiblePositionManager` | Periphery | 以 ERC-721 表示用户仓位，代理调用 Pool 的 `mint/burn/collect` |

每个池子都是独立部署的 `UniswapV3Pool` 合约实例，有独立地址、Storage 和 Token 余额；它不是继承 Pool 的子合约。同一个 Factory 内：

```text
Pool 唯一身份 = sort(tokenA, tokenB) + fee
```

Factory 使用 CREATE2 部署 Pool，salt 为 `keccak256(abi.encode(token0, token1, fee))`，因此外围合约可以确定性计算地址。`createPool()` 只部署；新池还需调用 `initialize(sqrtPriceX96)` 设置初始价格。

## 二、核心接口速查

### Factory

```solidity
createPool(tokenA, tokenB, fee) returns (pool)
getPool(tokenA, tokenB, fee) view returns (pool)
feeAmountTickSpacing(fee) view returns (tickSpacing)
```

- Token 输入顺序任意，Factory 按地址排序为 `token0 < token1`。
- `fee` 单位为百万分之一：`500 = 0.05%`、`3000 = 0.30%`、`10000 = 1%`。

### Pool

```solidity
initialize(sqrtPriceX96)
mint(recipient, tickLower, tickUpper, liquidity, data)
burn(tickLower, tickUpper, liquidity)
collect(recipient, tickLower, tickUpper, amount0Requested, amount1Requested)
swap(recipient, zeroForOne, amountSpecified, sqrtPriceLimitX96, data)
flash(recipient, amount0, amount1, data)
```

`swap` 参数：

| 参数 | 含义 |
| --- | --- |
| `recipient` | 输出 Token 接收地址 |
| `zeroForOne` | `true`：token0→token1，价格/Tick 下降；`false`：token1→token0，价格/Tick 上升 |
| `amountSpecified` | 正数为 Exact Input；负数为 Exact Output |
| `sqrtPriceLimitX96` | 本次 Swap 在该方向上不可越过的单池价格边界 |
| `data` | 原样传给 Callback 的上下文 |

Pool 可以跨越多个 Tick，但输入耗尽或当前价格触及 `sqrtPriceLimitX96` 时停止。这个参数限制的是价格，不是 Tick 数量；它不会保存为 Pool 配置。成功 Swap 会改变 `slot0.sqrtPriceX96`，传入的 limit 本身不变。

### SwapRouter

```solidity
exactInputSingle({tokenIn, tokenOut, fee, recipient, deadline,
                  amountIn, amountOutMinimum, sqrtPriceLimitX96})
exactInput({path, recipient, deadline, amountIn, amountOutMinimum})
exactOutputSingle({tokenIn, tokenOut, fee, recipient, deadline,
                   amountOut, amountInMaximum, sqrtPriceLimitX96})
exactOutput({path, recipient, deadline, amountOut, amountInMaximum})
```

- `amountOutMinimum`：整条路径最终最少收到多少。
- `amountInMaximum`：整条路径最多支付多少。
- `sqrtPriceLimitX96`：单个 Pool 的价格运动边界。Router 接收 0 时会替换成协议极限。
- Exact Input 多跳路径：`tokenA | feeAB | tokenB | feeBC | tokenC`；Exact Output 反向编码。

### Quoter

```solidity
quoteExactInputSingle(tokenIn, tokenOut, fee, amountIn, sqrtPriceLimitX96)
quoteExactInput(path, amountIn)
quoteExactOutputSingle(tokenIn, tokenOut, fee, amountOut, sqrtPriceLimitX96)
quoteExactOutput(path, amountOut)
```

Quoter 不自己维护另一套 AMM 公式，而是调用真实 `Pool.swap()`。在 Callback 中把结果写入 revert data 并故意回滚，外层 `try/catch` 解析报价；通常通过 `eth_call` 使用。

### NonfungiblePositionManager

```solidity
createAndInitializePoolIfNecessary(token0, token1, fee, sqrtPriceX96)
mint({token0, token1, fee, tickLower, tickUpper,
      amount0Desired, amount1Desired, amount0Min, amount1Min,
      recipient, deadline})
increaseLiquidity({tokenId, amount0Desired, amount1Desired,
                   amount0Min, amount1Min, deadline})
decreaseLiquidity({tokenId, liquidity, amount0Min, amount1Min, deadline})
collect({tokenId, recipient, amount0Max, amount1Max})
positions(tokenId)
burn(tokenId)
```

实际 ERC-20 在 Pool 中；Core Position 的 owner 通常是 PositionManager；用户钱包里的 NFT 和 PositionManager 的内部账本表示控制权与经济权益。

## 三、Callback 的工作机制

Callback 不是 EVM 特殊语法，而是合约间同步外部调用：

```text
EOA → Router.exactInputSingle       Router 中 msg.sender = EOA
    → Pool.swap                     Pool 中 msg.sender = Router
        → Router.swapCallback       Callback 中 msg.sender = Pool
```

Swap 流程：

1. Pool 根据当前价格、有效流动性和 Tick 状态逐段计算。
2. Pool 得到 `amount0Delta/amount1Delta`，负数表示 Pool 输出，正数表示 Pool 应收。
3. Pool 先发送输出 Token，再调用 `msg.sender.uniswapV3SwapCallback(...)`。
4. Router 验证 `msg.sender` 是规范 Factory 对应的真实 Pool。
5. Router 从 payer 向 Pool 支付正 Delta 对应的 Token。
6. Pool 比较 Callback 前后余额；付款不足则 revert，整条交易原子回滚。

V3 需要先完成逐 Tick 计算才能知道精确付款额。Callback 也使多跳、闪电组合和自定义结算可以在同一交易调用栈内完成。主要回调有 `uniswapV3MintCallback`、`uniswapV3SwapCallback` 和 `uniswapV3FlashCallback`。

## 四、价格、Tick 与有效流动性

```text
rawPrice(token1/token0) = 1.0001^tick
sqrtPriceX96 = sqrt(rawPrice) × 2^96
humanPrice(token1/token0)
  = rawPrice × 10^(decimals0-decimals1)
```

- `slot0.sqrtPriceX96`：当前精确价格，Swap 后可能改变。
- `slot0.tick`：当前对数价格坐标，用于定位区间。
- `liquidity()`：当前价格区间有效的 L，不是 TVL。
- `tickSpacing`：LP 可选边界 Tick 的间隔。
- `liquidityGross`：以某 Tick 为边界的总流动性。
- `liquidityNet`：从左向右穿越该 Tick 时有效 L 的变化量。
- Position 仅在 `[tickLower, tickUpper)` 内活跃并赚取手续费。

`zeroForOne` 必须由 Pool 的 Token 顺序判断，不能根据符号或价格猜测：

```text
tokenIn == token0 → zeroForOne = true  → sqrtPrice/Tick 下降
tokenIn == token1 → zeroForOne = false → sqrtPrice/Tick 上升
```

## 五、报价、执行与最少收到

最终权威金额由 Pool 中的 `SwapMath.computeSwapStep` 和 `SqrtPriceMath` 逐 Tick 计算：

```text
前端/路由服务搜索候选路径
  → Quoter 或链下模拟得到 expectedAmountOut
  → 根据用户滑点计算 amountOutMinimum
  → SwapRouter 调 Pool 执行并检查 amountOut >= amountOutMinimum
```

例如预期 `3500 USDC`、滑点 `0.5%`：

```text
amountOutMinimum = floor(3500 × 0.995) = 3482.5 USDC
```

优化方向：固定同一 `blockTag`，缓存 Token/fee/tickSpacing 等静态数据，批量读取状态，在本地同步 `slot0 + liquidity + tickBitmap + initialized ticks` 并实现整数逐 Tick 报价，只用 Quoter/`eth_call` 验证少量候选路径。不能只用当前现货价格乘输入量，因为会漏掉手续费、价格影响和跨 Tick 流动性变化。

## 六、今日实现与运行

代码：

- `day03/src/v3_pool_snapshot.py`：价格转换和固定区块 Pool 快照。
- `day03/test/test_v3_pool_snapshot.py`：零依赖最小测试。
- `day03/snapshot/weth_usdc_005_block_25703592.json`：主网固定区块验收结果。

运行测试：

```powershell
python -m unittest discover -s day03/test -v
```

读取 Ethereum 主网 WETH/USDC 0.05% Pool；程序先读取最新块号，再把全部调用固定到该区块：

```powershell
$env:ETH_RPC_URL = "https://你的以太坊RPC"
python day03/src/v3_pool_snapshot.py
```

也可以指定历史区块和其他 Pool：

```powershell
python day03/src/v3_pool_snapshot.py --block 23000000 --pool 0x...
```

输出字段：

| 字段 | 来源 | 套利用途 | 实时读取 |
| --- | --- | --- | --- |
| `sqrt_price_x96` | `slot0` | 精确价格和报价起点 | 是 |
| `tick` | `slot0` | 定位当前区间 | 是 |
| `liquidity` | Pool | 当前区间深度 | 是 |
| `tick_spacing` | Pool | Tick 扫描规则 | 否 |
| `fee` | Pool | 手续费计算和 Pool 身份 | 否 |
| Token decimals | ERC-20 | Human Price 修正 | 否 |

## 七、错误检查

- Token 顺序：始终读取 `token0()`/`token1()`，并验证 `token0 < token1`。
- Decimals：Human Price 必须乘 `10^(decimals0-decimals1)`。
- 平方：`sqrtPriceX96 / 2^96` 后还要平方。
- 精度：链上整数使用 `int`，价格使用 `Decimal`，不使用二进制 `float`。
- 一致区块：先锁定区块号，之后所有 `eth_call` 使用相同 blockTag。
- V3 余额：Pool Token 余额不是 V2 reserves，不能套用 `x*y=k` 直接报价。

## 完成情况

- [x] 说明五个核心合约的职责与接口。
- [x] 说明 Callback、`zeroForOne` 和 `sqrtPriceLimitX96`。
- [x] 实现 Tick、Q64.96、decimals 和正反价格转换。
- [x] 实现同区块 Pool/Token 状态读取。
- [x] 添加 Token 顺序、非法 decimals、零价格和精度测试。
- [x] 生成并保存区块 `25703592` 的真实 Pool 快照。
- [ ] 扫描当前 Tick 左右相邻的已初始化 Tick（顺延 Day04）。

## 官方资料

- [Uniswap V3 Core](https://github.com/Uniswap/v3-core)
- [Uniswap V3 Periphery](https://github.com/Uniswap/v3-periphery)
- [Uniswap V3 Development Book](https://uniswapv3book.com/)
