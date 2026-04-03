/**
 * TradeAudit Background Script
 * Receives snapshots from content script, hash-chains them into audit trail.
 */

const runtimeApi = typeof browser !== 'undefined' ? browser : chrome;
const AUDIT_KEY = 'tradeaudit_entries';
const DIGEST_KEY = 'tradeaudit_digests';

async function sha256(message) {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function appendAuditEntry(event, symbol, data) {
  const store = await runtimeApi.storage.local.get(AUDIT_KEY);
  const entries = store[AUDIT_KEY] || [];
  const seq = entries.length + 1;
  const ts = new Date().toISOString();
  const prev = entries.length > 0 ? entries[entries.length - 1].hash : 'GENESIS';

  const inputsStr = JSON.stringify(data.inputs || {});
  const responseStr = JSON.stringify(data.response || {});
  const detail = data.detail || '';

  const rowData = `${seq}|${ts}|${event}|${symbol}|${data.side || ''}|${data.strategy || ''}|${inputsStr}|${responseStr}|${detail}|${prev}`;
  const hash = await sha256(`${prev}|${rowData}`);

  entries.push({
    seq, timestamp: ts, event, symbol,
    side: data.side || '', strategy: data.strategy || '',
    decision_inputs: inputsStr, exchange_response: responseStr,
    detail, prev_hash: prev, hash
  });

  // Cap at 10,000 entries
  if (entries.length > 10000) entries.splice(0, entries.length - 10000);

  await runtimeApi.storage.local.set({ [AUDIT_KEY]: entries });
  return seq;
}

// Listen for messages from content script and popup
runtimeApi.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'log_snapshot') {
    const snap = msg.data;
    appendAuditEntry('SNAPSHOT', snap.exchange || 'unknown', {
      response: {
        balances: snap.balances,
        positions: snap.positions?.length || 0,
        orders: snap.orders?.length || 0,
        pnl: snap.pnl,
        prices: snap.prices,
        fees: snap.fees,
        page_numbers: snap.page_text?.slice(0, 20),
      },
      detail: `${snap.exchange_name}: ${snap.balances?.length || 0} balances, ${snap.positions?.length || 0} positions, ${snap.orders?.length || 0} orders`
    }).then(seq => sendResponse({ ok: true, seq }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.action === 'log_event') {
    appendAuditEntry(msg.event, msg.symbol || '', msg.data || {})
      .then(seq => sendResponse({ ok: true, seq }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

// Daily digest — check every hour
setInterval(async () => {
  const store = await runtimeApi.storage.local.get([AUDIT_KEY, DIGEST_KEY, '_last_digest_date']);
  const today = new Date().toISOString().slice(0, 10);
  if (store._last_digest_date === today) return;

  const entries = store[AUDIT_KEY] || [];
  if (entries.length === 0) return;

  const fullHash = await sha256(JSON.stringify(entries));
  const digests = store[DIGEST_KEY] || [];
  digests.push({ timestamp: new Date().toISOString(), rows: entries.length, sha256: fullHash });
  if (digests.length > 365) digests.splice(0, digests.length - 365);

  await runtimeApi.storage.local.set({
    [DIGEST_KEY]: digests,
    '_last_digest_date': today
  });
}, 3600000); // Every hour
