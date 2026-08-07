"""Minimal Uniswap V3 price conversion and fixed-block pool reader.

Only Python's standard library is used. Set ETH_RPC_URL before running.
"""

from __future__ import annotations

import argparse
from decimal import Decimal, getcontext
import json
import os
import urllib.error
import urllib.request


getcontext().prec = 80
Q96 = 1 << 96
Q192 = 1 << 192

MAINNET_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984"
WETH_USDC_005_POOL = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640"

# First four bytes of keccak256("functionSignature(types)").
SELECTOR = {
    "getPool": "1698ee82",
    "token0": "0dfe1681",
    "token1": "d21220a7",
    "fee": "ddca3f43",
    "tickSpacing": "d0c93a7c",
    "slot0": "3850c7bd",
    "liquidity": "1a686502",
    "symbol": "95d89b41",
    "decimals": "313ce567",
}


def _validate_decimals(value: int, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 255:
        raise ValueError(f"{name} must be an integer in [0, 255]")


def normalize_address(address: str) -> str:
    if not isinstance(address, str) or not address.startswith("0x") or len(address) != 42:
        raise ValueError(f"invalid Ethereum address: {address!r}")
    try:
        int(address[2:], 16)
    except ValueError as exc:
        raise ValueError(f"invalid Ethereum address: {address!r}") from exc
    return "0x" + address[2:].lower()


def validate_token_order(token0: str, token1: str) -> None:
    token0 = normalize_address(token0)
    token1 = normalize_address(token1)
    if token0 == token1:
        raise ValueError("token0 and token1 must be different")
    if int(token0, 16) >= int(token1, 16):
        raise ValueError("invalid V3 token order: token0 must be the lower address")


def tick_to_raw_price(tick: int) -> Decimal:
    if isinstance(tick, bool) or not isinstance(tick, int):
        raise TypeError("tick must be an integer")
    return Decimal("1.0001") ** tick


def sqrt_price_x96_to_raw_price(sqrt_price_x96: int) -> Decimal:
    if isinstance(sqrt_price_x96, bool) or not isinstance(sqrt_price_x96, int):
        raise TypeError("sqrt_price_x96 must be an integer")
    if sqrt_price_x96 <= 0:
        raise ValueError("sqrt_price_x96 must be positive")
    return Decimal(sqrt_price_x96 * sqrt_price_x96) / Decimal(Q192)


def raw_to_human_price(raw_price: Decimal, decimals0: int, decimals1: int) -> Decimal:
    _validate_decimals(decimals0, "decimals0")
    _validate_decimals(decimals1, "decimals1")
    raw_price = Decimal(raw_price)
    if raw_price <= 0:
        raise ValueError("raw_price must be positive")
    return raw_price * (Decimal(10) ** (decimals0 - decimals1))


def prices_from_sqrt_price_x96(
    sqrt_price_x96: int, decimals0: int, decimals1: int
) -> tuple[Decimal, Decimal]:
    token1_per_token0 = raw_to_human_price(
        sqrt_price_x96_to_raw_price(sqrt_price_x96), decimals0, decimals1
    )
    return token1_per_token0, Decimal(1) / token1_per_token0


class JsonRpc:
    def __init__(self, url: str) -> None:
        if not url:
            raise ValueError("RPC URL is empty")
        self.url = url
        self.request_id = 0

    def call(self, method: str, params: list[object]) -> object:
        self.request_id += 1
        payload = json.dumps(
            {"jsonrpc": "2.0", "id": self.request_id, "method": method, "params": params}
        ).encode()
        request = urllib.request.Request(
            self.url,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "User-Agent": "colearn-uniswap-v3-snapshot/1.0",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                result = json.load(response)
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"RPC HTTP error {exc.code}: {exc.reason}") from exc
        if "error" in result:
            raise RuntimeError(f"RPC {method} failed: {result['error']}")
        return result["result"]

    def eth_call(self, to: str, data: str, block: int) -> str:
        return str(self.call("eth_call", [{"to": to, "data": data}, hex(block)]))


def _words(encoded: str) -> list[str]:
    body = encoded.removeprefix("0x")
    if len(body) % 64:
        raise ValueError("invalid ABI response length")
    return [body[index : index + 64] for index in range(0, len(body), 64)]


def _uint(word: str) -> int:
    return int(word, 16)


def _signed(word: str) -> int:
    value = int(word, 16)
    return value - (1 << 256) if value >= (1 << 255) else value


def _address(word: str) -> str:
    return "0x" + word[-40:]


def _encode_address(address: str) -> str:
    return normalize_address(address)[2:].rjust(64, "0")


def _encode_uint(value: int) -> str:
    if value < 0:
        raise ValueError("ABI uint cannot be negative")
    return hex(value)[2:].rjust(64, "0")


def _decode_symbol(encoded: str) -> str:
    words = _words(encoded)
    if not words:
        return ""
    # Standard ABI string: offset, length, then UTF-8 bytes.
    if _uint(words[0]) == 32 and len(words) >= 2:
        length = _uint(words[1])
        body = encoded.removeprefix("0x")
        raw = bytes.fromhex(body[128 : 128 + length * 2])
    else:  # Compatibility with old bytes32 symbol implementations.
        raw = bytes.fromhex(words[0]).rstrip(b"\x00")
    return raw.decode("utf-8", errors="replace")


def read_pool_snapshot(
    rpc: JsonRpc,
    pool: str = WETH_USDC_005_POOL,
    factory: str = MAINNET_FACTORY,
    block: int | None = None,
) -> dict[str, object]:
    pool = normalize_address(pool)
    factory = normalize_address(factory)
    chain_id = int(str(rpc.call("eth_chainId", [])), 16)
    if block is None:
        block = int(str(rpc.call("eth_blockNumber", [])), 16)

    def pool_call(name: str) -> str:
        return rpc.eth_call(pool, "0x" + SELECTOR[name], block)

    token0 = _address(_words(pool_call("token0"))[0])
    token1 = _address(_words(pool_call("token1"))[0])
    validate_token_order(token0, token1)
    fee = _uint(_words(pool_call("fee"))[0])
    tick_spacing = _signed(_words(pool_call("tickSpacing"))[0])
    slot0 = _words(pool_call("slot0"))
    sqrt_price_x96 = _uint(slot0[0])
    tick = _signed(slot0[1])
    liquidity = _uint(_words(pool_call("liquidity"))[0])

    expected_pool_data = (
        "0x"
        + SELECTOR["getPool"]
        + _encode_address(token0)
        + _encode_address(token1)
        + _encode_uint(fee)
    )
    expected_pool = _address(_words(rpc.eth_call(factory, expected_pool_data, block))[0])
    if normalize_address(expected_pool) != pool:
        raise ValueError("pool does not match factory.getPool(token0, token1, fee)")

    def token_metadata(token: str) -> tuple[str, int]:
        symbol = _decode_symbol(rpc.eth_call(token, "0x" + SELECTOR["symbol"], block))
        decimals = _uint(_words(rpc.eth_call(token, "0x" + SELECTOR["decimals"], block))[0])
        _validate_decimals(decimals, "token decimals")
        return symbol, decimals

    symbol0, decimals0 = token_metadata(token0)
    symbol1, decimals1 = token_metadata(token1)
    price1_per_0, price0_per_1 = prices_from_sqrt_price_x96(
        sqrt_price_x96, decimals0, decimals1
    )

    return {
        "chain_id": chain_id,
        "block_number": block,
        "factory": factory,
        "pool": pool,
        "token0": {"address": token0, "symbol": symbol0, "decimals": decimals0},
        "token1": {"address": token1, "symbol": symbol1, "decimals": decimals1},
        "fee": fee,
        "tick_spacing": tick_spacing,
        "sqrt_price_x96": str(sqrt_price_x96),
        "tick": tick,
        "liquidity": str(liquidity),
        "price_token1_per_token0": format(price1_per_0, "f"),
        "price_token0_per_token1": format(price0_per_1, "f"),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pool", default=WETH_USDC_005_POOL)
    parser.add_argument("--factory", default=MAINNET_FACTORY)
    parser.add_argument("--block", type=int)
    args = parser.parse_args()
    rpc_url = os.environ.get("ETH_RPC_URL")
    if not rpc_url:
        parser.error("set ETH_RPC_URL to an Ethereum JSON-RPC endpoint")
    snapshot = read_pool_snapshot(JsonRpc(rpc_url), args.pool, args.factory, args.block)
    print(json.dumps(snapshot, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
