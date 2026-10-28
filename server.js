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

function priceMap(list) {
    const m = {};
    list.forEach(t => { m[t.symbol] = num(t.lastPrice); });
    return m;
}

// Vrne funkcijo: kovanec -> cena v EUR
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

        const m = tk.ok ? priceMap(tk.list) : {};
        const toEur = eurConverter(m);

        const coins = uni.coins.filter(c => c.total > 0)
            .map(c => ({ ...c, eurValue: c.total * toEur(c.coin) }));
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
            totalEquity: sum(coins),
            fundingEquity: sum(funding),
            currency: 'EUR',
            coins, funding, quoteFree, activePositions, warnings
        });
    } catch (err) {
        return fail(res, -500, err.message);
    }
});

// 2. Predlogi trgov (top 5 po prometu, brez stabilnih kovancev)
const STABLE_BASES = new Set(['USDT', 'USDC', 'USDE', 'FDUSD', 'TUSD', 'DAI', 'BUSD', 'USDD', 'PYUSD', 'USD1', 'USDP', 'GUSD', 'EUR', 'EURI', 'EURC', 'EURR', 'AEUR']);
const isLeveraged = base => /\d[LS]$/.test(base);

app.post('/api/analyze', async (req, res) => {
    try {
        if (!checkAuth(req, res)) return;
        const tk = await getTickers();
        if (!tk.ok) return fail(res, -1, tk.message);

        const pick = quote => tk.list
            .filter(t => t.symbol && t.symbol.endsWith(quote) && t.symbol.length > quote.length)
            .map(t => ({ t, base: t.symbol.slice(0, -quote.length), quote }))
            .filter(x => !STABLE_BASES.has(x.base) && !isLeveraged(x.base) && num(x.t.turnover24h) >= 20000);

        let list = pick('EUR');
        if (list.length < 5) list = pick('USDT');

        const items = list
            .sort((a, b) => num(b.t.turnover24h) - num(a.t.turnover24h))
            .slice(0, 5)
            .map(({ t, quote }) => {
                const chg = num(t.price24hPcnt) * 100;
                let signal = 'HOLD', reasons = ['Trg stabilen (24h)'];
                if (chg > 0.2) { signal = 'BUY'; reasons = [`Cena v 24h: +${chg.toFixed(2)}%`]; }
                else if (chg < -0.2) { signal = 'SELL'; reasons = [`Cena v 24h: ${chg.toFixed(2)}%`]; }
                return { symbol: t.symbol, quote, lastPrice: num(t.lastPrice), change24h: chg.toFixed(2), signal, reasons };
            });
        return ok(res, {
