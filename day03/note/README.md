# Day 03 学习计划：读懂 Uniswap V3 Pool 与价格状态

## 今日定位

Day01—02 已经完成 V2 的核心机制，并初步接触了 V3 的 Tick、有效流动性和 Callback。今天不重复比较版本，也不要求从头推导全部数学公式，而是完成一个可验证的工程目标：

> 给定一个 Ethereum 主网 V3 Pool，在指定区块读取状态，并正确输出币对、费率、当前价格、Tick 和有效流动性。

建议投入 4—6 小时。如果价格方向、Token decimals 或 `sqrtPriceX96` 转换仍不稳定，可以把相邻 Tick 查询顺延到 Day04，不要为了赶进度跳过价格验证。

## 今日目标

- 说清楚 Factory、Pool、SwapRouter、Quoter 和 NonfungiblePositionManager 的职责。
- 理解 V3 Pool 由 `token0 + token1 + fee` 唯一确定。
- 理解 `slot0`、`sqrtPriceX96`、Tick、`tickSpacing` 和当前有效 `liquidity`。
- 能处理 Token 顺序、decimals、正反价格和定点数精度。
- 生成一份可供后续报价程序使用的 Pool 状态快照。

## 一、从 V2 迁移到 V3 的最小认知

只围绕后续套利程序需要的变化学习：

| 问题 | V2 | V3 |
| --- | --- | --- |
| 池的身份 | `token0 + token1` | `token0 + token1 + fee` |
| 主要价格状态 | `reserve0/reserve1` | `sqrtPriceX96`、Tick |
| 流动性 | 全价格范围储备 | 当前区间有效 `liquidity` + 各 Tick 状态 |
| LP 凭证 | 同质化 ERC-20 | 不同区间头寸通常由 NFT 表示 |
| Swap 收款 | 通常先向 Pair 转入 Token | Pool 计算后通过 Callback 收款 |

今天必须区分：

- Pool 合约中的 `liquidity()` 是当前价格区间的有效流动性，不是 TVL。
- Pool 的 Token 余额不能直接代替 V2 储备进行报价。
- 一个币对可以同时存在多个费率 Pool，每个 Pool 的价格和流动性相互独立。

## 二、价格、Tick 与 `sqrtPriceX96`

理解以下关系及用途，不要求脱稿证明：

```text
rawPrice(token1/token0) = 1.0001^tick
sqrtPriceX96 = sqrt(rawPrice) × 2^96
humanPrice(token1/token0)
  = rawPrice × 10^(decimals0-decimals1)
```

动手时必须验证四个常见错误：

1. 把 token0/token1 的方向写反。
2. 忘记按两种 Token 的 decimals 修正。
3. 将平方根价格除以 `2^96` 后忘记平方。
4. 直接使用普通浮点数处理链上大整数，造成不可控误差。

建议同时输出两个方向的价格，并在字段名中写清楚单位，例如：

```text
USDC per WETH
WETH per USDC
```

## 三、Tick 与有效流动性

今天掌握概念和状态含义，不展开完整逐 Tick Swap 公式：

- Tick 是对数价格坐标，价格可以处在两个可用头寸边界之间。
- `tickSpacing` 限制 LP 头寸边界可选择的 Tick。
- 只有被头寸边界使用的 Tick 才需要初始化。
- `liquidityGross` 表示以该 Tick 为边界的总流动性。
- `liquidityNet` 用于价格穿越该 Tick 时调整当前有效流动性。
- 头寸只在 `[tickLower, tickUpper)` 内处于活跃状态并赚取手续费。

## 四、今日动手任务

### 必做任务 A：实现价格转换工具

在 `day03/src/` 中实现并验证：

- [ ] `tick_to_raw_price(tick)`
- [ ] `sqrt_price_x96_to_raw_price(sqrt_price_x96)`
- [ ] decimals 修正后的 Human Price
- [ ] 正向价格与反向价格
- [ ] 对非法 decimals、零价格和错误 Token 顺序给出明确错误

至少准备三类测试：

- Tick 为 0 时 Raw Price 应接近 1。
- 同一个 Pool 的 Tick 价格与 `sqrtPriceX96` 价格应接近。
- USDC/WETH 这类 decimals 不同的币对，输出价格数量级应符合常识。

### 必做任务 B：读取真实 V3 Pool

选择 Ethereum 主网一个流动性充足的 WETH/USDC V3 Pool，通过 Factory 或已核验地址读取：

- [ ] `token0()`、`token1()`
- [ ] 两个 Token 的 `symbol()`、`decimals()`
- [ ] `fee()`、`tickSpacing()`
- [ ] `slot0()`
- [ ] `liquidity()`
- [ ] 查询使用的 `chainId`、`blockNumber` 和 Pool 地址

所有状态尽量使用同一个明确的 `blockTag`。输出一份结构化快照，例如：

```json
{
  "chain_id": 1,
  "block_number": 0,
  "pool": "0x...",
  "token0": {"address": "0x...", "symbol": "...", "decimals": 0},
  "token1": {"address": "0x...", "symbol": "...", "decimals": 0},
  "fee": 0,
  "tick_spacing": 0,
  "sqrt_price_x96": "0",
  "tick": 0,
  "liquidity": "0",
  "price_token1_per_token0": "0",
  "price_token0_per_token1": "0"
}
```

### 进阶任务：相邻初始化 Tick

- [ ] 理解 Tick Bitmap 中 word、bit 和压缩 Tick 的关系。
- [ ] 找到当前 Tick 左右最近的已初始化 Tick。
- [ ] 读取它们的 `liquidityGross` 和 `liquidityNet`。

如果这部分超过 90 分钟仍未打通，只记录问题并顺延到 Day04。Tick Bitmap 是实现高效离线报价的重要工具，但不是今天完成价格读取的前置条件。

## 五、今日交付物

- [ ] 一份价格转换 Python 代码及最小测试。
- [ ] 一份固定区块的真实 Pool 状态快照。
- [ ] 一张“字段含义与套利用途”表。
- [ ] 一份错误记录，至少包含 Token 顺序、decimals 和精度检查。

字段记录模板：

| 字段 | 从哪里读取 | 实际值 | 套利用途 | 是否必须实时读取 |
| --- | --- | --- | --- | --- |
| `sqrtPriceX96` | `slot0` |  | 当前价格/报价起点 | 是 |
| `tick` | `slot0` |  | 定位当前价格区间 | 是 |
| `liquidity` | Pool |  | 当前区间深度 | 是 |
| `tickSpacing` | Pool |  | Tick 扫描规则 | 否 |
| Token decimals | Token |  | Human Price 修正 | 否 |

## 六、完成标准

今天完成后，应当能够不依赖区块浏览器界面的价格显示，仅使用链上状态回答：

1. 这个 Pool 对应哪两个 Token 和哪个费率档？
2. 当前价格是多少，价格方向是什么？
3. 当前 Tick 和有效流动性是多少？
4. 为什么不能使用 Pool 的 Token 总余额套用 V2 公式？
5. 所有输出是否来自同一明确区块？

如果前四项仍无法稳定回答，Day04 不进入完整跨 Tick 数学，先补齐今天的状态读取和价格转换。

## 官方资料

- [Uniswap V3 Core](https://github.com/Uniswap/v3-core)
- [Uniswap V3 Development Book](https://uniswapv3book.com/)
- [Uniswap 集中流动性概念](https://developers.uniswap.org/docs/get-started/concepts/liquidity-providers/concentrated-liquidity)

