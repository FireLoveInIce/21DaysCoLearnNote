# Day 16 学习记录：可观测性、回放与监控验收

## 今日结论

- 可观测性不只是“打印日志”，而是让一次区块采集、事件解析、报价请求和信号判断能够通过关联 ID 串起来。
- 回放必须固定链、区块、配置和程序版本，并且只读取当时已经产生的数据；否则会不小心使用未来状态，得到无法复现的结果。
- 当前 LI.FI 面板已经能展示 Quote 用时、Provider、Gas、费用、净收益、ROI、报价年龄和浏览器内历史，但还不能完成严格的链上历史回放。
- `localStorage` 适合个人学习页面保存少量配置和结果，不适合作为审计记录、跨设备历史或告警状态的唯一来源。
- Day 12—16 的监控原型已经完成“人工选择交易对 → 双向 Quote → 成本折算 → 候选信号 → 页面展示”的闭环；“链上事件自动发现 → 服务端持久化 → 可复现回放 → 外部告警”仍是下一阶段工作。

## 一、当前监控链路盘点

当前实现位于 [`project/monitor/`](../../project/monitor/)，数据流如下：

```text
用户配置链、Token、金额和阈值
              ↓
        正向 LI.FI Quote
              ↓
使用正向 toAmountMin 请求反向 Quote
              ↓
折算 Gas 和未包含费用，计算净收益与 ROI
              ↓
页面展示结果，并保存最近 80 条浏览器历史
```

已经可观察的内容：

| 类别 | 当前字段或行为 | 保存位置 |
| --- | --- | --- |
| 请求状态 | idle、scanning、running、error | 页面内存 |
| Quote 明细 | Provider、输入、`toAmountMin`、费用、Gas、预计时长 | 当前页面 |
| 信号结果 | 候选机会、未达阈值、扫描失败 | 当前页面 |
| 性能 | 两次 Quote 的总用时 `durationMs` | 当前页面 |
| 新鲜度 | 最后扫描时间、报价年龄，超过 60 秒提示为历史参考 | 当前页面 |
| 历史 | 时间、链、交易对、投入、返还、净收益、ROI | `localStorage`，最多 80 条 |
| 活动日志 | 开始扫描、结果、暂停、限流和错误 | 页面内存，最多 24 条 |
| 请求预算 | 最近两小时 Quote 次数 | `localStorage` |

当前缺口：

- 历史记录没有保存区块号、区块哈希、原始 Quote、完整配置和代码版本；
- 活动日志不是结构化数据，刷新页面后会消失；
- 不同浏览器之间不能共享历史；
- 用户可以直接修改或删除 `localStorage`，因此它不能作为审计证据；
- 页面没有 Alchemy 采集器的 checkpoint、断线次数和补漏结果；
- 没有邮件、Webhook、Telegram 等外部告警通道。

因此，当前面板适合机会观察和交互验证，不等同于已经完成生产级监控验收。

## 二、关联 ID 设计

一次信号不应只依赖时间戳。建议使用以下 ID 把各阶段串联起来：

| ID | 建议生成方式 | 用途 |
| --- | --- | --- |
| `run_id` | 每次进程或定时任务启动生成 UUID | 区分一次运行周期 |
| `scan_id` | 每轮扫描生成 UUID | 串联正向 Quote、反向 Quote 和最终信号 |
| `block_id` | `chain_id:block_number:block_hash` | 标识不可混淆的链上状态 |
| `event_id` | `chain_id:tx_hash:log_index` | 事件去重；不能只用交易哈希 |
| `quote_id` | 优先使用供应商 ID，否则对规范化输入、响应和时间做哈希 | 定位一次报价 |
| `signal_id` | 对策略版本、区块哈希、Token、金额和路线做确定性哈希 | 防止同一机会重复告警 |
| `alert_id` | `signal_id:channel:policy_version` | 追踪告警发送与重试 |

区块号不足以唯一标识历史状态，因为链重组后相同高度可能对应不同区块哈希。事件唯一键也必须包含 `logIndex`，因为同一交易可以发出多个同类事件。

## 三、结构化日志

日志应是一行一个 JSON 对象，字段名和类型保持稳定。推荐的最小结构：

```json
{
  "timestamp": "2026-08-23T15:30:45.123Z",
  "level": "info",
  "event": "quote.completed",
  "run_id": "run_uuid",
  "scan_id": "scan_uuid",
  "chain_id": 8453,
  "block_number": 12345678,
  "block_hash": "0x...",
  "provider": "OKX",
  "duration_ms": 842,
  "success": true,
  "error_code": null
}
```

推荐事件名称：

- `collector.connected`、`collector.disconnected`、`collector.backfill_completed`；
- `block.received`、`event.decoded`、`event.duplicate`；
- `quote.started`、`quote.completed`、`quote.failed`；
- `signal.created`、`signal.rejected`、`signal.expired`；
- `alert.sent`、`alert.failed`、`alert.acknowledged`。

日志中不能记录私钥、助记词、API Key、完整授权头或签名。钱包地址虽然是公开数据，也应只在确有排障需要时记录，并设置保留期限。

## 四、核心指标与计算方式

### 采集健康度

| 指标 | 计算方式 | 作用 |
| --- | --- | --- |
| `head_lag_blocks` | 节点最新高度减去本地 checkpoint 高度 | 发现采集落后 |
| `event_delay_seconds` | 收到事件时间减去区块时间 | 观察端到端延迟 |
| `disconnect_total` | WebSocket 断线次数 | 判断节点或网络稳定性 |
| `backfill_blocks_total` | 每次重连后补扫区块数 | 判断断线影响范围 |
| `duplicate_event_ratio` | 重复事件数除以收到事件总数 | 验证去重逻辑 |
| `reconciliation_gap_total` | 二次 `eth_getLogs` 校验发现的缺失事件数 | 衡量数据完整性 |

“数据完整率”不能用程序自己第一次采到的数据作为分母。可在区块达到确认数后，使用固定区块范围重新调用 `eth_getLogs`，将去重后的结果与数据库记录对账。

### 报价与信号质量

| 指标 | 计算方式 | 作用 |
| --- | --- | --- |
| `quote_latency_ms` | Quote 完成时间减去开始时间 | 识别接口变慢 |
| `quote_success_ratio` | 成功 Quote 数除以总 Quote 数 | 识别限流和供应商异常 |
| `signal_age_seconds` | 当前时间减去信号生成时间 | 阻止使用过期信号 |
| `signal_candidate_total` | 达到本地阈值的信号数 | 观察候选数量 |
| `simulation_pass_ratio` | 模拟通过数除以进入模拟的信号数 | 衡量报价到可执行性的损耗 |
| `realized_profit_error` | 实际净收益减去模拟净收益 | 校准滑点、Gas 和 MEV 模型 |

指标标签只放链、策略版本、结果类型等有限枚举；`tx_hash`、`scan_id`、Token 地址等高基数字段留在日志和数据库中，避免时序指标膨胀。

## 五、告警规则

下面是适合原型阶段的初始阈值，不是已经测得的生产基线。运行一段时间后应根据各链出块速度和历史分布调整。

| 告警 | 初始触发条件 | 恢复条件 | 处理动作 |
| --- | --- | --- | --- |
| 采集落后 | `head_lag_blocks >= 3` 持续两轮 | 落后小于 2 个区块 | 检查节点、补漏和 checkpoint |
| 连续失败 | 同一链连续 3 次 RPC 或 Quote 失败 | 下一次完整扫描成功 | 切换备用节点或降低频率 |
| 数据缺口 | 确认区块对账出现缺失事件 | 补漏并再次对账一致 | 暂停该链信号输出 |
| Quote 变慢 | 延迟超过滚动 P95 的 2 倍 | 连续 3 次回到阈值内 | 检查 Provider 和网络 |
| 请求预算 | 本地两小时预算使用达到 90% | 窗口滚动后低于 70% | 暂停自动扫描 |
| 高价值信号 | 净收益、ROI、模拟结果同时超过策略阈值 | 信号过期或已处理 | 发送一次告警并按 `signal_id` 去重 |

高价值信号告警必须包含链、区块、Token 地址、输入金额、最低输出、净收益、报价年龄和详情链接。只展示 Ticker 容易把同名 Token 混淆。

## 六、历史回放设计

### 回放所需输入

每个可回放案例至少保存：

- `chain_id`、`block_number`、`block_hash` 和区块时间；
- 原始日志的 `transactionHash`、`logIndex`、topics 和 data；
- Token 地址、decimals、输入金额和方向；
- 策略版本、配置快照、阈值和依赖版本；
- Quote 请求参数、原始响应、供应商与接收时间；
- 最终判定、拒绝原因和程序版本 Git commit。

### 回放流程

```text
读取案例清单并校验 block_hash
              ↓
只加载 block_number 及之前的事件和配置
              ↓
按当时的策略版本重建池状态或读取固定区块状态
              ↓
重新计算候选、费用、Gas 和阈值
              ↓
与历史 signal_id、结果和拒绝原因逐项比较
```

为了避免未来数据污染：

1. 所有链上 `eth_call` 都指定历史区块，而不是使用 `latest`；
2. Token 元数据、白名单和策略参数使用当时的快照；
3. 不用后来的价格、后来新增的池或最终交易结果参与当时的信号生成；
4. 真实交易结果只在回放完成后用于评价命中情况；
5. 节点无法读取旧状态时使用 archive node，不能悄悄回退到最新状态。

LI.FI Quote 是短时在线报价，不能通过今天重新请求来还原过去的同一条路线。严格回放必须保存原始 Quote；如果要重算历史池状态，则需要直接对历史区块的协议 Quoter 或本地 fork 进行调用。

## 七、案例复盘：Base USDC → WETH → USDC

Day 14 和 Day 15 已使用 Base 上的 USDC → WETH → USDC 完成双向 Quote 验证：正反向均成功返回，页面能够展示 Provider、`toAmountMin`、Gas 和费用，并正确得出示例不盈利的结论。

本次用它检查回放能力，结果如下：

| 项目 | 结果 |
| --- | --- |
| 原始案例来源 | Day 14/15 的在线 Quote 验证记录 |
| 可确认内容 | 路线、接口成功、字段可读取、示例未达到盈利阈值 |
| 缺失内容 | 精确时间、区块号/哈希、原始响应、完整配置、代码 commit |
| 能否精确回放 | 不能 |
| 根因 | 浏览器历史只保存摘要，旧 Quote 也不能按历史区块重新请求 |
| 改进 | 服务端保存原始输入/响应、固定区块和版本，再建立 replay 命令 |

这个案例说明“页面曾显示过正确结果”和“系统可以复现、解释该结果”是两件事。当前只完成前者。

## 八、Cloudflare 组件职责

| 组件 | 适合承担 | 不适合承担 |
| --- | --- | --- |
| Workers | 接收采集数据、标准化、查询 API、定时检查、告警编排 | 长时间常驻 WebSocket 采集器的唯一运行环境 |
| D1 | 结构化保存区块、事件、Quote、信号、告警和回放结果；按字段查询和关联 | 大体积原始文件或无限增长的高频时序数据 |
| KV | 低频更新的配置、白名单、功能开关、告警冷却状态和可丢失缓存 | 强一致 checkpoint、事件去重和资金状态 |
| Cache API | 缓存公开且可重复生成的查询结果，减少 D1/API 压力 | 审计记录、唯一事实来源和必须立即一致的数据 |

KV 是最终一致的，其他地区可能短时间读到旧值，因此不能依赖它完成“只告警一次”或原子推进 checkpoint。需要唯一约束和可查询历史的内容优先放 D1；需要严格串行协调时再考虑 Durable Objects。

当前 GitHub Pages 版本没有接入上述 Cloudflare 后端，这一节是后续架构设计，不代表已经部署。

## 九、验收结果

| 验收项 | 目标 | 当前实际 | 结果 |
| --- | --- | --- | --- |
| Quote 可见性 | 展示耗时、路线、费用、Gas、收益与状态 | 页面已展示 | 通过 |
| 报价新鲜度 | 明确显示年龄，过期不伪装成实时结果 | 超过 60 秒标记为历史参考 | 通过 |
| 请求预算保护 | 接近额度时停止持续请求 | 最近两小时本地预算限制为 70 次 | 通过（单浏览器） |
| 区块/事件延迟 | 保存区块时间、接收时间和 checkpoint | 尚未接入面板 | 未通过 |
| 数据完整性 | 确认区块二次对账，缺口自动补齐 | Day 12 有 checkpoint 示例，未与面板打通 | 未通过 |
| 信号可回放 | 固定区块、原始输入和版本可复现 | 当前历史仅保存摘要 | 未通过 |
| 外部告警 | 去重、重试并记录送达时间 | 尚未实现 | 未通过 |

## 十、动手任务完成情况

- [x] 定义结构化日志、关联 ID 和核心指标。
- [x] 审核现有信号明细、历史、日志和新鲜度展示。
- [x] 选择 Base USDC → WETH → USDC 案例检查回放条件，并定位无法精确回放的字段缺口。
- [x] 定义延迟、断线、连续失败、预算和高价值信号告警规则。
- [ ] 将区块、原始 Quote、配置和版本持久化到服务端。
- [ ] 实现固定区块 replay 命令和外部告警通道。

## 阶段复盘

### 当前系统能稳定捕捉哪类机会？

当前系统能够稳定完成“用户指定同链计价币与中间币后，调用两次 LI.FI Quote 并计算保守净收益”的低频候选观察。它还不能自动从链上事件发现全市场机会，也不能证明两个顺序 Quote 可以原子执行。

### 哪些误报必须在进入执行阶段前解决？

- 两次 Quote 之间状态变化导致的伪利润；
- Gas 或 Token 美元价格缺失造成的成本低估；
- 同名、恶意、转账税或非标准 Token；
- 旧 Quote、重复信号和链重组后的失效事件；
- 本地盈利但链上执行末尾无法达到最低利润。

### 下一阶段执行接口需要接收哪些字段？

执行接口至少应接收：

```text
signal_id、strategy_version、chain_id、observed_block_number、observed_block_hash
sender、recipient、executor、target、calldata、value
token_in、token_out、amount_in、min_amount_out、min_profit
spender、allowance_amount、gas_limit、max_fee_per_gas、max_priority_fee_per_gas
deadline、max_block_lag、quote_received_at、quote_id
```

执行层必须重新校验这些字段，不能因为监控层已经判断“候选机会”就直接签名。

## 参考资料

- [Ethereum JSON-RPC API](https://ethereum.org/developers/docs/apis/json-rpc/)
- [Cloudflare Workers 存储选型](https://developers.cloudflare.com/workers/platform/storage-options/)
- [Cloudflare D1 入门](https://developers.cloudflare.com/d1/get-started/)
- [Cloudflare Workers KV 一致性说明](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

