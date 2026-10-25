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

// ---------- Prenos Funding <-> Unified ----------
async function doTransfer(coin, amount, from, to) {
    const body = {
        transferId: crypto.randomUUID(),
        coin,
        amount,
        fromAccountType: from,
        toAccountType: to
    };
    return bybit('POST', '/v5/asset/transfer/inter-transfer', { body });
}

// ---------- Samodejni prenos pred naročilom (samo Spot) ----------
const QUOTES = ['USDT', 'USDC', 'USD', 'EUR', 'BTC', 'ETH'];
function splitSymbol(symbol) {
    for (const q of QUOTES) {
        if (symbol.length > q.length && symbol.endsWith(q)) {
            return { base: symbol.slice(0, -q.length), quote: q };
        }
    }
    return null;
}

async function ensureFunds({ symbol, side, qty, marketUnit }) {
    const sp = splitSymbol(symbol);
    if (!sp) return { transferred: false, note: 'Kovanca ni mogoče določiti iz para, samodejni prenos preskočen.' };

    const tk = await publicGet('/v5/market/tickers', `category=spot&symbol=${symbol}`);
    const price = num(tk.ok ? tk.result?.list?.[0]?.lastPrice : 0);
    if (!price) return { transferred: false, note: 'Cene ni bilo mogoče pridobiti, samodejni prenos preskočen.' };

    const q = parseFloat(qty);
    let coin, need;
    if (side === 'Buy') {
        coin = sp.quote;
        need = marketUnit === 'quoteCoin' ? q : q * price * 1.02;
    } else {
        coin = sp.base;
        need = marketUnit === 'baseCoin' ? q : (q / price) * 1.02;
    }

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
        return { error: `Premalo ${coin}: potrebujete ok. ${fmt8(need)}, na Unified ${fmt8(uniFree)}, na Funding ${fmt8(fundFree)}.` };
    }

    const amount = fmt8(Math.min(Math.ceil(shortfall * 1e8) / 1e8, fundFree));
    const t = await doTransfer(coin, amount, 'FUND', 'UNIFIED');
    if (!t.ok) return { error: `Samodejni prenos ni uspel: ${t.message} (${t.code})` };
    await wait(600);
    return { transferred: true, coin, amount };
}

// ---------- Monitor ene postavke ----------
async function monitorOne(category, symbol) {
    const item = { symbol, ok: false };
    try {
        const [t, o, p] = await Promise.all([
            publicGet('/v5/market/tickers', `category=${category}&symbol=${symbol}`),
            bybit('GET', '/v5/order/realtime', { query: `category=${category}&symbol=${symbol}` }),
            category === 'linear'
                ? bybit('GET', '/v5/position/list', { query: `category=linear&symbol=${symbol}` })
                : Promise.resolve(null)
        ]);
        const tk = t.ok ? t.result?.list?.[0] : null;
        if (!tk) {
            item.message = t.ok ? 'Par ni najden na tem trgu.' : `${t.message} (${t.code})`;
            return item;
        }
        item.ok = true;
        item.lastPrice = tk.lastPrice;
        item.bid = tk.bid1Price;
        item.ask = tk.ask1Price;
        item.change24h = num(tk.price24hPcnt) * 100;
        item.openOrders = o.ok ? (o.result?.list || []).length : null;
        if (category === 'linear' && p && p.ok) {
            const pos = (p.result?.list || []).find(x => num(x.size) > 0);
            if (pos) {
                item.position = {
                    side: pos.side,
                    size: pos.size,
                    avgPrice: pos.avgPrice,
                    markPrice: pos.markPrice,
                    unrealisedPnl: pos.unrealisedPnl,
                    leverage: pos.leverage
                };
            }
        }
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
        baseUrl: BYBIT_URL
    });
});

// Stanje: UNIFIED + SPOT (če Unified ne obstaja) + FUNDING
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

// Prenos Funding <-> Unified
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
        return ok(res, r.result, 'Prenos izveden.');
    } catch (err) {
        return fail(res, -500, `Napaka strežnika: ${err.message}`);
    }
});

// Market naročilo (Spot ali linear)
app.post('/api/order', async (req, res) => {
    try {
        if (!checkAuth(req, res)) return;
        if (keysMissing(res)) return;

        const symbol = cleanSymbol(req.body?.symbol);
        const side = String(req.body?.side || '');
        const qty = String(req.body?.qty || '').trim().replace(',', '.');
        const category = String(req.body?.category || 'spot');
        const marketUnit = String(req.body?.marketUnit || 'baseCoin');
        const autoTransfer = req.body?.autoTransfer === true;

        if (!validSymbol(symbol)) return fail(res, -422, 'Neveljaven trgovalni par.');
        if (side !== 'Buy' && side !== 'Sell') return fail(res, -422, 'Neveljavna stran (Buy/Sell).');
        if (!/^\d+(\.\d{1,12})?$/.test(qty) || parseFloat(qty) <= 0) return fail(res, -422, 'Neveljavna količina.');
        if (category !== 'spot' && category !== 'linear') return fail(res, -422, 'Neveljavna kategorija.');
        if (marketUnit !== 'baseCoin' && marketUnit !== 'quoteCoin') return fail(res, -422, 'Neveljavna enota količine.');

        let transferInfo = null;
        if (autoTransfer && category === 'spot') {
            transferInfo = await ensureFunds({ symbol, side, qty, marketUnit });
            if (transferInfo.error) return fail(res, -430, transferInfo.error, { autoTransfer: transferInfo });
        }

        const order = {
            category,
            symbol,
            side,
            orderType: 'Market',
            qty,
            orderLinkId: `term-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
        };
        if (category === 'spot') order.marketUnit = marketUnit;

        const r = await bybit('POST', '/v5/order/create', { body: order });
        if (!r.ok) {
            const extra = transferInfo?.transferred
                ? ` (Samodejni prenos ${transferInfo.amount} ${transferInfo.coin} je bil že izveden.)`
                : '';
            return fail(res, r.code, r.message + extra, { autoTransfer: transferInfo });
        }

        // Najboljši poskus: preberi izvedbo naročila
        let fill = null;
        try {
            await wait(800);
            const q = await bybit('GET', '/v5/order/history', {
                query: `category=${category}&orderId=${encodeURIComponent(r.result?.orderId || '')}`
            });
            const o = q.ok ? q.result?.list?.[0] : null;
            if (o) {
                fill = {
                    status: o.orderStatus,
                    avgPrice: o.avgPrice,
                    execQty: o.cumExecQty,
                    execValue: o.cumExecValue,
                    fee: o.cumExecFee
                };
            }
        } catch { /* ni kritično */ }

        return ok(res, { ...r.result, fill, autoTransfer: transferInfo }, 'Naročilo oddano.');
    } catch (err) {
        return fail(res, -500, `Napaka strežnika: ${err.message}`);
    }
});

// AI Trade Monitor: do 5 parov
app.post('/api/monitor', async (req, res) => {
    try {
        if (!checkAuth(req, res)) return;
        if (keysMissing(res)) return;

        const category = req.body?.category === 'linear' ? 'linear' : 'spot';
        const raw = Array.isArray(req.body?.symbols) ? req.body.symbols : [];
        const symbols = [...new Set(raw.map(cleanSymbol).filter(validSymbol))].slice(0, 5);
        if (!symbols.length) return fail(res, -422, 'Vpišite vsaj en veljaven par.');

        const items = await Promise.all(symbols.map(s => monitorOne(category, s)));
        return ok(res, { category, items, ts: Date.now() });
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
