# Day 05：Uniswap V4 工程认知与第一阶段收口

## 今日目标

V4 延续 V3 的集中流动性和逐 Tick Swap 数学，但通过 Singleton、Flash Accounting、原生 ETH 和 Hooks 改变了 Pool 的身份、调用方式和结算边界。

Day05 不要求从零实现 V4 Router、Hook 或生产级离线报价器，而是要达到以下能力：

- 能用 `PoolKey` 和 `PoolId` 正确识别一个 V4 Pool。
- 能说明 PoolManager、StateView、Quoter、Router 和 Hook 的职责。
- 能解释 `unlock → unlockCallback → 操作 → settle/take → Delta 归零`。
- 能正确区分 V3 与 V4 的 `amountSpecified` 符号语义。
- 能从 `Initialize` 和 `Swap` 事件还原 Pool 信息与成交结果。
- 能判断一个 Hook Pool 是否适合进入自动报价和执行白名单。
- 能将 V2、V3、V4 接入统一的监控、报价与执行系统。

## 一、V4 的核心架构

### Singleton PoolManager

V2 和 V3 为每个池部署独立合约；V4 将所有池的核心状态放在同一个 `PoolManager` 中：

```text
V2：Factory → Pair 合约 → reserves
V3：Factory → Pool 合约 → slot0 / liquidity / ticks
V4：PoolManager → PoolId → 内部 Pool.State
```

这带来几个直接变化：

- V4 Pool 没有独立的 Pool 合约地址，不能把 PoolManager 地址当作 Pool 的唯一身份。
- 监听 `Swap` 时，日志地址通常都是 PoolManager，必须再用事件中的 `PoolId` 区分池。
- 多池操作共享同一个 Manager，可以在一次 unlock 中先记账、最后净额结算，减少中间 Token 转移。
- Pool 核心状态仍包含 `sqrtPriceX96`、Tick、当前有效流动性、Tick Bitmap 和流动性边界。

Singleton 降低部署和多跳结算成本，但也扩大了集成边界：程序必须正确传入完整 `PoolKey`，并理解 Hook 和 Currency Delta。

### PoolKey 与 PoolId

一个 V4 Pool 由完整的 `PoolKey` 定义：

```solidity
struct PoolKey {
    Currency currency0;
    Currency currency1;
    uint24 fee;
    int24 tickSpacing;
    IHooks hooks;
}
```

Pool 身份可以表示为：

```text
PoolId = keccak256(abi.encode(PoolKey))
```

必须掌握：

- `currency0 < currency1`，按底层地址值排序。
- `fee`、`tickSpacing` 和 `hooks` 都属于 Pool 身份，不能只用 Token 对去重。
- 相同 Currency、相同费率但 Hook 不同，是不同的 Pool。
- `PoolId` 用于状态索引和事件过滤；实际执行 `swap` 时仍需提交完整 `PoolKey`。
- `PoolKey` 不由 PoolManager 完整保存为一个可直接枚举的公开结构，监控系统应从 `Initialize` 事件重建并持久化。

推荐的唯一键：

```text
chainId + PoolManager + PoolId
```

推荐缓存结构：

```python
PoolDescriptor(
    protocol_version="v4",
    chain_id=1,
    manager="0x...",
    pool_id="0x...",
    currency0="0x...",
    currency1="0x...",
    fee=...,
    tick_spacing=...,
    hooks="0x...",
)
```

### Currency 与原生 ETH

V4 使用 `Currency` 类型同时表示 ERC-20 和原生 ETH：

- ERC-20 Currency 的底层值是 Token 地址。
- `address(0)` 表示原生 ETH。
- Symbol 和 decimals 仍需要从 Token 元数据或本地配置获取。
- 原生 ETH 没有 ERC-20 的 `approve`、`transferFrom` 和 `decimals()` 调用。

因此不能把所有 `address(0)` 自动替换成 WETH，也不能对原生 ETH 走 ERC-20 的结算流程。

## 二、Unlock、Flash Accounting 与 Delta

### 调用流程

需要修改 Pool 状态的集成方通常先调用：

```solidity
poolManager.unlock(data)
```

PoolManager 随后回调调用者：

```solidity
unlockCallback(data)
```

完整流程：

```text
用户/套利执行器调用 Router
  → Router 调用 PoolManager.unlock(data)
  → PoolManager 调用 Router.unlockCallback(data)
  → Router 在 Callback 中执行 swap / modifyLiquidity / donate
  → PoolManager 在瞬态存储中累计每种 Currency Delta
  → Router 使用 settle 支付负 Delta
  → Router 使用 take 提取正 Delta
  → unlockCallback 返回
  → PoolManager 检查所有非零 Delta 已清空
  → 仍有未结算 Delta 则整笔交易回滚
```

`initialize` 和动态 LP Fee 更新有各自的调用条件；不能简单认为 PoolManager 的所有函数都必须在 unlock 内调用。

### Delta 的符号

Currency Delta 以集成调用者相对 PoolManager 的应收应付表示：

| Delta | 含义 | 典型处理 |
| --- | --- | --- |
| `> 0` | PoolManager 欠调用者 | `take`、mint ERC-6909 Claim 或参与后续净额结算 |
| `< 0` | 调用者欠 PoolManager | 转入资产并 `settle`，或 burn Claim |
| `= 0` | 已结清 | unlock 可以结束 |

Flash Accounting 的“Flash”表示 unlock 期间允许暂时存在未结清余额，不代表资产免费，也不代表可以把负债带出本次交易。结束前所有 Delta 必须归零。

### ERC-20 与原生 ETH 的结算差异

ERC-20 支付的一般顺序是：

```text
PoolManager.sync(currency)
  → 把 ERC-20 转入 PoolManager
  → PoolManager.settle()
```

`sync` 先记录余额基准，PoolManager 才能计算本次实际到账数量。原生 ETH 则通过 payable `settle{value: amount}()` 结算，不需要先执行相同的 ERC-20 转账流程。

提取 PoolManager 欠调用者的资产通常使用：

```solidity
poolManager.take(currency, recipient, amount);
```

`clear` 会在不转出资产的情况下清除完全相等的正 Delta，使资产永久留在 PoolManager 中，只适合调用者明确愿意放弃的 dust，不能当作普通提款函数。

### Unlock Callback 的鉴权

任何地址都能直接调用执行器公开的 `unlockCallback`，因此必须验证：

```solidity
if (msg.sender != address(poolManager)) revert Unauthorized();
```

这与 V3 的 `uniswapV3SwapCallback` 安全原则相同：Callback 会触发付款或资产操作，不能只相信 Callback 参数。

## 三、V4 Swap 必须掌握的语义

### SwapParams

```solidity
struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}
```

方向与 V3 一致：

| `zeroForOne` | 方向 | 价格与 Tick |
| --- | --- | --- |
| `true` | currency0 → currency1 | 下降 |
| `false` | currency1 → currency0 | 上升 |

但是 `amountSpecified` 的符号与 V3 Core Pool 相反：

| 协议入口 | Exact Input | Exact Output |
| --- | --- | --- |
| V3 `Pool.swap` | `amountSpecified > 0` | `amountSpecified < 0` |
| V4 `PoolManager.swap` | `amountSpecified < 0` | `amountSpecified > 0` |

这是 V3/V4 共用执行代码时必须显式隔离的差异。不能把 V3 参数直接传给 V4。

### Swap 的计算部分

在没有改变 Swap Delta 的 Hook 时，V4 仍沿用熟悉的集中流动性过程：

```text
读取当前 sqrtPriceX96、tick、liquidity
  → 按方向找到下一个初始化 Tick
  → 在下一 Tick 与 sqrtPriceLimitX96 之间选择目标
  → 计算 amountIn、amountOut 和 feeAmount
  → 跨 Tick 时按 liquidityNet 更新有效流动性
  → 数量耗尽或触及价格限制时结束
```

真正需要重新学习的部分不是基础 Tick 数学，而是 Hook 介入、动态费率、返回 Delta 和最终结算。

### BalanceDelta 与事件 Delta

`PoolManager.swap()` 返回调用者的 `BalanceDelta`，Hook 还可能改变调用者最终需要支付或收到的数量。执行器必须以最终返回值和自身余额变化做保护，不能只使用没有 Hook 时的理论 Swap 结果。

PoolManager 的 `Swap` 事件包含：

```solidity
event Swap(
    PoolId indexed id,
    address indexed sender,
    int128 amount0,
    int128 amount1,
    uint160 sqrtPriceX96,
    uint128 liquidity,
    int24 tick,
    uint24 fee
);
```

事件中的 `amount0`、`amount1` 是 Pool 的 Currency 变化：

- 正数表示 Pool 收到该 Currency。
- 负数表示 Pool 发出该 Currency。
- `sqrtPriceX96`、`liquidity`、`tick` 是 Swap 后状态。
- `fee` 是该次 Swap 实际采用的费率，动态费率 Pool 不能只看 PoolKey 中的标记值。

Hook 返回的额外 Delta 可能使调用者的最终资产变化与基础 Pool Swap 事件不完全相同。因此复盘 Hook Pool 时，还要结合 trace、Hook 事件、Router 返回值和 Token 实际转移。

## 四、Hooks 的能力和风险

### Hook 能介入哪些阶段

Hook 可以在生命周期节点前后运行：

```text
beforeInitialize / afterInitialize
beforeAddLiquidity / afterAddLiquidity
beforeRemoveLiquidity / afterRemoveLiquidity
beforeSwap / afterSwap
beforeDonate / afterDonate
```

是否调用某个 Hook 函数，由 Hook 地址的低位权限标志决定。Pool 初始化时会验证 Hook 地址与权限是否匹配；PoolKey 确定后，这个 Hook 地址不能为该 Pool 随意替换。

但“Hook 地址固定”不等于“行为永远不变”。Hook 可能：

- 根据自己的 Storage、Oracle 或外部协议状态改变行为。
- 使用动态 LP Fee，甚至在 Swap 前覆盖本次费率。
- 在允许的权限下返回额外 Delta，改变调用者最终输入或输出。
- 根据任意 `hookData` 走不同逻辑。
- 是可升级代理，或依赖可升级的外部合约。
- 故意 revert、消耗较多 Gas，或引入新的重入和外部调用风险。

### 报价必须执行真实 Hook 路径

带 Hook 的 Pool 不能只用 PoolManager 基础状态离线计算。可信报价至少要保证：

- 使用正确的 PoolKey 和 Hook 地址。
- 使用与真实执行相同的 `hookData`。
- 实际运行 `beforeSwap` / `afterSwap` 等已启用逻辑。
- 读取动态费率和 Hook 依赖的状态。
- 对最终 Router/执行器 calldata 做完整 `eth_call`。

Quoter 成功仍然只说明模拟区块下的执行结果。Hook 状态、Oracle、费用或外部调用在打包前变化，都会让报价失效。

### 第一版白名单原则

```text
无 Hook Pool
  → 正常进入报价与完整模拟

已审查、代码固定、依赖明确的 Hook
  → 使用精确 hookData 报价和模拟后接入

未知、可升级或外部依赖复杂的 Hook
  → 只监控，不自动交易
```

Hook 审查至少记录：

- Hook 地址与权限位。
- 合约代码哈希和是否为代理。
- 动态费率来源和最大值。
- 是否启用 before/after Swap Return Delta。
- `hookData` 格式和校验规则。
- 外部调用、Oracle、管理员权限与暂停机制。
- 重入、Gas 上限、错误处理和资产托管行为。

## 五、状态读取、报价与执行

### StateView 与 StateLibrary

PoolManager 的 Pool 状态位于内部映射中。应用通常通过 StateView 或针对 PoolManager 外部存储读取能力封装的 StateLibrary 获取：

- `slot0`：`sqrtPriceX96`、tick、协议费和 LP Fee。
- 当前有效 `liquidity`。
- Tick 信息和 Tick Bitmap。
- Position 流动性与费用增长。

监控时必须固定：

```text
chainId + blockNumber + blockHash + PoolManager + PoolId
```

PoolKey 元数据可以缓存；价格、流动性、动态费用、Hook 状态和相关 Tick 属于实时输入。不能混合不同区块的数据制造一个链上从未存在的状态。

### 三层验证

V4 接入仍使用 Day04 的三层结构，但多出 Hook 边界：

```text
StateView / 本地缓存快速筛选
  → V4 Quoter 使用真实 PoolKey + hookData 报价
  → 对最终 Router/套利执行器 calldata 做 eth_call
  → estimateGas
  → 扣除 Gas、动态费率、Hook Delta 和安全缓冲
  → 满足链上 minProfit 才发送
```

完整模拟需要与真实交易保持一致的：

- `from`、`to`、`value`、calldata 和 blockTag。
- PoolKey、路径、方向和数量符号。
- Hook 地址与 `hookData`。
- 原生 ETH 或 ERC-20 结算方式。
- deadline、最大输入、最小输出和最低利润。

### Router 与 PoolManager 的边界

PoolManager 提供核心状态变化和会计接口，不负责替用户完成通用路径解析、授权、滑点保护和付款组织。外围 Router/Universal Router 通常负责：

- 解码单跳或多跳路径。
- 调用 `unlock` 并实现 `unlockCallback`。
- 调用一个或多个 `swap`。
- 使用 Permit2、ERC-20 或原生 ETH 收付款。
- 执行 `settle` / `take` 并检查最终数量。

直接调用 PoolManager 并不会自动获得 Router 的安全检查。自定义套利执行器必须自行实现这些约束。

## 六、真实 V4 Pool 与 Swap 的解析方法

### 从 Initialize 事件发现 Pool

PoolManager 的 `Initialize` 事件包含构造 PoolKey 所需的信息：

```solidity
event Initialize(
    PoolId indexed id,
    Currency indexed currency0,
    Currency indexed currency1,
    uint24 fee,
    int24 tickSpacing,
    IHooks hooks,
    uint160 sqrtPriceX96,
    int24 tick
);
```

监控程序应保存：

- `chainId`、PoolManager、blockNumber、blockHash、txHash、logIndex。
- PoolId、currency0、currency1、fee、tickSpacing、hooks。
- 初始 `sqrtPriceX96` 和 Tick。
- Token 元数据以及 Hook 代码哈希和权限分析结果。

保存后重新计算 PoolId，与事件中的 id 对比，避免 ABI 或字段顺序错误。

### 解析一笔真实 Swap

给定交易哈希：

1. 读取交易和回执，确认状态成功。
2. 解码入口 Router/Universal Router 命令；必要时读取 trace。
3. 从 PoolManager 日志中筛选目标 PoolId 的 `Swap`。
4. 用本地 PoolKey 注册表还原 Currency、fee、tickSpacing 和 Hook。
5. 根据 `amount0/amount1` 符号判断 Pool 的输入输出方向。
6. 记录事件后的价格、流动性、Tick 和实际 fee。
7. 对 Hook Pool 继续解析 Hook 调用、额外事件和最终 Token 转移。
8. 使用回执计算执行成本：

```text
gasCostWei = gasUsed × effectiveGasPrice
```

事件没有交易前状态。需要读取交易执行前的同区块状态或 trace/state diff；`blockNumber - 1` 只能近似表示该区块开始前状态，无法包含同一区块中排在目标交易之前的交易影响。

### 实践记录模板

| 字段 | 结果 |
| --- | --- |
| Chain ID |  |
| PoolManager |  |
| PoolId |  |
| PoolKey |  |
| Hook / 权限 |  |
| Transaction Hash | 待选择并固定 |
| Block Number / Hash |  |
| Entry Router / Function |  |
| Currency In / Amount In |  |
| Currency Out / Amount Out |  |
| `zeroForOne` / Exact 类型 |  |
| 实际 Swap Fee |  |
| Tick Before / After |  |
| `sqrtPriceX96` Before / After |  |
| Liquidity Before / After |  |
| Hook Delta / Hook Events |  |
| Gas Used / Effective Gas Price |  |
| 数据限制 | Archive / Trace 是否可用 |

## 七、V2、V3、V4 对比

| 维度 | V2 | V3 | V4 |
| --- | --- | --- | --- |
| 池身份 | Pair 地址 | Pool 地址 | PoolManager + PoolId |
| 身份字段 | 排序 Token 对 | Token 对 + fee | Currency 对 + fee + tickSpacing + hooks |
| 核心架构 | 每池一个 Pair | 每池一个 Pool | Singleton PoolManager |
| 价格状态 | reserves | `sqrtPriceX96`、Tick、L | V3 类状态 + 动态 LP Fee |
| 流动性 | 全价格范围 | 集中流动性 | 集中流动性 |
| 多跳结算 | Pair 间转 Token | 每池 Callback 付款 | unlock 内 Delta 净额结算 |
| Callback | 可选 Flash Swap Callback | Swap/Mint/Flash Callback | `unlockCallback` + Hook Callbacks |
| 原生 ETH | 通常使用 WETH | 通常使用 WETH | Currency 原生支持 ETH |
| 扩展方式 | Fork 或外围合约 | 外围合约 | Hooks |
| 报价 | reserves 公式 | Quoter / 逐 Tick | V4 Quoter + 真实 Hook 逻辑 |
| 自动接入策略 | 验证 Token 后支持 | Quoter + 完整模拟 | Hook 白名单 + 完整模拟 |

## 八、V4 最小接口清单

第一版监控和报价系统至少需要：

```solidity
// Pool 发现与 Swap 监控
event Initialize(
    PoolId indexed id,
    Currency indexed currency0,
    Currency indexed currency1,
    uint24 fee,
    int24 tickSpacing,
    IHooks hooks,
    uint160 sqrtPriceX96,
    int24 tick
);

event Swap(
    PoolId indexed id,
    address indexed sender,
    int128 amount0,
    int128 amount1,
    uint160 sqrtPriceX96,
    uint128 liquidity,
    int24 tick,
    uint24 fee
);

// 核心调用
function unlock(bytes calldata data) external returns (bytes memory);
function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
    external returns (BalanceDelta swapDelta);
function sync(Currency currency) external;
function settle() external payable returns (uint256 paid);
function take(Currency currency, address to, uint256 amount) external;

// 执行器必须实现
function unlockCallback(bytes calldata data) external returns (bytes memory);
```

此外还需要：

- StateView 的 `getSlot0`、`getLiquidity`、Tick 和 Tick Bitmap 读取接口。
- V4 Quoter 的 Exact Input / Output 单池和路径接口。
- ERC-20 `balanceOf`、`allowance`、`approve`、`transfer`、`transferFrom`。
- Hook 的权限元数据、代码哈希、代理实现地址与自定义事件 ABI。

ABI 应从实际部署版本的官方构建产物或接口生成。不同 Router、Quoter 和部署版本的 tuple 布局不能凭名称混用。

## 九、应该具备的实践技能

完成 Day05 后，应该能够独立完成：

- 从 PoolManager `Initialize` 日志建立 PoolKey/PoolId 注册表。
- 验证 Currency 排序并重新计算 PoolId。
- 使用 StateView 在固定区块读取 slot0 和流动性。
- 根据 Currency 类型选择 ERC-20 或原生 ETH 结算流程。
- 构造 V4 Exact Input / Exact Output 参数，并正确处理与 V3 相反的符号。
- 解释 unlock、Callback、Currency Delta、settle 和 take 的完整关系。
- 识别 Hook 地址权限，判断动态费率和 Return Delta 能力。
- 使用相同 PoolKey、hookData 和 blockTag 调用 V4 Quoter。
- 对最终执行 calldata 做 `eth_call` 和 `estimateGas`。
- 解码真实 V4 Swap，计算输入、输出、实际费率和 Gas 成本。
- 对未知 Hook 默认拒绝自动执行，并输出明确的风险原因。
- 把 V2 Pair、V3 Pool 和 V4 PoolId 转换为统一的池描述结构。

## 十、自测问题

如果能准确回答以下问题，说明理论部分基本合格：

1. 为什么 V4 不能只用 PoolManager 地址标识一个 Pool？
2. PoolKey 中为什么必须包含 Hook 和 tickSpacing？
3. PoolId 如何计算，为什么执行 Swap 时仍需完整 PoolKey？
4. unlock 结束前为什么所有 Currency Delta 必须归零？
5. 正 Delta 和负 Delta 分别代表谁欠谁？
6. ERC-20 结算为什么通常要先 `sync`，原生 ETH 有何不同？
7. V3 和 V4 的 `amountSpecified` 符号语义有什么差异？
8. Hook 地址权限位说明什么，为什么仍然需要阅读 Hook 代码？
9. 为什么带 Hook Pool 的报价必须使用真实 `hookData` 执行 Hook？
10. 为什么 `Swap` 事件可能不足以解释 Hook Pool 的最终资产变化？
11. StateView 数据、Hook 状态和 Quoter 为什么必须固定在同一 blockTag？
12. 未知 Hook 为什么不能直接进入自动套利执行器？

## 完成情况

- [x] 梳理 Singleton、PoolManager、PoolKey 和 PoolId。
- [x] 梳理 Currency、原生 ETH 和 ERC-20 的区别。
- [x] 梳理 unlock、unlockCallback、Currency Delta、settle 和 take。
- [x] 标明 V3/V4 `amountSpecified` 符号差异。
- [x] 梳理 Hook 权限、动态费率、Return Delta 和白名单风险。
- [x] 梳理 StateView、Quoter 与完整 `eth_call` 三层验证。
- [x] 整理 Initialize/Swap 事件、最小接口和版本对比。
- [ ] 固定一个主网 V4 Pool，保存 Initialize、PoolKey、PoolId 和状态快照。
- [ ] 固定并完整解析该 Pool 的一笔真实 Swap。
- [ ] 使用 V4 Quoter 完成无 Hook Pool 的双向、三个输入规模报价。
- [ ] 选择一个 Hook Pool，记录权限、代码哈希、升级性和报价差异。

未完成项依赖可复现的主网 RPC、Archive/Trace 数据或新增实现。当前文档只标记已经完成的知识整理，不虚构链上实测结果。

## 第一阶段结论

Day01—05 完成后，系统设计应形成以下主线：

```text
统一发现 V2 Pair / V3 Pool / V4 PoolId
  → 固定区块读取最小状态
  → 本地轻量筛选
  → 对应协议 Quoter 复核
  → 最终执行 calldata 完整模拟
  → 扣除费用和风险缓冲
  → 链上滑点与 minProfit 检查
  → 发送或放弃
```

第一阶段不要求支持任意 V4 Hook，也不要求生产级 V3/V4 离线报价器。V4 的第一版接入边界应是：无 Hook 或已经审查、可复现报价并通过完整模拟的白名单 Hook。

## 官方源码与资料

- [Uniswap V4 Core](https://github.com/Uniswap/v4-core)
- [PoolManager 源码](https://github.com/Uniswap/v4-core/blob/main/src/PoolManager.sol)
- [IPoolManager 接口与事件](https://github.com/Uniswap/v4-core/blob/main/src/interfaces/IPoolManager.sol)
- [PoolKey](https://github.com/Uniswap/v4-core/blob/main/src/types/PoolKey.sol)
- [PoolId](https://github.com/Uniswap/v4-core/blob/main/src/types/PoolId.sol)
- [SwapParams](https://github.com/Uniswap/v4-core/blob/main/src/types/PoolOperation.sol)
- [Hooks 权限与调用](https://github.com/Uniswap/v4-core/blob/main/src/libraries/Hooks.sol)
- [StateLibrary](https://github.com/Uniswap/v4-core/blob/main/src/libraries/StateLibrary.sol)
- [Uniswap V4 Periphery](https://github.com/Uniswap/v4-periphery)
