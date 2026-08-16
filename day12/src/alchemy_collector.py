"""Day 12：Alchemy 节点与简易链上数据采集。

HTTP 查询使用 Python 标准库；WebSocket 订阅使用 websockets。
请通过环境变量传入节点地址，不要把 Alchemy API Key 写进代码。
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Callable
import urllib.request


def rpc_call(rpc_url: str, method: str, params: list[Any] | None = None) -> Any:
    """发送一个 HTTP JSON-RPC 请求。"""

    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params or [],
    }
    request = urllib.request.Request(
        rpc_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        result = json.load(response)
    if "error" in result:
        raise RuntimeError(f"RPC {method} 失败：{result['error']}")
    return result["result"]


def batch_rpc_call(rpc_url: str, calls: list[tuple[str, list[Any]]]) -> list[Any]:
    """批量调用 RPC，并按照传入 calls 的顺序返回结果。"""

    payload = [
        {"jsonrpc": "2.0", "id": index, "method": method, "params": params}
        for index, (method, params) in enumerate(calls, start=1)
    ]
    request = urllib.request.Request(
        rpc_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        responses = json.load(response)
    by_id = {item["id"]: item for item in responses}
    ordered: list[Any] = []
    for request_id in range(1, len(calls) + 1):
        item = by_id[request_id]
        if "error" in item:
            raise RuntimeError(f"批量 RPC 第 {request_id} 项失败：{item['error']}")
        ordered.append(item["result"])
    return ordered


def get_latest_block_number(rpc_url: str) -> int:
    """获取最新区块高度。"""

    return int(rpc_call(rpc_url, "eth_blockNumber"), 16)


def get_block(rpc_url: str, block_number: int, full_transactions: bool = False) -> dict:
    """获取指定区块；full_transactions=True 时返回完整交易对象。"""

    return rpc_call(
        rpc_url,
        "eth_getBlockByNumber",
        [hex(block_number), full_transactions],
    )


def get_transaction(rpc_url: str, transaction_hash: str) -> dict | None:
    """通过交易哈希获取交易内容。"""

    return rpc_call(rpc_url, "eth_getTransactionByHash", [transaction_hash])


def get_transaction_receipt(rpc_url: str, transaction_hash: str) -> dict | None:
    """获取交易执行状态、Gas 和事件日志。"""

    return rpc_call(rpc_url, "eth_getTransactionReceipt", [transaction_hash])


def get_logs(
    rpc_url: str,
    from_block: int,
    to_block: int,
    address: str | None = None,
    topics: list[Any] | None = None,
) -> list[dict]:
    """通过 eth_getLogs 获取一个闭区间内的历史日志。"""

    log_filter: dict[str, Any] = {
        "fromBlock": hex(from_block),
        "toBlock": hex(to_block),
    }
    if address:
        log_filter["address"] = address
    if topics:
        log_filter["topics"] = topics
    return rpc_call(rpc_url, "eth_getLogs", [log_filter])


def call_contract(
    rpc_url: str,
    contract_address: str,
    calldata: str,
    block_number: int,
) -> str:
    """在指定区块执行 eth_call，避免多次读取混用不同区块状态。"""

    return rpc_call(
        rpc_url,
        "eth_call",
        [{"to": contract_address, "data": calldata}, hex(block_number)],
    )


def read_checkpoint(checkpoint_file: str | Path) -> int | None:
    """读取上次已经补扫完成的区块号。"""

    path = Path(checkpoint_file)
    if not path.exists():
        return None
    return int(json.loads(path.read_text(encoding="utf-8"))["block_number"])


def write_checkpoint(checkpoint_file: str | Path, block_number: int) -> None:
    """保存补扫进度；生产系统应改为与业务数据放在同一数据库事务中。"""

    path = Path(checkpoint_file)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"block_number": block_number}, indent=2),
        encoding="utf-8",
    )


def backfill_logs(
    rpc_url: str,
    checkpoint_file: str | Path,
    handle_log: Callable[[dict], None],
    *,
    start_block: int,
    address: str | None = None,
    topics: list[Any] | None = None,
    confirmations: int = 12,
    chunk_size: int = 500,
) -> int:
    """从 checkpoint 后继续分段补扫日志，并返回最新完成高度。"""

    latest = get_latest_block_number(rpc_url)
    safe_end = max(0, latest - confirmations)
    checkpoint = read_checkpoint(checkpoint_file)
    cursor = start_block if checkpoint is None else checkpoint + 1

    while cursor <= safe_end:
        end = min(cursor + chunk_size - 1, safe_end)
        for log in get_logs(rpc_url, cursor, end, address, topics):
            handle_log(log)
        # handle_log 全部成功后才推进 checkpoint，失败时下次会重新补扫。
        write_checkpoint(checkpoint_file, end)
        cursor = end + 1
    return safe_end


async def subscribe_logs_once(
    ws_url: str,
    handle_log: Callable[[dict], None],
    *,
    address: str | None = None,
    topics: list[Any] | None = None,
) -> None:
    """建立一次 WebSocket 日志订阅；连接断开时函数返回或抛错。"""

    from websockets.asyncio.client import connect

    log_filter: dict[str, Any] = {}
    if address:
        log_filter["address"] = address
    if topics:
        log_filter["topics"] = topics

    async with connect(ws_url, ping_interval=20, ping_timeout=20) as websocket:
        request = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_subscribe",
            "params": ["logs", log_filter],
        }
        await websocket.send(json.dumps(request))
        reply = json.loads(await websocket.recv())
        if "error" in reply:
            raise RuntimeError(f"订阅失败：{reply['error']}")

        async for message in websocket:
            event = json.loads(message)
            if event.get("method") == "eth_subscription":
                handle_log(event["params"]["result"])


async def collect_logs_with_reconnect(
    rpc_url: str,
    ws_url: str,
    checkpoint_file: str | Path,
    handle_log: Callable[[dict], None],
    *,
    start_block: int,
    address: str | None = None,
    topics: list[Any] | None = None,
    confirmations: int = 12,
) -> None:
    """断线后先用 HTTP 补漏，再重新建立 WebSocket 订阅。"""

    from websockets.exceptions import ConnectionClosed

    while True:
        try:
            await asyncio.to_thread(
                backfill_logs,
                rpc_url,
                checkpoint_file,
                handle_log,
                start_block=start_block,
                address=address,
                topics=topics,
                confirmations=confirmations,
            )
            await subscribe_logs_once(
                ws_url,
                handle_log,
                address=address,
                topics=topics,
            )
        except (ConnectionClosed, OSError, TimeoutError, RuntimeError) as error:
            print(f"连接中断：{error}；5 秒后补漏并重连")
            await asyncio.sleep(5)


def print_log(log: dict) -> None:
    """最简单的日志处理函数：输出 JSON；可替换为数据库写入。"""

    print(json.dumps(log, ensure_ascii=False))


if __name__ == "__main__":
    # 这是最小查询示例；完整调用方式见 day12/note/README.md。
    import os

    url = os.environ.get("ALCHEMY_HTTP_URL")
    if not url:
        raise SystemExit("请先设置 ALCHEMY_HTTP_URL")
    latest_block = get_latest_block_number(url)
    print(json.dumps(get_block(url, latest_block), ensure_ascii=False, indent=2))
