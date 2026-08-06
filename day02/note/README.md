# Day 02：Uniswap V2/V3 从建池到撤池的完整调用链

> 本日主线是 Uniswap V2，因为 `Pair`、`Router02`、LP ERC-20 都属于 V2。V3 不存在，但是V3继承了相关思想。
> `Pair` 和同质化 LP Token；对应概念是 `Pool`、`SwapRouter`、
> `NonfungiblePositionManager` 和代表仓位的 NFT。两套流程不能混用。

## 1. 今日产出与边界

- 追踪代币创建后，V2 的 `createPair → approve → addLiquidity → quote → swap → removeLiquidity`。
- 整理每一步的外部账户、合约账户、授权对象、资产流和事件。
- 解释 Factory、Pair、Router02、ERC-20 函数的参数和内部原理。
- 对照 V3 的建池、初始化、集中流动性、报价、交换和撤出流程。
- 理清直接调用 Pair、`skim/sync`、Flash Swap、手续费和 K 的边界。
- 为后续使用真实交易和 Python 复算链上结果建立验证清单。

必须先纠正一个表述：上面的生命周期通常不是“一笔交易”，而是多笔按顺序执行的交易。
创建两个代币本身还会再增加两笔部署交易。`approve` 也是独立交易，除非代币支持 permit，
或者使用自定义执行合约把允许组合的步骤原子化。一次普通 EOA 调用 Router02 不能同时完成
建池、加池、交换和撤池。

## 2. 账户、角色与信任边界

| 角色/账户 | 类型 | 持有什么 | 调用什么 | 是否有特权 |
| --- | --- | --- | --- | --- |
| Token 部署者 | EOA/部署合约 | 初始 Token、ETH | 部署 ERC-20 | 取决于 Token 是否保留 owner/mint/tax 权限 |
| Pair 创建者 | 任意 EOA/合约 | Gas 代币 | `Factory.createPair` | 没有；谁先创建都不能占有 Pair |
| LP | EOA/合约 | tokenA、tokenB | `approve`、`addLiquidity`、`removeLiquidity` | 没有；按 LP 份额拥有池中资产索取权 |
| Trader | EOA/合约 | 输入 Token | `approve`、Router swap | 没有 |
| Factory | 合约账户 | Pair 注册表 | 部署和登记 Pair | `feeToSetter` 可管理协议费接收设置 |
| Pair | 合约账户 | 两种底层 Token；自身也是 LP ERC-20 | `mint`、`burn`、`swap`、`skim`、`sync` | Core 状态机；只校验余额和不变量，不信任 Router |
| Router02 | 合约账户 | 正常情况下不长期留存资产 | 编排创建 Pair、转账、mint/burn/swap | 无 owner；用户只授权本次需要的 Token |
| WETH | 合约账户 | 托管 ETH 并发行 WETH | `deposit`、`withdraw` | 解决原生 ETH 不是 ERC-20 的问题 |
| 套利者/MEV 搜索者 | EOA/合约 | 执行资金 | 调用任意 Router 或直接调用 Pair | 将偏离的池价拉回；也可能抢跑/夹击宽松滑点交易 |
| RPC/前端 | 链下服务 | 不托管链上状态 | 报价、构造 calldata、广播 | 可能给出错误或过期信息，最终以链上执行为准 |

关键安全边界：`approve(spender, amount)` 的 spender 是 Router02，不是 Factory，也通常不是 Pair。
Router 随后调用 Token 的 `transferFrom(user, pair, amount)`，Token 合约检查的是
`allowance[user][router]`。

### 2.1 `transfer` 与 `transferFrom`

| 方法 | 资产来源 | 是否需要 allowance | V2 中的典型场景 |
| --- | --- | --- | --- |
| `transfer(to, amount)` | Token 合约视角下的 `msg.sender` | 不需要 | Pair 把输出 Token 发给用户；Router 把自己持有的 WETH 发给 Pair |
| `transferFrom(from, to, amount)` | 参数 `from` | 需要 `allowance[from][msg.sender]` | Router 从用户钱包把输入 Token 或加池 Token 直接送入 Pair |

用户调用 Router 时，进入 Token 合约的 `msg.sender` 已经是 Router，所以 Router 不能用
`transfer` 移动用户余额，只能在获得授权后调用 `transferFrom`。`approve` 只修改额度，不移动资产。

V2/V3 Core 都只处理 ERC-20，界面中的 ETH 池实际是 WETH/Token 池。使用 `addLiquidityETH`、
`swapExactETHForTokens` 等外围入口时，由 Router 在边界处执行 `WETH.deposit/withdraw`；V4 Core
才原生支持 ETH。

## 3. V2 合约关系与资产流

```text
用户 EOA
  ├─ createPair(tokenA, tokenB) ───────────────→ Factory
  │                                                └─ CREATE2 → Pair
  ├─ approve(router, amountA/B) ───────────────→ TokenA / TokenB
  ├─ addLiquidity(...) ─────────────────────────→ Router02
  │                                                ├─ transferFrom → Pair
  │                                                └─ Pair.mint(to) → LP Token
  ├─ swapExactTokensForTokens(...) ─────────────→ Router02
  │                                                ├─ input Token → first Pair
  │                                                └─ Pair.swap → output Token
  └─ removeLiquidity(...) ──────────────────────→ Router02
                                                   ├─ LP Token → Pair
                                                   └─ Pair.burn(to) → TokenA/B
```

Router02 是无状态编排器，不是资金池。Pair 的 ERC-20 `balanceOf(pair)` 是实际余额，
`reserve0/reserve1` 是上次 `_update` 固化的会计储备。Pair 利用两者的差值判断本次输入。

## 4. 步骤一：代币创建

典型 ERC-20 构造参数包括 `name`、`symbol`、初始供应量和接收者。真正影响 DEX 的不是名称，
而是以下行为：

- `decimals()`：只影响人类显示和链下换算，合约始终处理最小单位整数。
- `balanceOf` / `transfer` / `transferFrom` / `approve`：Router 所依赖的基本接口。
- 是否收转账税、rebasing、黑名单、暂停交易、最大钱包、可增发：这些都可能破坏标准 Router 的假设。
- token 地址：V2 用地址数值升序决定 `token0/token1`，与创建时参数顺序无关。

创建池前应做只读检查：代码是否已验证、总供应量、owner 权限、转账能否正常执行、
是否为代理合约，以及是否存在转账税或动态余额。

## 5. 步骤二：Factory 创建 Pair

### 5.1 外部调用

```solidity
Factory.createPair(address tokenA, address tokenB) returns (address pair)
```

参数：

- `tokenA/tokenB`：两个不同的非零 ERC-20 地址；顺序不重要。
- `msg.sender`：仅支付 Gas，不成为 owner，也不会自动获得 LP Token。

内部过程：

1. 按地址排序成 `token0 < token1`。
2. 检查两地址不同、`token0 != address(0)`、`getPair[token0][token1] == 0`。
3. 令 `salt = keccak256(abi.encodePacked(token0, token1))`。
4. 用 CREATE2 部署 `UniswapV2Pair`，因此地址可在部署前确定。
5. 调用 `pair.initialize(token0, token1)`；此函数只允许 Factory 调用一次。
6. 双向写入 `getPair`，追加 `allPairs`，发出 `PairCreated(token0, token1, pair, index)`。

创建后 `reserve0 = reserve1 = totalSupply = 0`；“有 Pair”不等于“有流动性”。
Router 的 `_addLiquidity` 在 Pair 不存在时也会代为调用 `createPair`，所以显式创建不是必需步骤。

### 5.2 同币对能否创建多个 Pair

同一 Factory 中，排序后的 `(token0, token1)` 只能对应一个 Pair；再次调用会以
`UniswapV2: PAIR_EXISTS` 回滚。换一个 Factory 则可以为相同币对创建另一个独立 Pair。

不同 Factory 可以近似理解为不同的 V2 市场或 DEX 部署，但不严格等于不同品牌：同一项目可能在
不同链或不同时期部署多个 Factory，任何人也都能部署 V2 Fork。监控时应使用
`chainId + factory + pair` 作为身份，而不是只看 DEX 名称。

> [!IMPORTANT]
> **套利相关：同币对的独立市场。** 不同 Factory 下的 A/B Pair 拥有独立储备和价格，因此可能形成
> 跨 DEX 套利。同一 Factory 内也可能通过 `A → B` 与 `A → C → B` 的路径差形成三角套利。
> V3 在同一 Factory 内就允许 `(token0, token1, fee)` 多池；V4 在同一 PoolManager 内允许由
> `currency0/currency1/fee/tickSpacing/hooks` 区分多个 Pool。套利的本质不是“品牌不同”，而是
> 独立流动性状态给出了足以覆盖手续费、Gas、价格影响、MEV 与失败风险的不同可成交价格。

## 6. 步骤三：授权与添加 V2 流动性

### 6.1 授权

```solidity
tokenA.approve(router, amountADesired)
tokenB.approve(router, amountBDesired)
```

授权只是修改 allowance，不会移动资产。无限授权减少后续交易次数，但扩大 Router/集成被攻击时的
风险面；学习和测试时建议精确授权。某些旧 Token 修改非零 allowance 前必须先设为零。

### 6.2 Router02.addLiquidity

```solidity
addLiquidity(
  tokenA, tokenB,
  amountADesired, amountBDesired,
  amountAMin, amountBMin,
  to, deadline
) returns (amountA, amountB, liquidity)
```

| 参数 | 原理 |
| --- | --- |
| `amountADesired/BDesired` | 最多希望投入的最小单位数量，不保证全部使用 |
| `amountAMin/BMin` | 状态变化后仍能接受的最低实际投入量；防止按过差比例加池 |
| `to` | 接收 LP Token 的地址，可以不同于付款人 |
| `deadline` | Unix 秒；矿工执行时必须 `block.timestamp <= deadline` |

Router 的 `_addLiquidity`：

1. 若 Pair 不存在则创建。
2. 读取储备，并按用户参数顺序映射 reserveA/reserveB。
3. 空池使用全部 desired，初始 LP 用自己的比例定义初始价格。
4. 非空池计算 `amountBOptimal = amountADesired * reserveB / reserveA`；若合规则使用它，
   否则反向计算 `amountAOptimal`。多余 Token 留在用户钱包。
5. 检查两个 minimum；任一不满足则整笔回滚。
6. `transferFrom` 两种 Token：用户直接转到 Pair。
7. 调用 `Pair.mint(to)`。

`amountBOptimal` 的准确含义是：如果完整使用 `amountADesired`，为了保持当前储备比例应搭配的 B
数量。它不是 Swap 输出，也不是“市场最优价格”。例如储备为 `1000 A / 2000 B`：

```text
用户 desired = 100 A / 250 B
amountBOptimal = 100 * 2000 / 1000 = 200 B
实际投入 = 100 A / 200 B，50 B 留在钱包

用户 desired = 100 A / 150 B
amountBOptimal = 200 B > 150 B
amountAOptimal = 150 * 1000 / 2000 = 75 A
实际投入 = 75 A / 150 B，25 A 留在钱包
```

`amountDesired` 是上限，`amountMin` 是执行保护。Router 总是尝试完整使用一侧，再按储备比例减少
另一侧，使增加流动性本身不改变池价。

### 6.3 Pair.mint 的内部原理

Pair 不接收 amount 参数，而是读取实际余额并计算：

```text
amount0 = balance0 - reserve0
amount1 = balance1 - reserve1
```

首次注入：

```text
liquidity = floor(sqrt(amount0 * amount1)) - MINIMUM_LIQUIDITY
MINIMUM_LIQUIDITY = 1000
```

1000 份 LP 永久铸给零地址，使 `totalSupply` 永不归零并降低某些份额操纵风险。后续注入：

```text
liquidity = min(
  floor(amount0 * totalSupply / reserve0),
  floor(amount1 * totalSupply / reserve1)
)
```

最后更新储备，发出 `Mint(sender, amount0, amount1)` 和 `Sync(reserve0, reserve1)`。
`Mint.sender` 通常是 Router，不一定是实际 LP；LP 接收者要结合 LP Token `Transfer` 判断。

### 6.4 是否必须通过 Router 添加流动性

不是。Pair 本身公开提供 `mint(to)`，任何地址都可以调用。底层顺序是：

```text
token0 → Pair
token1 → Pair
Pair.mint(LP接收者)
```

Pair 不接收 desired/min/deadline，也不会主动从用户钱包拉取 Token，只根据
`balance - reserve` 识别本次两侧增量。Router 的价值是创建/查找 Pair、排序 Token、按当前比例
选择实际投入、执行 `transferFrom`、检查 minimum/deadline 以及处理 ETH/WETH。

不能把直接调用拆成多笔公开交易。Pair 不记录是谁转入 Token；如果两侧都出现未记账增量，任何人
都能抢先 `mint(attacker)` 把 LP 铸给自己。安全的直接调用必须由自定义执行合约在同一笔交易中完成
`transferFrom → mint → minLiquidity 检查`，任一步失败则全部回滚。

`skim(to)` 同样是任何人可调用的底层函数：它把 `balance0-reserve0` 和
`balance1-reserve1` 发送给指定地址，但不更新储备；`sync()` 则不转账，直接把 reserve 更新为当前
balance。因此，裸转进 Pair、尚未被 `mint/swap/sync` 计入储备的 Token 不属于某个地址的存款，
可能被第三方取走或利用。

> [!IMPORTANT]
> **套利相关：不平衡加池与未记账余额。** 绕过 Router 按不同比例转入两种 Token 时，LP 铸造量
> 取两侧份额的较小值，多余一侧不会获得对应 LP，实质上部分捐赠给全体 LP，并会改变池价、制造
> 套利机会。若 `transfer → mint` 被拆成多笔交易，搜索者还可能抢先 mint 或 skim；专业执行必须
> 原子完成并校验 Pair 来源、比例和最低 LP 数量。

## 7. 步骤四：报价 amountIn / amountOut

V2 单跳、0.3% 输入手续费的精确输入公式：

```text
amountInWithFee = amountIn * 997
amountOut = floor(
  amountInWithFee * reserveOut
  / (reserveIn * 1000 + amountInWithFee)
)
```

已知精确输出反推最少输入：

```text
amountIn = floor(
  reserveIn * amountOut * 1000
  / ((reserveOut - amountOut) * 997)
) + 1
```

末尾 `+1` 很重要：整数除法向下取整，少这一单位可能无法通过 K 校验。

Router/Library 接口：

- `quote(amountA, reserveA, reserveB)`：不含手续费的同比例换算，用于加池。
- `getAmountOut(amountIn, reserveIn, reserveOut)`：单跳精确输入。
- `getAmountIn(amountOut, reserveIn, reserveOut)`：单跳精确输出。
- `getAmountsOut(amountIn, path)`：逐池把上一跳输出作为下一跳输入。
- `getAmountsIn(amountOut, path)`：从最后一跳向前反推。

这些函数只使用读取时的储备，不是价格承诺，也不是 Oracle。签名到上链之间可能发生状态变化。

`quote` 的实现只是保持比例：

```text
amountA / reserveA = amountB / reserveB
amountB = amountA * reserveB / reserveA
```

它是 `pure` 数学函数，不会自己读取 Pair，也不包含 0.3% 手续费、恒定乘积价格影响或多跳逻辑。
因此 `quote(100, 1000, 2000) = 200` 表示“加池时 100 A 应搭配 200 B”，不表示把 100 A
卖给池子能收到 200 B。真实 Swap 必须使用 `getAmountOut`，在同样储备下输出会因为手续费和价格
影响低于 200 B。

## 8. 步骤五：通过 Router02 执行 Swap

### 8.1 精确输入

```solidity
swapExactTokensForTokens(
  amountIn, amountOutMin, path, to, deadline
) returns (uint[] amounts)
```

- `amountIn`：固定支付数量。
- `amountOutMin`：全路径最终至少收到多少；不要简单设 0。
- `path`：至少两个 Token 地址，例如 `[A, WETH, B]` 代表两跳、两个 Pair。
- `to`：最终输出接收者。
- `deadline`：执行过期保护，不是“必须多久确认”的保证。

内部链路：

1. `getAmountsOut` 用当前储备计算每一跳 amounts。
2. 要求最终值 `>= amountOutMin`。
3. `transferFrom(msg.sender, firstPair, amounts[0])`。
4. `_swap` 遍历 path；根据 token0 顺序把输出填到 `amount0Out` 或 `amount1Out`。
5. 中间跳的 `to` 是下一 Pair，最后一跳的 `to` 才是用户指定接收者。
6. 每个 Pair 执行 `swap`、更新储备并发出 `Swap`、`Sync`。

单跳调用栈的职责边界如下。它们都是同一笔 EVM 交易，不是七笔交易：

| 步骤 | 执行者 | 所在函数 |
| --- | --- | --- |
| 计算输出 | Router/Library | `swapExactTokensForTokens → getAmountsOut` |
| 检查最低输出 | Router | `require(amounts[last] >= amountOutMin)` |
| 输入转入 Pair | Router → Token | `transferFrom(user, pair, amountIn)` |
| 发起底层交换 | Router → Pair | `Pair.swap(...)` 外部调用边界 |
| 反推实际输入 | Pair | 同一个 `Pair.swap()` 内部 |
| 手续费与 K 校验 | Pair | 同一个 `Pair.swap()` 内部 |
| 更新储备与事件 | Pair | `Pair.swap()` 内调用私有 `_update()` |

Token 转账虽然是跨合约调用，仍处在同一调用栈。任意 `require` 失败时，Router、Pair 和 Token 的
所有状态变化及日志全部回滚，用户只承担已消耗 Gas。只有人为把 `transfer(Pair)` 和 `Pair.swap()`
拆成两笔交易时才失去原子性。

### 8.2 Pair.swap

```solidity
swap(amount0Out, amount1Out, to, data)
```

底层参数是输出而不是输入。Pair 先乐观转出 Token；若 `data` 非空，再回调
`uniswapV2Call`，这就是 Flash Swap。随后读取实际余额，反推 `amount0In/amount1In`：

```text
amount0In = max(balance0 - (reserve0 - amount0Out), 0)
amount1In = max(balance1 - (reserve1 - amount1Out), 0)
```

再校验手续费调整后的恒定乘积：

```text
(balance0*1000 - amount0In*3)
* (balance1*1000 - amount1In*3)
>= reserve0 * reserve1 * 1000²
```

校验失败则包括之前 Token 转账在内全部回滚。成功后储备变为实际余额。手续费没有转给 Router，
而是留在池中，使 LP 每份对应的底层资产增长。

Pair 不维护“谁转入了多少”的个人存款账本。Token 的 `Transfer` 日志能显示来源，但 Pair 只观察
当前余额、旧 reserve 和本次输出。`Pair.swap` 也不替用户决定最小输出：调用者先指定
`amount0Out/amount1Out`，Pair 只判断该输出是否得到足够输入支持。请求太多会因 K 回滚；请求太少
通常成功，额外价值在 `_update` 后成为正式储备，归全体 LP 份额所有者，不能再被 `skim`。

### 8.3 手续费、K 与 `kLast`

Router 用 `997/1000` 公式预计算输出；Pair 则根据真实 `amountIn` 执行调整后余额的 K 校验。
所以直接调用 Pair 不会绕过 0.3% 手续费。手续费不是单独转给 Router 或逐个 LP，而是留在池中。

每次 Swap 的右侧基准是函数开始时读取的 `_reserve0 * _reserve1`，已经包含此前交易积累的手续费。
成功后 `_update` 写入新储备，下一笔交易以新的乘积为基准。在连续 Swap、没有加减流动性时，原始
`reserve0 * reserve1` 通常因手续费和整数取整增长；手续费调整后的不变量被要求不能下降。

`kLast` 是另一个变量：它记录最近一次 mint/burn 流动性事件后的储备乘积，只用于可选协议费
`_mintFee`，不是每次 Swap 的校验基准。V2 LP 也没有单独 `collectFees`：手续费与本金混在储备中，
只能通过 burn LP 按比例取回。撤池会同时减少两侧储备，所以绝对 K 下降约为
`K * (1 - withdrawnShare)^2`，但不会“回到初始 K”；剩余手续费仍按 LP 份额留在池中。

### 8.4 直接调用 Pair.swap

不强制经过 Router。自定义合约可以在一笔交易中完成：

```text
验证可信 Factory 与 Pair
→ 读取 token0/token1 和 reserve
→ 使用整数公式计算 amountOut
→ 输入 Token 转入 Pair
→ Pair.swap
→ 检查实际输出或最低利润
```

同样储备、实际输入、路径和手续费下，直接调用与 Router 得到的最大输出相同；直接调用可能减少
通用编排 Gas，但必须自己承担 Pair 验证、排序、多跳、WETH、deadline、滑点、税币与回滚保护。

> [!IMPORTANT]
> **套利相关：直接 Pair 执行。** 套利与清算合约经常直接调用 Pair，以固定路径、减少通用 Router
> 开销，并让第一池输出直接进入下一池。但优势主要是原子组合和潜在 Gas 节省，不是绕过手续费或
> 获得更优 AMM 价格。绝不能用两笔交易完成 `transfer → swap`，否则未记账输入可能被抢先利用。

### 8.5 Flash Swap

Flash Swap 不是另一个函数，而是官方 `Pair.swap(amount0Out, amount1Out, to, data)` 在
`data.length > 0` 时的内置模式：Pair 先乐观转出 Token，再调用接收合约的
`uniswapV2Call`；回调结束前必须支付足够的一种或两种 Token，随后仍执行同一套余额、手续费和 K
校验。不足则连同最初输出一起原子回滚。

Uniswap 部署的 Pair 提供能力，套利者或协议自行部署实现 callback 的执行合约。普通钱包不能直接
承担 callback。

> [!IMPORTANT]
> **套利相关：Flash Swap。** 它允许执行合约先使用 Pair 的资产在另一 DEX 套利、执行清算或完成
> 抵押品置换，再在同一交易回调中偿还。它降低预置本金要求，但不会创造利润；净收益仍必须覆盖
> Pair 费用、另一市场费用、Gas、价格影响、MEV 和失败风险。callback 必须验证 `msg.sender` 是可信
> Factory 登记的真实 Pair，防止伪造回调骗取资产。

### 8.6 精确输出

`swapTokensForExactTokens(amountOut, amountInMax, path, to, deadline)` 固定最终输出、限制最大输入。
Router 用 `getAmountsIn` 逆向报价，但实际执行仍从第一跳向最后一跳转账。

## 9. 步骤六：移除 V2 流动性

先授权 LP Token：

```solidity
pair.approve(router, liquidity)
```

再调用：

```solidity
removeLiquidity(
  tokenA, tokenB, liquidity,
  amountAMin, amountBMin,
  to, deadline
) returns (amountA, amountB)
```

内部过程：

1. Router 用 `pair.transferFrom(user, pair, liquidity)` 把 LP Token 送回 Pair 自身。
2. 调用 `Pair.burn(to)`。
3. Pair 以实时 Token 余额和 LP 总供应量计算：
   `amount0 = liquidity * balance0 / totalSupply`，另一边同理。
4. 销毁 Pair 自身持有的 LP，向 `to` 转出两种 Token。
5. 再读余额、更新储备，发出 `Burn` 和 `Sync`。
6. Router 把 token0/token1 结果映射回用户的 A/B 顺序，并检查 minimum。

撤池拿回的是当前储备构成，不是最初存入数量；其差异来自交易、手续费、价格变化和无常损失。

## 10. V3 对照：相同目标，不同模型

| 目标 | V2 | V3 |
| --- | --- | --- |
| 池身份 | `(token0, token1)` | `(token0, token1, fee)`；同一币对可有多个费率池 |
| 创建 | `Factory.createPair` | `Factory.createPool(tokenA, tokenB, fee)` |
| 首次定价 | 首次按两币注入比例 | `Pool.initialize(sqrtPriceX96)`，必须显式初始化 |
| LP 凭证 | Pair 自身发行同质化 ERC-20 | PositionManager 发行 NFT `tokenId` |
| 流动性范围 | 全价格区间 | `[tickLower, tickUpper)` 集中流动性 |
| 添加 | Router02 `addLiquidity` | `NonfungiblePositionManager.mint` / `increaseLiquidity` |
| 移除 | `removeLiquidity` 调 Pair `burn` | `decreaseLiquidity` 后还要 `collect` |
| Swap 入口 | Router02 | `SwapRouter.exactInputSingle/exactInput/...` |
| 报价 | Router view 公式 | Quoter/QuoterV2 通过模拟 swap 并 revert 返回结果；不应在链上业务中调用 |
| Core 收款 | 输入先转入 Pair | Pool 先算 delta，再在 callback 中要求付款 |

没有变化的基础包括：Factory/Core/Periphery 分层、token0/token1 地址排序、ERC-20 授权、精确输入与
精确输出、多跳、最低输出保护、WETH、原子回滚和套利驱动的价格收敛。发生根本变化的是：Pair 政名
为 Pool；同币对可按 fee 多池；全局 reserve/K 模型改为 `sqrtPriceX96 + tick + liquidity`；同质化
LP ERC-20 改为官方 PositionManager 管理的仓位 NFT；手续费可按仓位单独 collect。

V3 没有 V2 的 `getReserves/skim/sync`。误转 Token 到 Pool 不会自动成为某个仓位的 liquidity 或
手续费，也没有标准 `skim` 入口。V3 Core 仍然持有真实 Token，但定价不再由两个总余额的比值决定。

### 10.1 V3 建池与初始化

```solidity
factory.createPool(tokenA, tokenB, fee)
pool.initialize(sqrtPriceX96)
```

常用外围函数 `createAndInitializePoolIfNecessary(token0, token1, fee, sqrtPriceX96)` 可以组合两步。

- `fee`：百万分比，例如 `3000 = 0.3%`；必须是 Factory 已启用的费率档。
- `sqrtPriceX96`：`sqrt(token1/token0) * 2^96`，比例使用最小单位，方向严格是 token1/token0。
- 初始价格一旦设置，不能再次 initialize；随后价格由 swap 移动。

### 10.2 V3 创建仓位

```solidity
NonfungiblePositionManager.mint(MintParams)
```

核心参数：`token0`、`token1`、`fee`、`tickLower`、`tickUpper`、
`amount0Desired`、`amount1Desired`、`amount0Min`、`amount1Min`、`recipient`、`deadline`。

- tick 必须落在该费率池 `tickSpacing` 的整数倍上。
- 当前价格低于区间时仓位只需要 token0；高于区间时只需要 token1；区间内需要两者。
- `amountDesired` 是上限，实际使用量由当前 `sqrtPrice` 和区间决定。
- Pool 在 `mint` 过程中回调 `uniswapV3MintCallback`，PositionManager 验证调用者是正确 Pool 后付款。
- 返回 `tokenId`、增加的 `liquidity` 和实际支付 `amount0/amount1`。

V3 的 liquidity `L` 不是 Token 数量，也不能与 V2 LP totalSupply 直接比较。区间内常用关系为：

```text
amount0 = L * (sqrtB - sqrtP) / (sqrtP * sqrtB)
amount1 = L * (sqrtP - sqrtA)
```

实际合约使用 Q64.96 定点整数和严格的向上/向下取整。

### 10.3 Tick 与有效流动性 L

Tick 是对数价格坐标：原始单位下 `price(token1/token0) = 1.0001^tick`，而 Pool 保存的精确价格是
`sqrtPriceX96 = sqrt(price) * 2^96`。价格可在 Tick 之间连续移动；只有被 LP 选作区间边界的 Tick
才需要初始化，`tickSpacing` 限制哪些 Tick 可以作为边界。

仓位在 `[tickLower, tickUpper)` 内才 active。`L` 不是 Token 数量或美元价值，而是当前价格区间的
交易深度；当前有效 L 等于所有覆盖当前 Tick 的仓位 liquidity 之和。L 越大，同样 amountIn 推动
价格越少。区间内常用变化关系为：

```text
delta token0 = L * (1/sqrtP_after - 1/sqrtP_before)
delta token1 = L * (sqrtP_after - sqrtP_before)
```

两个初始化 Tick 之间 L 保持不变；跨过边界时应用该 Tick 的 `liquidityNet`，得到新的有效 L，再
计算下一段。因此 V3 没有一个描述整个 Pool 的固定全局 K；仅在单个有效区间内可用虚拟储备理解为
`x_virtual * y_virtual = L^2`。

> [!IMPORTANT]
> **套利相关：V3 报价不能只比较显示价格。** 两个 V3 Pool 即使当前 `sqrtPriceX96` 接近，当前
> Tick 附近的 L 和后续初始化 Tick 分布也可能完全不同。套利计算必须逐段模拟跨 Tick 后的
> `liquidityNet`、费率、价格限制与整数取整，不能仅用池中 Token 总余额或瞬时显示价判断利润。

### 10.4 V3 Swap 与 callback 付款

```solidity
SwapRouter.exactInputSingle({
  tokenIn, tokenOut, fee, recipient, deadline,
  amountIn, amountOutMinimum, sqrtPriceLimitX96
})
```

Pool 的底层 `swap(recipient, zeroForOne, amountSpecified, sqrtPriceLimitX96, data)`：

1. 正数 `amountSpecified` 表示 exact input，负数表示 exact output。
2. 沿价格方向逐 tick 计算；跨越已初始化 tick 时改变当前有效 liquidity。
3. 收取该池 fee，更新 fee growth、tick、观察值和价格。
4. 先把输出转给 recipient，再回调 Router 的 `uniswapV3SwapCallback` 收取输入。
5. Router 必须验证 callback 来自 Factory 对应的真实 Pool。

调用关系：

```text
用户授权并调用 SwapRouter
→ Router 调用 Pool.swap
→ Pool 逐 Tick 计算精确 amount0Delta/amount1Delta
→ Pool 先发送负数 delta 对应的输出 Token
→ Pool 调用 Router.uniswapV3SwapCallback
→ Router 为正数 delta 付款
→ Pool 比较 callback 前后余额，付款不足则全部回滚
```

callback 的好处是：Pool 可在完成 Tick 穿越后要求精确付款；无需像 V2 那样预先裸转 Token；付款
来源可以是用户、Router、上一跳输出或其他原子化协议；同时支持高效多跳和 exact-output 的反向
递归结算。Pool 不绑定官方 Router，任何实现 callback 的合约都可调用，但 callback 合约必须验证
调用者是真实 Pool，否则攻击者可伪造 callback 诱导付款。

V3 仍由 Core 强制执行手续费，直接调用 Pool 不能绕过；不同费率 Pool 用 fee growth 为 active LP
记录手续费。V3 普通 swap callback 与独立的 `Pool.flash(...)` 不同：后者是明确的闪电借贷入口，
通过 `uniswapV3FlashCallback` 归还本金和费用。

`sqrtPriceLimitX96 = 0` 在外围 Router 中通常被替换为协议允许的极限；生产交易可以设置更严格的
价格边界。它是池内价格限制，`amountOutMinimum` 是最终收到数量限制，二者不能互相替代。

### 10.5 V3 撤出和领取

1. `decreaseLiquidity(tokenId, liquidity, amount0Min, amount1Min, deadline)`：降低仓位流动性，
   应得 Token 先记入 position 的 `tokensOwed`。
2. `collect(tokenId, recipient, amount0Max, amount1Max)`：取出已实现的本金和手续费。
3. 只有 liquidity 为 0 且 owed 也清零后，才可 `burn(tokenId)` 销毁空 NFT。

所以 V3 的 `decreaseLiquidity` 不等于资产已经回到钱包；漏掉 `collect` 是常见错误。

### 10.6 V4 的进一步变化

V4 不再为每个池部署 Pair/Pool 合约，而由单例 `PoolManager` 保存所有池状态；PoolKey 还包含 fee、
tickSpacing 和 hooks，同币对可以存在更多不同规则的池。V4 仍使用 Tick/L 集中流动性思想，但加入
Hooks、动态费率、原生 ETH 与统一结算。不同 Hook 可能改变费用或结算行为，因此 V4 套利必须理解
具体 Hook，不能机械套用 V3 报价逻辑。

## 11. 真实交易验证方法

优先选一组容易解释的同一地址交易：

1. `PairCreated`：Factory 日志中确认 token0、token1、pair。
2. 初次加池：交易输入是 Router02 `addLiquidity`，receipt 同时有两笔 Token `Transfer`、
   Pair 的 `Mint`、`Sync`、LP `Transfer(0x0 → LP)` 和锁定的 1000 LP。
3. Swap：确认 Router 函数选择器、path、amountIn、amountOutMin、deadline；再按 Pair 的
   `Swap` 与 `Sync` 还原实际输入输出。
4. 撤池：确认先有 LP approve；receipt 中有 LP 转入 Pair、LP burn、两种 Token 转出、
   `Burn`、`Sync`。
5. 所有金额先保持原始整数，最后再按 Token decimals 格式化。

不要只看区块浏览器的 UI 标签。验证时记录：`chainId`、区块号、交易哈希、from/to、status、
gasUsed、effectiveGasPrice、input、日志地址/topics/data，以及查询所用的 block identifier。

## 12. 后续 Python 实践

后续脚本分成两层：

1. 纯整数模型：模拟 `createPair → approve → addLiquidity → quote/getAmountIn/getAmountOut → swap
   → removeLiquidity`，断言 K、储备、LP supply 和账户余额变化。
2. RPC 真实验证：输入链、区块和交易哈希，读取 calldata、receipt、logs、同区块 reserve，复算
   Router 报价与 Pair 的实际 amountIn/amountOut。

模拟代码不能替代 EVM fork：真实执行还包括 Gas、nonce、EIP-1559、签名、mempool、MEV、回滚和
非标准 Token 行为。涉及资金前应先在本地 fork 或测试网络验证，不在代码或仓库中保存私钥。

## 13. 常见失败与排查顺序

| 失败 | 常见原因 | 首先检查 |
| --- | --- | --- |
| `TRANSFER_FROM_FAILED` | allowance/余额不足、Token 返回值异常、税币限制 | owner、spender、allowance、实际余额 |
| `INSUFFICIENT_*_AMOUNT` | 加/撤池时比例变化超过 minimum | 当前 reserve、desired/min、token 顺序 |
| `EXPIRED` | deadline 小于执行区块时间 | Unix 秒与本地时区换算 |
| `INSUFFICIENT_OUTPUT_AMOUNT` | 报价后价格变动或滑点过严 | 最新 reserve、path、amountOutMin |
| `EXCESSIVE_INPUT_AMOUNT` | 精确输出所需输入超过上限 | 最新 reserve、amountInMax |
| `UniswapV2: K` | 输出拿多、输入到账少、转账税/异常余额 | Pair 实际 balance 与 reserve 差值 |
| V3 `STF` | transferFrom 失败 | 对 PositionManager/Router 的授权和余额 |
| V3 tick 错误 | tick 顺序或 spacing 不合法 | `tickLower < tickUpper` 且均可整除 spacing |
| V3 撤仓后钱包没币 | 只 decrease 未 collect | position 的 tokensOwed |

## 14. 今日检查清单

- [ ] 能说清 EOA、Token、Factory、Pair、Router02、LP Token 的资产和调用方向。
- [ ] 能解释为什么 createPair 后储备仍是零。
- [ ] 能解释 allowance 的 owner/spender，以及为什么授权 Router。
- [ ] 能用整数手算 `quote/getAmountOut/getAmountIn`。
- [ ] 能解释 Pair 如何由余额差反推 amountIn，以及 K 校验在哪里发生。
- [ ] 能区分每次 Swap 的 K 基准、原始 K 增长和协议费使用的 `kLast`。
- [ ] 能解释 `skim/sync/mint` 对未记账余额的处理及跨交易风险。
- [ ] 能解释普通 Swap、直接 Pair Swap 与 Flash Swap 的付款顺序。
- [ ] 能解释 `amountMin/amountMax/deadline` 分别保护什么、不保护什么。
- [ ] 能解释 V2 LP ERC-20 与 V3 Position NFT 的根本差别。
- [ ] 能解释 V3 为什么必须 initialize、Tick/L 如何决定逐段 Swap。
- [ ] 能解释 V3 callback 的 delta、付款验证和调用者认证。
- [ ] 用 Python 实现生命周期整数模拟并通过测试。
- [ ] 找到真实交易后，保存链、区块、哈希和原始日志并逐项核验。

## 15. 今日核心结论

1. V2 同一 Factory 的同币对只能有一个 Pair；不同 Factory、路径或版本都可能形成独立市场和价差。
2. Router 是无状态外围编排器，Pair 才是持有资产并执行 AMM 校验的 Core；两者都没有普通用户特权。
3. `transfer` 移动调用者自己的 Token，`transferFrom` 依赖 owner 对当前 spender 的 allowance。
4. `quote` 只做储备比例换算；`getAmountOut/getAmountIn` 才包含手续费和恒定乘积价格影响。
5. Pair 不记录转账者存款；标准 Router 在同一交易中完成输入转账、Pair.swap、K 校验和储备更新。
6. Router 负责手续费报价和滑点保护，Pair 通过调整后余额强制执行手续费与 K，直接调用无法绕过。
7. Swap 手续费进入储备，LP 没有独立 collect；每次 Swap 使用包含此前手续费的新储备乘积作为基准。
8. `skim/mint/sync` 都可公开调用，裸转 Pair 的未记账余额没有个人归属；直接执行必须原子化。
9. V3 用 Pool、Tick、有效 L 和 Position NFT 取代 Pair、全局储备 K 和同质化 LP Token。
10. V3 callback 让 Pool 在逐 Tick 计算后精确收款，并支持多跳、exact-output 和原子组合；回调必须认证。

## 16. 官方源码与资料

- [Uniswap V2 Factory 源码](https://github.com/Uniswap/v2-core/blob/master/contracts/UniswapV2Factory.sol)
- [Uniswap V2 Pair 源码](https://github.com/Uniswap/v2-core/blob/master/contracts/UniswapV2Pair.sol)
- [Uniswap V2 Router02 源码](https://github.com/Uniswap/v2-periphery/blob/master/contracts/UniswapV2Router02.sol)
- [Uniswap V2 Library 源码](https://github.com/Uniswap/v2-periphery/blob/master/contracts/libraries/UniswapV2Library.sol)
- [Uniswap V2 白皮书](https://docs.uniswap.org/whitepaper.pdf)
- [Uniswap V2 Flash Swap 官方说明](https://developers.uniswap.org/docs/protocols/v2/concepts/flash-swap)
- [Uniswap V3 Factory 源码](https://github.com/Uniswap/v3-core/blob/main/contracts/UniswapV3Factory.sol)
- [Uniswap V3 Pool 源码](https://github.com/Uniswap/v3-core/blob/main/contracts/UniswapV3Pool.sol)
- [V3 NonfungiblePositionManager 源码](https://github.com/Uniswap/v3-periphery/blob/main/contracts/NonfungiblePositionManager.sol)
- [V3 SwapRouter 源码](https://github.com/Uniswap/v3-periphery/blob/main/contracts/SwapRouter.sol)
- [V3 QuoterV2 源码](https://github.com/Uniswap/v3-periphery/blob/main/contracts/lens/QuoterV2.sol)
- [Uniswap V4 PoolManager 源码](https://github.com/Uniswap/v4-core/blob/main/src/PoolManager.sol)
