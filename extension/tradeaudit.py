"""
TradeAudit — Tamper-Evident Trade Audit Trail
==============================================
Forensic logging for algorithmic and manual traders.
Proves what the exchange reported, what you decided, and whether the numbers matched.

SHA-256 hash chain — modifying any record breaks the chain.
Daily digests for external anchoring (email, tweet, blockchain).

Works with any exchange via ccxt. Language-agnostic via proxy mode.

Usage:
    from tradeaudit import TradeAudit
    audit = TradeAudit("./my_audit")
    audit.log_order_open("BTC/USDT", "long", response, price=65000, size=0.01)
    audit.log_order_close("BTC/USDT", "long", response, entry=65000, exit=66000, pnl=10.0)
    audit.log_reconciliation(internal_pnl=50.0, exchange_balance=5050.0, base=5000.0)
    print(audit.verify())  # {"valid": True, "rows": 3}
"""

import os
import sys
import csv
import json
import hashlib
import threading
import glob as _glob
from datetime import datetime, timezone

# Large exchange responses (order books, batch results) can exceed default 131KB CSV field limit
csv.field_size_limit(sys.maxsize)

__version__ = "0.1.0"

FIELDS = [
    "seq", "timestamp", "event", "symbol", "side", "strategy",
    "decision_inputs", "exchange_response", "detail", "prev_hash", "hash",
]

# Keys to strip from exchange responses (security)
_SENSITIVE_KEYS = frozenset({
    "apiKey", "secret", "password", "passphrase", "token",
    "signature", "sign", "X-CHANNEL-API-CODE", "nonce",
})


class TradeAudit:
    """Tamper-evident audit trail for trade decisions and exchange interactions."""

    def __init__(self, directory: str = ".", prefix: str = "audit"):
        """
        Args:
            directory: Where to store audit files.
            prefix: File prefix (default: "audit" → audit_trail.csv, audit_digests.csv)
        """
        self.directory = os.path.abspath(directory)
        os.makedirs(self.directory, exist_ok=True)
        self.trail_path = os.path.join(self.directory, f"{prefix}_trail.csv")
        self.digest_path = os.path.join(self.directory, f"{prefix}_digests.csv")
        self._lock = threading.Lock()

    # ── INTERNAL ──

    def _hash(self, row_str: str, prev: str) -> str:
        return hashlib.sha256(f"{prev}|{row_str}".encode()).hexdigest()

    def _ensure_file(self):
        if not os.path.exists(self.trail_path):
            with open(self.trail_path, "w", newline="") as f:
                csv.writer(f).writerow(FIELDS)

    def _get_seq_and_prev(self) -> tuple:
        if not os.path.exists(self.trail_path):
            return 1, "GENESIS"
        try:
            with open(self.trail_path, "r") as f:
                rows = list(csv.DictReader(f))
            if rows:
                last = rows[-1]
                return int(last.get("seq", 0)) + 1, last.get("hash", "GENESIS")
        except Exception:
            pass
        return 1, "GENESIS"

    def _append(self, event: str, symbol: str = "", side: str = "",
                strategy: str = "", decision_inputs: dict = None,
                exchange_response: dict = None, detail: str = ""):
        with self._lock:
            self._ensure_file()
            seq, prev = self._get_seq_and_prev()
            ts = datetime.now(timezone.utc).isoformat()
            # Coerce None to "" — csv.writer writes None as "", so hash must match
            event = event or ""
            symbol = symbol or ""
            side = side or ""
            strategy = strategy or ""
            detail = detail or ""
            inputs_str = json.dumps(decision_inputs or {}, default=str)
            response_str = json.dumps(exchange_response or {}, default=str)
            row_data = (f"{seq}|{ts}|{event}|{symbol}|{side}|{strategy}|"
                        f"{inputs_str}|{response_str}|{detail}|{prev}")
            row_hash = self._hash(row_data, prev)
            with open(self.trail_path, "a", newline="") as f:
                csv.writer(f).writerow([
                    seq, ts, event, symbol, side, strategy,
                    inputs_str, response_str, detail, prev, row_hash,
                ])

    @staticmethod
    def _sanitize(resp) -> dict:
        if not isinstance(resp, dict):
            return {}
        return {k: v for k, v in resp.items() if k not in _SENSITIVE_KEYS}

    # ── PUBLIC API ──

    def log_decision(self, symbol: str, side: str, strategy: str = "",
                     inputs: dict = None, result: str = ""):
        """Log a trade decision with all inputs that drove it."""
        self._append("DECISION", symbol, side, strategy,
                      decision_inputs=inputs, detail=result)

    def log_order_open(self, symbol: str, side: str, exchange_response: dict,
                       strategy: str = "", price: float = 0,
                       size: float = 0, fees_pct: float = 0,
                       extra: dict = None):
        """Log raw exchange response when opening a position."""
        safe = self._sanitize(exchange_response)
        inputs = {"price": price, "size": size, "fees_pct": fees_pct}
        if extra:
            inputs.update(extra)
        self._append("ORDER_OPEN", symbol, side, strategy,
                      decision_inputs=inputs, exchange_response=safe,
                      detail=f"price=${price:.8g} size=${size:.8g} fee={fees_pct:.4f}%")

    def log_order_close(self, symbol: str, side: str, exchange_response: dict,
                        strategy: str = "", entry: float = 0, exit: float = 0,
                        pnl: float = 0, fees_pct: float = 0,
                        funding_cost: float = 0, funding_settlements: int = 0,
                        reason: str = "", order_id_open: str = "",
                        order_id_close: str = "", extra: dict = None):
        """Log raw exchange response when closing a position."""
        safe = self._sanitize(exchange_response)
        inputs = {
            "entry": entry, "exit": exit, "pnl": round(pnl, 4),
            "fees_pct": round(fees_pct, 4),
            "funding_cost": round(funding_cost, 4),
            "funding_settlements": funding_settlements,
            "reason": reason,
            "order_id_open": order_id_open,
            "order_id_close": order_id_close,
        }
        if extra:
            inputs.update(extra)
        self._append("ORDER_CLOSE", symbol, side, strategy,
                      decision_inputs=inputs, exchange_response=safe,
                      detail=f"pnl=${pnl:+.2f} reason={reason}")

    def log_reconciliation(self, internal_pnl: float, exchange_balance: float,
                           base: float, positions: dict = None):
        """Log internal PnL vs exchange balance. Returns the delta."""
        expected = base + internal_pnl
        delta = exchange_balance - expected
        self._append("RECONCILE", "ACCOUNT", "", "",
                      decision_inputs={
                          "internal_pnl": round(internal_pnl, 4),
                          "exchange_balance": round(exchange_balance, 4),
                          "base": round(base, 4),
                          "expected": round(expected, 4),
                          "delta": round(delta, 4),
                          "open_positions": len(positions) if positions else 0,
                      },
                      detail=f"exchange=${exchange_balance:.2f} expected=${expected:.2f} delta=${delta:+.2f}")
        return delta

    def log_balance(self, total: float, spot: float = 0,
                    futures: float = 0, unrealized: float = 0):
        """Log a raw balance snapshot from the exchange."""
        self._append("BALANCE", "ACCOUNT", "", "",
                      exchange_response={
                          "total": round(total, 4), "spot": round(spot, 4),
                          "futures": round(futures, 4), "unrealized": round(unrealized, 4),
                      })

    def log_api_call(self, method: str, endpoint: str, response: dict,
                     symbol: str = ""):
        """Log any raw API call/response (proxy mode)."""
        safe = self._sanitize(response)
        self._append("API_CALL", symbol, "", "",
                      exchange_response=safe,
                      detail=f"{method} {endpoint}")

    def log_event(self, event: str, symbol: str = "", detail: str = "",
                  data: dict = None):
        """Log a custom event."""
        self._append(event, symbol, "", "", decision_inputs=data, detail=detail)

    # ── VERIFICATION ──

    def verify(self) -> dict:
        """Verify hash chain integrity.
        Returns {"valid": bool, "broken_at": int|None, "rows": int}"""
        if not os.path.exists(self.trail_path):
            return {"valid": True, "broken_at": None, "rows": 0}
        try:
            with open(self.trail_path, "r") as f:
                rows = list(csv.DictReader(f))
        except Exception as e:
            return {"valid": False, "broken_at": 0, "rows": 0, "error": f"File unreadable: {e}"}
        if not rows:
            return {"valid": True, "broken_at": None, "rows": 0}

        prev = "GENESIS"
        for i, row in enumerate(rows):
            try:
                row_data = (f"{row['seq']}|{row['timestamp']}|{row['event']}|"
                            f"{row['symbol']}|{row['side']}|{row['strategy']}|"
                            f"{row['decision_inputs']}|{row['exchange_response']}|"
                            f"{row['detail']}|{row['prev_hash']}")
                expected = self._hash(row_data, prev)
                if row["hash"] != expected or row["prev_hash"] != prev:
                    return {"valid": False, "broken_at": int(row["seq"]), "rows": len(rows)}
                prev = row["hash"]
            except Exception as e:
                return {"valid": False, "broken_at": i + 1, "rows": len(rows),
                        "error": f"Row {i+1} malformed: {e}"}
        return {"valid": True, "broken_at": None, "rows": len(rows)}

    # ── DIGEST ──

    def write_digest(self) -> str:
        """Write SHA-256 digest of entire audit file. Returns the hash.
        Anchor this externally (email, tweet) to prove file state at this point in time."""
        if not os.path.exists(self.trail_path):
            return ""
        with open(self.trail_path, "rb") as f:
            file_hash = hashlib.sha256(f.read()).hexdigest()
        ts = datetime.now(timezone.utc).isoformat()
        row_count = 0
        try:
            with open(self.trail_path, "r") as f:
                row_count = sum(1 for _ in f) - 1
        except Exception:
            pass
        exists = os.path.exists(self.digest_path)
        with open(self.digest_path, "a", newline="") as f:
            w = csv.writer(f)
            if not exists:
                w.writerow(["timestamp", "rows", "sha256"])
            w.writerow([ts, row_count, file_hash])
        return file_hash

    # ── FILE MANAGEMENT ──

    def rotate(self, max_mb: int = 10):
        """Archive trail if it exceeds max_mb. Keeps 5 backups."""
        if not os.path.exists(self.trail_path):
            return
        if os.path.getsize(self.trail_path) / (1024 * 1024) <= max_mb:
            return
        # Write final digest before rotating
        self.write_digest()
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        bak = f"{self.trail_path}.{ts}.bak"
        os.rename(self.trail_path, bak)
        # Keep last 5 backups
        baks = sorted(_glob.glob(f"{self.trail_path}.*.bak"))
        for old in baks[:-5]:
            try:
                os.remove(old)
            except Exception:
                pass

    def status(self) -> dict:
        """Get audit trail status."""
        chain = self.verify()
        digest_count = 0
        if os.path.exists(self.digest_path):
            try:
                with open(self.digest_path, "r") as f:
                    digest_count = sum(1 for _ in f) - 1
            except Exception:
                pass
        size_kb = 0
        if os.path.exists(self.trail_path):
            size_kb = round(os.path.getsize(self.trail_path) / 1024, 1)
        return {
            "rows": chain["rows"],
            "chain_valid": chain["valid"],
            "chain_broken_at": chain.get("broken_at"),
            "digests": digest_count,
            "size_kb": size_kb,
        }
