const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');

const app = express();
app.set('trust proxy', 1);

// CORS nastavitve
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

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
        fail(res, 401, 'Napačno geslo.');
        return false;
    }
    return true;
}

// ---------- BYBIT KLICI ----------
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

// VARNO PRIDOBIVANJE PODATKOV O PARU (VARNO PRED lotSizeFilter UNDEFINED)
const instCache = new Map();
async function getInstrument(symbol) {
    const c = instCache.get(symbol);
    if (c && Date.now() - c.ts < 10 * 60 * 1000) return c.val;

    const r = await publicGet('/v5/market/instruments-info', `category=spot&symbol=${symbol}`);
    const item = r.ok && r.result?.list?.[0] ? r.result.list[0] : null;

    if (!item) {
        return {
            symbol,
            baseCoin: symbol.replace('USDT', ''),
            quoteCoin: 'USDT',
            basePrecision: '0.000001',
            quotePrecision: '0.000001'
        };
    }

    const val = {
        symbol,
        baseCoin: item.baseCoin,
        quoteCoin: item.quoteCoin,
        basePrecision: item.lotSizeFilter?.basePrecision || '0.000001',
        quotePrecision: item.lotSizeFilter?.quotePrecision || '0.000001'
    };
    instCache.set(symbol, { ts: Date.now(), val });
    return val;
}

// ---------- STANJA IN PRENOS ----------
async function loadWallet(accountType) {
    const r = await bybit('GET', '/v5/account/wallet-balance', { query: `accountType=${accountType}` });
    if (!r.ok) return { ok: false, coins: [] };
    const coins = (r.result?.list?.[0]?.coin || []).map(c => ({ coin: c.coin, account: accountType, total: num(c.walletBalance), free: Math.max(0, num(c.walletBalance) - num(c.locked)) }));
    return { ok: true, coins, totalEquity: num(r.result?.list?.[0]?.totalEquity) };
}

async function loadFunding() {
    const r = await bybit('GET', '/v5/asset/transfer/query-account-coins-balance', { query: 'accountType=FUND' });
    if (!r.ok) return { ok: false, coins: [] };
    const coins = (r.result?.balance || []).map(c => ({ coin: c.coin, account: 'FUND', total: num(c.walletBalance), free: num(c.transferBalance || c.walletBalance) }));
    return { ok: true, coins };
}

async function ensureCoin(coin, need, toAccount = 'UNIFIED') {
    const fromAccount = toAccount === 'UNIFIED' ? 'FUND' : 'UNIFIED';
    const toWallet = await loadWallet(toAccount);
    const freeInTo = (toWallet.coins || []).filter(c => c.coin === coin).reduce((s, c) => s + c.free, 0);
    const shortfall = need - freeInTo;
    
    if (shortfall <= 0) return true;

    const fromWallet = fromAccount === 'FUND' ? await loadFunding() : await loadWallet('UNIFIED');
    const freeInFrom = (fromWallet.coins || []).filter(c => c.coin === coin).reduce((s, c) => s + c.free, 0);
    
    if (freeInFrom < shortfall) return false;

    const amount = fmt8(Math.min(shortfall, freeInFrom));
    const t = await bybit('POST', '/v5/asset/transfer/inter-transfer', { 
        body: { transferId: crypto.randomUUID(), coin, amount, fromAccountType: fromAccount, toAccountType: toAccount } 
    });
    await wait(600);
    return t.ok;
}

// ---------- INDIKATORJI ----------
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

app.post('/api/balance', async (req, res) => {
    try {
        if (!checkAuth(req, res)) return;
        const [uni, fund] = await Promise.all([loadWallet('UNIFIED'), loadFunding()]);
        const coins = [...(uni.coins || []), ...(fund.coins || [])].filter(c => c.total > 0);
        return ok(res, { totalEquity: uni.totalEquity || 0, coins });
    } catch (err) {
        return fail(res, -500, err.message);
    }
});

app.post('/api/analyze', async (req, res) => {
    try {
        if (!checkAuth(req, res)) return;
        const totalBudget = num(req.body?.totalAmount) || 26;
        const tickers = await publicGet('/v5/market/tickers', 'category=spot');
        
        if (!tickers.ok) return fail(res, -1, 'Ni mogoče pridobiti cen');

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
    } catch (err) {
        return fail(res, -500, err.message);
    }
});

// HITRO TRGOVANJE - POTPOVOLNO VAROVANO PRED `lotSizeFilter` NAPAKAMI
app.post('/api/trade', async (req, res) => {
    try {
        if (!checkAuth(req, res)) return;
        const symbol = cleanSymbol(req.body?.symbol);
        const side = String(req.body?.side || '');
        const amount = num(req.body?.amount);

        if (!symbol || (side !== 'Buy' && side !== 'Sell') || amount <= 0) {
            return fail(res, -422, 'Neveljavni podatki za naročilo.');
        }

        const inst = await getInstrument(symbol);
        const tk = await publicGet('/v5/market/tickers', `category=spot&symbol=${symbol}`);
        const price = num(tk.result?.list?.[0]?.lastPrice);

        if (!price) return fail(res, -406, 'Cene ni mogoče pridobiti.');

        if (side === 'Buy') {
            const qtyQuote = floorToStep(amount, inst.quotePrecision);
            await ensureCoin('USDT', num(qtyQuote), 'UNIFIED');
            const order = await bybit('POST', '/v5/order/create', { 
                body: { category: 'spot', symbol, side: 'Buy', orderType: 'Market', qty: qtyQuote, marketUnit: 'quoteCoin' } 
            });
            return order.ok ? ok(res, order.result, `KUPLJENO ${symbol}`) : fail(res, order.code, order.message);
        } else {
            // PRODAJA: Preveri prosta sredstva na UNIFIED in FUNDING
            const baseCoin = inst.baseCoin;
            const [uni, fund] = await Promise.all([loadWallet('UNIFIED'), loadFunding()]);
            let freeUni = (uni.coins || []).filter(c => c.coin === baseCoin).reduce((s, c) => s + c.free, 0);
            let freeFund = (fund.coins || []).filter(c => c.coin === baseCoin).reduce((s, c) => s + c.free, 0);
            
            let totalFree = freeUni + freeFund;
            if (totalFree <= 0) {
                return fail(res, -432, `Nimate ${baseCoin} na računu za prodajo.`);
            }

            // Če so kovaneci na FUNDING računu, jih samodejno prenesemo na UNIFIED
            if (freeUni <= 0 && freeFund > 0) {
                await ensureCoin(baseCoin, freeFund, 'UNIFIED');
                freeUni = freeFund;
            }

            const qtyBase = floorToStep(Math.min(freeUni, amount / price), inst.basePrecision);
            const order = await bybit('POST', '/v5/order/create', { 
                body: { category: 'spot', symbol, side: 'Sell', orderType: 'Market', qty: qtyBase, marketUnit: 'baseCoin' } 
            });
            return order.ok ? ok(res, order.result, `PRODANO ${symbol}`) : fail(res, order.code, order.message);
        }
    } catch (err) {
        return fail(res, -500, `Lokalna napaka strežnika: ${err.message}`);
    }
});

// VAROVALO PRED DOCTYPE / HTML NAPAKAMI
app.use('*', (req, res) => {
    res.status(404).json({ status: 'error', code: 404, message: 'API pot ne obstaja.', data: null });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 STREŽNIK TEČE NA PORTU ${PORT}`));
