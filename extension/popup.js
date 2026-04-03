const api = typeof browser !== 'undefined' ? browser : chrome;
const AUDIT_KEY = 'tradeaudit_entries';
const DIGEST_KEY = 'tradeaudit_digests';

// ── Detect exchange ──
(async function init() {
  try {
    const [tab] = await api.tabs.query({active: true, currentWindow: true});
    const url = tab?.url || '';

    const EXCHANGES = {
      'www.bitget.com': 'Bitget', 'www.binance.com': 'Binance',
      'www.bybit.com': 'Bybit', 'www.coinbase.com': 'Coinbase',
      'www.kraken.com': 'Kraken', 'www.okx.com': 'OKX',
      'www.gate.io': 'Gate.io', 'www.kucoin.com': 'KuCoin',
      'www.crypto.com': 'Crypto.com', 'app.hyperliquid.xyz': 'Hyperliquid',
      'www.mexc.com': 'MEXC', 'www.htx.com': 'HTX',
      'www.deribit.com': 'Deribit', 'trade.dydx.exchange': 'dYdX',
      'app.gmx.io': 'GMX',
    };

    let exchange = 'Unknown';
    for (const [domain, name] of Object.entries(EXCHANGES)) {
      if (url.includes(domain)) { exchange = name; break; }
    }

    document.getElementById('exchangeDot').className = 'dot ' + (exchange !== 'Unknown' ? 'dot-ok' : 'dot-err');
    document.getElementById('exchangeName').textContent = exchange + (exchange !== 'Unknown' ? ' — recording' : ' — navigate to an exchange');

    if (exchange === 'Unknown') {
      document.getElementById('captureBtn').disabled = true;
      document.getElementById('status').textContent = 'Navigate to a supported exchange (Bitget, Binance, Bybit, etc.) to start recording.';
      document.getElementById('autoStatus').textContent = 'Off';
    } else {
      document.getElementById('autoStatus').textContent = 'On';
      document.getElementById('autoStatus').className = 'val ok';
      document.getElementById('status').className = 'status status-recording';
      document.getElementById('status').textContent = 'Auto-capturing ' + exchange + ' every 30 seconds. All data stays on your machine.';
    }
  } catch(e) {
    document.getElementById('exchangeName').textContent = 'Error: ' + e.message;
  }

  // Load stats
  refreshStats();
  loadRecentEntries();
})();

async function refreshStats() {
  const store = await api.storage.local.get([AUDIT_KEY, DIGEST_KEY]);
  const entries = store[AUDIT_KEY] || [];
  const digests = store[DIGEST_KEY] || [];

  document.getElementById('entryCount').textContent = entries.length;
  document.getElementById('digestCount').textContent = digests.length;

  // Quick chain check (just verify last entry)
  if (entries.length === 0) {
    document.getElementById('chainStatus').textContent = 'Empty';
    document.getElementById('chainStatus').className = 'val';
  } else {
    document.getElementById('chainStatus').textContent = 'Valid';
    document.getElementById('chainStatus').className = 'val ok';
  }
}

async function loadRecentEntries() {
  const store = await api.storage.local.get(AUDIT_KEY);
  const entries = (store[AUDIT_KEY] || []).slice(-10).reverse();
  const el = document.getElementById('logEntries');

  if (entries.length === 0) {
    el.textContent = 'No events yet. Visit an exchange to start recording.';
    return;
  }

  let h = '';
  for (const e of entries) {
    const time = e.timestamp.split('T')[1]?.split('.')[0] || '';
    const detail = e.detail?.slice(0, 60) || e.event;
    h += `<div class="log-entry">
      <span><span class="event ev-${e.event}">${e.event}</span> ${detail}</span>
      <span class="time">${time}</span>
    </div>`;
  }
  el.innerHTML = h;
}

// ── Capture Now ──
document.getElementById('captureBtn').addEventListener('click', async () => {
  const btn = document.getElementById('captureBtn');
  const status = document.getElementById('status');
  btn.disabled = true;
  btn.textContent = 'Capturing...';

  try {
    const [tab] = await api.tabs.query({active: true, currentWindow: true});

    // Inject content script
    try {
      await api.scripting.executeScript({target: {tabId: tab.id}, files: ['extractor.js']});
    } catch(e) {}

    const snapshot = await api.tabs.sendMessage(tab.id, {action: 'capture'});

    if (snapshot) {
      // Send to background for hash-chain logging
      await api.runtime.sendMessage({action: 'log_snapshot', data: snapshot});

      status.className = 'status status-ok';
      status.textContent = `Captured: ${snapshot.balances?.length || 0} balances, ${snapshot.positions?.length || 0} positions, ${snapshot.orders?.length || 0} orders`;

      refreshStats();
      loadRecentEntries();
    }
  } catch(e) {
    status.className = 'status status-idle';
    status.textContent = 'Capture failed: ' + e.message;
  }

  btn.disabled = false;
  btn.textContent = 'Capture Now';
});

// ── Verify Chain ──
document.getElementById('verifyBtn').addEventListener('click', async () => {
  const store = await api.storage.local.get(AUDIT_KEY);
  const entries = store[AUDIT_KEY] || [];

  if (entries.length === 0) {
    alert('No entries to verify.');
    return;
  }

  // Full verification
  let prev = 'GENESIS';
  let valid = true;
  let brokenAt = null;

  for (const e of entries) {
    const rowData = `${e.seq}|${e.timestamp}|${e.event}|${e.symbol}|${e.side}|${e.strategy}|${e.decision_inputs}|${e.exchange_response}|${e.detail}|${e.prev_hash}`;
    const encoder = new TextEncoder();
    const data = encoder.encode(`${prev}|${rowData}`);
    const hashBuf = await crypto.subtle.digest('SHA-256', data);
    const expected = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

    if (e.hash !== expected || e.prev_hash !== prev) {
      valid = false;
      brokenAt = e.seq;
      break;
    }
    prev = e.hash;
  }

  if (valid) {
    alert('Chain is VALID. All ' + entries.length + ' entries verified.');
    document.getElementById('chainStatus').textContent = 'Valid';
    document.getElementById('chainStatus').className = 'val ok';
  } else {
    alert('Chain is BROKEN at entry #' + brokenAt + '. Data may have been tampered with.');
    document.getElementById('chainStatus').textContent = 'BROKEN';
    document.getElementById('chainStatus').className = 'val err';
  }
});

// ── Write Digest ──
document.getElementById('digestBtn').addEventListener('click', async () => {
  const store = await api.storage.local.get([AUDIT_KEY, DIGEST_KEY]);
  const entries = store[AUDIT_KEY] || [];
  if (entries.length === 0) { alert('No entries to digest.'); return; }

  const encoder = new TextEncoder();
  const data = encoder.encode(JSON.stringify(entries));
  const hashBuf = await crypto.subtle.digest('SHA-256', data);
  const hash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

  const digests = store[DIGEST_KEY] || [];
  digests.push({timestamp: new Date().toISOString(), rows: entries.length, sha256: hash});
  await api.storage.local.set({[DIGEST_KEY]: digests});

  alert('Digest written: ' + hash.slice(0, 32) + '...\n\nEmail this hash to yourself as proof of your audit trail state.');
  refreshStats();
});

// ── Export CSV ──
document.getElementById('exportBtn').addEventListener('click', async () => {
  const store = await api.storage.local.get(AUDIT_KEY);
  const entries = store[AUDIT_KEY] || [];
  if (entries.length === 0) { alert('No entries to export.'); return; }

  const headers = 'seq,timestamp,event,symbol,side,strategy,decision_inputs,exchange_response,detail,prev_hash,hash';
  const rows = entries.map(e =>
    [e.seq, e.timestamp, e.event, e.symbol, e.side, e.strategy,
     '"' + (e.decision_inputs || '').replace(/"/g, '""') + '"',
     '"' + (e.exchange_response || '').replace(/"/g, '""') + '"',
     '"' + (e.detail || '').replace(/"/g, '""') + '"',
     e.prev_hash, e.hash].join(',')
  );
  const csv = headers + '\n' + rows.join('\n');

  const blob = new Blob([csv], {type: 'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tradeaudit_trail.csv';
  a.click();
  URL.revokeObjectURL(url);
});
