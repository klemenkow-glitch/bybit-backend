const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Pomočniki ----------
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const wait = ms => new Promise(r => setTimeout(r, ms));
const fmt8 = n => Number(n).toFixed(8).replace(/\.?0+$/, '');
const cleanSymbol = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const validSymbol = s => /^[A-Z0-9]{5,20}$/.test(s);
const freeOf = (coins, coin) => coins.filter(c => c.coin === coin).reduce((s, c) => s + c.free, 0);

const BYBIT_URL = (process.env.BYBIT_BASE_URL || 'https://api.bybit.eu').trim();
const API_KEY = (process.env.BYBIT_API_KEY || '').trim();
const API_SECRET = (process.env.BYBIT_API_SECRET || '').trim();
const APP_PASSWORD = (process.env.APP_PASSWORD || '').trim();
const MAX_ORDER_AMOUNT = num(process.env.MAX_ORDER_AMOUNT); // 0 = brez omejitve
const RECV_WINDOW = '10000';

const ok = (res, data, message = 'OK') => res.json({ status: 'success', code: 0, message, data });
const fail = (res, code, message, data = null) => res.json({ status: 'error', code, message, data });

function floorToStep(value, step) {
    const st = num(step);
    if (!st) return String(value);
    let d = 0;
    while (d < 12 && Math.abs(st * 10 ** d - Math.round(st * 10 ** d)) > 1e-9) d++;
    return (Math.floor(value / st + 1e-9) * st).toFixed(d);
}

// ---------- Geslo: zaklep po 5 napačnih poskusih za 15 minut ----------
const fails = new Map();
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const sha = s => crypto.createHash('sha256').update(String(s)).digest();

function checkAuth(req, res) {
    if (!APP_PASSWORD) {
        res.status(503).json({ status: 'error', code: 503, message: 'APP_PASSWORD ni nastavljen na strežniku.', data: null });
        return false;
    }
    const ip = req.ip;
    const rec = fails.get(ip) || { count: 0, lockUntil: 0 };
    if (rec.lockUntil > Date.now()) {
        const min = Math.ceil((rec.lockUntil - Date.now()) / 60000);
        res.status(429).json({ status: 'error', code: 429, message: `Preveč napačnih poskusov. Poskusite čez ${min} min.`, data: null });
        return false;
    }
    const sent = String(req.body?.password || '').trim();
    if (!crypto.timingSafeEqual(sha(sent), sha(APP_PASSWORD))) {
        rec.count += 1;
        if (rec.count >= MAX_FAILS) { rec.lockUntil = Date.now() + LOCK_MS; rec.count = 0; }
        fails.set(ip, rec);
        res.status(401).json({ status: 'error', code: 401, message: 'Napačno geslo.', data: null });
        return false;
    }
    fails.delete(ip);
    return true;
}

function keysMissing(res) {
    if (!API_KEY || !API_SECRET) {
        fail(res, -400, 'Na strežniku manjkata BYBIT_API_KEY / BYBIT_API_SECRET.');
        return true;
    }
    return false;
}

// ---------- Bybit klici ----------
function snippet(body) {
    try {
        const s = typeof body === 'string' ? body : JSON.stringify(body);
        return (s || '(prazno)').replace(/\s+/g, ' ').slice(0, 160);
    } catch { return '(ni berljivo)'; }
}

function parseReply(response) {
    const data = response.data;
    if (!data || typeof data !== 'object') {
        return { ok: false, code: response.status, message: `Bybit ni vrnil JSON (HTTP ${response.status}). ${snippet(data)}` };
    }
    if (data.retCode === 0) return { ok: true, result: data.result };
    return { ok: false, code: data.retCode ?? -1, message: data.retMsg || 'Napaka Bybit API' };
}

async function bybit(method, apiPath, { query = '', body = null } = {}) {
    try {
        const timestamp = Date.now().toString();
        const bodyStr = body ? JSON.stringify(body) : '';
        const payload = method === 'GET' ? query : bodyStr;
        const signature = crypto.createHmac('sha256', API_SECRET)
            .update(timestamp + API_KEY + RECV_WINDOW + payload).digest('hex');
        const headers = {
            'X-BAPI-API-KEY': API_KEY,
            'X-BAPI-SIGN': signature,
            'X-BAPI-TIMESTAMP': timestamp,
            'X-BAPI-RECV-WINDOW': RECV_WINDOW
        };
        const url = `${BYBIT_URL}${apiPath}${method === 'GET' && query ? '?' + query : ''}`;
        const response = method === 'GET'
            ? await axios.get(url, { headers, timeout: 15000, validateStatus: () => true })
            : await axios.post(url, bodyStr, { headers: { ...headers, 'Content-Type': 'application/json' }, timeout: 15000, validateStatus: () => true });
        return parseReply(response);
    } catch (e) {
        return { ok: false, code: -500, message: e.message };
    }
}

async function publicGet(apiPath, query = '') {
    try {
        const url = `${BYBIT_URL}${apiPath}${query ? '?' + query : ''}`;
        const response = await axios.get(url, { timeout: 15000, validateStatus: () => true });
        return parseReply(response);
    } catch (e) {
        return { ok: false, code: -500, message: e.message };
    }
}

// ---------- Stanja ----------
async function loadWallet() {
    const r = await bybit('GET', '/v5/account/wallet-balance', { query: 'accountType=UNIFIED' });
    if (!r.ok) return { ok: false, message: `${r.message} (${r.code})` };
    const acc = r.result?.list?.[0];
    const coins = (acc?.coin || []).map(c => {
        const total = num(c.walletBalance) || num(c.equity);
        return { coin: c.coin, total, free: Math.max(0, total - num(c.locked)) };
    });
    return { ok: true, coins };
}

async function loadFunding() {
    const r = await bybit('GET', '/v5/asset/transfer/query-account-coins-balance', { query: 'accountType=FUND' });
    if (!r.ok) return { ok: false, message: `${r.message} (${r.code})` };
    const coins = (r.result?.balance || []).map(c => {
        const total = num(c.walletBalance);
        const hasTransfer = c.transferBalance !== undefined && c.transferBalance !== '';
        return { coin: c.coin, total, free: hasTransfer ? num(c.transferBalance) : total };
    });
    return { ok: true, coins };
}

let walletCache = { ts: 0, val: null };
async function getWalletCached(maxAge = 5000) {
    if (walletCache.val && Date.now() - walletCache.ts < maxAge) return walletCache.val;
    const v = await loadWallet();
    if (v.ok) walletCache = { ts: Date.now(), val: v };
    return v;
}
const clearWallet = () => { walletCache = { ts: 0, val: null }; };

async function doTransfer(coin, amount, from, to) {
    return bybit('POST', '/v5/asset/transfer/inter-transfer', {
        body: { transferId: crypto.randomUUID(), coin, amount, fromAccountType: from, toAccountType: to }
    });
}

// ---------- Cene ----------
let tkCache = { ts: 0, list: null };
async function getTickers() {
    if (tkCache.list && Date.now() - tkCache.ts < 5000) return { ok: true, list: tkCache.list };
    const r = await publicGet('/v5/market/tickers', 'category=spot');
    if (!r.ok) return r;
    const list = r.result?.list || [];
    tkCache = { ts: Date.now(), list };
    return { ok: true, list };
}

const priceMap = list => { const m = {}; list.forEach(t => { m[t.symbol] = num(t.lastPrice); }); return m; };

function eurConverter(m) {
    const usdtEur = m['USDTEUR'] || (m['EURUSDT'] ? 1 / m['EURUSDT'] : 0);
    return coin => {
        if (coin === 'EUR') return 1;
        if (m[coin + 'EUR']) return m[coin + 'EUR'];
        if (coin === 'USDT') return usdtEur;
        if (coin === 'USDC') return m['USDCEUR'] || usdtEur;
        const u = m[coin + 'USDT'];
        return u && usdtEur ? u * usdtEur : 0;
    };
}

const instCache = new Map();
async function getInstrument(symbol) {
    const c = instCache.get(symbol);
    if (c && Date.now() - c.ts < 10 * 60 * 1000) return c.val;
    const r = await publicGet('/v5/market/instruments-info', `category=spot&symbol=${symbol}`);
    const it = r.ok ? r.result?.list?.[0] : null;
    if (!it) return null;
    const val = {
        base: it.baseCoin, quote: it.quoteCoin, status: it.status,
        basePrecision: it.lotSizeFilter?.basePrecision,
        quotePrecision: it.lotSizeFilter?.quotePrecision,
        minOrderQty: it.lotSizeFilter?.minOrderQty,
        minOrderAmt: it.lotSizeFilter?.minOrderAmt
    };
    instCache.set(symbol, { ts: Date.now(), val });
    return val;
}

// ---------- Svečke in kazalniki ----------
const klineCache = new Map();
async function getCandles(symbol, interval) {
    const key = `${symbol}:${interval}`;
    const c = klineCache.get(key);
    if (c && Date.now() - c.ts < 15000) return c.val;
    const r = await publicGet('/v5/market/kline', `category=spot&symbol=${symbol}&interval=${interval}&limit=200`);
    if (!r.ok) return { ok: false, message: `${r.message} (${r.code})` };
    const candles = (r.result?.list || []).slice().reverse().map(k => ({ h: num(k[2]), l: num(k[3]), c: num(k[4]) }));
    const val = { ok: true, candles };
    klineCache.set(key, { ts: Date.now(), val });
    return val;
}

function emaSeries(values, p) {
    const k = 2 / (p + 1);
    const out = [values[0]];
    for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
    return out;
}

function rsiLast(closes, p = 14) {
    if (closes.length <= p) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= p; i++) {
        const d = closes[i] - closes[i - 1];
        if (d >= 0) g += d; else l -= d;
    }
    let ag = g / p, al = l / p;
    for (let i = p + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        ag = (ag * (p - 1) + Math.max(d, 0)) / p;
        al = (al * (p - 1) + Math.max(-d, 0)) / p;
    }
    if (al === 0) return 100;
    return 100 - 100 / (1 + ag / al);
}

function atrLast(c, p = 14) {
    const trs = [];
    for (let i = 1; i < c.length; i++) {
        trs.push(Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)));
    }
    const last = trs.slice(-p);
    return last.reduce((s, x) => s + x, 0) / (last.length || 1);
}

// Točkovanje: od -5 (močno PRODAJ) do +5 (močno KUPI)
function analyze(candles) {
    const n = candles.length;
    if (n < 60) return null;
    const closes = candles.map(c => c.c);
    const last = closes[n - 1];

    const e9 = emaSeries(closes, 9), e21 = emaSeries(closes, 21), e50 = emaSeries(closes, 50);
    const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
    const macdLine = e12.map((v, i) => v - e26[i]);
    const macdSig = emaSeries(macdLine, 9);
    const hist = macdLine[n - 1] - macdSig[n - 1];
    const rsi = rsiLast(closes, 14);
    const mom = (last / closes[n - 11] - 1) * 100;
    const atr = atrLast(candles, 14);

    let score = 0;
    const reasons = [];

    if (e9[n - 1] > e21[n - 1]) { score += 1; reasons.push('EMA9 nad EMA21: kratkoročni trend navzgor'); }
    else { score -= 1; reasons.push('EMA9 pod EMA21: kratkoročni trend navzdol'); }

    if (last > e50[n - 1]) { score += 1; reasons.push('Cena nad EMA50: širši trend navzgor'); }
    else { score -= 1; reasons.push('Cena pod EMA50: širši trend navzdol'); }

    if (hist > 0) { score += 1; reasons.push('MACD pozitiven: zagon navzgor'); }
    else { score -= 1; reasons.push('MACD negativen: zagon navzdol'); }

    if (rsi !== null) {
        if (rsi < 30) { score += 1; reasons.push(`RSI ${rsi.toFixed(0)}: preprodano`); }
        else if (rsi > 70) { score -= 1; reasons.push(`RSI ${rsi.toFixed(0)}: prekupljeno`); }
        else reasons.push(`RSI ${rsi.toFixed(0)}: nevtralno`);
    }

    if (mom > 0.4) { score += 1; reasons.push(`Zadnjih 10 svečk: +${mom.toFixed(2)}%`); }
    else if (mom < -0.4) { score -= 1; reasons.push(`Zadnjih 10 svečk: ${mom.toFixed(2)}%`); }
    else reasons.push(`Zadnjih 10 svečk: ${mom.toFixed(2)}% (ravno)`);

    const signal = score >= 3 ? 'BUY' : score <= -3 ? 'SELL' : 'HOLD';
    const decimals = last >= 100 ? 2 : last >= 1 ? 4 : 6;
    return {
        signal, score,
        confidence: Math.round(Math.abs(score) / 5 * 100),
        rsi: rsi === null ? null : Math.round(rsi),
        reasons,
        stop: signal === 'BUY' ? (last - 1.5 * atr).toFixed(decimals) : null,
        target: signal === 'BUY' ? (last + 2 * atr).toFixed(decimals) : null
    };
}

async function analyzeSymbol(symbol, interval, byS, wallet) {
    const item = { symbol, ok: false };
    try {
        const [inst, c] = await Promise.all([getInstrument(symbol), getCandles(symbol, interval)]);
        if (!inst) { item.message = 'Par ni najden na Bybit Spot.'; return item; }
        const tk = byS.get(symbol);
        if (!tk) { item.message = 'Par nima cene.'; return item; }

        item.ok = true;
        item.base = inst.base;
        item.quote = inst.quote;
        item.lastPrice = tk.lastPrice;
        item.bid = tk.bid1Price;
        item.ask = tk.ask1Price;
        item.change24h = num(tk.price24hPcnt) * 100;
        item.held = wallet && wallet.ok ? freeOf(wallet.coins, inst.base) : null;

        const a = c.ok ? analyze(c.candles) : null;
        if (a) Object.assign(item, a);
        else { item.signal = 'N/A'; item.reasons = [c.ok ? 'Premalo podatkov za analizo.' : `Svečk ni mogoče pridobiti: ${c.message}`]; }
        return item;
    } catch (e) {
        item.message = e.message;
        return item;
    }
}

// ---------- Dnevni izbor trgov ----------
const STABLE_BASES = new Set(['USDT', 'USDC', 'USDE', 'FDUSD', 'TUSD', 'DAI', 'BUSD', 'USDD', 'PYUSD', 'USD1', 'USDP', 'GUSD', 'EUR', 'EURI', 'EURC', 'EURR', 'AEUR']);
const isLeveraged = base => /\d[LS]$/.test(base);
const MIN_TURNOVER = 20000;

function candidatesFor(list, quote) {
    return list
        .filter(t => t.symbol && t.symbol.endsWith(quote) && t.symbol.length > quote.length)
        .map(t => ({
            symbol: t.symbol,
            base: t.symbol.slice(0, -quote.length),
            last: num(t.lastPrice),
            change: num(t.price24hPcnt) * 100,
            turnover: num(t.turnover24h)
        }))
        .filter(c => c.base && !STABLE_BASES.has(c.base) && !isLeveraged(c.base) && c.last > 0 && c.turnover >= MIN_TURNOVER);
}

// Med 20 najbolj prometnimi trgi izbere tiste z najmočnejšim signalom
async function rankAI(cands, interval) {
    const pool = cands.slice().sort((a, b) => b.turnover - a.turnover).slice(0, 20);
    const out = [];
    for (let i = 0; i < pool.length; i += 5) {
        const res = await Promise.all(pool.slice(i, i + 5).map(async c => {
            try {
                const k = await getCandles(c.symbol, interval);
                const a = k.ok ? analyze(k.candles) : null;
                return { ...c, signal: a?.signal || 'N/A', score: a?.score ?? 0, confidence: a?.confidence ?? 0 };
            } catch {
                return { ...c, signal: 'N/A', score: 0, confidence: 0 };
            }
        }));
        out.push(...res);
    }
    out.sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || b.turnover - a.turnover);
    return out;
}

const topCache = new Map();

// ====================== API ======================
app.get('/api/health', (req, res) => {
    ok(res, {
        passwordSet: APP_PASSWORD.length > 0,
        keySet: API_KEY.length > 0,
        secretSet: API_SECRET.length > 0,
        baseUrl: BYBIT_URL,
        maxOrderAmount: MAX_ORDER_AMOUNT || null
    });
});

// 1. Stanje (Unified + Funding), vrednosti v EUR
app.post('/api/balance', async (req, res) => {
    try {
        if (!checkAuth(req, res)) return;
        if (keysMissing(res)) return;

        const [uni, fund, tk] = await Promise.all([loadWallet(), loadFunding(), getTickers()]);
        if (!uni.ok) return fail(res, -1, `Unified: ${uni.message}`);
        walletCache = { ts: Date.now(), val: uni };

        const m = tk.ok ? priceMap(tk.list) : {};
        const toEur = eurConverter(m);

        const coins = uni.coins.filter(c => c.total > 0).map(c => ({ ...c, eurValue: c.total * toEur(c.coin) }));
        const funding = fund.ok
            ? fund.coins.filter(c => c.total > 0).map(c => ({ ...c, eurValue: c.total * toEur(c.coin) }))
            : [];
        const sum = list => list.reduce((s, c) => s + c.eurValue, 0);

        const quoteFree = {
            EUR: freeOf(uni.coins, 'EUR'),
            USDT: freeOf(uni.coins, 'USDT'),
            USDC: freeOf(uni.coins, 'USDC')
        };

        const activePositions = coins
            .filter(c => !['EUR', 'USDT', 'USDC'].includes(c.coin) && c.eurValue >= 0.5)
            .map(c => ({
                symbol: m[c.coin + 'EUR'] ? c.coin + 'EUR' : c.coin + 'USDT',
                coin: c.coin, size: c.total, free: c.free, eurValue: c.eurValue
            }));

        const warnings = [];
        if (!fund.ok) warnings.push(`Funding: ${fund.message}`);
        if (!tk.ok) warnings.push(`Cene: ${tk.message}`);

        return ok(res, {
            totalEquity: sum(coins), fundingEquity: sum(funding), currency: 'EUR',
            coins, funding, quoteFree, activePositions, warnings
        });
    } catch (err) {
        return fail(res, -500, err.message);
    }
});

// 2. Prenos Funding <-> Unified
app.post('/api/transfer', async (req, res) => {
    try {
        if (!checkAuth(req, res)) return;
        if (keysMissing(res)) return;

        const coin = cleanSymbol(req.body?.coin);
        const amount = String(req.body?.amount || '').trim().replace(',', '.');
        const from = String(req.body?.from || '');
        const to = String(req.body?.to || '');
        const allowed = ['FUND', 'UNIFIED'];

        if (!/^[A-Z0-9]{2,12}$/.test(coin)) return fail(res, -422, 'Neveljaven kovanec.');
        if (!/^\d+(\.\d{1,12})?$/.test(amount) || parseFloat(amount) <= 0) return fail(res, -422, 'Neveljaven znesek.');
        if (!allowed.includes(from) || !allowed.includes(to) || from === to) return fail(res, -422, 'Neveljavna smer prenosa.');

        const r = await doTransfer(coin, amount, from, to);
        if (!r.ok) return fail(res, r.code, r.message);
        clearWallet();
        return ok(res, r.result, 'Prenos izveden.');
    } catch (err) {
        return fail(res, -500, err.message);
    }
});

// 3. Dnevni izbor najbolj aktualnih trgov
app.post('/api/top', async (req, res) => {
    try {
        if (!checkAuth(req, res)) return;

        const quote = ['EUR', 'USDT', 'USDC'].includes(req.body?.quote) ? req.body.quote : 'EUR';
        const mode = ['ai', 'volume', 'movers'].includes(req.body?.mode) ? req.body.mode : 'ai';
        const interval = ['5', '15', '60'].includes(String(req.body?.interval)) ? String(req.body.interval) : '15';

        const tk = await getTickers();
        if (!tk.ok) return fail(res, -1, tk.message);
        const cands = candidatesFor(tk.list, quote);
        if (!cands.length) return fail(res, -404, `Ni najdenih trgov z valuto ${quote}.`);

        const key = `${quote}:${mode}:${interval}`;
        let ranked;
        const cached = topCache.get(key);
        if (cached && Date.now() - cached.ts < 60000) {
            ranked = cached.val;
        } else {
            if (mode === 'volume') ranked = cands.slice().sort((a, b) => b.turnover - a.turnover);
            else if (mode === 'movers') ranked = cands.slice().sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
            else ranked = await rankAI(cands, interval);
            ranked = ranked.slice(0, 15);
            topCache.set(key, { ts: Date.now(), val: ranked });
        }

        let held = [];
        if (API_KEY && API_SECRET) {
            const w = await getWalletCached();
            if (w.ok) {
                const m = priceMap(tk.list);
                held = w.coins
                    .filter(x => x.coin !== quote && x.free > 0 && m[x.coin + quote] && x.free * m[x.coin + quote] >= 1)
                    .map(x => ({ symbol: x.coin + quote, base: x.coin, free: x.free }));
            }
        }

        return ok(res, {
            quote, mode, interval, ts: Date.now(),
            items: ranked.map(r => ({
                symbol: r.symbol, base: r.base, change: r.change, turnover: r.turnover,
                signal: r.signal || null, score: r.score ?? null, confidence: r.confidence ?? null
            })),
            held
        });
    } catch (err) {
        return fail(res, -500, err.message);
    }
});

// 4. AI analiza do 5 trgov
app.post('/api/analyze', async (req, res) => {
    try {
        if (!checkAuth(req, res)) return;

        const interval = ['5', '15', '60'].includes(String(req.body?.interval)) ? String(req.body.interval) : '15';
        const raw = Array.isArray(req.body?.symbols) ? req.body.symbols : [];
        const symbols = [...new Set(raw.map(cleanSymbol).filter(validSymbol))].slice(0, 5);
        if (!symbols.length) return fail(res, -422, 'Izberite vsaj en trg.');

        const tk = await getTickers();
        if (!tk.ok) return fail(res, -1, tk.message);
        const byS = new Map(tk.list.map(t => [t.symbol, t]));
        const wallet = (API_KEY && API_SECRET) ? await getWalletCached() : null;

        const items = await Promise.all(symbols.map(s => analyzeSymbol(s, interval, byS, wallet)));
        return ok(res, { items, interval, ts: Date.now() });
    } catch (err) {
        return fail(res, -500, err.message);
    }
});

// 5. Naročilo (market, Spot)
app.post('/api/trade', async (req, res) => {
    try {
        if (!checkAuth(req, res)) return;
        if (keysMissing(res)) return;

        const symbol = cleanSymbol(req.body?.symbol);
        const side = String(req.body?.side || '');
        const amount = num(String(req.body?.amount ?? '').replace(',', '.'));
        const sellAll = req.body?.sellAll === true;
        const autoTransfer = req.body?.autoTransfer !== false;

        if (!validSymbol(symbol)) return fail(res, -422, 'Neveljaven trgovalni par.');
        if (side !== 'Buy' && side !== 'Sell') return fail(res, -422, 'Neveljavna stran (Buy/Sell).');
        if ((side === 'Buy' || !sellAll) && !(amount > 0)) return fail(res, -422, 'Vnesite znesek za ta trg.');
        if (side === 'Buy' && MAX_ORDER_AMOUNT > 0 && amount > MAX_ORDER_AMOUNT) {
            return fail(res, -424, `Znesek presega dovoljeno omejitev (${MAX_ORDER_AMOUNT}).`);
        }

        const inst = await getInstrument(symbol);
        if (!inst) return fail(res, -404, 'Par ni najden na Bybit Spot.');
        if (inst.status && inst.status !== 'Trading') return fail(res, -405, `Par trenutno ni na voljo (${inst.status}).`);

        let order, info = {}, transfer = null;

        if (side === 'Buy') {
            const quote = inst.quote;
            let uni = await loadWallet();
            if (!uni.ok) return fail(res, -431, `Stanja Unified ni mogoče prebrati: ${uni.message}`);
            let avail = freeOf(uni.coins, quote);
            let note = '';

            if (autoTransfer && avail < amount) {
                const fund = await loadFunding();
                if (!fund.ok) {
                    note = ` Funding ni bilo mogoče prebrati: ${fund.message}.`;
                } else {
                    const fundFree = freeOf(fund.coins, quote);
                    const move = Math.min(Math.ceil((amount - avail) * 1e8) / 1e8, fundFree);
                    if (move > 0) {
                        const t = await doTransfer(quote, fmt8(move), 'FUND', 'UNIFIED');
                        if (t.ok) {
                            transfer = { coin: quote, amount: fmt8(move) };
                            await wait(800);
                            uni = await loadWallet();
                            if (uni.ok) avail = freeOf(uni.coins, quote);
                        } else {
                            note = ` Samodejni prenos iz Funding ni uspel: ${t.message} (${t.code}).`;
                        }
                    } else {
                        note = ` Na Funding ni ${quote}.`;
                    }
                }
            }

            if (avail <= 0) return fail(res, -434, `Na računu Unified nimate ${quote}.${note}`);

            const spend = Math.min(amount, avail * 0.995); // 0,5 % rezerve
            const qty = floorToStep(spend, inst.quotePrecision);
            const minAmt = num(inst.minOrderAmt);
            if (num(qty) <= 0 || (minAmt && num(qty) < minAmt)) {
                return fail(res, -423,
                    `Znesek je pod Bybitovim minimumom. Na voljo ${fmt8(avail)} ${quote}, naročilo ${qty} ${quote}, minimum ${inst.minOrderAmt} ${quote}.${note}`);
            }
            order = { category: 'spot', symbol, side, orderType: 'Market', qty, marketUnit: 'quoteCoin' };
            info = { requested: amount, spent: num(qty), unit: quote, available: avail };
        } else {
            const uni = await loadWallet();
            if (!uni.ok) return fail(res, -431, `Stanja Unified ni mogoče prebrati: ${uni.message}`);
            const free = freeOf(uni.coins, inst.base);
            const tk = await getTickers();
            const price = tk.ok ? priceMap(tk.list)[symbol] : 0;

            let want = free;
            if (!sellAll) {
                if (!price) return fail(res, -406, 'Cene ni bilo mogoče pridobiti.');
                want = Math.min(free, amount / price);
            }
            const qty = floorToStep(want, inst.basePrecision);
            if (num(qty) <= 0 || (num(inst.minOrderQty) && num(qty) < num(inst.minOrderQty))) {
                return fail(res, -432, `Nimate dovolj ${inst.base} na Unified (na voljo ${fmt8(free)}, minimum ${inst.minOrderQty}).`);
            }
            if (price && num(inst.minOrderAmt) && num(qty) * price < num(inst.minOrderAmt)) {
                return fail(res, -433, `Vrednost prodaje je pod Bybitovim minimumom (${inst.minOrderAmt} ${inst.quote}).`);
            }
            order = { category: 'spot', symbol, side, orderType: 'Market', qty, marketUnit: 'baseCoin' };
            info = { spent: num(qty), unit: inst.base };
        }

        order.orderLinkId = `term-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
        const r = await bybit('POST', '/v5/order/create', { body: order });
        clearWallet();
        if (!r.ok) {
            const extra = transfer ? ` (Prenos ${transfer.amount} ${transfer.coin} iz Funding je bil že izveden.)` : '';
            const ctx = info.available != null ? ` Na Unified je bilo ${fmt8(info.available)} ${info.unit}, naročilo ${order.qty}.` : '';
            return fail(res, r.code, `${r.message}.${ctx}${extra}`);
        }

        let fill = null;
        try {
            await wait(800);
            const q = await bybit('GET', '/v5/order/history', { query: `category=spot&orderId=${encodeURIComponent(r.result?.orderId || '')}` });
            const o = q.ok ? q.result?.list?.[0] : null;
            if (o) fill = { status: o.orderStatus, avgPrice: o.avgPrice, execQty: o.cumExecQty };
        } catch { /* ni kritično */ }

        let msg = side === 'Buy'
            ? `KUPI ${symbol}: porabljeno ${order.qty} ${info.unit}`
            : `PRODAJ ${symbol}: prodano ${order.qty} ${info.unit}`;
        if (side === 'Buy' && info.spent < info.requested) msg += ` (zahtevano ${info.requested}, več ni bilo na voljo)`;
        if (transfer) msg += `. Samodejni prenos iz Funding: ${transfer.amount} ${transfer.coin}`;
        if (fill) msg += `. Status: ${fill.status}` + (fill.avgPrice && fill.avgPrice !== '0' ? `, povp. cena ${fill.avgPrice}` : '');

        return ok(res, { orderId: r.result?.orderId, side, symbol, ...info, fill, transfer }, msg);
    } catch (err) {
        return fail(res, -500, `Napaka strežnika: ${err.message}`);
    }
});

app.use('/api', (req, res) => res.status(404).json({ status: 'error', code: 404, message: 'Pot ne obstaja.', data: null }));
app.use((err, req, res, next) => res.status(400).json({ status: 'error', code: -400, message: `Neveljavna zahteva: ${err.message}`, data: null }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Strežnik teče na portu ${PORT}`));
