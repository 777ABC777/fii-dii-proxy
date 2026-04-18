/**
 * Signal Tracker Pro — FII/DII Backend Proxy
 * ─────────────────────────────────────────────────────────────────
 * Fetches FII/DII data from NSE India and serves it via a CORS-open
 * REST API so your frontend (Netlify) can call it freely.
 *
 * Deploy FREE on Render.com:
 *   1. Push this folder to a GitHub repo
 *   2. Go to render.com → New Web Service → connect your repo
 *   3. Build command: npm install  |  Start command: npm start
 *   4. Done — copy the URL (e.g. https://fii-proxy.onrender.com)
 *      and paste it into your tracker app's BACKEND_URL constant
 *
 * Endpoints:
 *   GET /api/fii-dii          → Today's FII & DII cash market data
 *   GET /api/fii-dii/history  → Last 30 days historical data
 *   GET /api/fno              → FII F&O positions (futures & options)
 *   GET /api/bulk-deals       → Today's BSE/NSE bulk deals
 *   GET /api/block-deals      → Today's NSE block deals
 *   GET /api/india-vix        → India VIX level
 *   GET /api/market-status    → NSE market open/close status
 *   GET /health               → Health check
 * ─────────────────────────────────────────────────────────────────
 */

const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── CORS: allow all origins (your Netlify app + local dev) ────────
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── In-memory cache (reduces NSE hits, 5-min TTL) ─────────────────
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function cached(key, fetcher) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return Promise.resolve(entry.data);
  return fetcher().then(data => {
    cache.set(key, { data, ts: Date.now() });
    return data;
  });
}

// ── NSE headers — required to avoid 401/403 ──────────────────────
function nseHeaders() {
  return {
    'Accept':           'application/json, text/plain, */*',
    'Accept-Language':  'en-US,en;q=0.9',
    'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer':          'https://www.nseindia.com/',
    'Origin':           'https://www.nseindia.com',
    'Connection':       'keep-alive',
  };
}

// ── Helper: fetch NSE with cookie bootstrap ───────────────────────
let nseCookies = '';
let cookieFetchedAt = 0;

async function getNseCookies() {
  if (nseCookies && Date.now() - cookieFetchedAt < 10 * 60 * 1000) return nseCookies;
  try {
    const res = await fetch('https://www.nseindia.com/', { headers: nseHeaders() });
    const setCookie = res.headers.raw()['set-cookie'] || [];
    nseCookies = setCookie.map(c => c.split(';')[0]).join('; ');
    cookieFetchedAt = Date.now();
  } catch (e) {
    nseCookies = '';
  }
  return nseCookies;
}

async function nseFetch(url) {
  const cookies = await getNseCookies();
  const headers = { ...nseHeaders(), Cookie: cookies };
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error('NSE returned ' + res.status);
  return res.json();
}

// ── Formatter helpers ─────────────────────────────────────────────
function parseNetValue(raw) {
  if (!raw) return 0;
  const n = parseFloat(String(raw).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

function signalFromNet(net) {
  if (net > 2000)  return { label: 'Strong Buy',   color: '#22c55e', emoji: '🟢', strength: 90 };
  if (net > 500)   return { label: 'Moderate Buy',  color: '#86efac', emoji: '🟢', strength: 65 };
  if (net > 0)     return { label: 'Mild Buy',      color: '#bbf7d0', emoji: '🟡', strength: 45 };
  if (net > -500)  return { label: 'Mild Sell',     color: '#fca5a5', emoji: '🟠', strength: 40 };
  if (net > -2000) return { label: 'Moderate Sell', color: '#f87171', emoji: '🔴', strength: 65 };
  return              { label: 'Strong Sell',   color: '#ef4444', emoji: '🔴', strength: 90 };
}

// ─────────────────────────────────────────────────────────────────
// ROUTE: /api/fii-dii  →  Today's FII & DII cash market data
// ─────────────────────────────────────────────────────────────────
app.get('/api/fii-dii', async (req, res) => {
  try {
    const data = await cached('fii-dii-today', async () => {
      const raw = await nseFetch('https://www.nseindia.com/api/fiidiiTradeReact');

      // NSE returns an array: [{ category, buyValue, sellValue, netValue, date }, ...]
      // Categories: "FII/FPI", "DII"
      const rows = Array.isArray(raw) ? raw : (raw.data || []);

      const fii = rows.find(r => r.category && r.category.includes('FII')) || {};
      const dii = rows.find(r => r.category && r.category.includes('DII')) || {};

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
        date:        fii.date || fii.DATE || new Date().toISOString().slice(0,10),
        fii: {
          buy:    fiiBuy,  sell:   fiiSell, net:    fiiNet,
          signal: signalFromNet(fiiNet),
          label:  'FII/FPI (Foreign)',
        },
        dii: {
          buy:    diiBuy,  sell:   diiSell, net:    diiNet,
          signal: signalFromNet(diiNet),
          label:  'DII (Domestic)',
        },
        combined: {
          net:         fiiNet + diiNet,
          signal:      signalFromNet(fiiNet + diiNet),
          divergence,
        },
        raw,
        fetchedAt: new Date().toISOString(),
        source:    'NSE India (provisional)',
      };
    });
    res.json({ ok: true, data });
  } catch (err) {
    console.error('fii-dii error:', err.message);
    res.status(500).json({ ok: false, error: err.message, fallback: true });
  }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE: /api/fii-dii/history  →  Last 30 days
// ─────────────────────────────────────────────────────────────────
app.get('/api/fii-dii/history', async (req, res) => {
  try {
    const data = await cached('fii-dii-history', async () => {
      // NSE historical FII/DII endpoint
      const url = 'https://www.nseindia.com/api/historical/fiiDii';
      const raw = await nseFetch(url);
      const rows = Array.isArray(raw) ? raw : (raw.data || []);

      return rows.slice(0, 30).map(r => {
        const fiiNet = parseNetValue(r.fiiNet || r.FII_NET || r.netValueFii);
        const diiNet = parseNetValue(r.diiNet || r.DII_NET || r.netValueDii);
        return {
          date:    r.date || r.DATE || r.tradingDate,
          fiiNet,  diiNet,
          fiiSignal: signalFromNet(fiiNet).label,
          diiSignal: signalFromNet(diiNet).label,
        };
      });
    });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE: /api/fno  →  FII F&O positions
// ─────────────────────────────────────────────────────────────────
app.get('/api/fno', async (req, res) => {
  try {
    const data = await cached('fno', async () => {
      const raw = await nseFetch('https://www.nseindia.com/api/fii-statistics');
      return { raw, fetchedAt: new Date().toISOString() };
    });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE: /api/bulk-deals  →  Today's bulk deals
// ─────────────────────────────────────────────────────────────────
app.get('/api/bulk-deals', async (req, res) => {
  try {
    const data = await cached('bulk-deals', async () => {
      const raw = await nseFetch('https://www.nseindia.com/api/snapshot-capital-market-mostactive-bulkdeals');
      return { deals: raw.data || raw || [], fetchedAt: new Date().toISOString() };
    });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE: /api/block-deals  →  NSE block deals
// ─────────────────────────────────────────────────────────────────
app.get('/api/block-deals', async (req, res) => {
  try {
    const data = await cached('block-deals', async () => {
      const raw = await nseFetch('https://www.nseindia.com/api/block-deal');
      return { deals: raw.data || raw || [], fetchedAt: new Date().toISOString() };
    });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE: /api/india-vix  →  India VIX
// ─────────────────────────────────────────────────────────────────
app.get('/api/india-vix', async (req, res) => {
  try {
    const data = await cached('india-vix', async () => {
      const raw = await nseFetch('https://www.nseindia.com/api/allIndices');
      const indices = raw.data || [];
      const vix = indices.find(i => i.indexSymbol === 'INDIA VIX');
      return {
        value:   vix ? parseFloat(vix.last) : null,
        change:  vix ? parseFloat(vix.percentChange) : null,
        signal:  vix ? (parseFloat(vix.last) > 20 ? 'High Fear — caution' : parseFloat(vix.last) < 13 ? 'Low Fear — complacency' : 'Normal range') : 'Unknown',
        fetchedAt: new Date().toISOString(),
      };
    });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE: /api/market-status
// ─────────────────────────────────────────────────────────────────
app.get('/api/market-status', async (req, res) => {
  try {
    const data = await cached('market-status', async () => {
      const raw = await nseFetch('https://www.nseindia.com/api/marketStatus');
      return { ...raw, fetchedAt: new Date().toISOString() };
    });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE: /health
// ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    service: 'Signal Tracker Pro — FII/DII Proxy',
    version: '1.0.0',
    uptime:  Math.round(process.uptime()) + 's',
    cached:  cache.size + ' endpoints cached',
    time:    new Date().toISOString(),
  });
});

app.get('/', (req, res) => {
  res.json({
    name:      'Signal Tracker Pro — FII/DII Backend',
    endpoints: ['/api/fii-dii', '/api/fii-dii/history', '/api/fno', '/api/bulk-deals', '/api/block-deals', '/api/india-vix', '/api/market-status', '/health'],
    docs:      'Each endpoint returns { ok: true, data: {...} }',
  });
});

app.listen(PORT, () => {
  console.log('FII/DII Proxy running on port', PORT);
  console.log('Endpoints: /api/fii-dii  /api/fii-dii/history  /api/fno  /api/bulk-deals  /api/block-deals  /api/india-vix');
});
