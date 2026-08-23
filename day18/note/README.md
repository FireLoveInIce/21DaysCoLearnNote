# Day 18 学习记录：交易模拟与执行保护

## 今日结论

- LI.FI Quote、LI.FI 内部模拟、本地 `eth_call`、`eth_estimateGas` 和 fork 模拟不是同一层能力，不能互相替代。
- 模拟必须使用最终准备发送的 `from`、`to`、`data`、`value` 和执行账户；任一字段变化后，原模拟结果都应失效。
- 模拟成功只证明交易在某个状态快照下可以执行，不保证广播时状态、排序、Gas、余额和授权仍然相同。
- 利润、最小输出和 deadline 的最终保护必须由原子执行合约检查并主动 revert；只在本地 JavaScript 中判断无法保护已广播交易。
- 当前仓库仍是“报价观察”阶段：没有签名、广播、执行合约、本地 `eth_call` 或 fork 测试。本日完成的是模拟与放行规范，不把尚未执行的测试写成已通过。

## 一、当前实现与模拟的边界

`project/monitor/app.js` 当前会调用 LI.FI `/quote`，并读取：

- `estimate.toAmountMin`；
- `estimate.gasCosts` 和 `feeCosts`；
- Provider、预计执行时间和 Token 价格；
- Quote 返回的路线信息。

页面默认传入 `skipSimulation=true` 以获得快速报价。关闭“快速报价”后，只是不再要求 LI.FI 跳过其服务端模拟；这仍然不是本项目对最终交易执行的独立验证。

更重要的是，当前往返路线由两个顺序 Quote 组成：

```text
计价币 → 中间币
中间币 → 计价币
```

这两段不是一笔原子交易。即使两个 Quote 都成功，第一段执行后第二段仍可能因为价格、余额、授权、deadline 或 MEV 变化而失败。因此 Day 18 的前提不是“直接发送两个 transactionRequest”，而是先设计能够在同一笔交易末尾检查净利润的 Executor 合约。

## 二、四层验证各自能回答什么

| 验证层 | 能验证 | 不能保证 |
| --- | --- | --- |
| LI.FI Quote | 当前可用路线、估算输出、`toAmountMin`、费用、Gas 和待发送交易字段 | 两段原子性、未来区块成交、最终净利润 |
| `eth_call` | 在指定状态下执行完整 calldata，得到返回值或 revert；不会写入链上 | 广播时状态不变、一定被打包、交易排序 |
| `eth_estimateGas` | 在节点当前状态下估算成功执行所需 Gas，失败时通常暴露执行问题 | Gas 一定足够、未来冷/热访问和状态完全相同 |
| 本地 fork | 固定历史区块，注入余额/授权，执行多交易场景，检查余额差和事件 | 公共 mempool 排序、真实 Builder 行为和未来竞争交易 |

推荐顺序：

```text
Quote 生成最终 calldata
        ↓
字段白名单与成本上限检查
        ↓
固定区块 eth_call + eth_estimateGas
        ↓
必要时在 fork 中模拟状态扰动和竞争交易
        ↓
签名前使用最新状态再次 eth_call
        ↓
人工确认、签名、广播并追踪回执
```

## 三、`eth_call` 与 `eth_estimateGas` 的正确输入

模拟对象必须尽量等同于最终交易：

```json
{
  "from": "0x执行账户",
  "to": "0x执行合约",
  "data": "0x完整calldata",
  "value": "0x原生币金额",
  "gas": "0x可选上限",
  "maxFeePerGas": "0x费用上限",
  "maxPriorityFeePerGas": "0x优先费上限"
}
```

示意 RPC：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "eth_call",
  "params": [
    {"from": "0x...", "to": "0x...", "data": "0x...", "value": "0x0"},
    "0x指定区块号"
  ]
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "eth_estimateGas",
  "params": [
    {"from": "0x...", "to": "0x...", "data": "0x...", "value": "0x0"},
    "latest"
  ]
}
```

注意事项：

- `from` 会影响权限、余额、allowance 和合约分支，不能省略后再假设结果等价；
- 原生币交易必须携带准确 `value`；
- 模拟单独的 LI.FI `transactionRequest` 不等于模拟完整往返套利；
- 某些节点支持 state override，可在不真实授权的情况下临时注入余额或存储，但这类结果必须标记为“使用覆盖状态”，不能当作真实账户可执行证明；
- `eth_estimateGas` 返回的是估计值，不是承诺。发送时仍需设置策略允许的余量和绝对 `gas_limit` 上限。

## 四、选择 `latest`、`pending` 还是指定区块

| 状态参数 | 适合场景 | 风险 |
| --- | --- | --- |
| 指定区块号/哈希 | 可重复测试、历史案例、把信号与模拟绑定到同一状态 | 旧状态读取可能需要 archive node；不代表当前可执行 |
| `latest` | 签名前的主检查，基于节点最新已知区块 | 从 Quote 到调用之间仍可能已经变化 |
| `pending` | 观察节点已知 pending 交易加入后的可能状态 | 不同节点看到的 mempool 不同，结果不可稳定复现 |
| `safe` / `finalized` | 历史审计、对账和稳定数据处理 | 对低延迟执行过旧，不适合作为最终交易状态 |

建议同时保存两次模拟：

1. **基准模拟**：在候选信号的 `observed_block_number` 上运行，用于复现和解释；
2. **放行模拟**：在签名或广播前对 `latest` 运行，用于确认当前状态。

`pending` 只作为附加风险信号，不能作为唯一放行依据。不同 RPC 供应商的 pending 视图可能不同。

## 五、状态变化与重新报价规则

不能只用“过去了几秒”判断 Quote 是否有效。建议同时使用区块、时间和关键状态：

| 检查项 | 初始规则 | 触发后的动作 |
| --- | --- | --- |
| 区块新鲜度 | `current_block - quoted_block <= max_block_lag` | 超过即重新报价和模拟 |
| 时间新鲜度 | `now <= quote_received_at + max_quote_age` | 超过即丢弃旧 Quote |
| 区块身份 | 基准区块的哈希必须仍能对应原高度 | 不一致说明发生重组，整条信号失效 |
| calldata | `keccak256(calldata)` 必须与审批记录一致 | 任一字节变化都重新审批 |
| 池状态 | reserve、`sqrtPriceX96`、Tick 或预期输出超出容差 | 重新报价；不在本地修补最低输出 |
| 余额/授权 | 低于所需金额或 spender/额度变化 | 拒绝执行或生成独立授权计划 |
| Gas 成本 | 以费用上限计算后的净利润低于 `min_profit` | 拒绝执行 |
| deadline | 预计打包时间已接近 deadline | 丢弃并生成新交易 |

`max_block_lag` 和 `max_quote_age` 应按链、流动性和策略分别配置。原型阶段可以从“1 个新区块或 15 秒，任一先到即失效”开始采样，但不能把这个值直接当作所有链的生产参数。

## 六、执行保护分层

### 本地必须检查

- `chain_id` 与钱包当前网络一致；
- `to` 是审核过的 Executor 或协议合约；
- 目标合约存在代码，必要时比对白名单中的 runtime bytecode hash；
- 函数 selector、Token 地址、spender、recipient 和退款地址均在允许范围；
- 输入金额、授权额度、`value`、滑点、deadline 和 Gas 费用不超过硬上限；
- Quote、模拟和人工审批使用完全相同的 calldata hash；
- 同一 `signal_id` 没有处于 pending、confirmed 或 replaced 状态；
- 使用费用上限而不是当前乐观 Gas 价格计算最坏成本。

本地检查便于解释和阻止错误签名，但本地程序可以崩溃、被绕过或在广播后失去控制。

### 合约必须检查

- 只允许授权的调用者、目标合约和函数；
- 在同一笔交易内完成整个往返路径；
- 每一步使用明确的最低输出或价格边界；
- `block.number` 和 `block.timestamp` 不超过调用参数中的上限；
- 执行结束后根据 Executor 的计价币余额差计算实际利润；
- 实际利润小于 `minProfit` 时整笔交易 revert；
- 中间失败时不遗留可被任意地址取走的 Token；
- 紧急暂停、提款和授权撤销只能由受控权限执行。

最终利润检查应类似：

```text
balanceBefore = quoteToken.balanceOf(executor)
执行完整往返路径
balanceAfter = quoteToken.balanceOf(executor)
require(balanceAfter >= balanceBefore + minProfit)
```

如果 Gas 由外部 EOA 支付，合约看到的 Token 余额差不包含 Gas。此时 `minProfit` 必须在链下先按 `maxFeePerGas × gasLimit` 和安全余量折算，合约负责保证 Token 毛利润底线，链下负责保证扣 Gas 后仍满足净利润目标。

## 七、放行决策

候选交易只有全部满足下列条件才进入人工签名：

```text
quote_complete
AND calldata_allowlisted
AND quote_fresh
AND block_not_reorged
AND balance_and_allowance_sufficient
AND baseline_eth_call_passed
AND latest_eth_call_passed
AND gas_estimate <= max_gas
AND pessimistic_net_profit >= min_net_profit
AND deadline_has_margin
AND no_same_signal_pending
```

任何一步失败都返回结构化拒绝原因，不允许通过“忽略错误继续发送”降级。

建议的拒绝码：

| 分类 | 示例代码 |
| --- | --- |
| 输入 | `INVALID_CHAIN`、`TARGET_NOT_ALLOWED`、`CALLDATA_CHANGED` |
| 状态 | `STALE_BLOCK`、`QUOTE_EXPIRED`、`REORG_DETECTED` |
| 资产 | `INSUFFICIENT_BALANCE`、`INSUFFICIENT_ALLOWANCE` |
| 收益 | `SLIPPAGE_EXCEEDED`、`MIN_PROFIT_NOT_MET`、`GAS_TOO_HIGH` |
| EVM | `REVERT_ERROR_STRING`、`REVERT_PANIC`、`REVERT_CUSTOM_ERROR` |
| 基础设施 | `RPC_TIMEOUT`、`RPC_RATE_LIMITED`、`SIMULATION_UNAVAILABLE` |

对于 EVM revert，应依次尝试解码 `Error(string)`、`Panic(uint256)` 和已知 ABI 的 custom error；无法解码时保存前 4 字节 selector、完整 revert data 的哈希和 RPC 供应商，不把所有失败都归类为“滑点”。

## 八、模拟记录格式

每次模拟至少保存：

| 字段 | 内容 |
| --- | --- |
| 身份 | `simulation_id`、`signal_id`、策略版本、Git commit |
| 状态 | chain ID、区块号、区块哈希、区块时间、RPC Provider |
| 交易 | from、to、value、calldata hash、deadline |
| 资产 | Token 地址、输入金额、最低输出、最低利润、余额和授权 |
| 结果 | success、返回值、revert 分类、revert data hash |
| Gas | estimate、gas limit、max fee、最坏 Gas 成本 |
| 时效 | Quote 时间、模拟开始/结束时间、广播前区块 |
| 决策 | allow/reject、规则版本、所有拒绝原因 |

不建议默认长期保存完整 calldata 和完整 revert data 到公开日志，因为其中可能包含可被关联的地址和策略细节。审计库可加密保存，普通日志只记录哈希和必要摘要。

## 九、池状态变化测试方案

后续实现 Executor 后，使用固定区块 fork 完成以下测试：

1. 在区块 `H` fork 链状态并生成一条原本通过的候选交易；
2. 记录 Executor、Token、输入金额、`minProfit` 和 calldata hash；
3. 先执行一次基准模拟，确认交易成功且余额差达到阈值；
4. 在同一 fork 中用另一个账户先执行一笔大额 Swap，改变目标池价格；
5. 不修改原交易 calldata，再次模拟；
6. 预期结果必须是 `SLIPPAGE_EXCEEDED` 或 `MIN_PROFIT_NOT_MET` 并整笔 revert；
7. 检查 Executor 和调用账户没有遗留异常中间资产或无限授权。

这个测试必须验证“合约主动拒绝”，不能只验证本地程序选择不发送。

## 十、本日模拟记录

| 项目 | 结果 |
| --- | --- |
| 候选来源 | 当前 LI.FI 同链双向 Quote 监控原型 |
| 模拟区块/时间 | 未执行；当前历史没有保存区块号与区块哈希 |
| 预期输出/利润 | 页面可计算 Quote 级结果，但不是原子执行结果 |
| Gas 估算 | 仅使用 LI.FI 返回的估算字段，未独立调用 `eth_estimateGas` |
| 状态差异 | 未建立固定区块 fork，无法注入池状态变化 |
| 放行/拒绝 | 拒绝进入签名阶段 |
| 拒绝原因 | 缺少原子 Executor、最终 calldata、固定区块模拟和链上 `minProfit` 检查 |

这是一条有效的安全验收结果：准备条件不完整时必须拒绝，而不是为了勾选任务构造一次真实资金交易。

## 十一、动手任务完成情况

- [x] 区分 LI.FI 模拟、`eth_call`、`eth_estimateGas` 与 fork 的职责。
- [x] 定义模拟记录、revert 分类和放行决策格式。
- [x] 定义 stale block、Quote 年龄、max gas、deadline 和 min profit 硬限制。
- [x] 设计池状态变化测试及预期拒绝结果。
- [ ] 实现原子 Executor 合约及链上最终利润检查。
- [ ] 对最终 Executor calldata 运行真实 `eth_call` 和 `eth_estimateGas`。
- [ ] 在固定区块 fork 中执行状态扰动测试。

## 今日复盘

### 哪些校验应在本地做，哪些必须在合约中做？

地址白名单、代码哈希、calldata 可读展示、余额、授权、Gas 成本、Quote 年龄和重复提交适合先在本地检查。原子性、每步最低输出、deadline 和最终余额差必须由合约再次检查。本地校验负责减少错误，合约校验负责保证交易即使被广播也不能越过资金底线。

### 模拟与广播之间允许多长时间？

没有跨链通用的固定秒数。应使用 `max_quote_age`、`max_block_lag` 和关键池状态变化共同判断。对本原型可先采用“1 个新区块或 15 秒，任一先到即重新报价和模拟”作为采样起点，再用真实延迟分布校准。

### 如何分类并统计 revert 原因？

先按输入、状态、资产、收益、EVM 和基础设施六类归档，再保存稳定的错误码。EVM 层继续解码 `Error(string)`、`Panic(uint256)` 和 custom error。指标只使用低基数错误码，完整 selector、交易哈希和 revert 摘要保存在可查询日志中。

## 参考资料

- [Ethereum JSON-RPC API](https://ethereum.org/developers/docs/apis/json-rpc/)
- [Geth `eth_call` 文档](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth)
- [LI.FI Quote API](https://docs.li.fi/api-reference/get-a-quote-for-a-token-transfer)
- [LI.FI Quote 与 Route 的区别](https://docs.li.fi/introduction/user-flows-and-examples/difference-between-quote-and-route)

