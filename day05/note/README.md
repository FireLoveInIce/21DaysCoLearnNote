# Day 05 学习计划：V4 工程认知与第一阶段收口

## 今日定位

V4 延续 V3 的集中流动性，但通过 Singleton、Flash Accounting 和 Hooks 改变了池的组织与结算方式。一天不适合从零掌握所有 Hook、V4 数学和自定义会计，因此今天的目标是：

> 能识别一个 V4 Pool，知道应从哪里读取状态、怎样获取可信报价，以及为什么未知 Hook 不能直接接入套利执行器。

建议投入 4—6 小时。今天不要求手写 V4 Router、Hook 或离线报价器；优先完成真实事件读取、版本对比和后续系统接口清单。

## 今日目标

- 理解 PoolManager、PoolKey、PoolId、StateView、Quoter 和外围 Router 的关系。
- 理解 Singleton、Unlock/Flash Accounting、Currency Delta 和最终结算。
- 理解 Hooks 如何改变费用、Swap 行为或返回 Delta。
- 读取并解释一个真实 V4 Pool 的初始化和 Swap 数据。
- 完成 V2/V3/V4 面向套利系统的对比与最小 ABI 清单。

## 一、V4 与 V3 的核心变化

```text
V3
每个 Pool 一个独立合约
  → Pool 自己保存状态和 Token 余额
  → Router 调用 Pool
  → Callback 完成付款

V4
所有 Pool 状态集中在 PoolManager
  → PoolKey/PoolId 标识内部 Pool
  → Unlock 周期内执行一个或多个操作
  → 内部记录 Currency Delta
  → 结束前统一 settle/take，所有 Delta 必须结清
```

重点组件：

| 组件 | 作用 | 套利程序关注点 |
| --- | --- | --- |
| PoolManager | 保存并修改所有 Pool 的核心状态 | Swap、解锁、结算和 Callback 边界 |
| PoolKey | `currency0/currency1/fee/tickSpacing/hooks` | 完整定义一个 Pool 的规则 |
| PoolId | PoolKey 的确定性标识 | 事件索引、状态缓存和路径标识 |
| StateView | 对外读取 Pool 状态 | `slot0`、liquidity、Tick 状态 |
| Quoter | 模拟 V4 路径报价 | 发送前验证输出和 Gas |
| Hooks | 在生命周期节点执行扩展逻辑 | 动态费率、自定义 Delta 和额外风险 |

## 二、Flash Accounting 与原子结算

理解流程，不要求今天实现：

```text
进入 unlock
  → 执行一个或多个 Pool 操作
  → PoolManager 记录各 Currency 的净 Delta
  → 调用方使用 settle 支付欠款
  → 使用 take 取出应收资产
  → unlock 结束前所有 Delta 必须归零
  → 未结清则整笔交易回滚
```

需要明确：

- Flash Accounting 主要减少多跳过程中的重复 Token 转移，不等于免费闪电贷。
- V4 的原子性仍只覆盖同一条链、同一笔交易。
- 多池操作可以先记账后净额结算，但执行器必须正确处理每种 Currency 的最终 Delta。
- V4 原生支持 ETH；程序不能无条件把所有原生 ETH 路径当作 WETH 路径。

## 三、Hooks：套利程序的新边界

选择一个动态手续费 Hook 作为主案例，回答：

1. Hook 地址和权限如何进入 PoolKey？
2. `beforeSwap` 或 `afterSwap` 在什么时候执行？
3. Hook 是否能够覆盖动态 LP Fee？
4. Hook 是否返回额外 Delta？
5. 报价调用是否实际执行了 Hook 逻辑？
6. Hook 状态是否可能在交易打包前发生变化？

建立第一版白名单原则：

```text
无 Hook 或已审查 Hook
  → 可以进入报价与模拟流程

未知 Hook
  → 只监控，不自动执行
```

不能因为两个 V4 Pool 的 Token 和瞬时价格相同，就假设它们具有相同费用或执行行为。

## 四、今日动手任务

### 必做任务 A：读取真实 V4 Pool

在 Ethereum 主网选择一个资料明确的 V4 Pool：

- [ ] 从 PoolManager 的 `Initialize` 事件获得 PoolId 和 PoolKey 相关信息。
- [ ] 记录 `currency0`、`currency1`、fee、`tickSpacing` 和 hooks。
- [ ] 使用 StateView 读取 `slot0` 和当前 liquidity。
- [ ] 找到该 Pool 的一笔 `Swap` 事件并解释 amount0/amount1。
- [ ] 明确记录 chainId、PoolManager、PoolId、blockNumber 和 txHash。

如果选择带 Hook 的 Pool，还需要记录 Hook 地址和已声明权限；无法确认 Hook 行为时，不进行“可套利”判断。

### 必做任务 B：画出 V4 单池 Swap 调用链

流程图至少包含：

```text
用户/套利执行器
→ 外围 Router
→ PoolManager.unlock
→ unlockCallback
→ PoolManager.swap
→ Hook（如果启用）
→ settle/take
→ Delta 归零
```

在每个节点标注：谁持有资产、谁记录状态、哪里可能回滚、哪里需要白名单验证。

### 必做任务 C：完成版本对比

| 维度 | V2 | V3 | V4 |
| --- | --- | --- | --- |
| 池身份 | Token Pair | Token Pair + Fee | PoolKey / PoolId |
| 核心架构 | 每池一个 Pair | 每池一个 Pool | Singleton PoolManager |
| 价格状态 | Reserves | `sqrtPriceX96`、Tick、L | V3 类状态 + Hook/动态费用 |
| 多跳结算 | Pair 间直接转 Token | Callback 付款 | Delta 记账后净额结算 |
| 报价方式 | 储备公式 | 逐 Tick / Quoter | Quoter + 实际 Hook 行为 |
| 主要扩展方式 | Fork/外围合约 | 外围合约 | Hooks |
| 第一版接入策略 | 可完整支持 | Quoter + 模拟后支持 | 仅白名单 Hook |

### 必做任务 D：第一阶段最小接口清单

整理后续监控系统需要的内容：

- [ ] V2：Pair 发现、储备、Swap/Sync 事件和执行入口。
- [ ] V3：Pool 发现、slot0、liquidity、Tick、Swap 事件、Quoter 和执行入口。
- [ ] V4：Initialize/Swap 事件、StateView、Quoter、PoolKey/PoolId 和 Hook 元数据。
- [ ] 通用 Token 元数据：address、symbol、decimals。
- [ ] 通用上下文：chainId、blockNumber、blockHash、txHash、logIndex。

建议形成统一池描述：

```python
PoolDescriptor(
    protocol_version,
    chain_id,
    pool_address_or_manager,
    pool_id,
    token0,
    token1,
    fee,
    tick_spacing,
    hook_address,
)
```

### 进阶任务

- [ ] 使用 V4 Quoter 对选定 Pool 获取小额报价。
- [ ] 比较无 Hook Pool 与动态费率 Hook Pool 的报价输入。
- [ ] 阅读一个官方示例 Hook，但暂不部署或接入资金。

## 五、第一阶段交付物

Day01—05 结束时应保留以下可复用成果：

- [ ] V2、V3、V4 面向监控和执行的对比表。
- [ ] 三版本最小 ABI 与事件 Topic 清单。
- [ ] 一份 V3 Pool 固定区块状态快照。
- [ ] 一笔 V3 Swap 和一笔 V4 Swap 的解析记录。
- [ ] 从轻量筛选、Quoter 验证到完整模拟的流程图。
- [ ] 一份自动执行白名单与风险检查清单。

## 六、完成标准

第一阶段完成后，应能够：

1. 从链上发现并识别 V2 Pair、V3 Pool 和 V4 PoolId。
2. 读取各版本报价所需的最小状态，并说明哪些数据必须来自同一区块。
3. 使用官方 Quoter 和完整调用模拟验证候选路径。
4. 从交易哈希定位核心调用、事件、输入、输出和 Gas。
5. 明确说明为什么未知 V4 Hook 不能直接进入自动套利执行器。

不要求在 Day05 前做到：

- 从零实现生产级 V3/V4 离线报价器。
- 自己部署通用 SwapRouter。
- 支持任意 V4 Hook。
- 使用真实资金执行套利。

这些内容应在 Day06—10 建立套利与风险认知后，再进入 Day11—16 的程序化阶段。

## 时间不足时的调整

- 如果 Day03 的价格转换没有通过交叉验证：Day04 前半天继续补 V3 状态，不进入 V4 数学。
- 如果 Day04 仍不能解析真实 Swap：Day05 缩减为 2—3 小时 V4 架构，剩余时间完成交易复现。
- 如果每天只有 2—3 小时：建议把当前三天扩展为四天，将 V4 阶段总结单独占一天。

宁可减少 V4 深度，也不要跳过 V3 的固定区块读取、Quoter 验证和真实交易解析；这三项对后续套利程序更有实际价值。

## 官方资料

- [Uniswap V4 Core](https://github.com/Uniswap/v4-core)
- [Uniswap V4 Periphery](https://github.com/Uniswap/v4-periphery)
- [Uniswap V4 Hooks](https://docs.uniswap.org/contracts/v4/concepts/hooks)
- [Uniswap V4 Flash Accounting](https://docs.uniswap.org/contracts/v4/concepts/flash-accounting)
