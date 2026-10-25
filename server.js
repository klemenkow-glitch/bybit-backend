const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const BYBIT_URL = (process.env.BYBIT_BASE_URL || 'https://api.bybit.eu').trim();
const API_KEY = (process.env.BYBIT_API_KEY || '').trim();
const API_SECRET = (process.env.BYBIT_API_SECRET || '').trim();
const APP_PASSWORD = (process.env.APP_PASSWORD || '').trim();
const RECV_WINDOW = '10000';

// ---------- Pomočniki ----------
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const wait = ms => new Promise(r => setTimeout(r, ms));
const fmt8 = n => n.toFixed(8).replace(/\.?0+$/, '');
const cleanSymbol = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const validSymbol = s => /^[A-Z0-9]{5,20}$/.test(s);
const MAX_ORDER_AMOUNT = num(process.env.MAX_ORDER_AMOUNT); // 0 = brez omejitve

const ok = (res, data, message = 'OK') => res.json({ status: 'success', code: 0, message, data });
const fail = (res, code, message, data = null) => res.json({ status: 'error', code, message, data });

function snippet(body) {
    try {
        const s = typeof body === 'string' ? body : JSON.stringify(body);
        return (s || '(prazno)').replace(/\s+/g, ' ').slice(0, 200);
    } catch {
        return '(ni berljivo)';
    }
}

// Zaokroži navzdol na korak (npr. "0.000001") in vrne niz
function floorToStep(value, step) {
    const st = num(step);
    if (!st) return String(value);
    let d = 0;
    while (d < 12 && Math.abs(st * 10 ** d - Math.round(st * 10 ** d)) > 1e-9) d++;
    const n = Math.floor(value / st + 1e-9) * st;
    return n.toFixed(d);
}

// ---------- Zaščita gesla: zaklep po 5 napačnih poskusih za 15 minut ----------
const fails = new Map();
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const sha = s => crypto.createHash('sha256').update(String(s)).digest();

function checkAuth(req, res) {
    const ip = req.ip;
    const rec = fails.get(ip) || { count: 0, lockUntil: 0 };
    if (rec.lockUntil > Date.now()) {
        const min = Math.ceil((rec.lockUntil - Date.now()) / 60000);
        res.status(429).json({ status: 'error', code: 429, message: `Preveč napačnih poskusov. Poskusite čez ${min} min.`, data: null });
        return false;
    }
    const sent = String(req.body?.password || '').trim();
    const good = APP_PASSWORD.length > 0 && crypto.timingSafeEqual(sha(sent), sha(APP_PASSWORD));
    if (!good) {
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
async function bybit(method, apiPath, { query = '', body = null } = {}) {
    const timestamp = Date.now().toString();
    const bodyStr = body ? JSON.stringify(body) : '';
    const payload = method === 'GET' ? query : bodyStr;
    const signature = crypto
        .createHmac('sha256', API_SECRET)
        .update(timestamp + API_KEY + RECV_WINDOW + payload)
        .digest('hex');

    const headers = {
        'X-BAPI-API-KEY': API_KEY,
        'X-BAPI-SIGN': signature,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': RECV_WINDOW
    };
    const url = `${BYBIT_URL}${apiPath}${method === 'GET' && query ? '?' + query : ''}`;
    let response;
    if (method === 'GET') {
        response = await axios.get(url, { headers, timeout: 15000, validateStatus: () => true });
    } else {
        headers['Content-Type'] = 'application/json';
        response = await axios.post(url, bodyStr, { headers, timeout: 15000, validateStatus: () => true });
    }
    const data = response.data;
    if (!data || typeof data !== 'object') {
        return { ok: false, code: response.status, message: `Bybit ni vrnil JSON (HTTP ${response.status}). Odgovor: ${snippet(data)}` };
    }
    if (data.retCode === 0) return { ok: true, result: data.result };
    return { ok: false, code: data.retCode ?? -1, message: data.retMsg || 'Neznana napaka pri Bybitu' };
}

async function publicGet(apiPath, query = '') {
    const url = `${BYBIT_URL}${apiPath}${query ? '?' + query : ''}`;
    const response = await axios.get(url, { timeout: 15000, validateStatus: () => true });
    const data = response.data;
    if (!data || typeof data !== 'object') {
        return { ok: false, code: response.status, message: `Bybit ni vrnil JSON (HTTP ${response.status}).` };
    }
    if (data.retCode === 0) return { ok: true, result: data.result };
    return { ok: false, code: data.retCode ?? -1, message: data.retMsg || 'Neznana napaka pri Bybitu' };
}

// ---------- Stanja računov ----------
async function loadWallet(accountType) {
    const r = await bybit('GET', '/v5/account/wallet-balance', { query: `accountType=${accountType}` });
    if (!r.ok) return { accountType, ok: false, message: `${r.message} (${r.code})` };
    const acc = r.result?.list?.[0];
    const coins = (acc?.coin || []).map(c => {
        const total = num(c.walletBalance);
        return { coin: c.coin, account: accountType, total, free: Math.max(0, total - num(c.locked)) };
    });
    return { accountType, ok: true, totalEquity: num(acc?.totalEquity), coins };
}

async function loadFunding() {
    const r = await bybit('GET', '/v5/asset/transfer/query-account-coins-balance', { query: 'accountType=FUND' });
    if (!r.ok) return { accountType: 'FUND', ok: false, message: `${r.message} (${r.code})` };
    const coins = (r.result?.balance || []).map(c => {
        const total = num(c.walletBalance);
        const hasTransfer = c.transferBalance !== undefined && c.transferBalance !== '';
        return { coin: c.coin, account: 'FUND', total, free: hasTransfer ? num(c.transferBalance) : total };
    });
    return { accountType: 'FUND', ok: true, coins };
}

async function safe(accountType, fn) {
    try { return await fn(); }
    catch (e) { return { accountType, ok: false, message: e.message }; }
}

let uniCache = { ts: 0, val: null };
async function getUnifiedCached(maxAge = 5000) {
    if (uniCache.val && Date.now() - uniCache.ts < maxAge) return uniCache.val;
    const v = await safe('UNIFIED', () => loadWallet('UNIFIED'));
    if (v.ok) uniCache = { ts: Date.now(), val: v };
    return v;
}

// ---------- Prenos Funding <-> Unified ----------
async function doTransfer(coin, amount, from, to) {
    return bybit('POST', '/v5/asset/transfer/inter-transfer', {
        body: { transferId: crypto.randomUUID(), coin, amount, fromAccountType: from, toAccountType: to }
    });
}

// Pred nakupom prenese iz Funding samo toliko, kolikor manjka na Unified
async function ensureQuote(coin, need) {
    const [uni, fund] = await Promise.all([
        safe('UNIFIED', () => loadWallet('UNIFIED')),
        safe('FUND', loadFunding)
    ]);
    if (!uni.ok) return { error: `Stanja Unified ni mogoče prebrati: ${uni.message}` };

    const uniFree = uni.coins.filter(c => c.coin === coin).reduce((s, c) => s + c.free, 0);
    const shortfall = need - uniFree;
    if (shortfall <= 0) return { transferred: false };

    if (!fund.ok) return { error: `Na Unified je premalo ${coin}, stanja Funding pa ni mogoče prebrati: ${fund.message}` };
    const fundFree = fund.coins.filter(c => c.coin === coin).reduce((s, c) => s + c.free, 0);
    if (fundFree + 1e-12 < shortfall) {
        return { error: `Premalo ${coin}: potrebujete ${fmt8(need)}, na Unified ${fmt8(uniFree)}, na Funding ${fmt8(fundFree)}.` };
    }
    const amount = fmt8(Math.min(Math.ceil(shortfall * 1e8) / 1e8, fundFree));
    const t = await doTransfer(coin, amount, 'FUND', 'UNIFIED');
    if (!t.ok) return { error: `Samodejni prenos ni uspel: ${t.message} (${t.code})` };
    await wait(600);
    uniCache = { ts: 0, val: null };
    return { transferred: true, coin, amount };
}

// ---------- Podatki o paru (zaokroževanje, minimumi) ----------
const instCache = new Map();
async function getInstrument(symbol) {
    const c = instCache.get(symbol);
    if (c && Date.now() - c.ts < 10 * 60 * 1000) return c.val;
    const r = await publicGet('/v5/market/instruments-info', `category=spot&symbol=${symbol}`);
    const it = r.ok ? r.result?.list?.[0] : null;
    if (!it) return null;
    const val = {
        symbol,
        base: it.baseCoin,
        quote: it.quoteCoin,
        status: it.status,
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
    const candles = (r.result?.list || []).slice().reverse().map(k => ({
        h: num(k[2]), l: num(k[3]), c: num(k[4])
    }));
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
        signal,
        score,
        confidence: Math.round(Math.abs(score) / 5 * 100),
        rsi: rsi === null ? null : Math.round(rsi),
        reasons,
        stop: signal === 'BUY' ? (last - 1.5 * atr).toFixed(decimals) : null,
        target: signal === 'BUY' ? (last + 2 * atr).toFixed(decimals) : null
    };
}

async function analyzeSymbol(symbol, interval, uni) {
    const item = { symbol, ok: false };
    try {
        const [inst, t, c] = await Promise.all([
            getInstrument(symbol),
            publicGet('/v5/market/tickers', `category=spot&symbol=${symbol}`),
            getCandles(symbol, interval)
        ]);
        if (!inst) { item.message = 'Par ni najden na Bybit Spot.'; return item; }
        const tk = t.ok ? t.result?.list?.[0] : null;
        if (!tk) { item.message = t.ok ? 'Par nima cene.' : `${t.message} (${t.code})`; return item; }

        item.ok = true;
        item.base = inst.base;
        item.quote = inst.quote;
        item.lastPrice = tk.lastPrice;
        item.bid = tk.bid1Price;
        item.ask = tk.ask1Price;
        item.change24h = num(tk.price24hPcnt) * 100;
        item.held = uni && uni.ok
            ? uni.coins.filter(x => x.coin === inst.base).reduce((s, x) => s + x.free, 0)
            : null;

        const a = c.ok ? analyze(c.candles) : null;
        if (a) Object.assign(item, a);
        else { item.signal = 'N/A'; item.reasons = [c.ok ? 'Premalo podatkov za analizo.' : `Svečk ni mogoče pridobiti: ${c.message}`]; }
        return item;
    } catch (e) {
        item.message = e.message;
        return item;
    }
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

app.post('/api/balance', async (req, res) => {
    try {
        if (!checkAuth(req, res)) return;
        if (keysMissing(res)) return;

        const [uni, spot, fund] = await Promise.all([
            safe('UNIFIED', () => loadWallet('UNIFIED')),
            safe('SPOT', () => loadWallet('SPOT')),
            safe('FUND', loadFunding)
        ]);
        const sources = uni.ok ? [uni, fund] : [uni, spot, fund];

        if (!sources.some(a => a.ok)) {
            return fail(res, -1, sources.map(a => `${a.accountType}: ${a.message}`).join(' | '));
        }
        const warnings = sources.filter(a => !a.ok).map(a => `${a.accountType}: ${a.message}`);
        const coins = sources
            .filter(a => a.ok)
            .flatMap(a => a.coins)
            .filter(c => c.total > 0)
            .sort((a, b) => a.account.localeCompare(b.account) || a.coin.localeCompare(b.coin));

        return ok(res, { totalEquity: uni.ok ? uni.totalEquity : null, coins, warnings }, 'Povezano uspešno!');
    } catch (err) {
        return fail(res, -500, `Napaka strežnika: ${err.message}`);
    }
});

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
        uniCache = { ts: 0, val: null };
        return ok(res, r.result, 'Prenos izveden.');
    } catch (err) {
        return fail(res, -500, `Napaka strežnika: ${err.message}`);
    }
});

// AI analiza do 5 trgov
app.post('/api/analyze', async (req, res) => {
    try {
        if (!checkAuth(req, res)) return;
        if (keysMissing(res)) return;

        const interval = ['5', '15', '60'].includes(String(req.body?.interval)) ? String(req.body.interval) : '15';
        const raw = Array.isArray(req.body?.symbols) ? req.body.symbols : [];
        const symbols = [...new Set(raw.map(cleanSymbol).filter(validSymbol))].slice(0, 5);
        if (!symbols.length) return fail(res, -422, 'Vpišite vsaj en veljaven trg.');

        const uni = await getUnifiedCached();
        const items = await Promise.all(symbols.map(s => analyzeSymbol(s, interval, uni)));
        return ok(res, { items, interval, ts: Date.now() });
    } catch (err) {
        return fail(res, -500, `Napaka strežnika: ${err.message}`);
    }
});

// Enoklik trgovanje: znesek, količino in zaokroževanje izračuna strežnik
app.post('/api/trade', async (req, res) => {
    try {
        if (!checkAuth(req, res)) return;
        if (keysMissing(res)) return;

        const symbol = cleanSymbol(req.body?.symbol);
        const side = String(req.body?.side || '');
        const amount = String(req.body?.amount || '').trim().replace(',', '.');
        const autoTransfer = req.body?.autoTransfer !== false;

        if (!validSymbol(symbol)) return fail(res, -422, 'Neveljaven trgovalni par.');
        if (side !== 'Buy' && side !== 'Sell') return fail(res, -422, 'Neveljavna stran (Buy/Sell).');
        if (!/^\d+(\.\d{1,8})?$/.test(amount) || parseFloat(amount) <= 0) return fail(res, -422, 'Neveljaven znesek.');
        const amt = parseFloat(amount);
        if (MAX_ORDER_AMOUNT > 0 && amt > MAX_ORDER_AMOUNT) {
            return fail(res, -424, `Znesek presega dovoljeno omejitev (${MAX_ORDER_AMOUNT}).`);
        }

        const inst = await getInstrument(symbol);
        if (!inst) return fail(res, -404, 'Par ni najden na Bybit Spot.');
        if (inst.status && inst.status !== 'Trading') return fail(res, -405, `Par trenutno ni na voljo za trgovanje (${inst.status}).`);

        const tk = await publicGet('/v5/market/tickers', `category=spot&symbol=${symbol}`);
        const price = num(tk.ok ? tk.result?.list?.[0]?.lastPrice : 0);
        if (!price) return fail(res, -406, 'Cene pari ni bilo mogoče pridobiti.');

        let order;
        let transferInfo = null;

        if (side === 'Buy') {
            const amountQ = floorToStep(amt, inst.quotePrecision);
            if (num(amountQ) <= 0 || (num(inst.minOrderAmt) && num(amountQ) < num(inst.minOrderAmt))) {
                return fail(res, -423, `Znesek na trg je pod Bybitovim minimumom (${inst.minOrderAmt} ${inst.quote}). Povečajte začetni znesek ali izberite manj trgov.`);
            }
            if (autoTransfer) {
                transferInfo = await ensureQuote(inst.quote, num(amountQ));
                if (transferInfo.error) return fail(res, -430, transferInfo.error, { autoTransfer: transferInfo });
            }
            order = { category: 'spot', symbol, side, orderType: 'Market', qty: amountQ, marketUnit: 'quoteCoin' };
        } else {
            const uni = await safe('UNIFIED', () => loadWallet('UNIFIED'));
            if (!uni.ok) return fail(res, -431, `Stanja Unified ni mogoče prebrati: ${uni.message}`);
            const free = uni.coins.filter(c => c.coin === inst.base).reduce((s, c) => s + c.free, 0);
            const qty = floorToStep(Math.min(free, amt / price), inst.basePrecision);
            if (num(qty) <= 0 || (num(inst.minOrderQty) && num(qty) < num(inst.minOrderQty))) {
                return fail(res, -432, `Nimate dovolj ${inst.base} na računu Unified za prodajo (na voljo ${fmt8(free)}, minimum ${inst.minOrderQty}).`);
            }
            if (num(inst.minOrderAmt) && num(qty) * price < num(inst.minOrderAmt)) {
                return fail(res, -433, `Vrednost prodaje je pod Bybitovim minimumom (${inst.minOrderAmt} ${inst.quote}).`);
            }
            order = { category: 'spot', symbol, side, orderType: 'Market', qty, marketUnit: 'baseCoin' };
        }
        order.orderLinkId = `term-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

        const r = await bybit('POST', '/v5/order/create', { body: order });
        uniCache = { ts: 0, val: null };
        if (!r.ok) {
            const extra = transferInfo?.transferred
                ? ` (Samodejni prenos ${transferInfo.amount} ${transferInfo.coin} je bil že izveden.)`
                : '';
            return fail(res, r.code, r.message + extra, { autoTransfer: transferInfo });
        }

        let fill = null;
        try {
            await wait(800);
            const q = await bybit('GET', '/v5/order/history', {
                query: `category=spot&orderId=${encodeURIComponent(r.result?.orderId || '')}`
            });
            const o = q.ok ? q.result?.list?.[0] : null;
            if (o) {
                fill = { status: o.orderStatus, avgPrice: o.avgPrice, execQty: o.cumExecQty, execValue: o.cumExecValue, fee: o.cumExecFee };
            }
        } catch { /* ni kritično */ }

        return ok(res, { ...r.result, side, symbol, qty: order.qty, unit: side === 'Buy' ? inst.quote : inst.base, fill, autoTransfer: transferInfo }, 'Naročilo oddano.');
    } catch (err) {
        return fail(res, -500, `Napaka strežnika: ${err.message}`);
    }
});

// Vedno JSON za neznane API poti in napake
app.use('/api', (req, res) => {
    res.status(404).json({ status: 'error', code: 404, message: 'Neznana API pot.', data: null });
});
app.use((err, req, res, next) => {
    res.status(400).json({ status: 'error', code: -400, message: `Neveljavna zahteva: ${err.message}`, data: null });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Strežnik teče na portu ${PORT}`));
