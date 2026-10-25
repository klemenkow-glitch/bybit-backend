const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BYBIT_URL = (process.env.BYBIT_BASE_URL || 'https://api.bybit.eu').trim();
const API_KEY = (process.env.BYBIT_API_KEY || '').trim();
const API_SECRET = (process.env.BYBIT_API_SECRET || '').trim();
const APP_PASSWORD = (process.env.APP_PASSWORD || '').trim();
const RECV_WINDOW = '10000';

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const wait = ms => new Promise(r => setTimeout(r, ms));

function snippet(body) {
    try {
        const s = typeof body === 'string' ? body : JSON.stringify(body);
        return (s || '(prazno)').replace(/\s+/g, ' ').slice(0, 200);
    } catch {
        return '(ni berljivo)';
    }
}

// ---- Zaščita gesla: zaklep po 5 napačnih poskusih za 15 minut ----
const fails = new Map();
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest(); }

function checkAuth(req, res) {
    const ip = req.ip;
    const rec = fails.get(ip) || { count: 0, lockUntil: 0 };
    if (rec.lockUntil > Date.now()) {
        const min = Math.ceil((rec.lockUntil - Date.now()) / 60000);
        res.status(429).json({ status: 'error', code: 429, message: `Preveč napačnih poskusov. Poskusite čez ${min} min.` });
        return false;
    }
    const sent = String(req.body?.password || '').trim();
    const ok = APP_PASSWORD.length > 0 && crypto.timingSafeEqual(sha(sent), sha(APP_PASSWORD));
    if (!ok) {
        rec.count += 1;
        if (rec.count >= MAX_FAILS) { rec.lockUntil = Date.now() + LOCK_MS; rec.count = 0; }
        fails.set(ip, rec);
        res.status(401).json({ status: 'error', code: 401, message: 'Napačno geslo.' });
        return false;
    }
    fails.delete(ip);
    return true;
}

function keysMissing(res) {
    if (!API_KEY || !API_SECRET) {
        res.json({ status: 'error', code: -400, message: 'Na strežniku manjkata BYBIT_API_KEY / BYBIT_API_SECRET.' });
        return true;
    }
    return false;
}

// ---- Podpisan klic na Bybit ----
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

app.get('/api/health', (req, res) => {
    res.json({
        passwordSet: APP_PASSWORD.length > 0,
        keySet: API_KEY.length > 0,
        secretSet: API_SECRET.length > 0,
        baseUrl: BYBIT_URL
    });
});

// ---- Nalaganje stanj iz posameznih računov ----
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

// ---- Stanje sredstev (UNIFIED + SPOT + FUND) ----
app.post('/api/balance', async (req, res) => {
    try {
        if (!checkAuth(req, res)) return;
        if (keysMissing(res)) return;

        const [uni, spot, fund] = await Promise.all([
            safe('UNIFIED', () => loadWallet('UNIFIED')),
            safe('SPOT', () => loadWallet('SPOT')),
            safe('FUND', () => loadFunding())
        ]);

        // Če Unified obstaja, klasičnega Spot računa ne upoštevamo (da se stanja ne podvojijo)
        const sources = uni.ok ? [uni, fund] : [uni, spot, fund];

        if (!sources.some(a => a.ok)) {
            return res.json({
                status: 'error', code: -1,
                message: sources.map(a => `${a.accountType}: ${a.message}`).join(' | ')
            });
        }

        const warnings = sources.filter(a => !a.ok).map(a => `${a.accountType}: ${a.message}`);
        const coins = sources
            .filter(a => a.ok)
            .flatMap(a => a.coins)
            .filter(c => c.total > 0)
            .sort((a, b) => a.account.localeCompare(b.account) || a.coin.localeCompare(b.coin));

        return res.json({
            status: 'success',
            code: 0,
            message: 'Povezano uspešno!',
            data: {
                totalEquity: uni.ok ? uni.totalEquity : null,
                coins,
                warnings
            }
        });
    } catch (err) {
        return res.json({ status: 'error', code: -500, message: `Napaka strežnika: ${err.message}` });
    }
});

// ---- Market naročilo (Spot) ----
app.post('/api/order', async (req, res) => {
    try {
        if (!checkAuth(req, res)) return;
        if (keysMissing(res)) return;

        const symbol = String(req.body?.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const side = String(req.body?.side || '');
        const qty = String(req.body?.qty || '').trim().replace(',', '.');
        const marketUnit = String(req.body?.marketUnit || 'baseCoin');

        if (!/^[A-Z0-9]{5,20}$/.test(symbol)) {
            return res.json({ status: 'error', code: -422, message: 'Neveljaven trgovalni par.' });
        }
        if (side !== 'Buy' && side !== 'Sell') {
            return res.json({ status: 'error', code: -422, message: 'Neveljavna stran (Buy/Sell).' });
        }
        if (!/^\d+(\.\d{1,12})?$/.test(qty) || parseFloat(qty) <= 0) {
            return res.json({ status: 'error', code: -422, message: 'Neveljavna količina.' });
        }
        if (marketUnit !== 'baseCoin' && marketUnit !== 'quoteCoin') {
            return res.json({ status: 'error', code: -422, message: 'Neveljavna enota količine.' });
        }

        const order = {
            category: 'spot',
            symbol,
            side,
            orderType: 'Market',
            qty,
            marketUnit,
            orderLinkId: `term-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
        };

        const r = await bybit('POST', '/v5/order/create', { body: order });
        if (!r.ok) return res.json({ status: 'error', code: r.code, message: r.message });

        // Najboljši poskus: preberi stanje izvedbe naročila
        let fill = null;
        try {
            await wait(800);
            const q = await bybit('GET', '/v5/order/history', {
                query: `category=spot&orderId=${encodeURIComponent(r.result?.orderId || '')}`
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

        return res.json({ status: 'success', code: 0, message: 'Naročilo oddano.', data: r.result, fill });
    } catch (err) {
        return res.json({ status: 'error', code: -500, message: `Napaka strežnika: ${err.message}` });
    }
});

// ---- Prenos med lastnimi računi (FUND <-> UNIFIED) ----
app.post('/api/transfer', async (req, res) => {
    try {
        if (!checkAuth(req, res)) return;
        if (keysMissing(res)) return;

        const coin = String(req.body?.coin || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const amount = String(req.body?.amount || '').trim().replace(',', '.');
        const from = String(req.body?.from || '');
        const to = String(req.body?.to || '');
        const allowed = ['FUND', 'UNIFIED'];

        if (!/^[A-Z0-9]{2,12}$/.test(coin)) {
            return res.json({ status: 'error', code: -422, message: 'Neveljaven kovanec.' });
        }
        if (!/^\d+(\.\d{1,12})?$/.test(amount) || parseFloat(amount) <= 0) {
            return res.json({ status: 'error', code: -422, message: 'Neveljaven znesek.' });
        }
        if (!allowed.includes(from) || !allowed.includes(to) || from === to) {
            return res.json({ status: 'error', code: -422, message: 'Neveljava smer prenosa.' });
        }

        const body = {
            transferId: crypto.randomUUID(),
            coin,
            amount,
            fromAccountType: from,
            toAccountType: to
        };
        const r = await bybit('POST', '/v5/asset/transfer/inter-transfer', { body });
        if (!r.ok) return res.json({ status: 'error', code: r.code, message: r.message });
        return res.json({ status: 'success', code: 0, message: 'Prenos izveden.', data: r.result });
    } catch (err) {
        return res.json({ status: 'error', code: -500, message: `Napaka strežnika: ${err.message}` });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Strežnik teče na portu ${PORT}`));
