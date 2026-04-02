# TradeAudit — Tamper-Evident Trade Audit Trail

Forensic logging for algorithmic and manual traders. Proves what the exchange told you, what you decided, and whether the numbers matched.

**The problem:** When a trading platform shows you wrong PnL, wrong fees, or wrong fill prices, you make bad decisions based on bad data. After the fact, you can't prove what the platform displayed at the time of your decision. The exchange controls the records.

**The solution:** TradeAudit sits between your bot and the exchange, logging every API response with a SHA-256 hash chain. Every record is chained to the previous one — modifying any entry breaks the chain. Daily digests let you anchor proof externally (email yourself the hash). If a dispute arises, you have independent, tamper-evident proof.

## Quick Start

### Option A: Python Library (for bot developers)

```bash
pip install -r requirements.txt
```

```python
from tradeaudit import TradeAudit

audit = TradeAudit("./my_audit")

# Log a trade decision with the inputs that drove it
audit.log_decision("BTC/USDT", "long", "my_strategy",
    inputs={"rsi": 32, "ema50": 64000, "price": 63500},
    result="OPENED")

# Log the raw exchange order response
audit.log_order_open("BTC/USDT", "long", exchange_response=order,
    price=63500, size=0.01, fees_pct=0.06)

# Log a close
audit.log_order_close("BTC/USDT", "long", exchange_response=close_order,
    entry=63500, exit=65000, pnl=15.0, reason="take_profit")

# Check your PnL vs the exchange
audit.log_reconciliation(internal_pnl=15.0, exchange_balance=5015.0, base=5000.0)

# Verify the chain hasn't been tampered with
print(audit.verify())  # {"valid": True, "rows": 4}

# Write a daily digest — email this hash to yourself as external proof
print(audit.write_digest())  # "a3f2b8c9..."
```

### Option B: Proxy Mode (for any bot, any language)

Point your bot at the proxy instead of the exchange. Zero code changes needed.

```bash
# Start the proxy
python proxy.py --exchange bitget --key YOUR_KEY --secret YOUR_SECRET --passphrase YOUR_PASS --port 8877

# Or use environment variables
export TRADEAUDIT_API_KEY=your_key
export TRADEAUDIT_API_SECRET=your_secret
export TRADEAUDIT_API_PASSPHRASE=your_passphrase
python proxy.py --exchange bitget
```

Your bot calls `http://localhost:8877/api/order` instead of the exchange. The proxy forwards everything, logs everything, returns the real response. Your API keys never leave your machine.

### Option C: Docker

```bash
docker build -t tradeaudit .
docker run -d \
  -e TRADEAUDIT_API_KEY=your_key \
  -e TRADEAUDIT_API_SECRET=your_secret \
  -v ./audit_data:/app/audit_data \
  -p 8877:8877 \
  tradeaudit --exchange bitget
```

## What Gets Logged

| Event | What's Recorded |
|-------|----------------|
| `DECISION` | Every indicator/signal that drove the trade decision |
| `ORDER_OPEN` | Raw exchange response: order ID, filled qty, actual price, fees |
| `ORDER_CLOSE` | Entry/exit prices, PnL, fees, funding cost, both order IDs |
| `RECONCILE` | Your internal PnL vs exchange-reported balance + delta |
| `BALANCE` | Raw balance snapshot from exchange |
| `FUNDING_RATE` | Funding rate at time of query (proves what exchange reported) |
| `API_ERROR` | Failed API calls with error details |

## Tamper Protection

Each row in `audit_trail.csv` contains:
- `prev_hash` — SHA-256 hash of the previous row
- `hash` — SHA-256 hash of this row (includes prev_hash)

This creates a chain. If anyone modifies row #50, the hash won't match, and every row from #50 onward is invalidated. You can verify at any time:

```python
audit = TradeAudit("./audit_data")
result = audit.verify()
# {"valid": True, "rows": 1247, "broken_at": None}
```

## External Anchoring

The hash chain proves records weren't modified *relative to each other*. But what proves the file itself existed on a specific date?

**Daily digests.** Once per day, TradeAudit writes the SHA-256 hash of the entire file to `audit_digests.csv`. Email yourself this hash, tweet it, or write it to any timestamped service. If a dispute arises months later, you can prove:

1. The audit file produces this exact hash (verify with `sha256sum audit_trail.csv`)
2. You had this hash on that specific date (your email/tweet timestamp)
3. Therefore the file existed in this exact state on that date

## Proxy API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/balance` | GET | Fetch account balance |
| `/api/ticker/<symbol>` | GET | Fetch ticker |
| `/api/order` | POST | Create order (logs decision + response) |
| `/api/order/<id>?symbol=X` | GET | Fetch order status |
| `/api/cancel/<id>` | POST | Cancel order |
| `/api/positions` | GET | Fetch open positions |
| `/api/trades?symbol=X` | GET | Fetch recent trades |
| `/api/funding_rate/<symbol>` | GET | Fetch funding rate |
| `/audit/status` | GET | Audit trail status |
| `/audit/verify` | GET | Verify hash chain |
| `/audit/digest` | POST | Write daily digest |
| `/audit/reconcile` | POST | Manual balance reconciliation |

## File Management

- Audit trail rotates at 10 MB (configurable)
- 5 archived backups kept
- Daily digest written to separate file
- All files are plain CSV — readable by any spreadsheet or script

## License

MIT
