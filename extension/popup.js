const api = typeof browser !== 'undefined' ? browser : chrome;
const AUDIT_KEY = 'tradeaudit_entries';
const DIGEST_KEY = 'tradeaudit_digests';

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

// ── Init ──
(async function() {
  const [tab] = await api.tabs.query({active: true, currentWindow: true});
  const url = tab?.url || '';
  let exchange = '';
  for (const [domain, name] of Object.entries(EXCHANGES)) {
    if (url.includes(domain)) { exchange = name; break; }
  }

  const dot = document.getElementById('dot');
  const name = document.getElementById('exchangeName');
  if (exchange) {
    dot.className = 'dot dot-on';
    name.textContent = exchange + ' — recording';
  } else {
    name.textContent = 'Not on an exchange';
    document.getElementById('captureBtn').disabled = true;
  }

  refresh();
})();

async function refresh() {
  const store = await api.storage.local.get([AUDIT_KEY, DIGEST_KEY]);
  const entries = store[AUDIT_KEY] || [];
  const digests = store[DIGEST_KEY] || [];

  document.getElementById('events').textContent = entries.length;
  document.getElementById('digests').textContent = digests.length;
  document.getElementById('chainLabel').textContent = entries.length ? 'chain ok' : '—';

  // Storage size estimate
  const sizeKB = Math.round(JSON.stringify(entries).length / 1024);
  const maxKB = Math.round(10000 * (JSON.stringify(entries[0] || {}).length || 200) / 1024);
  document.getElementById('storageInfo').textContent = entries.length ?
    sizeKB + ' KB · max 10K entries' : 'no data';

  // Recent entries
  const el = document.getElementById('entries');
  if (entries.length === 0) {
    el.innerHTML = '<div class="empty">No events yet</div>';
    return;
  }
  const recent = entries.slice(-8).reverse();
  el.innerHTML = recent.map(e => {
    const time = (e.timestamp || '').split('T')[1]?.split('.')[0] || '';
    const detail = (e.detail || '').slice(0, 40);
    return `<div class="entry"><span class="info">${detail}</span><span class="time">${time}</span></div>`;
  }).join('');
}

// ── Capture ──
document.getElementById('captureBtn').addEventListener('click', async () => {
  const btn = document.getElementById('captureBtn');
  btn.disabled = true;
  btn.textContent = '...';
  try {
    const [tab] = await api.tabs.query({active: true, currentWindow: true});
    try { await api.scripting.executeScript({target: {tabId: tab.id}, files: ['extractor.js']}); } catch(e) {}
    const snap = await api.tabs.sendMessage(tab.id, {action: 'capture'});
    if (snap) await api.runtime.sendMessage({action: 'log_snapshot', data: snap});
    refresh();
  } catch(e) {}
  btn.disabled = false;
  btn.textContent = 'Capture';
});

function toast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.display = 'block';
  el.style.background = type === 'ok' ? '#14532d' : type === 'err' ? '#450a0a' : '#111';
  el.style.color = type === 'ok' ? '#22c55e' : type === 'err' ? '#ef4444' : '#999';
  el.style.border = '1px solid ' + (type === 'ok' ? '#166534' : type === 'err' ? '#7f1d1d' : '#222');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.style.display = 'none'; }, 5000);
}

// ── Verify ──
document.getElementById('verifyBtn').addEventListener('click', async () => {
  const store = await api.storage.local.get(AUDIT_KEY);
  const entries = store[AUDIT_KEY] || [];
  if (!entries.length) { toast('No entries yet.', ''); return; }

  let prev = 'GENESIS';
  for (const e of entries) {
    const row = `${e.seq}|${e.timestamp}|${e.event}|${e.symbol}|${e.side}|${e.strategy}|${e.decision_inputs}|${e.exchange_response}|${e.detail}|${e.prev_hash}`;
    const hash = await sha256(`${prev}|${row}`);
    if (e.hash !== hash || e.prev_hash !== prev) {
      toast('Chain BROKEN at entry #' + e.seq + ' — data may be tampered.', 'err');
      document.getElementById('chainLabel').textContent = 'BROKEN';
      return;
    }
    prev = e.hash;
  }
  toast('Chain valid — all ' + entries.length + ' entries verified.', 'ok');
  document.getElementById('chainLabel').textContent = 'chain ok';
});

// ── Digest ──
document.getElementById('digestBtn').addEventListener('click', async () => {
  const store = await api.storage.local.get([AUDIT_KEY, DIGEST_KEY]);
  const entries = store[AUDIT_KEY] || [];
  if (!entries.length) { toast('No entries yet.', ''); return; }
  const hash = await sha256(JSON.stringify(entries));
  const digests = store[DIGEST_KEY] || [];
  digests.push({timestamp: new Date().toISOString(), rows: entries.length, sha256: hash});
  await api.storage.local.set({[DIGEST_KEY]: digests});
  toast('Digest: ' + hash.slice(0, 24) + '... — email this to yourself as proof.', 'ok');
  refresh();
});

// ── Export ──
document.getElementById('exportBtn').addEventListener('click', async () => {
  const store = await api.storage.local.get(AUDIT_KEY);
  const entries = store[AUDIT_KEY] || [];
  if (!entries.length) { toast('No entries yet.', ''); return; }
  const hdr = 'seq,timestamp,event,symbol,side,strategy,decision_inputs,exchange_response,detail,prev_hash,hash';
  const rows = entries.map(e =>
    [e.seq,e.timestamp,e.event,e.symbol,e.side,e.strategy,
     '"'+(e.decision_inputs||'').replace(/"/g,'""')+'"',
     '"'+(e.exchange_response||'').replace(/"/g,'""')+'"',
     '"'+(e.detail||'').replace(/"/g,'""')+'"',
     e.prev_hash,e.hash].join(','));
  const blob = new Blob([hdr+'\n'+rows.join('\n')], {type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'tradeaudit_trail.csv';
  a.click();
});

// ── Clear ──
document.getElementById('clearBtn').addEventListener('click', async () => {
  const store = await api.storage.local.get(AUDIT_KEY);
  const count = (store[AUDIT_KEY] || []).length;
  if (!count) { toast('Nothing to clear.', ''); return; }
  if (!confirm('Delete all ' + count + ' audit entries? Export first if you need them.')) return;
  await api.storage.local.remove([AUDIT_KEY]);
  toast('Cleared ' + count + ' entries.', 'ok');
  refresh();
});

async function sha256(msg) {
  const data = new TextEncoder().encode(msg);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}
