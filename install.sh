#!/usr/bin/env bash
# TradeAudit Pro — One-command installer
# Usage: curl -sL https://raw.githubusercontent.com/rofomtl00/TradeAudit/master/install.sh | bash
set -e

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║       TradeAudit Pro Installer         ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""

# Check Docker
if command -v docker &>/dev/null; then
    USE_DOCKER=true
    echo "  ✓ Docker found — using container install (recommended)"
else
    USE_DOCKER=false
    echo "  ⚠ Docker not found — using Python install"
    if ! command -v python3 &>/dev/null; then
        echo "  ✗ Python3 not found. Install Docker or Python3 first."
        exit 1
    fi
fi

# Create directory
INSTALL_DIR="$HOME/tradeaudit"
mkdir -p "$INSTALL_DIR/audit_data"
cd "$INSTALL_DIR"

# Get license key
echo ""
read -p "  Enter your Pro license key: " LICENSE_KEY
if [ -z "$LICENSE_KEY" ]; then
    echo "  ✗ License key required. Get one at https://tradeaudit.lemonsqueezy.com"
    exit 1
fi

# Get exchange details
echo ""
echo "  Supported exchanges: bitget, binance, bybit, okx, kraken, coinbase, gate, kucoin, etc."
read -p "  Exchange (e.g. bitget): " EXCHANGE
read -p "  API Key: " API_KEY
read -sp "  API Secret: " API_SECRET
echo ""
read -p "  API Passphrase (press Enter if none): " PASSPHRASE

# Save config
cat > "$INSTALL_DIR/.env" <<EOF
TRADEAUDIT_LICENSE_KEY=$LICENSE_KEY
TRADEAUDIT_API_KEY=$API_KEY
TRADEAUDIT_API_SECRET=$API_SECRET
TRADEAUDIT_API_PASSPHRASE=$PASSPHRASE
TRADEAUDIT_EXCHANGE=$EXCHANGE
EOF
chmod 600 "$INSTALL_DIR/.env"

if [ "$USE_DOCKER" = true ]; then
    # Docker install
    echo ""
    echo "  Pulling TradeAudit..."
    docker pull ghcr.io/rofomtl00/tradeaudit:latest 2>/dev/null || {
        # Build from source if no registry image
        echo "  Building from source..."
        git clone --depth 1 https://github.com/rofomtl00/TradeAudit.git "$INSTALL_DIR/src" 2>/dev/null || true
        if [ -d "$INSTALL_DIR/src" ]; then
            docker build -t tradeaudit "$INSTALL_DIR/src"
        else
            echo "  ✗ Could not download TradeAudit. Check your internet connection."
            exit 1
        fi
    }

    # Create start/stop scripts
    cat > "$INSTALL_DIR/start.sh" <<'SCRIPT'
#!/usr/bin/env bash
set -a && source "$(dirname "$0")/.env" && set +a
docker stop tradeaudit 2>/dev/null; docker rm tradeaudit 2>/dev/null
docker run -d --name tradeaudit \
    --restart unless-stopped \
    -e TRADEAUDIT_LICENSE_KEY \
    -e TRADEAUDIT_API_KEY \
    -e TRADEAUDIT_API_SECRET \
    -e TRADEAUDIT_API_PASSPHRASE \
    -v "$(dirname "$0")/audit_data:/app/audit_data" \
    -p 8877:8877 \
    tradeaudit --exchange "$TRADEAUDIT_EXCHANGE"
echo "  ✓ TradeAudit running on http://localhost:8877"
echo "  Audit trail: $(dirname "$0")/audit_data/"
SCRIPT

    cat > "$INSTALL_DIR/stop.sh" <<'SCRIPT'
#!/usr/bin/env bash
docker stop tradeaudit && docker rm tradeaudit
echo "  ✓ TradeAudit stopped"
SCRIPT

    chmod +x "$INSTALL_DIR/start.sh" "$INSTALL_DIR/stop.sh"

    # Start it
    bash "$INSTALL_DIR/start.sh"

else
    # Python install
    echo ""
    echo "  Downloading TradeAudit..."
    git clone --depth 1 https://github.com/rofomtl00/TradeAudit.git "$INSTALL_DIR/src" 2>/dev/null || {
        echo "  ✗ Could not download. Check your internet connection."
        exit 1
    }

    echo "  Installing dependencies..."
    python3 -m pip install --user ccxt flask 2>/dev/null || pip install ccxt flask

    # Create start/stop scripts
    cat > "$INSTALL_DIR/start.sh" <<SCRIPT
#!/usr/bin/env bash
set -a && source "$INSTALL_DIR/.env" && set +a
cd "$INSTALL_DIR/src"
nohup python3 proxy.py --exchange "\$TRADEAUDIT_EXCHANGE" --license "\$TRADEAUDIT_LICENSE_KEY" --dir "$INSTALL_DIR/audit_data" > "$INSTALL_DIR/proxy.log" 2>&1 &
echo \$! > "$INSTALL_DIR/.pid"
echo "  ✓ TradeAudit running on http://localhost:8877 (PID \$(cat "$INSTALL_DIR/.pid"))"
echo "  Audit trail: $INSTALL_DIR/audit_data/"
echo "  Logs: $INSTALL_DIR/proxy.log"
SCRIPT

    cat > "$INSTALL_DIR/stop.sh" <<SCRIPT
#!/usr/bin/env bash
if [ -f "$INSTALL_DIR/.pid" ]; then
    kill \$(cat "$INSTALL_DIR/.pid") 2>/dev/null
    rm -f "$INSTALL_DIR/.pid"
    echo "  ✓ TradeAudit stopped"
else
    echo "  Not running"
fi
SCRIPT

    chmod +x "$INSTALL_DIR/start.sh" "$INSTALL_DIR/stop.sh"

    # Start it
    bash "$INSTALL_DIR/start.sh"
fi

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║         TradeAudit Pro Ready           ║"
echo "  ╠═══════════════════════════════════════╣"
echo "  ║  Proxy:  http://localhost:8877         ║"
echo "  ║  Start:  ~/tradeaudit/start.sh         ║"
echo "  ║  Stop:   ~/tradeaudit/stop.sh          ║"
echo "  ║  Data:   ~/tradeaudit/audit_data/      ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""
echo "  Point your trading bot at http://localhost:8877"
echo "  instead of the exchange API. That's it."
echo ""
