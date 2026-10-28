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

const BYBIT_URL = (process.env.BYBIT_BASE_URL || 'https://api.bybit.eu').trim();
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

// STANJE IN AKTIVNE POZICIJE (S PREGLEDOM P&L)
app.post('/api/balance', async (req, res) => {
    try {
        if (!checkAuth(req, res)) return;
        const r = await bybit('GET', '/v5/account/wallet-balance', { query: 'accountType=UNIFIED' });
        const rawCoins = r.result?.list?.[0]?.coin || [];
        
        // Pridobimo še zadnje cene za izračun vrednosti in pozicij
        const tickersRes = await publicGet('/v5/market/tickers', 'category=spot');
        const tickersMap = {};
        if (tickersRes.ok && Array.isArray(tickersRes.result?.list)) {
            tickersRes.result.list.forEach(t => { tickersMap[t.symbol] = num(t.lastPrice); });
        }

        const coins = rawCoins.map(c => {
            const total = num(c.walletBalance);
            const free = num(c.equity);
            const coinName = c.coin;
            
            // Izračun ocenjene vrednosti v USD/EUR
            let currentPrice = 1;
            if (coinName !== 'USDT' && coinName !== 'EUR' && coinName !== 'USDC') {
                currentPrice = tickersMap[coinName + 'USDT'] || tickersMap[coinName + 'EUR'] || 0;
            }
            const usdValue = total * currentPrice;

            return {
                coin: coinName,
                account: 'UNIFIED',
                total: total,
                free: free,
                usdValue: usdValue,
                currentPrice: currentPrice
            };
        });

        // Filtriramo aktivne pozicije (kripto kovanci z vrednostjo > 1 USD)
        const activePositions = coins.filter(c => 
            c.coin !== 'USDT' && c.coin !== 'EUR' && c.coin !== 'USDC' && c.total > 0.00001 && c.usdValue > 0.5
        ).map(c => {
            // Poskusimo najti par v EUR ali USDT
            const pairUsdt = c.coin + 'USDT';
            const pairEur = c.coin + 'EUR';
            const symbol = tickersMap[pairEur] ? pairEur : pairUsdt;
            
            return {
                symbol: symbol,
                coin: c.coin,
                size: c.total,
                usdValue: c.usdValue,
                currentPrice: c.currentPrice
            };
        });

        return ok(res, { 
            totalEquity: num(r.result?.list?.[0]?.totalEquity), 
            coins, 
            activePositions 
        });
    } catch (err) {
        return fail(res, -500, err.message);
    }
});

// AI SKENER ZA 5 NAJBOLJŠIH TRGOVALNIH PRILOŽNOSTI
app.post('/api/analyze', async (req, res) => {
    try {
        if (!checkAuth(req, res)) return;
        const totalBudget = num(req.body?.totalAmount) || 25;
        
        const tickers = await publicGet('/v5/market/tickers', 'category=spot');
        
        let items = [];
        if (tickers.ok && Array.isArray(tickers.result?.list)) {
            const eurPairs = tickers.result.list.filter(t => t.symbol && t.symbol.endsWith('EUR'));
            const sourceList = eurPairs.length >= 5 ? eurPairs : tickers.result.list.filter(t => t.symbol && t.symbol.endsWith('USDT'));

            items = sourceList
                .sort((a, b) => num(b.turnover24h) - num(a.turnover24h))
                .slice(0, 5)
                .map(t => {
                    const price = num(t.lastPrice);
                    const chg = num(t.price24hPcnt) * 100;
                    
                    let signal = 'HOLD';
                    let reasons = ['Trg stabilen'];
                    if (chg > 0.2) { signal = 'BUY'; reasons = ['Momentum rasti (+24h)']; }
                    else if (chg < -0.2) { signal = 'SELL'; reasons = ['Pritisk prodajalcev (-24h)']; }

                    return {
                        symbol: t.symbol,
                        lastPrice: price,
                        change24h: chg.toFixed(2),
                        signal: signal,
                        reasons: reasons
                    };
                });
        }

        return ok(res, { items, fullAmount: totalBudget, ts: Date.now() });
    } catch (err) {
        return fail(res, -500, err.message);
    }
});

// IZVEDBA NAROČILA (NAKUP ALI PRODAJA / ZAPIRANJE)
app.post('/api/trade', async (req, res) => {     try {         if (!checkAuth(req, res)) return;         const symbol = cleanSymbol(req.body?.symbol);         const side = String(req.body?.side || '');         const amount = num(req.body?.amount);          if (!symbol || (side !== 'Buy' && side !== 'Sell')) {             return fail(res, -422, 'Neveljavni podatki za naročilo.');         }          const tk = await publicGet('/v5/market/tickers', `category=spot&symbol=${symbol}`);         const price = num(tk.result?.list?.[0]?.lastPrice);         if (!price) return fail(res, -406, 'Cene ni mogoče pridobiti.');          const inst = await publicGet('/v5/market/instruments-info', `category=spot&symbol=${symbol}`);         const lotFilter = inst.result?.list?.[0]?.lotSizeFilter;                  let orderBody = { category: 'spot', symbol, side, orderType: 'Market' };          if (side === 'Buy') {             // Preverimo, če je vnešen znesek vsaj minimalni zahtevan (običajno 1 ali 5 USD/EUR)             const minOrderAmt = num(lotFilter?.minOrderAmt || '1');             const finalAmount = amount < minOrderAmt ? minOrderAmt : amount;              const qtyQuote = floorToStep(finalAmount, lotFilter?.quotePrecision || '0.01');             orderBody.qty = qtyQuote;             orderBody.marketUnit = 'quoteCoin';         } else {             // Prodaja / Zapiranje celotne pozicije z Unified računa             const rWallet = await bybit('GET', '/v5/account/wallet-balance', { query: 'accountType=UNIFIED' });             const baseCoin = inst.result?.list?.[0]?.baseCoin || symbol.replace(/EUR|USDT|USDC/, '');             const coinData = (rWallet.result?.list?.[0]?.coin || []).find(c => c.coin === baseCoin);             const freeQty = num(coinData?.equity || coinData?.walletBalance);              if (freeQty <= 0) {                 return fail(res, -432, `Nimate več ${baseCoin} na Unified računu.`);             }              const minOrderQty = num(lotFilter?.minOrderQty || '0.00001');             if (freeQty < minOrderQty) {                 return fail(res, -433, `Količina ${baseCoin} je premajhna za trgovanje (Minimum je ${minOrderQty}).`);             }              const qtyBase = floorToStep(freeQty, lotFilter?.basePrecision || '0.000001');             orderBody.qty = qtyBase;             orderBody.marketUnit = 'baseCoin';         }          const order = await bybit('POST', '/v5/order/create', { body: orderBody });         return order.ok ? ok(res, order.result, `Naročilo uspešno izvedeno!`) : fail(res, order.code, order.message);     } catch (err) {         return fail(res, -500, `Napaka strežnika: ${err.message}`);     } });
    try {
        if (!checkAuth(req, res)) return;
        const symbol = cleanSymbol(req.body?.symbol);
        const side = String(req.body?.side || '');
        const amount = num(req.body?.amount);

        if (!symbol || (side !== 'Buy' && side !== 'Sell')) {
            return fail(res, -422, 'Neveljavni podatki za naročilo.');
        }

        const tk = await publicGet('/v5/market/tickers', `category=spot&symbol=${symbol}`);
        const price = num(tk.result?.list?.[0]?.lastPrice);
        if (!price) return fail(res, -406, 'Cene ni mogoče pridobiti.');

        const inst = await publicGet('/v5/market/instruments-info', `category=spot&symbol=${symbol}`);
        const lotFilter = inst.result?.list?.[0]?.lotSizeFilter;
        
        let orderBody = { category: 'spot', symbol, side, orderType: 'Market' };

        if (side === 'Buy') {
            const qtyQuote = floorToStep(amount, lotFilter?.quotePrecision || '0.01');
            orderBody.qty = qtyQuote;
            orderBody.marketUnit = 'quoteCoin';
        } else {
            // Prodaja / Zapiranje celotne pozicije
            const rWallet = await bybit('GET', '/v5/account/wallet-balance', { query: 'accountType=UNIFIED' });
            const baseCoin = inst.result?.list?.[0]?.baseCoin || symbol.replace(/EUR|USDT|USDC/, '');
            const coinData = (rWallet.result?.list?.[0]?.coin || []).find(c => c.coin === baseCoin);
            const freeQty = num(coinData?.equity || coinData?.walletBalance);

            if (freeQty <= 0) {
                return fail(res, -432, `Nimate več ${baseCoin} na računu.`);
            }

            const qtyBase = floorToStep(freeQty, lotFilter?.basePrecision || '0.000001');
            orderBody.qty = qtyBase;
            orderBody.marketUnit = 'baseCoin';
        }

        const order = await bybit('POST', '/v5/order/create', { body: orderBody });
        return order.ok ? ok(res, order.result, `Pozicija uspešno zaključena/izvedena!`) : fail(res, order.code, order.message);
    } catch (err) {
        return fail(res, -500, `Napaka strežnika: ${err.message}`);
    }
});

app.use('*', (req, res) => res.status(404).json({ status: 'error', code: 404, message: 'Pot ne obstaja.' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 STREŽNIK TEČE NA PORTU ${PORT}`));
