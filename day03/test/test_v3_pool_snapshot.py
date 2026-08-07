import importlib.util
from decimal import Decimal
import json
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).parents[1] / "src" / "v3_pool_snapshot.py"
SPEC = importlib.util.spec_from_file_location("v3_pool_snapshot", MODULE_PATH)
v3 = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(v3)


class PriceConversionTest(unittest.TestCase):
    def test_tick_zero_is_raw_price_one(self):
        self.assertEqual(v3.tick_to_raw_price(0), Decimal(1))

    def test_q96_is_raw_price_one(self):
        self.assertEqual(v3.sqrt_price_x96_to_raw_price(1 << 96), Decimal(1))

    def test_human_price_and_inverse_with_different_decimals(self):
        # token0 has 6 decimals and token1 has 18 decimals.
        raw_price = Decimal("3500000000000000")
        price1_per_0 = v3.raw_to_human_price(raw_price, 6, 18)
        self.assertEqual(price1_per_0, Decimal("3500"))
        self.assertEqual(Decimal(1) / price1_per_0, Decimal(1) / Decimal(3500))

    def test_invalid_values_are_rejected(self):
        with self.assertRaises(ValueError):
            v3.sqrt_price_x96_to_raw_price(0)
        with self.assertRaises(ValueError):
            v3.raw_to_human_price(Decimal(1), -1, 18)
        with self.assertRaises(ValueError):
            v3.raw_to_human_price(Decimal(0), 18, 18)

    def test_token_order_is_checked(self):
        low = "0x0000000000000000000000000000000000000001"
        high = "0x0000000000000000000000000000000000000002"
        v3.validate_token_order(low, high)
        with self.assertRaises(ValueError):
            v3.validate_token_order(high, low)

    def test_snapshot_tick_and_sqrt_prices_are_in_same_tick(self):
        snapshot_path = (
            Path(__file__).parents[1]
            / "snapshot"
            / "weth_usdc_005_block_25703592.json"
        )
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        sqrt_price = v3.sqrt_price_x96_to_raw_price(int(snapshot["sqrt_price_x96"]))
        tick_price = v3.tick_to_raw_price(snapshot["tick"])
        relative_gap = abs(sqrt_price - tick_price) / sqrt_price
        self.assertLess(relative_gap, Decimal("0.0001"))


if __name__ == "__main__":
    unittest.main()
