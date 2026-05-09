// Static HTML for the GET /dashboard route. Vanilla JS, no build
// pipeline, no external assets — fetches from the same origin's
// JSON routes (/balance, /peers, /v1/models, /ledger). Keep this
// file self-contained; the goal is "open the URL, see the network."

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>🦞 Lobstah · network status</title>
<style>
  :root {
    --bg: #0e0f12;
    --panel: #161821;
    --panel-2: #1f2330;
    --border: #2a2f3e;
    --fg: #e6e8ef;
    --muted: #8b93a7;
    --accent: #ff7a47;
    --green: #4ade80;
    --red: #f87171;
    --yellow: #fbbf24;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
    background: var(--bg); color: var(--fg);
    max-width: 1200px; margin: 0 auto;
  }
  h1 { font-size: 24px; margin: 0 0 4px 0; }
  h2 { font-size: 16px; margin: 0 0 12px 0; color: var(--muted); font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; }
  .subtitle { color: var(--muted); margin-bottom: 24px; font-size: 13px; }
  .grid { display: grid; gap: 16px; grid-template-columns: 1fr 1fr; }
  @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
  .card {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 8px; padding: 16px;
  }
  .stat { display: flex; justify-content: space-between; align-items: baseline; margin: 6px 0; }
  .stat-label { color: var(--muted); font-size: 12px; }
  .stat-value { font-family: var(--mono); font-weight: 600; }
  .stat-value.big { font-size: 22px; color: var(--accent); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 4px; font-size: 13px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; text-transform: uppercase; font-size: 11px; letter-spacing: 0.05em; }
  td.num { text-align: right; font-family: var(--mono); }
  td.pk { font-family: var(--mono); color: var(--muted); }
  td.pk.you { color: var(--accent); font-weight: 600; }
  .pos { color: var(--green); }
  .neg { color: var(--red); }
  .muted { color: var(--muted); }
  .live { color: var(--green); }
  .dead { color: var(--red); }
  .pending { color: var(--yellow); }
  pre { font: 12px/1.4 var(--mono); color: var(--muted); margin: 0; white-space: pre-wrap; word-break: break-all; }
  footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; }
  footer a { color: var(--muted); }
  .refresh { float: right; padding: 4px 12px; background: var(--panel-2); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; cursor: pointer; font-family: inherit; font-size: 12px; }
  .refresh:hover { border-color: var(--accent); color: var(--accent); }
  .ts { color: var(--muted); font-family: var(--mono); font-size: 11px; }
  .ledger-note { background: var(--panel-2); padding: 10px; border-radius: 6px; margin-bottom: 12px; font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
  <h1>🦞 Lobstah <span style="color:var(--muted);font-weight:400;font-size:18px;">network status</span></h1>
  <div class="subtitle">
    Public accounts, federated ledger. Each receipt is signed by the worker; this view is one node's perspective.
    <button class="refresh" onclick="loadAll()">↻ refresh</button>
  </div>

  <div id="self-card" class="card" style="margin-bottom: 16px;">
    <h2>You</h2>
    <div id="self-content"><div class="muted">Loading…</div></div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>Network volume (this node's view)</h2>
      <div id="totals-content"><div class="muted">Loading…</div></div>
    </div>
    <div class="card">
      <h2>Live workers</h2>
      <div id="workers-content"><div class="muted">Loading…</div></div>
    </div>
  </div>

  <div class="card" style="margin-top: 16px;">
    <h2>Public accounts (top by volume)</h2>
    <div class="ledger-note">
      Earned = compute provided · Spent = compute consumed · Net = creditor (+) or debtor (−).
      Ranked by total volume (earned + spent). Visible accounts are limited to those this
      node has witnessed — federation across nodes is roadmap.
    </div>
    <div id="leaderboard-content"><div class="muted">Loading…</div></div>
  </div>

  <div class="card" style="margin-top: 16px;">
    <h2>Activity feed (latest receipts)</h2>
    <div id="ledger-content"><div class="muted">Loading…</div></div>
  </div>

  <footer>
    <p>
      🦞 Lobstah grid · <a href="https://github.com/marouenbg/lobstah" target="_blank">github</a>
      · <a href="https://www.npmjs.com/org/lobstah" target="_blank">npm</a>
      · <a href="https://clawhub.ai/plugins/@lobstah/openclaw-provider" target="_blank">clawhub</a>
    </p>
    <p>Architecture note: receipts are Ed25519-signed. Anyone can verify a receipt's authenticity offline. This dashboard reflects one node's local ledger; no central authority owns the data.</p>
  </footer>

<script>
const fmt = (n) => new Intl.NumberFormat().format(n);
const pk = (p, full) => full ? p : (p ? p.slice(0, 16) + '…' : '?');
const time = (ms) => {
  const d = new Date(ms);
  const now = Date.now();
  const ago = now - ms;
  if (ago < 60000) return Math.round(ago/1000) + 's ago';
  if (ago < 3600000) return Math.round(ago/60000) + 'm ago';
  if (ago < 86400000) return Math.round(ago/3600000) + 'h ago';
  return d.toISOString().slice(0, 10);
};

let myPubkey = null;

async function loadAll() {
  // Self pubkey + balance summary
  try {
    const bal = await fetch('/balance').then(r => r.json());
    myPubkey = bal.pubkey;
    renderSelf(bal);
    renderTotals(bal);
    renderLeaderboard(bal);
  } catch (e) {
    document.getElementById('self-content').innerHTML = '<div class="dead">error: ' + e.message + '</div>';
  }

  // Live worker probes via /peers + each peer's /capacity
  try {
    const peers = await fetch('/peers').then(r => r.json());
    renderWorkers(peers);
  } catch (e) {
    document.getElementById('workers-content').innerHTML = '<div class="dead">error: ' + e.message + '</div>';
  }

  // Recent receipts feed
  try {
    const led = await fetch('/ledger?limit=20').then(r => r.json());
    renderLedger(led);
  } catch (e) {
    document.getElementById('ledger-content').innerHTML = '<div class="dead">error: ' + e.message + '</div>';
  }
}

function renderSelf(bal) {
  const me = bal.self;
  const netClass = me.net > 0 ? 'pos' : me.net < 0 ? 'neg' : '';
  const netSign = me.net > 0 ? '+' : '';
  document.getElementById('self-content').innerHTML = \`
    <div class="stat"><span class="stat-label">your pubkey</span><span class="stat-value muted">\${me.pubkey}</span></div>
    <div class="stat"><span class="stat-label">earned (compute provided)</span><span class="stat-value">\${fmt(me.earned)} tokens</span></div>
    <div class="stat"><span class="stat-label">spent (compute consumed)</span><span class="stat-value">\${fmt(me.spent)} tokens</span></div>
    <div class="stat"><span class="stat-label">net</span><span class="stat-value big \${netClass}">\${netSign}\${fmt(me.net)}</span></div>
  \`;
}

function renderTotals(bal) {
  document.getElementById('totals-content').innerHTML = \`
    <div class="stat"><span class="stat-label">total receipts</span><span class="stat-value">\${fmt(bal.totals.receipts)}</span></div>
    <div class="stat"><span class="stat-label">tokens earned (network)</span><span class="stat-value">\${fmt(bal.totals.earned)}</span></div>
    <div class="stat"><span class="stat-label">tokens spent (network)</span><span class="stat-value">\${fmt(bal.totals.spent)}</span></div>
    <div class="stat"><span class="stat-label">distinct accounts seen</span><span class="stat-value">\${fmt(bal.perPeer.length)}</span></div>
  \`;
}

function renderLeaderboard(bal) {
  if (bal.perPeer.length === 0) {
    document.getElementById('leaderboard-content').innerHTML = '<div class="muted">No accounts in ledger yet.</div>';
    return;
  }
  const rows = bal.perPeer.map(p => {
    const isMe = p.pubkey === myPubkey;
    const netClass = p.net > 0 ? 'pos' : p.net < 0 ? 'neg' : '';
    const netSign = p.net > 0 ? '+' : '';
    return \`<tr>
      <td class="pk \${isMe ? 'you' : ''}" title="\${p.pubkey}">\${pk(p.pubkey)}\${isMe ? ' (you)' : ''}</td>
      <td class="num">\${fmt(p.earned)}</td>
      <td class="num">\${fmt(p.spent)}</td>
      <td class="num \${netClass}">\${netSign}\${fmt(p.net)}</td>
    </tr>\`;
  }).join('');
  document.getElementById('leaderboard-content').innerHTML = \`
    <table>
      <thead><tr><th>account</th><th class="num">earned</th><th class="num">spent</th><th class="num">net</th></tr></thead>
      <tbody>\${rows}</tbody>
    </table>
  \`;
}

async function renderWorkers(peers) {
  if (peers.length === 0) {
    document.getElementById('workers-content').innerHTML = '<div class="muted">No peers configured. Try <code>lobstah peers gossip-nostr</code>.</div>';
    return;
  }
  const probes = await Promise.all(peers.map(async (p) => {
    try {
      const r = await fetch(p.url.replace(/\\/$/, '') + '/capacity', { signal: AbortSignal.timeout(4000) });
      if (!r.ok) return { peer: p, alive: false };
      const cap = await r.json();
      return { peer: p, alive: true, cap };
    } catch {
      return { peer: p, alive: false };
    }
  }));
  const rows = probes.map(({ peer, alive, cap }) => {
    if (!alive) {
      return \`<tr>
        <td class="pk" title="\${peer.pubkey}">\${pk(peer.pubkey)}</td>
        <td class="muted">\${peer.label || '—'}</td>
        <td class="dead">✗ offline</td>
        <td class="muted">—</td>
      </tr>\`;
    }
    return \`<tr>
      <td class="pk" title="\${peer.pubkey}">\${pk(peer.pubkey)}</td>
      <td>\${peer.label || '—'}</td>
      <td class="live">✓ \${cap.tier || '?'}</td>
      <td class="muted">\${(cap.models || []).join(', ')}</td>
    </tr>\`;
  }).join('');
  document.getElementById('workers-content').innerHTML = \`
    <table>
      <thead><tr><th>worker</th><th>label</th><th>status</th><th>models</th></tr></thead>
      <tbody>\${rows}</tbody>
    </table>
  \`;
}

function renderLedger(led) {
  if (!led.receipts || led.receipts.length === 0) {
    document.getElementById('ledger-content').innerHTML = '<div class="muted">No receipts yet.</div>';
    return;
  }
  const rows = led.receipts.map(s => {
    const r = s.receipt;
    const youAreReq = r.requesterPubkey === myPubkey;
    const youAreWk = r.workerPubkey === myPubkey;
    const reqLabel = youAreReq ? '(you)' : '';
    const wkLabel = youAreWk ? '(you)' : '';
    return \`<tr>
      <td class="ts">\${time(r.completedAt)}</td>
      <td class="muted">\${r.model}</td>
      <td class="num">\${r.inputTokens}+\${r.outputTokens}=\${r.inputTokens + r.outputTokens}</td>
      <td class="pk \${youAreReq ? 'you' : ''}" title="requester: \${r.requesterPubkey}">\${pk(r.requesterPubkey)} \${reqLabel}</td>
      <td>→</td>
      <td class="pk \${youAreWk ? 'you' : ''}" title="worker: \${r.workerPubkey}">\${pk(r.workerPubkey)} \${wkLabel}</td>
    </tr>\`;
  }).join('');
  document.getElementById('ledger-content').innerHTML = \`
    <table>
      <thead><tr><th>when</th><th>model</th><th class="num">tokens</th><th>requester</th><th></th><th>worker</th></tr></thead>
      <tbody>\${rows}</tbody>
    </table>
  \`;
}

loadAll();
setInterval(loadAll, 30000); // auto-refresh every 30s
</script>
</body>
</html>
`;
