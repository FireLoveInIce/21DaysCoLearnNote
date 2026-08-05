# Day 01 学习记录：Uniswap V2 源码、AMM 与套利基础

## 今日目标

- 从源码角度理解 Uniswap V1—V4 的架构演进。
- 掌握 V2 的 `Factory → Pair → Router` 关系和 Swap 调用链。
- 理解 `keccak256`、Salt、`CREATE`、`CREATE2` 与确定性 Pair 地址。
- 理解恒定乘积、手续费、价格影响、滑点、TWAP 和闪电交换。
- 标记与套利程序直接相关的链上数据、执行条件和风险。

## 一、V1—V4 源码架构演进

统计口径为官方 Core 仓库中的生产合约源文件，包含接口和库，排除测试、示例及 Periphery。文件数量会随仓库分支调整，V4 仅作当前结构的近似参考。

| 版本 | Core 生产源码规模 | 部署结构 | 核心变化 |
| --- | ---: | --- | --- |
| V1 | 2 个 Vyper 文件 | 1 个 Factory；每个 Token 一个 ETH/Token Exchange | 验证恒定乘积 AMM；ERC-20 间交易必须经过 ETH |
| V2 | 11 个 Solidity 文件 | 1 个 Factory；每个 Token 组合一个 Pair | 任意 ERC-20/ERC-20 池、Core/Periphery 分层、TWAP、闪电交换 |
| V3 | 约 33 个 Solidity 文件 | 1 个 Factory；每个 Token 组合和费率档一个 Pool | 集中流动性、Tick、多个费率、改进的 Oracle |
| V4 | 约 47 个 Solidity 文件 | 所有 Pool 状态集中在一个 `PoolManager` | Singleton、Hooks、闪电记账、原生 ETH、自定义会计 |

源码架构演进可以概括为：

```text
V1：Exchange 同时负责资金、AMM 和用户入口
  ↓
V2：Pair 负责资产和不变量，Router 负责用户交互
  ↓
V3：Pair/Pool 变成处理 Tick 和 Position 的集中流动性状态机
  ↓
V4：Pool 不再逐个部署，统一成为 PoolManager 内部状态，并由 Hook 扩展
```

Day01 的重点是 V2，后续内容均限定在 Uniswap V2。

## 二、V2 整体架构

V2 是一个 Core 与 Periphery 分离的系统：

```text
Core
├── UniswapV2Factory：创建、登记、查询 Pair
├── UniswapV2Pair：持有两种 Token、执行 AMM、发行 LP Token
└── 数学库与接口

Periphery
├── UniswapV2Router01/02：报价、转账、多跳和用户保护参数
└── UniswapV2Library：排序 Token、计算 Pair 地址和 amountIn/amountOut
```

### 一套 V2 中有多少 Factory、Router 和 Pair

在同一条链、同一套 Uniswap V2 部署中：

```text
Factory（1 个）
├── Pair USDC/WETH
├── Pair USDT/WETH
├── Pair USDC/USDT
└── 其他大量 Pair

Router02（1 个官方实例）
└── 可以调用这个 Factory 创建的所有 Pair
```

需要加上三个限定：

1. 不是每个 Token 一个 Factory，而是一套 V2 共用一个 Factory。
2. 不同链各有独立部署；即使地址相同，链上状态也互不相同。
3. Uniswap、SushiSwap 或其他 V2 Fork 各自有 Factory，因此同一 Token 组合可以在不同 Factory 下存在多个 Pair。

Ethereum 主网经典 V2 部署地址：

```text
Factory  0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f
Router02 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D
```

## 三、Factory、Keccak、Salt 与 CREATE2

### 1. Factory 是什么

`UniswapV2Factory` 是部署在链上的公共合约，主要状态是：

```solidity
mapping(address => mapping(address => address)) public getPair;
address[] public allPairs;
```

它负责：

- `createPair(tokenA, tokenB)`：创建新的 Pair 合约实例；
- `getPair(tokenA, tokenB)`：查询 Pair 地址；
- `allPairs(index)`、`allPairsLength()`：枚举已创建的 Pair；
- 管理协议费接收地址 `feeTo`，但不执行普通 Swap。

任何人都可以调用 `createPair` 并支付 Gas，调用者不会因此获得 Pair 的特殊权限。

### 2. `keccak256` 是什么

`keccak256` 是 Ethereum 广泛使用的 256 bit 哈希函数：

```text
任意长度输入 → keccak256 → 固定 32 字节 bytes32
```

主要性质：

- 确定性：相同输入一定得到相同输出；
- 雪崩效应：输入只改变一点，结果通常完全不同；
- 单向性：容易由输入计算哈希，难以由哈希反推输入；
- 抗碰撞性：不同输入得到相同结果在工程上极难发生。

它不是加密，因为没有对应的解密过程。Ethereum 的 Keccak-256 与标准 SHA3-256 的填充规则不同，链下计算时不能直接用普通 `sha3_256` 代替。

Ethereum 还用 Keccak 计算函数选择器、事件 Topic、Mapping 存储位置、签名摘要、Merkle 节点和 CREATE2 地址。

### 3. V2 的 Salt 如何生成

Factory 先按地址大小排序：

```solidity
(address token0, address token1) = tokenA < tokenB
    ? (tokenA, tokenB)
    : (tokenB, tokenA);
```

然后生成 Salt：

```solidity
bytes32 salt = keccak256(abi.encodePacked(token0, token1));
```

两个地址各为 20 字节，`abi.encodePacked` 将其拼成 40 字节，再由 `keccak256` 得到 32 字节 Salt。

排序保证：

```text
createPair(USDC, WETH)
createPair(WETH, USDC)
```

最终都得到相同的 `token0/token1`、Salt 和 Pair 身份。这里的 Salt 不是随机数，而是交易对的确定性部署参数。

### 4. `CREATE` 与 `CREATE2`

EVM 正式存在两个创建合约的操作码：

```text
CREATE
CREATE2
```

没有正式名为 `CREATE1` 的操作码，但开发者有时会非正式地把普通 `CREATE` 称为 CREATE1。

普通 CREATE 地址依赖：

```text
创建者地址 + 创建者 nonce
```

概念公式：

```text
address = last20Bytes(keccak256(RLP(creator, nonce)))
```

CREATE2 地址依赖：

```text
部署者地址 + Salt + 创建代码哈希
```

公式：

```text
address = last20Bytes(
    keccak256(
        0xff
        ++ factory
        ++ salt
        ++ keccak256(init_code)
    )
)
```

V2 Factory 的核心源码：

```solidity
bytes memory bytecode = type(UniswapV2Pair).creationCode;
bytes32 salt = keccak256(abi.encodePacked(token0, token1));

assembly {
    pair := create2(0, add(bytecode, 32), mload(bytecode), salt)
}

IUniswapV2Pair(pair).initialize(token0, token1);
```

使用 CREATE2 后，只要知道 Factory、两个 Token 和 Pair 创建代码哈希，就可以在 Pair 创建前预测地址。`UniswapV2Library.pairFor()` 正是利用这个性质计算 Pair 地址。

Pair 没有把 Token 地址作为构造参数。构造函数只记录创建者 Factory，部署后再由 Factory 调用一次 `initialize(token0, token1)`。这样所有 Pair 的创建代码保持一致，便于确定性计算地址。

## 四、Pair：合约定义、链上实例与流动性池

### 1. Pair 到底是什么

可以从三个层次理解：

| 层次 | 含义 |
| --- | --- |
| 源码 | `UniswapV2Pair.sol` 是一个合约类型，类似类定义 |
| 链上 | Factory 创建出的具体 Pair 地址，是该合约的一个实例 |
| 业务 | 这个实例持有两种 Token，是可执行 Swap 的流动性池 |

例如 USDC/WETH Pair 有自己的：

- 合约地址；
- `token0`、`token1`；
- `reserve0`、`reserve1`；
- 累计价格；
- LP Token 总供应量和余额；
- `Swap`、`Sync`、`Mint`、`Burn` 日志。

Pair 继承 `UniswapV2ERC20`，所以 Pair 本身也是 LP Token 合约，不需要额外部署另一个 LP Token。

### 2. Factory 创建 Pair 的完整过程

```text
用户调用 Factory.createPair(tokenA, tokenB)
  ↓
Factory 排序为 token0/token1
  ↓
检查非零地址、不同 Token、Pair 尚不存在
  ↓
使用 CREATE2 部署 UniswapV2Pair 实例
  ↓
调用 Pair.initialize(token0, token1)
  ↓
双向写入 getPair[token0][token1]
  ↓
加入 allPairs 并发出 PairCreated
```

在同一个 Factory 中，一对排序后的 Token 只能有一个 Pair。创建 Pair 后不会自动产生流动性：初始储备和 LP 总供应量均为零，还需要 LP 转入两种 Token 并调用 `mint`，通常由 Router 的 `addLiquidity` 编排。

### 3. Pair 的核心状态

```solidity
address public token0;
address public token1;

uint112 private reserve0;
uint112 private reserve1;
uint32 private blockTimestampLast;

uint public price0CumulativeLast;
uint public price1CumulativeLast;
```

`getReserves()` 第三个返回值是最近一次储备更新的时间戳，不是区块高度。监控程序应另外记录 RPC 查询使用的区块号。

## 五、恒定乘积与 Pair.swap

### 1. 基本模型

设输入侧储备为 `x`，输出侧储备为 `y`：

```text
x * y = k
```

不计手续费时，输入 `Δx` 后：

```text
(x + Δx) * (y - Δy) = k
Δy = y * Δx / (x + Δx)
```

V2 对输入收取 0.3% 手续费：

```text
amountInWithFee = amountIn * 997

amountOut = reserveOut * amountInWithFee
          / (reserveIn * 1000 + amountInWithFee)
```

Solidity 使用整数除法并向下取整，链下报价必须使用整数或高精度计算。

### 2. Pair 如何判断输入数量

Pair 的底层接口只接收期望输出，不接收 `amountIn`：

```solidity
swap(amount0Out, amount1Out, to, data)
```

普通 Swap 的流程：

```text
调用者先把输入 Token 转到 Pair
  ↓
调用 Pair.swap 指定输出量
  ↓
Pair 先转出输出 Token
  ↓
Pair 读取两种 Token 的实际 balance
  ↓
用 balance、旧 reserve 和输出量反推 amountIn
  ↓
扣除手续费后校验 K
  ↓
更新 reserve，发出 Swap 和 Sync
```

核心校验：

```solidity
balance0Adjusted = balance0 * 1000 - amount0In * 3;
balance1Adjusted = balance1 * 1000 - amount1In * 3;

require(
    balance0Adjusted * balance1Adjusted
        >= reserve0 * reserve1 * 1000**2,
    "UniswapV2: K"
);
```

Pair 不关心输入来自哪个地址，只关心最终余额是否足够、手续费是否满足、不变量是否没有下降。

### 3. 价格、价格影响、滑点和手续费

| 概念 | 准确定义 |
| --- | --- |
| 边际价格 | 交易前由储备比例决定的瞬时价格，例如 `reserveOut / reserveIn` |
| 价格影响 | 当前交易本身沿曲线改变储备比例，使成交均价偏离交易前边际价格 |
| 滑点 | 报价后、成交前因其他交易或状态变化产生的额外偏差；滑点容忍度是用户允许的最大偏差 |
| 手续费 | V2 默认从输入量扣除 0.3%，先留在池内；协议费开启时通过铸造 LP Token 捕获部分增长 |

两边储备按相同比例扩大时，边际价格不变，但同规模交易的价格影响降低。

## 六、Router01、Router02 与直接调用 Pair

### 1. 为什么有 01 和 02

`UniswapV2Router01` 是第一版外围 Router，`UniswapV2Router02` 是改进版。这里的 01/02 是 Router 版本号，不是 Uniswap V1/V2。

Router02 增加了对一部分 Fee-on-Transfer Token 的支持，例如：

```solidity
swapExactTokensForTokensSupportingFeeOnTransferTokens
swapExactETHForTokensSupportingFeeOnTransferTokens
swapExactTokensForETHSupportingFeeOnTransferTokens
```

普通 Token 转出 100，Pair 收到 100；Fee-on-Transfer Token 可能转出 100、Pair 只收到 98。支持函数会根据 Pair 的实际余额差计算输入，但仍不能保证兼容所有 Rebase、额外转账或恶意 Token。

### 2. Router02 的职责

- 根据 `path` 查找或计算各 Pair；
- 读取 `getReserves()`；
- 使用 `getAmountOut/getAmountsOut` 逐跳计算输出；
- 通过 `transferFrom` 将输入送到首个 Pair；
- 调用一个或多个 Pair 的 `swap`；
- 处理 WETH 与原生 ETH 的包装/解包；
- 检查 `amountOutMin`、`amountInMax` 和 `deadline`。

Router 的 `getAmountsOut` 只使用调用时的当前储备，不使用 TWAP，也不会判断当前池价是不是公平市场价。`amountOutMin` 应由用户或上层系统结合报价、外部价格和风险容忍度设置。

### 3. 是否必须走 Router02

不是。Pair 不会验证调用者是不是官方 Router。可以使用：

- 官方 Router02；
- 自定义 Router；
- DEX 聚合器；
- 套利或清算合约；
- 自己编写的原子执行合约直接调用 Pair。

但直接调用者必须自行处理 Pair 地址、Token 顺序、整数报价、转账、多跳、WETH、最小输出和截止时间。

不能安全地先用一笔交易向 Pair 转入 Token，再用第二笔交易调用 `swap`；两笔交易之间，其他人可能利用已经进入 Pair 的余额把输出取走。安全的直接调用通常要在自定义合约的一笔原子交易中完成 `transfer → swap`。

### 4. 直接调用 Pair 会得到更多输出吗

在相同储备、输入、路径和手续费下不会。最大输出由 Pair 的 K 校验决定，Router02 使用的就是相同公式。尝试直接要求更多输出会以 `UniswapV2: K` 回滚。

```text
Token 输出：相同条件下通常相同
Gas 成本：精简的自定义直接调用可能更低
```

Router02 不额外收取 Token 手续费。不同输出通常来自不同路径、不同池状态或不同执行时点，而不是 Router 抽成。

一次精确输入调用链：

```text
用户 approve Router02
  ↓
Router02.swapExactTokensForTokens
  ↓
Library 读取储备并计算逐跳 amounts
  ↓
Router02.transferFrom：用户 → 第一个 Pair
  ↓
逐个 Pair.swap；中间输出直接发送给下一个 Pair
  ↓
最后一个 Pair 将 Token 发送给接收者
```

## 七、TWAP：时间加权平均价格

### 1. 为什么需要 TWAP

V2 瞬时价格来自储备比例，但储备可以被一笔大额交易临时改变。如果外部协议直接把瞬时价格当预言机，攻击者可能在同一笔交易中操纵价格并从该协议获利。

Pair 保存：

```solidity
price0CumulativeLast;
price1CumulativeLast;
blockTimestampLast;
```

更新储备时，先累计旧价格在过去一段时间内的贡献：

```text
priceCumulative += oldPrice * timeElapsed
```

外部 Oracle 在 `t0`、`t1` 分别记录累计值 `C0`、`C1`：

```text
TWAP = (C1 - C0) / (t1 - t0)
```

例如价格 2,000 持续 30 分钟、2,200 持续 30 分钟：

```text
TWAP = (2000 × 30 + 2200 × 30) / 60 = 2100
```

V2 Pair 提供累计价格底层数据，但没有直接提供 `getTWAP(window)`。观察窗口、采样和维护由外部 Oracle 合约负责。

### 2. TWAP 的边界

- 窗口越长、流动性越深，持续操纵成本通常越高；
- TWAP 是历史平均，不等于当前可成交价格；
- TWAP 不包含当前交易自身的价格影响；
- 低流动性池、短窗口、更新不及时或区块排序能力都会降低安全性；
- 使用时必须正确处理 Token 顺序、精度和累计值溢出语义。

> [!IMPORTANT]
> **套利相关：** 套利者的交易让池内价格持续靠近外部市场价格，这也是 V2 累计价格具有参考意义的重要经济基础。但套利只会把价差压缩到不足以覆盖手续费、Gas、价格影响、MEV 和失败风险的位置，不会保证价差严格为零。

## 八、闪电交换（Flash Swap）

### 1. 核心机制

V2 Pair 的 Swap 是“先乐观转出，最后校验付款”：

```text
Pair 先把 amount0Out/amount1Out 转给 to
  ↓
data 非空时调用 to.uniswapV2Call(...)
  ↓
接收合约使用这些资产执行任意原子逻辑
  ↓
回调结束前归还同一种 Token 或支付另一种 Token
  ↓
Pair 检查余额、手续费与 K
  ↓
不足则整笔交易回滚
```

普通 Swap 通常提前把输入转入 Pair，并传入空 `data`；闪电交换传入非空 `data`，触发：

```solidity
uniswapV2Call(sender, amount0Out, amount1Out, data)
```

接收者必须是实现该回调的合约，普通钱包地址无法执行回调逻辑。

### 2. 偿还方式和费用

可以用交易对中的另一种 Token 付款，此时按精确输出公式 `getAmountIn` 计算；也可以归还同一种 Token：

```text
returned * 0.997 >= withdrawn
returned >= withdrawn / 0.997
```

同币归还相对于取出量的有效费用约为：

```text
0.003 / 0.997 ≈ 0.3009027%
```

Callback 必须验证 `msg.sender` 是可信 Factory 登记的真实 Pair，否则攻击者可以伪造回调诱导合约转账。

> [!IMPORTANT]
> **套利相关：闪电套利流程**
>
> ```text
> 从 Uniswap Pair 闪电取出资产
>   ↓
> 在另一个 DEX 按更优价格卖出
>   ↓
> 向原 Pair 支付所需输入及费用
>   ↓
> 剩余金额才是毛利润
> ```
>
> 若任意步骤失败或偿还不足，整笔交易原子回滚，因此不需要预先持有全部本金。但闪电交换不会创造利润，实际净利润必须覆盖两边手续费、Gas、价格影响、MEV、区块竞争和失败成本。

> [!WARNING]
> **套利执行风险：** 报价出现利润不等于可成交。必须使用同一状态下的整数计算，设置最小利润或最小输出，并考虑交易进入区块前储备变化、抢跑、三明治、回滚 Gas、特殊 Token 行为及外部协议风险。

## 九、参与者与经济闭环

| 参与者 | 行为 | 收益/成本 |
| --- | --- | --- |
| LP | 存入两种 Token，获得 Pair 发行的 LP Token | 获得手续费；承担无常损失、资产与合约风险 |
| 交易者 | 消费池中流动性完成兑换 | 支付手续费、价格影响、Gas，并承担滑点风险 |
| 套利者 | 利用池内外或池间价差交易 | 将价格带回市场附近；利润需覆盖全部执行成本 |

三者形成：

```text
LP 提供深度
  ↓
交易者产生交易和手续费
  ↓
交易改变池内价格
  ↓
套利者利用并缩小价差
```

## 十、重点接口与事件速查

| 接口/事件 | 用途 | 注意事项 |
| --- | --- | --- |
| `Factory.createPair` | 使用 CREATE2 创建 Pair | 创建后没有流动性；同一 Factory 中不可重复 |
| `Factory.getPair` | 查询 Pair 地址 | 不存在时返回零地址 |
| `Pair.token0/token1` | 确定 Token 顺序 | 按地址排序，不是用户传参顺序 |
| `Pair.getReserves` | 读取储备和更新时间 | 返回原始整数；第三项不是区块号 |
| `Pair.swap` | 执行普通或闪电交换 | 底层接口，调用者负责输入、输出和安全校验 |
| `Router.getAmountsOut` | 按当前储备逐跳报价 | 不是 TWAP，不保证是公平市场价或最终成交价 |
| `Router.swapExactTokensForTokens` | 固定输入交易 | 需授权，并设置合理的 `amountOutMin`、`deadline` |
| `Swap` | 实际输入、输出、调用者、接收者 | 需结合 Token 顺序和多跳上下文解析 |
| `Sync` | 更新后的 `reserve0/reserve1` | 可用于重建池状态 |
| `Mint/Burn` | 增加/移除流动性 | 不应误判为普通交易 |

## 十一、今日核心结论

1. 一套 Uniswap V2 部署共用一个 Factory，不是每个 Token 一个 Factory；Factory 为每个 Token 组合创建一个独立 Pair 合约实例。
2. `keccak256(abi.encodePacked(token0, token1))` 将排序后的两个地址变成确定性 Salt；它不是随机数，也不是加密。
3. EVM 正式存在 `CREATE` 和 `CREATE2`，没有正式的 CREATE1；CREATE2 使 Pair 地址可以在部署前被计算。
4. Pair 同时是资金池、AMM 状态机和 LP Token 合约；创建 Pair 不等于已经注入流动性。
5. Router02 是全体 Pair 共用的可替换外围合约，负责计算与编排，不持有每个池的长期流动性，也不额外抽取 Swap Token 手续费。
6. 交易不强制经过 Router02；直接调用 Pair 不会在相同条件下获得更多输出，只可能通过精简调用节约 Gas，同时需要自行承担全部安全与编排责任。
7. `getAmountsOut` 使用当前储备，不是 TWAP；TWAP 由累计价格的时间差计算，是历史平均而非当前成交承诺。
8. 闪电交换利用 EVM 原子性先转出、后校验，可降低套利的初始资金门槛，但不能消除费用、MEV、竞争和失败风险。

## 十二、后续实践

- [x] 阅读和总结 V2 Factory、Pair、Router 的核心职责。
- [x] 手算带 0.3% 手续费的恒定乘积报价。
- [x] 理解 Pair 的 CREATE2 地址来源、TWAP 和闪电交换流程。
- [ ] 选择一个具体网络和 Pair，记录 Factory、Router、Pair、Token、储备及查询区块号。
- [ ] 使用同一区块的 `getReserves()` 与链下整数公式验证 `getAmountsOut()`。
- [ ] 解码一笔多跳交易的 `Swap`、`Sync` 日志，恢复每一跳方向和数量。
- [ ] 用只读 Python 脚本计算 Pair 地址，并与 `Factory.getPair()` 对比。
- [ ] 选择一笔历史套利或闪电交换交易，核算毛利润、手续费、Gas 与净利润。

## 参考资料

- [Uniswap V2 白皮书](https://docs.uniswap.org/whitepaper.pdf)
- [Uniswap V2 Factory 源码](https://github.com/Uniswap/v2-core/blob/master/contracts/UniswapV2Factory.sol)
- [Uniswap V2 Pair 源码](https://github.com/Uniswap/v2-core/blob/master/contracts/UniswapV2Pair.sol)
- [Uniswap V2 Router02 源码](https://github.com/Uniswap/v2-periphery/blob/master/contracts/UniswapV2Router02.sol)
- [Uniswap V2 Library 源码](https://github.com/Uniswap/v2-periphery/blob/master/contracts/libraries/UniswapV2Library.sol)
- [Uniswap V2 架构](https://developers.uniswap.org/docs/protocols/v2/concepts/architecture)
- [Uniswap V2 Oracle/TWAP](https://developers.uniswap.org/docs/protocols/v2/concepts/oracles)
- [Uniswap V2 Flash Swaps](https://developers.uniswap.org/docs/protocols/v2/guides/flash-swaps)
- [Uniswap V2 官方部署地址](https://developers.uniswap.org/docs/protocols/v2/deployments)
- [Solidity CREATE2 文档](https://docs.soliditylang.org/en/latest/control-structures.html#salted-contract-creations-create2)
