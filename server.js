const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');

const app = express();
app.set('trust proxy', 1);

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

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
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

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
function checkAuth(req, res) {
    const sent = String(req.body?.password || '').trim();
    if (APP_PASSWORD.length > 0 && !crypto.timingSafeEqual(sha(sent), sha(APP_PASSWORD))) {
        fail(res, 401, 'Napačno geslo.');
        return false;
    }
    return true;
}

async function bybit(method, apiPath, { query = '', body = null } = {}) {
    try {
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
            ? await axios.get(url, { headers, timeout: 10000, validateStatus: () => true })
            : await axios.post(url, bodyStr, { headers: { ...headers, 'Content-Type': 'application/json' }, timeout: 10000, validateStatus: () => true });
        
        return response.data?.retCode === 0 ? { ok: true, result: response.data.result } : { ok: false, code: response.data?.retCode || -1, message: response.data?.retMsg || 'Napaka Bybit API' };
    } catch (e) {
        return { ok: false, code: -500, message: e.message };
    }
}

async function publicGet(apiPath, query = '') {
    try {
        const url = `${BYBIT_URL}${apiPath}${query ? '?' + query : ''}`;
        const response = await axios.get(url, { timeout: 10000, validateStatus: () => true });
        return response.data?.retCode === 0 ? { ok: true, result: response.data.result } : { ok: false, message: response.data?.retMsg || 'Napaka API' };
    } catch (e) {
        return { ok: false, message: e.message };
    }
}

function emaSeries(values, p) {
    if (!values || !values.length) return [0];
    const k = 2 / (p + 1); const out = [values[0]];
    for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
    return out;
}

function rsiLast(closes, p = 14) {
    if (!closes || closes.length <= p) return 50;
    let g = 0, l = 0;
    for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
    let ag = g / p, al = l / p;
    for (let i = p + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        ag = (ag * (p - 1) + Math.max(d, 0)) / p; al = (al * (p - 1) + Math.max(-d, 0)) / p;
    }
    return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function analyze(candles, currentPrice) {
    const closes = (candles && candles.length) ? candles.map(c => c.c) : [];
    if (currentPrice > 0) closes.push(currentPrice);

    if (closes.length < 5) {
        return { signal: 'HOLD', score: 0, rsi: 50, reasons: ['Čakam na več trgovalnih podatkov...'] };
    }

    const e9 = emaSeries(closes, Math.min(9, closes.length));
    const e21 = emaSeries(closes, Math.min(21, closes.length));
    const rsi = rsiLast(closes, Math.min(14, closes.length - 1));
    
    let score = 0; 
    const reasons = [];

    const lastE9 = e9[e9.length - 1];
    const lastE21 = e21[e21.length - 1];

    if (lastE9 > lastE21) { 
        score += 2; 
        reasons.push('EMA trend rast'); 
    } else { 
        score -= 2; 
        reasons.push('EMA trend padanje'); 
    }

    if (rsi < 40) { 
        score += 3; 
        reasons.push(`RSI preprodano (${rsi.toFixed(0)})`); 
    } else if (rsi > 60) { 
        score -= 3; 
        reasons.push(`RSI prekupljeno (${rsi.toFixed(0)})`); 
    } else {
        reasons.push(`RSI nevtralen (${rsi.toFixed(0)})`);
    }

    const signal = score >= 2 ? 'BUY' : score <= -2 ? 'SELL' : 'HOLD';
    return { signal, score, rsi: Math.round(rsi), reasons };
}

app.post('/api/balance', async (req, res) => {
    try {
        if (!checkAuth(req, res)) return;
        const r = await bybit('GET', '/v5/account/wallet-balance', { query: 'accountType=UNIFIED' });
        const coins = (r.result?.list?.[0]?.coin || []).map(c => ({
            coin: c.coin, account: 'UNIFIED', total: num(c.walletBalance), free: num(c.equity)
        }));
        return ok(res, { totalEquity: num(r.result?.list?.[0]?.totalEquity), coins });
    } catch (err) {
        return fail(res, -500, err.message);
    }
});

// STABILEN PRIKAZ REALNIH CEN IN AI SIGNALOV
app.post('/api/analyze', async (req, res) => {
    try {
        if (!checkAuth(req, res)) return;
        const totalBudget = num(req.body?.totalAmount) || 25;
        
        let tickers = await publicGet('/v5/market/tickers', 'category=linear');
        let category = 'linear';

        if (!tickers.ok || !tickers.result?.list) {
            tickers = await publicGet('/v5/market/tickers', 'category=spot');
            category = 'spot';
        }

        let top5 = [];
        if (tickers.ok && Array.isArray(tickers.result?.list)) {
            top5 = tickers.result.list
                .filter(t => t.symbol && t.symbol.endsWith('USDT') && !t.symbol.includes('USDC'))
                .sort((a, b) => num(b.turnover24h) - num(a.turnover24h))
                .slice(0, 5);
        }

        if (!top5.length) {
            const fallbackSymbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT'];
            top5 = fallbackSymbols.map(s => ({ symbol: s, lastPrice: '0', price24hPcnt: '0' }));
        }

        const posRes = await bybit('GET', '/v5/position/list', { query: 'category=linear&settleCoin=USDT' });
        const openPositions = (posRes.ok && Array.isArray(posRes.result?.list)) ? posRes.result.list : [];

        const items = await Promise.all(top5.map(async (t) => {
            const symbol = t.symbol;
            let lastPrice = num(t.lastPrice);
            let change24h = (num(t.price24hPcnt) * 100).toFixed(2);

            if (lastPrice === 0) {
                const singleTk = await publicGet('/v5/market/tickers', `category=${category}&symbol=${symbol}`);
                if (singleTk.ok && singleTk.result?.list?.[0]) {
                    lastPrice = num(singleTk.result.list[0].lastPrice);
                    change24h = (num(singleTk.result.list[0].price24hPcnt) * 100).toFixed(2);
                }
            }

            const kline = await publicGet('/v5/market/kline', `category=${category}&symbol=${symbol}&interval=1&limit=30`);
            const candles = (kline.ok && Array.isArray(kline.result?.list)) 
                ? kline.result.list.slice().reverse().map(k => ({ c: num(k[4]) })) 
                : [];

            const ai = analyze(candles, lastPrice);
            const pos = openPositions.find(p => p.symbol === symbol && num(p.size) > 0);

            return {
                symbol,
                lastPrice,
                change24h,
                hasPosition: !!pos,
                positionSide: pos ? pos.side : null,
                positionSize: pos ? pos.size : 0,
                pnl: pos ? num(pos.unrealisedPnl).toFixed(2) : '0.00',
                ...ai
            };
        }));

        return ok(res, { items, fullAmount: totalBudget, ts: Date.now() });
    } catch (err) {
        return fail(res, -500, err.message);
    }
});

app.post('/api/trade', async (req, res) => {
    try {
        if (!checkAuth(req, res)) return;
        const symbol = cleanSymbol(req.body?.symbol);
        const side = String(req.body?.side || '');
        const amount = num(req.body?.amount);
        const action = String(req.body?.action || 'open');

        if (!symbol || (side !== 'Buy' && side !== 'Sell')) {
            return fail(res, -422, 'Neveljavni podatki za naročilo.');
        }

        const inst = await publicGet('/v5/market/instruments-info', `category=linear&symbol=${symbol}`);
        const filter = inst.result?.list?.[0]?.lotSizeFilter;
        const qtyStep = filter?.qtyStep || '0.001';

        const tk = await publicGet('/v5/market/tickers', `category=linear&symbol=${symbol}`);
        const price = num(tk.result?.list?.[0]?.lastPrice);
        if (!price) return fail(res, -406, 'Cene ni mogoče pridobiti.');

        if (action === 'close') {
            const posRes = await bybit('GET', '/v5/position/list', { query: `category=linear&symbol=${symbol}` });
            const pos = posRes.result?.list?.[0];
            if (!pos || num(pos.size) <= 0) return fail(res, -404, 'Pozicija ne obstaja ali je že zaprta.');

            const closeSide = pos.side === 'Buy' ? 'Sell' : 'Buy';
            const order = await bybit('POST', '/v5/order/create', {
                body: { category: 'linear', symbol, side: closeSide, orderType: 'Market', qty: pos.size, reduceOnly: true }
            });
            return order.ok ? ok(res, order.result, `Trade ${symbol} ZAPRT! Dobiček obračunan.`) : fail(res, order.code, order.message);
        } else {
            const qtyBase = floorToStep(amount / price, qtyStep);
            const order = await bybit('POST', '/v5/order/create', {
                body: { category: 'linear', symbol, side, orderType: 'Market', qty: qtyBase }
            });
            const tip = side === 'Buy' ? 'BUY (LONG)' : 'SELL (SHORT)';
            return order.ok ? ok(res, order.result, `Trade ${tip} za ${symbol} uspešno ODPRT!`) : fail(res, order.code, order.message);
        }
    } catch (err) {
        return fail(res, -500, `Napaka strežnika: ${err.message}`);
    }
});

app.use('*', (req, res) => {
    res.status(404).json({ status: 'error', code: 404, message: 'API pot ne obstaja.', data: null });
});

process.on('uncaughtException', (err) => {
    console.error('Zaščiteno pred zrušitvijo:', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('Zaščiteno pred zrušitvijo:', reason);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 STREŽNIK TEČE NA PORTU ${PORT}`));
