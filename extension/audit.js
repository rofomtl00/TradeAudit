/**
 * TradeAudit Core — SHA-256 Hash-Chained Audit Trail (JavaScript)
 * Stores audit entries in chrome.storage.local with tamper-evident hash chain.
 */

const AUDIT_STORAGE_KEY = 'tradeaudit_entries';
const DIGEST_STORAGE_KEY = 'tradeaudit_digests';
const runtimeApi = typeof browser !== 'undefined' ? browser : chrome;

async function sha256(message) {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getEntries() {
  const data = await runtimeApi.storage.local.get(AUDIT_STORAGE_KEY);
  return data[AUDIT_STORAGE_KEY] || [];
}

async function getLastHash() {
  const entries = await getEntries();
  if (entries.length === 0) return 'GENESIS';
  return entries[entries.length - 1].hash;
}

async function appendEntry(event, symbol, side, strategy, decisionInputs, exchangeResponse, detail) {
  const entries = await getEntries();
  const seq = entries.length + 1;
  const ts = new Date().toISOString();
  const prev = entries.length > 0 ? entries[entries.length - 1].hash : 'GENESIS';

  // Sanitize — remove sensitive keys
  const safeResponse = sanitize(exchangeResponse || {});

  const inputsStr = JSON.stringify(decisionInputs || {});
  const responseStr = JSON.stringify(safeResponse);

  // Coerce nulls to empty string (match Python version)
  const e = event || '';
  const sy = symbol || '';
  const si = side || '';
  const st = strategy || '';
  const de = detail || '';

  const rowData = `${seq}|${ts}|${e}|${sy}|${si}|${st}|${inputsStr}|${responseStr}|${de}|${prev}`;
  const hash = await sha256(`${prev}|${rowData}`);

  const entry = {
    seq, timestamp: ts, event: e, symbol: sy, side: si, strategy: st,
    decision_inputs: inputsStr, exchange_response: responseStr,
    detail: de, prev_hash: prev, hash
  };

  entries.push(entry);

  // Keep max 10,000 entries (rotate old ones)
  if (entries.length > 10000) {
    entries.splice(0, entries.length - 10000);
  }

  await runtimeApi.storage.local.set({ [AUDIT_STORAGE_KEY]: entries });
  return entry;
}

function sanitize(obj) {
  if (typeof obj !== 'object' || obj === null) return {};
  const sensitive = new Set(['apiKey', 'secret', 'password', 'passphrase', 'token', 'signature', 'sign', 'nonce']);
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!sensitive.has(k)) result[k] = v;
  }
  return result;
}

async function verifyChain() {
  const entries = await getEntries();
  if (entries.length === 0) return { valid: true, broken_at: null, rows: 0 };

  let prev = 'GENESIS';
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const rowData = `${e.seq}|${e.timestamp}|${e.event}|${e.symbol}|${e.side}|${e.strategy}|${e.decision_inputs}|${e.exchange_response}|${e.detail}|${e.prev_hash}`;
    const expected = await sha256(`${prev}|${rowData}`);
    if (e.hash !== expected || e.prev_hash !== prev) {
      return { valid: false, broken_at: e.seq, rows: entries.length };
    }
    prev = e.hash;
  }
  return { valid: true, broken_at: null, rows: entries.length };
}

async function writeDigest() {
  const entries = await getEntries();
  if (entries.length === 0) return null;
  const fullStr = JSON.stringify(entries);
  const hash = await sha256(fullStr);
  const ts = new Date().toISOString();

  const data = await runtimeApi.storage.local.get(DIGEST_STORAGE_KEY);
  const digests = data[DIGEST_STORAGE_KEY] || [];
  digests.push({ timestamp: ts, rows: entries.length, sha256: hash });
  if (digests.length > 365) digests.splice(0, digests.length - 365);
  await runtimeApi.storage.local.set({ [DIGEST_STORAGE_KEY]: digests });
  return hash;
}

async function getStatus() {
  const chain = await verifyChain();
  const data = await runtimeApi.storage.local.get(DIGEST_STORAGE_KEY);
  const digests = (data[DIGEST_STORAGE_KEY] || []).length;
  return {
    rows: chain.rows,
    chain_valid: chain.valid,
    chain_broken_at: chain.broken_at,
    digests
  };
}

async function exportCSV() {
  const entries = await getEntries();
  if (entries.length === 0) return '';
  const headers = 'seq,timestamp,event,symbol,side,strategy,decision_inputs,exchange_response,detail,prev_hash,hash';
  const rows = entries.map(e =>
    [e.seq, e.timestamp, e.event, e.symbol, e.side, e.strategy,
     `"${e.decision_inputs.replace(/"/g, '""')}"`,
     `"${e.exchange_response.replace(/"/g, '""')}"`,
     `"${(e.detail || '').replace(/"/g, '""')}"`,
     e.prev_hash, e.hash].join(',')
  );
  return headers + '\n' + rows.join('\n');
}
