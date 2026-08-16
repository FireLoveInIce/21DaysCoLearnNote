# Day 12：Alchemy 节点与链上数据采集

## 今日结论

- HTTP RPC 用于区块、交易、回执、合约状态和历史日志查询。
- WebSocket 用于尽快收到新日志，但断线期间的数据不会自动重放。
- 最简单的可靠方案是：保存 checkpoint，断线后先用 `eth_getLogs` 补漏，再重新订阅。
- 批量 RPC 可以减少 HTTP 往返，但不保证多个请求来自同一状态；读取合约状态时仍要给每个 `eth_call` 指定相同区块号。

实现位于 [`day12/src/alchemy_collector.py`](../src/alchemy_collector.py)，每项功能均为独立函数。

## 1. 准备环境

安装 WebSocket 依赖：

```powershell
.\.venv\Scripts\python.exe -m pip install -e .
```

从 Alchemy 控制台复制 HTTP 和 WebSocket 地址，只保存在环境变量中：

```powershell
$env:ALCHEMY_HTTP_URL="https://eth-mainnet.g.alchemy.com/v2/你的Key"
$env:ALCHEMY_WS_URL="wss://eth-mainnet.g.alchemy.com/v2/你的Key"
```

快速验证最新区块：

```powershell
.\.venv\Scripts\python.exe day12\src\alchemy_collector.py
```

## 2. 查询区块、交易和回执

```python
import os

from day12.src.alchemy_collector import (
    get_block,
    get_latest_block_number,
    get_transaction,
    get_transaction_receipt,
)

rpc_url = os.environ["ALCHEMY_HTTP_URL"]

height = get_latest_block_number(rpc_url)
block = get_block(rpc_url, height, full_transactions=False)

transaction_hash = block["transactions"][0]
transaction = get_transaction(rpc_url, transaction_hash)
receipt = get_transaction_receipt(rpc_url, transaction_hash)

print(height)
print(transaction)
print(receipt)
```

`get_transaction()` 返回交易输入等内容；`get_transaction_receipt()` 返回执行成功状态、Gas 和事件日志。

## 3. 获取历史事件日志

以下示例查询一个 Uniswap V3 Pool 的 `Swap` 日志：

```python
import os

from day12.src.alchemy_collector import get_logs

rpc_url = os.environ["ALCHEMY_HTTP_URL"]
pool = "0x你的Pool地址"
v3_swap_topic = "0xc42079f94a6350d7e6235f291749249f928cc2ac818eb64bcae59e8ee6c88c0a"

logs = get_logs(
    rpc_url,
    from_block=21_000_000,
    to_block=21_000_100,
    address=pool,
    topics=[v3_swap_topic],
)
print(logs)
```

区块范围过大可能被节点拒绝，实际使用时按几百或几千个区块分段查询。

## 4. 读取合约状态

下面用 ERC-20 `decimals()` 的 selector `0x313ce567` 演示 `eth_call`：

```python
import os

from day12.src.alchemy_collector import call_contract, get_latest_block_number

rpc_url = os.environ["ALCHEMY_HTTP_URL"]
token = "0xA0b86991c6218b36c1d19d4a2e9Eb0cE3606eB48"  # USDC

block_number = get_latest_block_number(rpc_url)
encoded = call_contract(rpc_url, token, "0x313ce567", block_number)
decimals = int(encoded, 16)
print(decimals)
```

先固定 `block_number`，随后对多个 Pool 的读取都使用这个区块号，才能形成一致快照。

## 5. 批量 RPC

```python
import os

from day12.src.alchemy_collector import batch_rpc_call

rpc_url = os.environ["ALCHEMY_HTTP_URL"]
block_number = 21_000_000

results = batch_rpc_call(
    rpc_url,
    [
        ("eth_getBlockByNumber", [hex(block_number), False]),
        ("eth_getBlockByNumber", [hex(block_number + 1), False]),
    ],
)
print(results)
```

返回结果会恢复为 `calls` 的顺序。批量请求适合减少网络开销，不等于原子快照。

## 6. checkpoint 补漏

```python
import os

from day12.src.alchemy_collector import backfill_logs, print_log

rpc_url = os.environ["ALCHEMY_HTTP_URL"]

backfill_logs(
    rpc_url,
    checkpoint_file="day12/checkpoint.json",
    handle_log=print_log,
    start_block=21_000_000,
    address="0x你的Pool地址",
    topics=["0x你的Swap事件Topic"],
    confirmations=12,
)
```

每段日志处理成功后，程序才更新 checkpoint。进程中断后再次调用，会从 checkpoint 的下一个区块继续。

## 7. WebSocket 订阅、断线重连与补漏

```python
import asyncio
import os

from day12.src.alchemy_collector import collect_logs_with_reconnect, print_log

asyncio.run(
    collect_logs_with_reconnect(
        os.environ["ALCHEMY_HTTP_URL"],
        os.environ["ALCHEMY_WS_URL"],
        checkpoint_file="day12/checkpoint.json",
        handle_log=print_log,
        start_block=21_000_000,
        address="0x你的Pool地址",
        topics=["0x你的Swap事件Topic"],
        confirmations=12,
    )
)
```

流程只有三步：

```text
读取 checkpoint 并用 HTTP 补漏
→ 建立 WebSocket 日志订阅
→ 断线后等待 5 秒，再补漏并重连
```

WebSocket 实时消息和之后的 HTTP 补扫可能看到同一日志，因此真正写数据库时应以 `transactionHash + logIndex` 做唯一键。

## 功能与 RPC 对照

| 功能 | Python 函数 | RPC |
| --- | --- | --- |
| 最新高度 | `get_latest_block_number` | `eth_blockNumber` |
| 区块 | `get_block` | `eth_getBlockByNumber` |
| 交易 | `get_transaction` | `eth_getTransactionByHash` |
| 回执 | `get_transaction_receipt` | `eth_getTransactionReceipt` |
| 历史日志 | `get_logs` | `eth_getLogs` |
| 合约状态 | `call_contract` | `eth_call` |
| 批量读取 | `batch_rpc_call` | JSON-RPC batch |
| 实时日志 | `subscribe_logs_once` | `eth_subscribe` |

## 简化版本的边界

- checkpoint 只保存区块号，没有处理深度链重组。
- 固定确认数可以降低短重组风险，但不能提供绝对最终性。
- `handle_log` 应先保存数据，成功返回后才能推进 checkpoint。
- API Key 只放环境变量或 `.env`，不要提交到 Git。
