const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const BYBIT_URL = (process.env.BYBIT_BASE_URL || 'https://api.bybit.com').trim();
const API_KEY = (process.env.BYBIT_API_KEY || '').trim();
const API_SECRET = (process.env.BYBIT_API_SECRET || '').trim();
const APP_PASSWORD = (process.env.APP_PASSWORD || '').trim();
const RECV_WINDOW = '10000';

// ---------- POMOČNIKI ----------
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const wait = ms => new Promise(r => setTimeout(r, ms));
const fmt8 = n => n.toFixed(8).replace(/\.?0+$/, '');
const cleanSymbol = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const ok = (res, data, message = 'OK') => res.json({ status: 'success', code: 0, message, data });
const fail = (res, code, message, data = null) => res.json({ status: 'error', code, message, data });

function floorToStep(value, step) {
    const st = num(step);
    if (!st) return String(value);
    let d = 0;
    while (d < 12 && Math.abs(st * 10 ** d - Math.round(st * 10 ** d)) > 1e-9) d++;
    return (Math.floor(value / st + 1e-9) * st).toFixed(d);
}

// ---------- OVERJANJE GESLA ----------
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
function checkAuth(req, res) {
    const sent = String(req.body?.password || '').trim();
    if (APP_PASSWORD.length > 0 && !crypto.timingSafeEqual(sha(sent), sha(APP_PASSWORD))) {
        res.status(401).json({ status: 'error', code: 401, message: 'Napačno geslo.', data: null });
        return false;
    }
    return true;
}

// ---------- BYBIT V5 KLICI ----------
async function bybit(method, apiPath, { query = '', body = null } = {}) {
    const timestamp = Date.now().toString();
    const bodyStr = body ? JSON.stringify(body) : '';
    const payload = method === 'GET' ? query : bodyStr;
    const signature = crypto.createHmac('sha256', API_SECRET).update(timestamp + API_KEY + RECV_WINDOW + payload).digest('hex');
    const headers = { 
        'X-BAPI-API-KEY': API_KEY, 
        'X-BAPI-SIGN': signature, 
        'X-BAPI-TIMESTAMP': timestamp, 
        'X-BAPI-RECV-WINDOW': RECV_WINDOW 
    };
    const url = `${BYBIT_URL}${apiPath}${method === 'GET' && query ? '?' + query : ''}`;
    let response = method === 'GET' 
        ? await axios.get(url, { headers, timeout: 15000, validateStatus: () => true })
        : await axios.post(url, bodyStr, { headers: { ...headers, 'Content-Type': 'application/json' }, timeout: 15000, validateStatus: () => true });
    
    return response.data?.retCode === 0 ? { ok: true, result: response.data.result } : { ok: false, code: response.data?.retCode || -1, message: response.data?.retMsg || 'Napaka Bybit API' };
}

async function publicGet(apiPath, query = '') {
    const url = `${BYBIT_URL}${apiPath}${query ? '?' + query : ''}`;
    const response = await axios.get(url, { timeout: 15000, validateStatus: () => true });
    return response.data?.retCode === 0 ? { ok: true, result: response.data.result } : { ok: false, message: response.data?.retMsg || 'Napaka API' };
}

// ---------- STANJA IN SAMODEJNI PRENOS ----------
async function loadWallet(accountType) {
    const r = await bybit('GET', '/v5/account/wallet-balance', { query: `accountType=${accountType}` });
    if (!r.ok) return { ok: false };
    const coins = (r.result?.list?.[0]?.coin || []).map(c => ({ coin: c.coin, account: accountType, total: num(c.walletBalance), free: Math.max(0, num(c.walletBalance) - num(c.locked)) }));
    return { ok: true, coins, totalEquity: num(r.result?.list?.[0]?.totalEquity) };
}

async function loadFunding() {
    const r = await bybit('GET', '/v5/asset/transfer/query-account-coins-balance', { query: 'accountType=FUND' });
    if (!r.ok) return { ok: false };
    const coins = (r.result?.balance || []).map(c => ({ coin: c.coin, account: 'FUND', total: num(c.walletBalance), free: num(c.transferBalance || c.walletBalance) }));
    return { ok: true, coins };
}

async function ensureQuote(coin, need) {
    const [uni, fund] = await Promise.all([loadWallet('UNIFIED'), loadFunding()]);
    const uniFree = (uni.coins || []).filter(c => c.coin === coin).reduce((s, c) => s + c.free, 0);
    const shortfall = need - uniFree;
    if (shortfall <= 0) return true;
    const fundFree = (fund.coins || []).filter(c => c.coin === coin).reduce((s, c) => s + c.free, 0);
    if (fundFree < shortfall) return false;
    const amount = fmt8(Math.min(shortfall, fundFree));
    const t = await bybit('POST', '/v5/asset/transfer/inter-transfer', { body: { transferId: crypto.randomUUID(), coin, amount, fromAccountType: 'FUND', toAccountType: 'UNIFIED' } });
    await wait(500);
    return t.ok;
}

// ---------- INDIKATORJI IN AI ANALIZA ----------
function emaSeries(values, p) {
    const k = 2 / (p + 1); const out = [values[0]];
    for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
    return out;
}

function rsiLast(closes, p = 14) {
    if (closes.length <= p) return 50;
    let g = 0, l = 0;
    for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
    let ag = g / p, al = l / p;
    for (let i = p + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        ag = (ag * (p - 1) + Math.max(d, 0)) / p; al = (al * (p - 1) + Math.max(-d, 0)) / p;
    }
    return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function analyze(candles) {
    if (candles.length < 30) return { signal: 'HOLD', score: 0, reasons: ['Čakam podatke...'] };
    const closes = candles.map(c => c.c);
    const e9 = emaSeries(closes, 9), e21 = emaSeries(closes, 21);
    const rsi = rsiLast(closes, 14);
    let score = 0; const reasons = [];

    if (e9[e9.length - 1] > e21[e21.length - 1]) { score += 2; reasons.push('EMA rast'); }
    else { score -= 2; reasons.push('EMA padanje'); }

    if (rsi < 35) { score += 3; reasons.push(`RSI preprodano (${rsi.toFixed(0)})`); }
    else if (rsi > 65) { score -= 3; reasons.push(`RSI prekupljeno (${rsi.toFixed(0)})`); }

    const signal = score >= 2 ? 'BUY' : score <= -2 ? 'SELL' : 'HOLD';
    return { signal, score, rsi: Math.round(rsi), reasons };
}

// ====================== API ROUTE ======================

// PRIDOBIVANJE STANJA
app.post('/api/balance', async (req, res) => {
    if (!checkAuth(req, res)) return;
    const [uni, fund] = await Promise.all([loadWallet('UNIFIED'), loadFunding()]);
    const coins = [...(uni.coins || []), ...(fund.coins || [])].filter(c => c.total > 0);
    return ok(res, { totalEquity: uni.totalEquity || 0, coins });
});

// AI SKENER: SAMODEJNO SKENIRA TOP 5 PAROV NA BYBITU
app.post('/api/analyze', async (req, res) => {
    if (!checkAuth(req, res)) return;
    const totalBudget = num(req.body?.totalAmount) || 26;
    const tickers = await publicGet('/v5/market/tickers', 'category=spot');
    
    if (!tickers.ok) return fail(res, -1, 'Ni mogoče pridobiti cen z Bybita');

    const top5 = tickers.result.list
        .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('USDC'))
        .sort((a, b) => parseFloat(b.turnover24h || 0) - parseFloat(a.turnover24h || 0))
        .slice(0, 5);

    const amountPerSymbol = (totalBudget / 5).toFixed(2);

    const items = await Promise.all(top5.map(async (t) => {
        const kline = await publicGet('/v5/market/kline', `category=spot&symbol=${t.symbol}&interval=1&limit=60`);
        const candles = kline.ok ? kline.result.list.slice().reverse().map(k => ({ c: num(k[4]) })) : [];
        const ai = analyze(candles);
        return {
            symbol: t.symbol,
            lastPrice: num(t.lastPrice),
            change24h: (num(t.price24hPcnt) * 100).toFixed(2),
            ...ai
        };
    }));

    return ok(res, { items, amountPerSymbol, ts: Date.now() });
});

// TRGOVANJE: KUPI / PRODAJ Z ENIM KLIKOM
app.post('/api/trade', async (req, res) => {
    if (!checkAuth(req, res)) return;
    const symbol = cleanSymbol(req.body?.symbol);
    const side = String(req.body?.side || '');
    const amount = num(req.body?.amount);

    const inst = await publicGet('/v5/market/instruments-info', `category=spot&symbol=${symbol}`);
    if (!inst.ok) return fail(res, -404, 'Par ni najden');
    
    const filter = inst.result.list[0].lotSizeFilter;
    const tk = await publicGet('/v5/market/tickers', `category=spot&symbol=${symbol}`);
    const price = num(tk.result?.list?.[0]?.lastPrice);

    if (side === 'Buy') {
        const qtyQuote = floorToStep(amount, filter.quotePrecision);
        await ensureQuote('USDT', num(qtyQuote));
        const order = await bybit('POST', '/v5/order/create', { 
            body: { category: 'spot', symbol, side: 'Buy', orderType: 'Market', qty: qtyQuote, marketUnit: 'quoteCoin' } 
        });
        return order.ok ? ok(res, order.result, `KUPLJENO ${symbol}`) : fail(res, order.code, order.message);
    } else {
        const uni = await loadWallet('UNIFIED');
        const baseCoin = inst.result.list[0].baseCoin;
        const free = (uni.coins || []).filter(c => c.coin === baseCoin).reduce((s, c) => s + c.free, 0);
        const qtyBase = floorToStep(Math.min(free, amount / price), filter.basePrecision);
        const order = await bybit('POST', '/v5/order/create', { 
            body: { category: 'spot', symbol, side: 'Sell', orderType: 'Market', qty: qtyBase, marketUnit: 'baseCoin' } 
        });
        return order.ok ? ok(res, order.result, `PRODANO ${symbol}`) : fail(res, order.code, order.message);
    }
});

app.use('/api', (req, res) => res.status(404).json({ status: 'error', message: 'Neznana pot.' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 STREŽNIK TEČE NA PORTU ${PORT}`));
