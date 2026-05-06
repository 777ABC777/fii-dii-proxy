/**
 * Signal Tracker Pro — Backend v2
 * ─────────────────────────────────────────────────────────────────
 * Combines:
 *   1. NSE FII/DII data proxy (original)
 *   2. Personal state sync — settings, Telegram, paper trading
 *      stored server-side so they load identically on phone + laptop
 *
 * Deploy on Render.com (free tier) — same service as before.
 * Just replace server.js with this file, redeploy.
 *
 * ENDPOINTS — NSE Data:
 *   GET  /api/fii-dii
 *   GET  /api/fii-dii/history
 *   GET  /api/india-vix
 *   GET  /api/bulk-deals
 *   GET  /api/block-deals
 *   GET  /api/market-status
 *
 * ENDPOINTS — Personal State (no auth needed, personal use only):
 *   GET  /api/state              → load all your saved state
 *   POST /api/state              → save all state
 *   GET  /api/state/telegram     → get telegram credentials
 *   POST /api/state/telegram     → save telegram credentials
 *   GET  /api/state/paper        → get paper trading portfolio
 *   POST /api/state/paper        → save paper trading portfolio
 *   POST /api/state/reset        → reset paper portfolio only
 *   GET  /health
 * ─────────────────────────────────────────────────────────────────
 */

const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));

// ── State file path (persists on Render disk between deploys) ──
const STATE_FILE = path.join(__dirname, 'user_state.json');

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch(e) {}
  return {
    telegram:     { token: '', chatId: '', connected: false, settings: {} },
    appSettings:  { currentMkt: 'sp500', currentFilter: 'all', tgThreshold: 75 },
    paperTrading: { active: false, capital: 1000000, cash: 1000000, positions: [], history: [] },
    watchlist:    ['AAPL', 'TSLA', 'NVDA'],
    scorecard:    [],
    savedAt:      null,
  };
}

function saveState(state) {
  try {
    state.savedAt = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch(e) {
    console.error('State save error:', e.message);
    return false;
  }
}

// ── NSE cache ──
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function cached(key, fetcher) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return Promise.resolve(entry.data);
  return fetcher().then(data => { cache.set(key, { data, ts: Date.now() }); return data; });
}

function nseHeaders() {
  return {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer': 'https://www.nseindia.com/',
    'Origin': 'https://www.nseindia.com',
  };
}

let nseCookies = '';
let cookieFetchedAt = 0;

async function getNseCookies() {
  if (nseCookies && Date.now() - cookieFetchedAt < 10 * 60 * 1000) return nseCookies;
  try {
    const res = await fetch('https://www.nseindia.com/', { headers: nseHeaders() });
    const setCookie = res.headers.raw()['set-cookie'] || [];
    nseCookies = setCookie.map(c => c.split(';')[0]).join('; ');
    cookieFetchedAt = Date.now();
  } catch(e) { nseCookies = ''; }
  return nseCookies;
}

async function nseFetch(url) {
  const cookies = await getNseCookies();
  const res = await fetch(url, { headers: { ...nseHeaders(), Cookie: cookies } });
  if (!res.ok) throw new Error('NSE returned ' + res.status);
  return res.json();
}

function parseNetValue(raw) {
  if (!raw) return 0;
  const n = parseFloat(String(raw).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

function signalFromNet(net) {
  if (net >  2000) return { label: 'Strong Buy',    color: '#22c55e', emoji: '🟢', strength: 90 };
  if (net >   500) return { label: 'Moderate Buy',  color: '#86efac', emoji: '🟢', strength: 65 };
  if (net >     0) return { label: 'Mild Buy',      color: '#f0b429', emoji: '🟡', strength: 45 };
  if (net >  -500) return { label: 'Mild Sell',     color: '#f97316', emoji: '🟠', strength: 40 };
  if (net > -2000) return { label: 'Moderate Sell', color: '#f87171', emoji: '🔴', strength: 65 };
  return               { label: 'Strong Sell',  color: '#ef4444', emoji: '🔴', strength: 90 };
}

// ════════════════════════════════════════════════════════════════
// PERSONAL STATE ENDPOINTS
// ════════════════════════════════════════════════════════════════

/** GET /api/state — load complete app state */
app.get('/api/state', (req, res) => {
  try {
    const state = loadState();
    // Never send telegram token in plain text — send masked version
    const safe = JSON.parse(JSON.stringify(state));
    if (safe.telegram && safe.telegram.token) {
      safe.telegram.tokenMasked = safe.telegram.token.slice(0, 6) + '...' + safe.telegram.token.slice(-4);
      safe.telegram.hasToken    = true;
      delete safe.telegram.token; // don't expose in GET
    }
    res.json({ ok: true, data: safe });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** POST /api/state — save complete app state */
app.post('/api/state', (req, res) => {
  try {
    const current = loadState();
    const incoming = req.body || {};
    // Merge — don't overwrite telegram token if not provided
    const merged = { ...current, ...incoming };
    if (!incoming.telegram || !incoming.telegram.token) {
      merged.telegram = current.telegram; // preserve existing token
    }
    const ok = saveState(merged);
    res.json({ ok, savedAt: merged.savedAt });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** GET /api/state/telegram — get telegram credentials (token included) */
app.get('/api/state/telegram', (req, res) => {
  try {
    const state = loadState();
    res.json({ ok: true, data: state.telegram || {} });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** POST /api/state/telegram — save telegram credentials */
app.post('/api/state/telegram', (req, res) => {
  try {
    const state = loadState();
    state.telegram = { ...state.telegram, ...req.body };
    saveState(state);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** GET /api/state/paper — get paper trading portfolio */
app.get('/api/state/paper', (req, res) => {
  try {
    const state = loadState();
    res.json({ ok: true, data: state.paperTrading || {} });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** POST /api/state/paper — save paper trading portfolio */
app.post('/api/state/paper', (req, res) => {
  try {
    const state = loadState();
    state.paperTrading = { ...state.paperTrading, ...req.body };
    saveState(state);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** POST /api/state/reset-paper — reset paper portfolio */
app.post('/api/state/reset-paper', (req, res) => {
  try {
    const state = loadState();
    state.paperTrading = {
      active:    false,
      capital:   1000000,
      cash:      1000000,
      positions: [],
      history:   [],
    };
    saveState(state);
    res.json({ ok: true, message: 'Paper portfolio reset' });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** POST /api/state/scorecard — save scorecard entries */
app.post('/api/state/scorecard', (req, res) => {
  try {
    const state = loadState();
    state.scorecard = req.body.scorecard || state.scorecard;
    saveState(state);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════
// NSE DATA ENDPOINTS (unchanged from v1)
// ════════════════════════════════════════════════════════════════

app.get('/api/fii-dii', async (req, res) => {
  try {
    const data = await cached('fii-dii-today', async () => {
      const raw  = await nseFetch('https://www.nseindia.com/api/fiidiiTradeReact');
      const rows = Array.isArray(raw) ? raw : (raw.data || []);
      const fii  = rows.find(r => r.category && r.category.includes('FII')) || {};
      const dii  = rows.find(r => r.category && r.category.includes('DII')) || {};
      const fiiBuy  = parseNetValue(fii.buyValue  || fii.BUY_VALUE);
      const fiiSell = parseNetValue(fii.sellValue || fii.SELL_VALUE);
      const fiiNet  = parseNetValue(fii.netValue  || fii.NET_VALUE);
      const diiBuy  = parseNetValue(dii.buyValue  || dii.BUY_VALUE);
      const diiSell = parseNetValue(dii.sellValue || dii.SELL_VALUE);
      const diiNet  = parseNetValue(dii.netValue  || dii.NET_VALUE);
      const divergence = fiiNet < 0 && diiNet > 0 ? 'DII absorbing FII selling — market supported' :
                         fiiNet > 0 && diiNet < 0 ? 'FII buying while DII takes profits — bullish' :
                         fiiNet > 0 && diiNet > 0 ? 'Both FII and DII buying — strong bullish' :
                                                     'Both FII and DII selling — high caution';
      return {
        date: fii.date || fii.DATE || new Date().toISOString().slice(0,10),
        fii:  { buy: fiiBuy, sell: fiiSell, net: fiiNet, signal: signalFromNet(fiiNet), label: 'FII/FPI (Foreign)' },
        dii:  { buy: diiBuy, sell: diiSell, net: diiNet, signal: signalFromNet(diiNet), label: 'DII (Domestic)' },
        combined: { net: fiiNet + diiNet, signal: signalFromNet(fiiNet + diiNet), divergence },
        fetchedAt: new Date().toISOString(), source: 'NSE India (provisional)',
      };
    });
    res.json({ ok: true, data });
  } catch(err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/fii-dii/history', async (req, res) => {
  try {
    const data = await cached('fii-dii-history', async () => {
      const raw  = await nseFetch('https://www.nseindia.com/api/historical/fiiDii');
      const rows = Array.isArray(raw) ? raw : (raw.data || []);
      return rows.slice(0, 30).map(r => {
        const fiiNet = parseNetValue(r.fiiNet || r.FII_NET || r.netValueFii);
        const diiNet = parseNetValue(r.diiNet || r.DII_NET || r.netValueDii);
        return { date: r.date || r.DATE || r.tradingDate, fiiNet, diiNet,
          fiiSignal: signalFromNet(fiiNet).label, diiSignal: signalFromNet(diiNet).label };
      });
    });
    res.json({ ok: true, data });
  } catch(err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/india-vix', async (req, res) => {
  try {
    const data = await cached('india-vix', async () => {
      const raw     = await nseFetch('https://www.nseindia.com/api/allIndices');
      const indices = raw.data || [];
      const vix     = indices.find(i => i.indexSymbol === 'INDIA VIX');
      return {
        value:     vix ? parseFloat(vix.last) : null,
        change:    vix ? parseFloat(vix.percentChange) : null,
        signal:    vix ? (parseFloat(vix.last) > 20 ? 'High Fear — caution' : parseFloat(vix.last) < 13 ? 'Low Fear — complacency' : 'Normal range') : 'Unknown',
        fetchedAt: new Date().toISOString(),
      };
    });
    res.json({ ok: true, data });
  } catch(err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/bulk-deals', async (req, res) => {
  try {
    const data = await cached('bulk-deals', async () => {
      const raw = await nseFetch('https://www.nseindia.com/api/snapshot-capital-market-mostactive-bulkdeals');
      return { deals: raw.data || raw || [], fetchedAt: new Date().toISOString() };
    });
    res.json({ ok: true, data });
  } catch(err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/block-deals', async (req, res) => {
  try {
    const data = await cached('block-deals', async () => {
      const raw = await nseFetch('https://www.nseindia.com/api/block-deal');
      return { deals: raw.data || raw || [], fetchedAt: new Date().toISOString() };
    });
    res.json({ ok: true, data });
  } catch(err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/market-status', async (req, res) => {
  try {
    const data = await cached('market-status', async () => {
      const raw = await nseFetch('https://www.nseindia.com/api/marketStatus');
      return { ...raw, fetchedAt: new Date().toISOString() };
    });
    res.json({ ok: true, data });
  } catch(err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/health', (req, res) => {
  const state = loadState();
  res.json({
    status:  'ok',
    service: 'Signal Tracker Pro v2 — NSE Proxy + State Sync',
    version: '2.0.0',
    uptime:  Math.round(process.uptime()) + 's',
    cached:  cache.size + ' endpoints cached',
    stateSavedAt: state.savedAt || 'never',
    hasTelegram:  !!(state.telegram && state.telegram.token),
    paperTrades:  state.paperTrading ? state.paperTrading.history.length : 0,
    time:    new Date().toISOString(),
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'Signal Tracker Pro Backend v2',
    endpoints: {
      nse:   ['/api/fii-dii', '/api/fii-dii/history', '/api/india-vix', '/api/bulk-deals', '/api/block-deals', '/api/market-status'],
      state: ['/api/state (GET/POST)', '/api/state/telegram (GET/POST)', '/api/state/paper (GET/POST)', '/api/state/reset-paper (POST)', '/api/state/scorecard (POST)'],
      util:  ['/health'],
    },
  });
});

app.listen(PORT, () => {
  console.log('Signal Tracker Pro Backend v2 running on port', PORT);
  console.log('State file:', STATE_FILE);
});
