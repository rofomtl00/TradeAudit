"""
TradeAudit Proxy — Exchange API Middleware
==========================================
Sits between any trading bot and any ccxt-supported exchange.
Logs every API call and response to a tamper-evident audit trail.

Your bot connects to this proxy instead of the exchange directly.
Keys never leave your machine. No code changes in your bot needed —
just change the API URL.

Usage:
    python proxy.py --exchange bitget --port 8877

Then point your bot at http://localhost:8877 instead of the exchange.
"""

import os
import sys
import json
import time
import argparse
import logging
from datetime import datetime, timezone

try:
    from flask import Flask, request, jsonify
except ImportError:
    print("Flask required: pip install flask")
    sys.exit(1)

try:
    import ccxt
except ImportError:
    print("ccxt required: pip install ccxt")
    sys.exit(1)

from tradeaudit import TradeAudit
from license import License

app = Flask(__name__, static_folder=None)
audit = None       # TradeAudit instance
exchange = None    # ccxt exchange instance
lic = None         # License instance
log = logging.getLogger("tradeaudit")


def _require_pro(feature: str):
    """Check if feature is available. Returns error response or None."""
    if lic and not lic.has_feature(feature):
        return jsonify({"ok": False, "error": f"Pro feature: {feature}. Get a license at https://tradeaudit.lemonsqueezy.com/checkout/buy/8729f38a-7c43-4cd1-9eae-b96429338312",
                        "plan": lic.plan}), 403
    return None


def create_exchange(exchange_id: str, api_key: str, api_secret: str,
                    passphrase: str = "", sandbox: bool = False) -> object:
    """Create a ccxt exchange instance."""
    cls = getattr(ccxt, exchange_id, None)
    if not cls:
        raise ValueError(f"Unknown exchange: {exchange_id}. Supported: {', '.join(ccxt.exchanges[:20])}...")
    config = {
        "apiKey": api_key,
        "secret": api_secret,
        "enableRateLimit": True,
    }
    if passphrase:
        config["password"] = passphrase
    ex = cls(config)
    if sandbox:
        ex.set_sandbox_mode(True)
    return ex


# ── PROXY ENDPOINTS ──
# These mirror the most common ccxt methods.
# The bot calls our proxy, we call the exchange, log both, return the response.

@app.route("/api/balance", methods=["GET"])
def proxy_balance():
    """Proxy: fetch_balance"""
    gate = _require_pro("proxy")
    if gate: return gate
    try:
        bal = exchange.fetch_balance()
        # Log the raw balance
        total = float(bal.get("total", {}).get("USDT", 0) or 0)
        free = float(bal.get("free", {}).get("USDT", 0) or 0)
        audit.log_balance(total=total, futures=free)
        return jsonify({"ok": True, "data": _serialize(bal)})
    except Exception as e:
        audit.log_event("API_ERROR", detail=f"fetch_balance: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/ticker/<symbol>", methods=["GET"])
def proxy_ticker(symbol):
    """Proxy: fetch_ticker"""
    sym = symbol.replace("_", "/")
    try:
        tk = exchange.fetch_ticker(sym)
        return jsonify({"ok": True, "data": _serialize(tk)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/order", methods=["POST"])
def proxy_create_order():
    """Proxy: create_order — THE critical endpoint to audit."""
    gate = _require_pro("proxy")
    if gate: return gate
    body = request.get_json() or {}
    symbol = body.get("symbol", "")
    order_type = body.get("type", "market")
    side = body.get("side", "buy")
    amount = float(body.get("amount", 0))
    price = float(body.get("price", 0)) if body.get("price") else None
    params = body.get("params", {})

    # Log the decision (what the bot asked for)
    audit.log_decision(symbol, side, strategy=body.get("strategy", ""),
                       inputs={"type": order_type, "amount": amount,
                               "price": price, "params": params},
                       result="ORDER_REQUESTED")

    try:
        if price and order_type == "limit":
            order = exchange.create_order(symbol, order_type, side, amount, price, params)
        else:
            order = exchange.create_order(symbol, order_type, side, amount, None, params)

        # Log the raw exchange response
        filled = float(order.get("filled", 0) or 0)
        avg_price = float(order.get("average", 0) or order.get("price", 0) or 0)
        fees = order.get("fees", [])
        fee_total = sum(float(f.get("cost", 0) or 0) for f in fees) if fees else 0

        is_close = params.get("reduceOnly", False) or params.get("stopLossPrice") or params.get("takeProfitPrice")

        if is_close:
            audit.log_order_close(symbol, side, _serialize(order),
                                  entry=float(body.get("entry_price", 0)),
                                  exit=avg_price, pnl=float(body.get("pnl", 0)),
                                  reason=body.get("reason", ""),
                                  order_id_close=order.get("id", ""))
        else:
            audit.log_order_open(symbol, side, _serialize(order),
                                 price=avg_price, size=amount,
                                 fees_pct=0,
                                 extra={"fee_cost": fee_total,
                                        "order_id": order.get("id", "")})

        return jsonify({"ok": True, "data": _serialize(order)})
    except Exception as e:
        audit.log_event("ORDER_FAILED", symbol=symbol,
                        detail=f"{side} {order_type} {amount} @ {price}: {e}",
                        data={"error": str(e), "body": body})
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/positions", methods=["GET"])
def proxy_positions():
    """Proxy: fetch_positions"""
    symbols = request.args.getlist("symbol")
    try:
        positions = exchange.fetch_positions(symbols if symbols else None)
        return jsonify({"ok": True, "data": _serialize(positions)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/order/<order_id>", methods=["GET"])
def proxy_fetch_order(order_id):
    """Proxy: fetch_order"""
    symbol = request.args.get("symbol", "")
    try:
        order = exchange.fetch_order(order_id, symbol)
        return jsonify({"ok": True, "data": _serialize(order)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/cancel/<order_id>", methods=["POST"])
def proxy_cancel_order(order_id):
    """Proxy: cancel_order"""
    body = request.get_json() or {}
    symbol = body.get("symbol", "")
    try:
        result = exchange.cancel_order(order_id, symbol)
        audit.log_event("ORDER_CANCEL", symbol=symbol,
                        detail=f"cancelled {order_id}",
                        data=_serialize(result))
        return jsonify({"ok": True, "data": _serialize(result)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/trades", methods=["GET"])
def proxy_trades():
    """Proxy: fetch_trades"""
    symbol = request.args.get("symbol", "")
    limit = int(request.args.get("limit", 50))
    try:
        trades = exchange.fetch_trades(symbol, limit=limit)
        return jsonify({"ok": True, "data": _serialize(trades)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/funding_rate/<symbol>", methods=["GET"])
def proxy_funding_rate(symbol):
    """Proxy: fetch_funding_rate"""
    sym = symbol.replace("_", "/")
    try:
        rate = exchange.fetch_funding_rate(sym)
        # Log funding rate — important for PnL accuracy disputes
        r = float(rate.get("fundingRate", 0) or 0)
        audit.log_event("FUNDING_RATE", symbol=sym,
                        detail=f"rate={r}",
                        data=_serialize(rate))
        return jsonify({"ok": True, "data": _serialize(rate)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# ── AUDIT ENDPOINTS ──

@app.route("/audit/status", methods=["GET"])
def audit_status():
    """Check audit trail status and chain integrity."""
    data = audit.status()
    if lic:
        data["license"] = lic.status()
    return jsonify(data)

@app.route("/license/status", methods=["GET"])
def license_status():
    """Check license status."""
    if lic:
        return jsonify(lic.status())
    return jsonify({"plan": "free"})


@app.route("/audit/verify", methods=["GET"])
def audit_verify():
    """Full chain verification."""
    return jsonify(audit.verify())


@app.route("/audit/digest", methods=["POST"])
def audit_digest():
    """Write a daily digest hash."""
    h = audit.write_digest()
    return jsonify({"digest": h})


@app.route("/audit/reconcile", methods=["POST"])
def audit_reconcile():
    """Manual reconciliation check."""
    try:
        bal = exchange.fetch_balance()
        total = float(bal.get("total", {}).get("USDT", 0) or 0)
        body = request.get_json() or {}
        internal_pnl = float(body.get("internal_pnl", 0))
        base = float(body.get("base_capital", 0))
        delta = audit.log_reconciliation(internal_pnl, total, base)
        return jsonify({"ok": True, "exchange_balance": total,
                        "expected": base + internal_pnl, "delta": delta})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# ── DASHBOARD ──

@app.route("/", methods=["GET"])
def dashboard():
    """Serve the web dashboard."""
    html_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dashboard.html")
    if os.path.exists(html_path):
        with open(html_path, "r") as f:
            return f.read(), 200, {"Content-Type": "text/html"}
    return "<h1>TradeAudit</h1><p>Dashboard not found. Place dashboard.html next to proxy.py.</p>", 200

@app.route("/audit/trail", methods=["GET"])
def audit_trail():
    """Return recent audit trail events as JSON."""
    import csv as _csv
    limit = int(request.args.get("limit", 50))
    if not os.path.exists(audit.trail_path):
        return jsonify([])
    try:
        with open(audit.trail_path, "r") as f:
            rows = list(_csv.DictReader(f))
        return jsonify(rows[-limit:])
    except Exception:
        return jsonify([])


# ── HELPERS ──

def _serialize(obj):
    """Make ccxt response JSON-serializable."""
    if isinstance(obj, dict):
        return {k: _serialize(v) for k, v in obj.items()
                if k not in ("info",) and not k.startswith("_")}
    if isinstance(obj, list):
        return [_serialize(x) for x in obj]
    if isinstance(obj, (datetime,)):
        return obj.isoformat()
    if isinstance(obj, float) and (obj != obj or obj == float('inf') or obj == float('-inf')):
        return None
    return obj


# ── MAIN ──

def main():
    parser = argparse.ArgumentParser(description="TradeAudit Proxy — Exchange API Middleware")
    parser.add_argument("--exchange", "-e", required=True, help="Exchange ID (bitget, binance, bybit, etc.)")
    parser.add_argument("--key", help="API key (or set TRADEAUDIT_API_KEY env var)")
    parser.add_argument("--secret", help="API secret (or set TRADEAUDIT_API_SECRET env var)")
    parser.add_argument("--passphrase", help="API passphrase (or set TRADEAUDIT_API_PASSPHRASE env var)")
    parser.add_argument("--port", "-p", type=int, default=8877, help="Proxy port (default: 8877)")
    parser.add_argument("--dir", "-d", default="./audit_data", help="Audit trail directory (default: ./audit_data)")
    parser.add_argument("--license", "-l", help="Pro license key (or set TRADEAUDIT_LICENSE_KEY env var)")
    parser.add_argument("--sandbox", action="store_true", help="Use exchange sandbox/testnet")
    args = parser.parse_args()

    api_key = args.key or os.environ.get("TRADEAUDIT_API_KEY", "")
    api_secret = args.secret or os.environ.get("TRADEAUDIT_API_SECRET", "")
    passphrase = args.passphrase or os.environ.get("TRADEAUDIT_API_PASSPHRASE", "")

    if not api_key or not api_secret:
        print("API key and secret required.")
        print("  Set via --key/--secret flags or TRADEAUDIT_API_KEY/TRADEAUDIT_API_SECRET env vars")
        sys.exit(1)

    global audit, exchange, lic
    audit = TradeAudit(args.dir)
    exchange = create_exchange(args.exchange, api_key, api_secret, passphrase, args.sandbox)

    # License validation
    license_key = args.license or os.environ.get("TRADEAUDIT_LICENSE_KEY", "")
    lic = License(license_key)
    lic_result = lic.validate()

    # Log startup
    audit.log_event("PROXY_START", detail=f"exchange={args.exchange} port={args.port} plan={lic.plan}")

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s [%(levelname)s] %(message)s")
    log.info(f"TradeAudit Proxy v{__import__('tradeaudit').__version__}")
    log.info(f"Exchange: {args.exchange}")
    log.info(f"Audit trail: {os.path.abspath(args.dir)}")
    log.info(f"License: {lic_result['message']}")
    log.info(f"Plan: {lic.plan.upper()} — features: {', '.join(sorted(lic.status()['features']))}")
    log.info(f"Listening on http://localhost:{args.port}")
    log.info(f"Point your bot at this URL instead of the exchange API")

    app.run(host="0.0.0.0", port=args.port, debug=False)


if __name__ == "__main__":
    main()
