# Day 02：Uniswap V2 运作原理与 V3/V4 的变化

## 学习背景

今天从一个具体流程开始：代币创建后，如何通过 Uniswap V2 创建交易池、添加流动性、执行 Swap，
以及移除流动性。讨论过程中进一步追问了 Pair 是否可以直接调用、手续费和 K 如何变化、
Flash Swap 的作用，以及这些设计在 V3/V4 中发生了什么变化。

把整个生命周期画成一条线时，容易误以为它是一笔交易。实际上通常由多笔交易组成：

```text
部署 Token
→ Factory 创建 Pair（也可由首次 addLiquidity 顺带创建）
→ 用户 approve Router
→ 添加流动性
→ approve 并执行 Swap
→ approve LP Token 并移除流动性
```

其中一次 Router Swap 内部的 Token 转账、Pair 校验和储备更新属于同一笔原子交易；完整生命周期则
不是天然的一笔交易。

## 一、V2 的合约与角色

```text
Factory
└─ 创建和登记 Pair

Pair
├─ 持有两种 Token
├─ 保存 reserve0/reserve1
├─ 执行 mint/burn/swap
└─ 自身也是 ERC-20 LP Token 合约

Router02
├─ 查找 Pair、读取储备和计算数量
├─ 从用户钱包转入 Token
├─ 编排 addLiquidity/removeLiquidity/swap
└─ 提供 minimum、deadline、多跳和 WETH 处理
```

| 角色 | 主要行为 |
| --- | --- |
| Pair 创建者 | 调用 `Factory.createPair` 并支付 Gas，不因此获得 Pair 所有权 |
| LP | 投入两种 Token，获得 Pair 发行的 ERC-20 LP Token |
| Trader | 授权并调用 Router，或通过自定义合约直接调用 Pair |
| Router02 | 无状态外围合约，正常情况下不长期持有池中资产 |
| Pair | Core 状态机，不信任 Router，只验证余额、手续费和不变量 |

### ETH 为什么要变成 WETH

V2 和 V3 Core 都按 ERC-20 接口处理资产，原生 ETH 没有 `transferFrom/balanceOf/approve`，所以所谓
ETH/Token 池实际是 WETH/Token 池。`addLiquidityETH`、`swapExactETHForTokens` 等 Router 入口会在
边界处自动执行 `WETH.deposit/withdraw`。V4 Core 才原生支持 ETH。

### `transfer` 与 `transferFrom`

```text
transfer(to, amount)
→ 转走 Token 合约视角下 msg.sender 自己的余额

transferFrom(from, to, amount)
→ 转走 from 的余额
→ 需要 allowance[from][msg.sender] 足够
```

用户调用 Router 后，Router 再调用 Token，此时 Token 看到的 `msg.sender` 是 Router，不是用户。
所以输入 Token 的路径是：

```text
用户 approve Router
→ Router 调用 token.transferFrom(user, pair, amount)
```

Pair 输出 Token 时转的是自己的余额，因此使用 `transfer(to, amount)`。

## 二、Factory 与 Pair 的唯一性

V2 Factory 将地址排序为 `token0 < token1`，同一 Factory 中一组 Token 只能对应一个 Pair：

```text
createPair(A, B)
createPair(B, A)
```

会被视为同一币对；重复创建会以 `PAIR_EXISTS` 回滚。Pair 通过 CREATE2 部署并登记在
`getPair[token0][token1]` 中。创建成功只代表合约存在，此时储备和 LP supply 仍为零。

不同 Factory 可以为同一币对创建独立 Pair。它们可以近似理解为不同的 V2 市场或 DEX 部署，但不
严格等于不同品牌：同一个项目可以在不同链或不同时期部署多个 Factory，任何人也能部署 V2 Fork。

> [!IMPORTANT]
> **套利相关：独立池之间的价差。** 不同 Factory 下的同币对 Pair 拥有独立储备和价格，因此可能
> 出现跨 DEX 套利。同一 Factory 内也可能通过直接路径和多跳路径形成三角套利。价差只有在覆盖
> 手续费、Gas、价格影响、MEV 与失败风险后，才是可执行利润。

## 三、添加流动性

### Router 如何选择实际投入数量

用户向 Router 提供：

```text
amountADesired / amountBDesired：最多希望投入的数量
amountAMin / amountBMin：执行时能接受的最低实际投入数量
```

对于非空池，Router 先计算：

```text
amountBOptimal = amountADesired * reserveB / reserveA
```

`amountBOptimal` 表示：完整使用 `amountADesired` 时，为保持当前储备比例应该搭配多少 B。它不是
Swap 输出，也不是市场最优价格。

例如池中有 `1000 A / 2000 B`：

```text
desired = 100 A / 250 B
amountBOptimal = 100 * 2000 / 1000 = 200 B
实际投入 = 100 A / 200 B，剩余 50 B 留在钱包

desired = 100 A / 150 B
amountBOptimal = 200 B，但用户最多只有 150 B
amountAOptimal = 150 * 1000 / 2000 = 75 A
实际投入 = 75 A / 150 B，剩余 25 A 留在钱包
```

Router 尽量完整使用一侧，再按储备比例减少另一侧，避免增加流动性本身改变池价。

### `quote` 的作用

V2 Library 的 `quote(amountA, reserveA, reserveB)` 只做同比例换算：

```text
amountB = amountA * reserveB / reserveA
```

它不读取 Pair，也不计算手续费、价格影响或多跳，所以主要用于加池比例。真实 Swap 输出应使用
`getAmountOut`，不能把 `quote` 当作交易报价。

### Pair 如何铸造 LP Token

Router 将两种 Token 直接从用户钱包送进 Pair，再调用 `Pair.mint(to)`。Pair 不接收 amount 参数，
而是读取：

```text
amount0 = balance0 - reserve0
amount1 = balance1 - reserve1
```

首次添加：

```text
liquidity = sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY
```

后续添加：

```text
liquidity = min(
  amount0 * totalSupply / reserve0,
  amount1 * totalSupply / reserve1
)
```

V2 LP 凭证是同质化 ERC-20，不是 NFT。谁持有 LP Token，谁就拥有对应比例的赎回权。

### 是否必须使用 Router

不必须。任何人都能调用 Pair 的 `mint(to)`，但需要自己完成 Pair 验证、Token 排序、比例计算、
Token 转账和最低 LP 检查。安全的自定义执行必须在一笔交易中完成：

```text
transferFrom 两种 Token → Pair
→ Pair.mint(to)
→ 检查实际 LP 数量
```

Pair 不记录是谁转入了 Token。如果先裸转两种 Token、下一笔交易才 mint，第三方可以抢先调用
`mint(attacker)`，把基于这两笔未记账增量铸造的 LP 发给自己。

> [!IMPORTANT]
> **套利相关：不平衡加池。** 绕过 Router 按不同比例转入 Token 时，LP 铸造量取两侧份额的较小
> 值，多余一侧不会带来对应 LP，实质上部分捐赠给全体 LP，同时改变池价并制造套利机会。

## 四、V2 Swap 的完整调用关系

以 `swapExactTokensForTokens` 单跳交易为例：

| 环节 | 执行者 | 所在函数 |
| --- | --- | --- |
| 计算输出 | Router/Library | `getAmountsOut` |
| 检查最低输出 | Router | `amountOut >= amountOutMin` |
| 输入转入 Pair | Router → Token | `transferFrom(user, pair, amountIn)` |
| 发起交换 | Router → Pair | `Pair.swap(...)` |
| 反推实际输入 | Pair | 同一个 `Pair.swap()` 内部 |
| 手续费和 K 校验 | Pair | 同一个 `Pair.swap()` 内部 |
| 更新储备 | Pair | `swap()` 内部调用私有 `_update()` |

这些步骤属于同一笔 EVM 交易。Token 转账虽然是跨合约调用，仍处于同一调用栈；任意一步回滚时，
之前的 Token 转账、Pair 输出、储备变化和日志都会一起回滚。

### Pair 为什么只接收输出参数

底层接口是：

```solidity
swap(amount0Out, amount1Out, to, data)
```

Pair 先按调用者请求乐观转出 Token，然后读取实际余额，反推输入：

```text
amount0In = max(balance0 - (reserve0 - amount0Out), 0)
amount1In = max(balance1 - (reserve1 - amount1Out), 0)
```

Pair 不维护个人存款账本，也不记录哪笔余额属于谁。Token 的 `Transfer` 日志能显示转账来源，但
Pair 只关心最终余额是否足够。

`amountOutMin` 是用户的价格保护，由 Router 或自定义执行合约检查。Pair 不知道用户愿意接受多少
滑点，只判断调用者请求的输出能否通过不变量校验：请求太多会回滚，请求太少通常成功。少拿的价值
在 `_update` 后成为正式储备，归所有 LP 按份额共有，不能再被 `skim`。

### 手续费与 K

Router 使用 0.3% 手续费公式预计算输出：

```text
amountInWithFee = amountIn * 997
amountOut = amountInWithFee * reserveOut
          / (reserveIn * 1000 + amountInWithFee)
```

Pair 才是最终执行者。它根据真实输入校验：

```text
(balance0 * 1000 - amount0In * 3)
* (balance1 * 1000 - amount1In * 3)
>= reserve0 * reserve1 * 1000²
```

所以 Router 负责报价和保护，Pair 负责强制执行；直接调用 Pair 不能绕过手续费。

每笔 Swap 使用函数开始时的当前 `reserve0 * reserve1` 作为基准，其中已经包含此前留在池中的
手续费。Swap 成功后写入新储备，下一笔交易再使用新的 K。连续 Swap 且没有加减流动性时，原始
储备乘积通常因手续费和整数取整而增长。

`kLast` 是另一个概念：它记录最近一次 mint/burn 后的储备乘积，只用于可选协议费 `_mintFee`，
不是每次 Swap 的校验基准。

V2 LP 没有单独领取手续费的 `collect`。手续费与本金一起留在储备中，LP 通过 burn LP Token 按
比例取回。撤池会让绝对 K 下降，因为池子规模缩小，但 K 不会回到某个“初始值”；剩余手续费仍
属于剩余 LP。

### `skim` 与 `sync`

```text
skim(to)
→ 把 balance-reserve 的未记账余额发给 to
→ 不更新 reserve

sync()
→ 不转账
→ 把 reserve 更新为当前 balance
```

二者都可以由任何人调用。裸转进 Pair、尚未被 mint/swap/sync 计入储备的 Token 没有个人归属，
可能被第三方 skim 或利用。

### 是否可以直接调用 Pair.swap

可以。自定义合约可以在同一笔交易中完成：

```text
验证 Pair 来自可信 Factory
→ 读取 token0/token1 和储备
→ 计算 amountOut
→ 输入 Token 转入 Pair
→ Pair.swap
→ 检查实际输出或最低利润
```

在相同储备、输入、路径和手续费下，直接调用与 Router 的最大输出相同。直接调用的优势是固定路径
和潜在 Gas 节省，代价是调用者必须自己实现所有安全检查。普通 EOA 不应把 `transfer → swap` 拆成
两笔交易，因为交易之间的未记账输入可能被其他人利用。

> [!IMPORTANT]
> **套利相关：直接调用 Pair。** 套利合约经常让第一池的输出直接进入下一池，以减少中转和通用
> Router 逻辑。但它不能突破 0.3% 手续费或恒定乘积，优势仅来自原子组合、固定路径和 Gas 优化。

## 五、Flash Swap

Flash Swap 不是独立函数，而是 V2 `Pair.swap(..., data)` 在 `data.length > 0` 时的内置模式：

```text
Pair 先把输出 Token 发给 to 合约
→ 调用 to.uniswapV2Call(...)
→ 接收合约使用资产执行其他操作
→ callback 结束前向 Pair 付款
→ Pair 校验余额、手续费和 K
```

付款不足时，整笔交易和最初输出都会回滚。Uniswap 部署的 Pair 提供这个能力，用户或套利者自行
部署实现 `uniswapV2Call` 的执行合约。

> [!IMPORTANT]
> **套利相关：Flash Swap。** 它可以先使用 Pair 资产在另一 DEX 套利、执行清算或置换抵押品，再
> 在同一交易内偿还，降低预置本金要求。但它不会创造利润，净收益仍必须覆盖全部手续费、Gas、
> 价格影响和 MEV 风险；callback 还必须验证调用者是真实 Pair。

## 六、移除流动性

用户先授权 Router 使用 LP Token，然后调用 `removeLiquidity`：

```text
Router 将 LP Token 从用户转到 Pair
→ Pair.burn(to)
→ 按 liquidity / totalSupply 计算两侧资产
→ 销毁 LP Token并转出两种 Token
→ 更新储备
```

取回的是当前储备构成，不是最初存入数量，其中已经包含手续费、交易造成的资产比例变化和无常
损失。V2 最初锁定的 `MINIMUM_LIQUIDITY` 不能被普通 LP 取回。

## 七、这些概念在 V3 中如何变化

V3 没有名为 Pair 的合约，底层合约叫 `UniswapV3Pool`。口语仍可说“交易对”，但合约身份变成：

```text
V2 Pair：(token0, token1)
V3 Pool：(token0, token1, fee)
```

所以同一 V3 Factory 内就能存在多个同币对、不同费率的 Pool。

| V2 | V3 |
| --- | --- |
| Pair 保存 `reserve0/reserve1` | Pool 保存 `sqrtPriceX96`、tick、liquidity 和 Tick 状态 |
| 全池使用一个恒定乘积模型 | 按当前有效 L 在 Tick 区间内逐段计算 |
| Pair 发行同质化 ERC-20 LP | PositionManager 发行代表独立仓位的 NFT |
| 所有 LP 覆盖全价格范围 | LP 自选 `[tickLower, tickUpper)` |
| 手续费混入储备，只能随 burn 提取 | 按仓位记录 fee growth，可通过 `collect` 提取 |
| 普通 Swap 通常先把输入转入 Pair | Pool 计算后通过 callback 要求付款 |
| Flash Swap 嵌入 `swap(data)` | Pool 提供独立 `flash()` |
| 有 `skim/sync` | 没有 V2 风格的 `skim/sync` |

V3 官方流程中，用户是 Position NFT 的 owner；Core Pool 中的仓位 owner 通常是
`NonfungiblePositionManager`，NFT 代表用户对底层仓位的控制和经济权利。V3 Core 本身并不强制
所有集成都必须发行 NFT。

### Tick 与有效流动性 L

Tick 是对数价格坐标：

```text
price(token1/token0) = 1.0001^tick
sqrtPriceX96 = sqrt(price) * 2^96
```

价格可在 Tick 之间连续移动。只有被 LP 用作仓位边界的 Tick 需要初始化，仓位在
`[tickLower, tickUpper)` 内才 active。

L 不是 Token 数量或美元价值，而是当前价格区间的流动性深度。当前有效 L 是所有覆盖当前 Tick 的
仓位 liquidity 之和；L 越大，相同输入造成的价格移动越小。两个初始化 Tick 之间 L 不变，跨过
边界时根据该 Tick 的 `liquidityNet` 增减 L，再继续计算下一段。

因此 V3 没有描述整个 Pool 的固定全局 K；只在单个有效区间内，可以用虚拟储备理解为：

```text
x_virtual * y_virtual = L²
```

> [!IMPORTANT]
> **套利相关：V3 必须逐 Tick 报价。** 两个 Pool 即使显示价格接近，当前 Tick 附近的 L 和后续
> Tick 分布也可能完全不同。套利计算必须模拟跨 Tick 后的 liquidity 变化、费率、价格限制和整数
> 取整，不能只比较瞬时价格或 Pool 的 Token 总余额。

### V3 为什么用 callback 付款

V3 Swap 可能跨越多个 Tick，每次跨 Tick 都可能改变有效 L。Pool 完成逐段计算后，才能得到精确的
`amount0Delta/amount1Delta`，因此采用：

```text
Router 调用 Pool.swap
→ Pool 逐 Tick 计算并发送输出
→ Pool 调用 Router.uniswapV3SwapCallback
→ Router 支付正数 delta
→ Pool 检查 callback 前后余额
```

付款不足则整笔回滚。callback 的主要价值是：

- Pool 在完成复杂计算后精确收款；
- 不需要像 V2 那样预先向 Pool 裸转 Token；
- 付款来源可以是用户、Router、上一跳输出或其他原子化协议；
- 支持多跳和 exact-output 的递归结算；
- Core 不必绑定官方 Router。

callback 合约必须验证 `msg.sender` 是 Factory 对应的真实 Pool，否则攻击者可能伪造 callback 诱导
转账。V3 仍由 Core 强制执行手续费，直接调用 Pool 同样不能绕过。

## 八、V4 的进一步变化

V4 延续 Tick/L 集中流动性，但不再为每个池部署 Pair/Pool 合约，所有池状态集中在单例
`PoolManager` 中。PoolKey 还包含 fee、tickSpacing 和 hooks，因此同币对可以存在更多不同规则的
池。V4 官方 PositionManager 仍可用 NFT 表示仓位，但 Core 不强制所有流动性必须包装为 NFT。

V4 还加入 Hooks、动态费率、统一结算和原生 ETH。不同 Hook 可能改变费用或结算行为，因此分析
V4 套利时必须理解具体 Hook，不能机械套用 V3 报价逻辑。

## 九、今日结论

1. V2 Router 负责报价、编排和用户保护，Pair 负责资产、LP 会计、手续费与 K 的最终校验。
2. Pair 不记录转账者存款，直接交互必须在一笔交易内原子完成。
3. `quote` 用于同比例加池，`getAmountOut/getAmountIn` 才用于 Swap 报价。
4. 手续费留在储备中推动 K 增长；`kLast` 只服务可选协议费，不是 Swap 校验基准。
5. 直接调用 Pair 可以减少通用逻辑，但不能绕过手续费或获得额外输出。
6. Flash Swap 是 V2 Pair.swap 的 callback 模式，用于先使用资产、后在同一交易内付款。
7. V3 用 Pool、Tick、有效 L 和 Position NFT 取代 V2 的 Pair、全局储备 K 和同质化 LP Token。
8. V3 callback 让 Pool 在逐 Tick 计算后精确收款，并支持灵活的原子组合。

## 官方源码与资料

- [Uniswap V2 Factory 源码](https://github.com/Uniswap/v2-core/blob/master/contracts/UniswapV2Factory.sol)
- [Uniswap V2 Pair 源码](https://github.com/Uniswap/v2-core/blob/master/contracts/UniswapV2Pair.sol)
- [Uniswap V2 Router02 源码](https://github.com/Uniswap/v2-periphery/blob/master/contracts/UniswapV2Router02.sol)
- [Uniswap V2 Library 源码](https://github.com/Uniswap/v2-periphery/blob/master/contracts/libraries/UniswapV2Library.sol)
- [Uniswap V2 Flash Swap 官方说明](https://developers.uniswap.org/docs/protocols/v2/concepts/flash-swap)
- [Uniswap V3 Pool 源码](https://github.com/Uniswap/v3-core/blob/main/contracts/UniswapV3Pool.sol)
- [V3 NonfungiblePositionManager 源码](https://github.com/Uniswap/v3-periphery/blob/main/contracts/NonfungiblePositionManager.sol)
- [V3 SwapRouter 源码](https://github.com/Uniswap/v3-periphery/blob/main/contracts/SwapRouter.sol)
- [Uniswap V4 PoolManager 源码](https://github.com/Uniswap/v4-core/blob/main/src/PoolManager.sol)
