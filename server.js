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
    if (!candles || candles.length < 20) return { signal: 'HOLD', score: 0, reasons: ['Osvežujem indikatorje...'] };
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

// ZAGOTOVLJEN PRIKAZ 5 PAROV (Z REZERVNO LISTO)
app.post('/api/analyze', async (req, res) => {
    try {
        if (!checkAuth(req, res)) return;
        const totalBudget = num(req.body?.totalAmount) || 25;
        
        const tickers = await publicGet('/v5/market/tickers', 'category=linear');
        let symbols = [];

        if (tickers.ok && tickers.result?.list) {
            symbols = tickers.result.list
                .filter(t => t.symbol.endsWith('USDT'))
                .sort((a, b) => parseFloat(b.turnover24h || 0) - parseFloat(a.turnover24h || 0))
                .slice(0, 5)
                .map(t => ({ symbol: t.symbol, lastPrice: num(t.lastPrice), change24h: (num(t.price24hPcnt) * 100).toFixed(2) }));
        }

        // Rezervni plan, če API ne vrne seznamov – da ne ostane prazno!
        if (!symbols.length) {
            symbols = [
                { symbol: 'BTCUSDT', lastPrice: 0, change24h: '0.00' },
                { symbol: 'ETHUSDT', lastPrice: 0, change24h: '0.00' },
                { symbol: 'SOLUSDT', lastPrice: 0, change24h: '0.00' },
                { symbol: 'XRPUSDT', lastPrice: 0, change24h: '0.00' },
                { symbol: 'ADAUSDT', lastPrice: 0, change24h: '0.00' }
            ];
        }

        const posRes = await bybit('GET', '/v5/position/list', { query: 'category=linear&settleCoin=USDT' });
        const openPositions = posRes.ok ? (posRes.result?.list || []) : [];

        const items = await Promise.all(symbols.map(async (s) => {
            let price = s.lastPrice;
            let chg = s.change24h;

            if (price === 0) {
                const tk = await publicGet('/v5/market/tickers', `category=linear&symbol=${s.symbol}`);
                if (tk.ok && tk.result?.list?.[0]) {
                    price = num(tk.result.list[0].lastPrice);
                    chg = (num(tk.result.list[0].price24hPcnt) * 100).toFixed(2);
                }
            }

            const kline = await publicGet('/v5/market/kline', `category=linear&symbol=${s.symbol}&interval=1&limit=40`);
            const candles = kline.ok ? kline.result.list.slice().reverse().map(k => ({ c: num(k[4]) })) : [];
            const ai = analyze(candles);

            const pos = openPositions.find(p => p.symbol === s.symbol && num(p.size) > 0);

            return {
                symbol: s.symbol,
                lastPrice: price,
                change24h: chg,
                hasPosition: !!pos,
                positionSide: pos ? pos.side : null,
                positionSize: pos ? pos.size : 0,
                pnl: pos ? num(pos.unrealisedPnl).toFixed(2) : 0,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 STREŽNIK TEČE NA PORTU ${PORT}`));
