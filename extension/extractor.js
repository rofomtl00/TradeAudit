/**
 * TradeAudit Content Script — Extracts trading data from exchange pages
 * Detects exchange, captures: balances, positions, order fills, PnL, fees
 */

(function() {
  'use strict';

  const EXCHANGES = {
    'www.bitget.com':       {id: 'bitget',     name: 'Bitget'},
    'www.binance.com':      {id: 'binance',    name: 'Binance'},
    'www.bybit.com':        {id: 'bybit',      name: 'Bybit'},
    'www.coinbase.com':     {id: 'coinbase',    name: 'Coinbase'},
    'pro.coinbase.com':     {id: 'coinbase',    name: 'Coinbase Pro'},
    'www.kraken.com':       {id: 'kraken',     name: 'Kraken'},
    'pro.kraken.com':       {id: 'kraken',     name: 'Kraken Pro'},
    'www.okx.com':          {id: 'okx',        name: 'OKX'},
    'www.gate.io':          {id: 'gate',       name: 'Gate.io'},
    'www.kucoin.com':       {id: 'kucoin',     name: 'KuCoin'},
    'www.crypto.com':       {id: 'cryptocom',  name: 'Crypto.com'},
    'app.hyperliquid.xyz':  {id: 'hyperliquid', name: 'Hyperliquid'},
    'www.mexc.com':         {id: 'mexc',       name: 'MEXC'},
    'www.htx.com':          {id: 'htx',        name: 'HTX'},
    'www.deribit.com':      {id: 'deribit',    name: 'Deribit'},
    'trade.dydx.exchange':  {id: 'dydx',       name: 'dYdX'},
    'app.gmx.io':           {id: 'gmx',        name: 'GMX'},
    'perp.exchange':        {id: 'perp',       name: 'Perp Protocol'},
  };

  function detectExchange() {
    const host = window.location.hostname;
    return EXCHANGES[host] || {id: 'unknown', name: 'Unknown Exchange'};
  }

  // ═══════════════════════════════════════════════
  // SNAPSHOT: capture everything visible on the page
  // ═══════════════════════════════════════════════

  function captureSnapshot() {
    const exchange = detectExchange();
    const snapshot = {
      exchange: exchange.id,
      exchange_name: exchange.name,
      url: window.location.href,
      timestamp: new Date().toISOString(),
      balances: extractBalances(),
      positions: extractPositions(),
      orders: extractOrders(),
      pnl: extractPnL(),
      prices: extractPrices(),
      fees: extractFees(),
      page_text: extractPageNumbers(),
    };
    return snapshot;
  }

  // ═══════════════════════════════════════════════
  // BALANCE EXTRACTION
  // ═══════════════════════════════════════════════

  function extractBalances() {
    const balances = [];
    // Look for balance-related elements
    const selectors = [
      '[class*="balance" i]', '[class*="Balance" i]',
      '[class*="equity" i]', '[class*="Equity" i]',
      '[class*="total-asset" i]', '[class*="totalAsset" i]',
      '[class*="account-value" i]', '[class*="portfolio" i]',
      '[data-testid*="balance" i]', '[data-testid*="equity" i]',
      '[class*="wallet" i] [class*="amount" i]',
    ];

    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(el => {
        const text = el.innerText.trim();
        const numbers = extractNumbers(text);
        if (numbers.length > 0) {
          balances.push({
            label: findNearbyLabel(el) || sel.replace(/[\[\]*"i]/g, ''),
            value: numbers[0],
            raw: text.slice(0, 200),
            element: describeElement(el),
          });
        }
      });
    }
    return dedupeByValue(balances).slice(0, 10);
  }

  // ═══════════════════════════════════════════════
  // POSITION EXTRACTION
  // ═══════════════════════════════════════════════

  function extractPositions() {
    const positions = [];
    const selectors = [
      '[class*="position" i]', '[class*="Position" i]',
      'tr[class*="position" i]', '[class*="open-order" i]',
      '[data-testid*="position" i]',
      '[class*="holdings" i]', '[class*="asset-row" i]',
    ];

    // Look for position rows (typically in tables)
    const tables = document.querySelectorAll('table');
    tables.forEach(table => {
      const headers = Array.from(table.querySelectorAll('th, thead td')).map(th => th.innerText.trim().toLowerCase());
      if (headers.some(h => h.includes('symbol') || h.includes('pair') || h.includes('position') || h.includes('size'))) {
        const rows = table.querySelectorAll('tbody tr');
        rows.forEach(row => {
          const cells = Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim());
          if (cells.length >= 3) {
            positions.push({
              cells: cells.slice(0, 8),
              raw: row.innerText.trim().slice(0, 300),
            });
          }
        });
      }
    });

    // Fallback: look for position cards/containers
    if (positions.length === 0) {
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach(el => {
          const text = el.innerText.trim();
          if (text.length > 10 && text.length < 500 && extractNumbers(text).length >= 2) {
            positions.push({ raw: text.slice(0, 300) });
          }
        });
      }
    }

    return positions.slice(0, 20);
  }

  // ═══════════════════════════════════════════════
  // ORDER EXTRACTION
  // ═══════════════════════════════════════════════

  function extractOrders() {
    const orders = [];
    const selectors = [
      '[class*="order-history" i]', '[class*="orderHistory" i]',
      '[class*="trade-history" i]', '[class*="tradeHistory" i]',
      '[class*="recent-trade" i]', '[class*="fill" i]',
      '[class*="execution" i]',
    ];

    // Table-based orders
    const tables = document.querySelectorAll('table');
    tables.forEach(table => {
      const headers = Array.from(table.querySelectorAll('th, thead td')).map(th => th.innerText.trim().toLowerCase());
      if (headers.some(h => h.includes('order') || h.includes('trade') || h.includes('fill') || h.includes('time'))) {
        if (headers.some(h => h.includes('price') || h.includes('amount') || h.includes('qty'))) {
          const rows = table.querySelectorAll('tbody tr');
          rows.forEach(row => {
            const cells = Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim());
            if (cells.length >= 3) {
              orders.push({
                headers: headers.slice(0, 8),
                cells: cells.slice(0, 8),
                raw: row.innerText.trim().slice(0, 300),
              });
            }
          });
        }
      }
    });

    // Fallback
    if (orders.length === 0) {
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach(el => {
          const rows = el.querySelectorAll('tr, [class*="row" i], [class*="item" i]');
          rows.forEach(row => {
            const text = row.innerText.trim();
            if (text.length > 10 && text.length < 400) {
              orders.push({ raw: text.slice(0, 300) });
            }
          });
        });
      }
    }

    return orders.slice(0, 50);
  }

  // ═══════════════════════════════════════════════
  // PNL EXTRACTION
  // ═══════════════════════════════════════════════

  function extractPnL() {
    const pnl = [];
    const selectors = [
      '[class*="pnl" i]', '[class*="PnL" i]', '[class*="profit" i]',
      '[class*="Profit" i]', '[class*="loss" i]', '[class*="return" i]',
      '[class*="realized" i]', '[class*="unrealized" i]',
      '[class*="gain" i]', '[class*="roi" i]',
    ];

    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(el => {
        const text = el.innerText.trim();
        const numbers = extractNumbers(text);
        if (numbers.length > 0) {
          // Check for color to determine positive/negative
          const color = window.getComputedStyle(el).color;
          const isGreen = color.includes('0, 128') || color.includes('34, 197') || color.includes('22, 163');
          const isRed = color.includes('255, 0') || color.includes('239, 68') || color.includes('220, 38');

          pnl.push({
            label: findNearbyLabel(el) || '',
            value: numbers[0],
            sign: isGreen ? '+' : isRed ? '-' : '?',
            raw: text.slice(0, 100),
          });
        }
      });
    }
    return dedupeByValue(pnl).slice(0, 10);
  }

  // ═══════════════════════════════════════════════
  // PRICE EXTRACTION
  // ═══════════════════════════════════════════════

  function extractPrices() {
    const prices = [];
    const selectors = [
      '[class*="last-price" i]', '[class*="lastPrice" i]',
      '[class*="mark-price" i]', '[class*="markPrice" i]',
      '[class*="index-price" i]', '[class*="ticker-price" i]',
      '[class*="current-price" i]',
    ];

    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(el => {
        const text = el.innerText.trim();
        const numbers = extractNumbers(text);
        if (numbers.length > 0 && numbers[0] > 0) {
          prices.push({
            label: findNearbyLabel(el) || 'price',
            value: numbers[0],
            raw: text.slice(0, 50),
          });
        }
      });
    }
    return prices.slice(0, 5);
  }

  // ═══════════════════════════════════════════════
  // FEE EXTRACTION
  // ═══════════════════════════════════════════════

  function extractFees() {
    const fees = [];
    const selectors = [
      '[class*="fee" i]', '[class*="Fee" i]',
      '[class*="commission" i]', '[class*="cost" i]',
    ];

    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(el => {
        const text = el.innerText.trim();
        const numbers = extractNumbers(text);
        if (numbers.length > 0) {
          fees.push({
            label: findNearbyLabel(el) || 'fee',
            value: numbers[0],
            raw: text.slice(0, 100),
          });
        }
      });
    }
    return fees.slice(0, 10);
  }

  // ═══════════════════════════════════════════════
  // PAGE NUMBERS — capture ALL visible numbers as fallback
  // ═══════════════════════════════════════════════

  function extractPageNumbers() {
    // Capture key financial numbers visible on the page
    const body = document.body.innerText;
    const numbers = [];
    // Match dollar amounts, percentages, and large numbers
    const patterns = [
      /\$[\d,]+\.?\d*/g,           // $1,234.56
      /[\d,]+\.?\d*\s*(?:USDT|USD|BTC|ETH)/g,  // 1234.56 USDT
      /[+-]?\d+\.?\d*%/g,          // +5.23%
    ];
    for (const pat of patterns) {
      let match;
      while ((match = pat.exec(body)) !== null) {
        if (!numbers.includes(match[0])) {
          numbers.push(match[0]);
        }
        if (numbers.length >= 50) break;
      }
    }
    return numbers;
  }

  // ═══════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════

  function extractNumbers(text) {
    const matches = text.match(/[\d,]+\.?\d*/g);
    if (!matches) return [];
    return matches
      .map(m => parseFloat(m.replace(/,/g, '')))
      .filter(n => !isNaN(n) && n > 0);
  }

  function findNearbyLabel(el) {
    // Check parent for label text
    const parent = el.parentElement;
    if (parent) {
      const label = parent.querySelector('label, [class*="label" i], [class*="title" i], span:first-child');
      if (label && label !== el) {
        const text = label.innerText.trim();
        if (text.length > 0 && text.length < 50) return text;
      }
    }
    // Check aria-label
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    // Check title
    const title = el.getAttribute('title');
    if (title) return title;
    return '';
  }

  function describeElement(el) {
    return el.tagName.toLowerCase() + (el.className ? '.' + el.className.split(' ')[0] : '');
  }

  function dedupeByValue(arr) {
    const seen = new Set();
    return arr.filter(item => {
      const key = item.value + '|' + (item.label || '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // ═══════════════════════════════════════════════
  // AUTO-CAPTURE: watch for page changes
  // ═══════════════════════════════════════════════

  let lastSnapshotHash = '';

  function autoCapture() {
    const snapshot = captureSnapshot();
    const hash = JSON.stringify(snapshot.balances) + JSON.stringify(snapshot.pnl) + JSON.stringify(snapshot.positions?.length);

    // Only log if something changed
    if (hash !== lastSnapshotHash) {
      lastSnapshotHash = hash;
      // Send to background script for hash-chain logging
      const runtimeApi = typeof browser !== 'undefined' ? browser : chrome;
      runtimeApi.runtime.sendMessage({
        action: 'log_snapshot',
        data: snapshot
      }).catch(() => {}); // Ignore if popup closed
    }
  }

  // Capture every 30 seconds while on an exchange page
  const exchange = detectExchange();
  if (exchange.id !== 'unknown') {
    // Initial capture after page loads
    setTimeout(autoCapture, 3000);
    // Periodic captures
    setInterval(autoCapture, 30000);
  }

  // Listen for manual capture requests from popup
  const runtimeApi = typeof browser !== 'undefined' ? browser : chrome;
  runtimeApi.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'capture') {
      const snapshot = captureSnapshot();
      sendResponse(snapshot);
    } else if (request.action === 'detect') {
      sendResponse(detectExchange());
    }
    return true;
  });

})();
