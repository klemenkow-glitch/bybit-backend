const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BYBIT_URL = (process.env.BYBIT_BASE_URL || 'https://api.bybit.com').trim();
const BYBIT_API_KEY = (process.env.BYBIT_API_KEY || '').trim();
const BYBIT_API_SECRET = (process.env.BYBIT_API_SECRET || '').trim();
const APP_PASSWORD = (process.env.APP_PASSWORD || '').trim();

function snippet(body) {
    try {
        const s = typeof body === 'string' ? body : JSON.stringify(body);
        return (s || '(prazno)').replace(/\s+/g, ' ').slice(0, 200);
    } catch {
        return '(ni berljivo)';
    }
}

app.get('/api/health', (req, res) => {
    res.json({
        passwordSet: APP_PASSWORD.length > 0,
        passwordLength: APP_PASSWORD.length,
        keySet: BYBIT_API_KEY.length > 0,
        keyLength: BYBIT_API_KEY.length,
        secretSet: BYBIT_API_SECRET.length > 0,
        secretLength: BYBIT_API_SECRET.length
    });
});

// Diagnostika: javni klic brez ključa + IP strežnika
app.get('/api/diag', async (req, res) => {
    const out = {};
    try {
        const r = await axios.get(`${BYBIT_URL}/v5/market/time`, { timeout: 15000, validateStatus: () => true });
        out.bybitPublicStatus = r.status;
        out.bybitPublicBody = snippet(r.data);
    } catch (e) {
        out.bybitPublicError = e.message;
    }
    try {
        const ip = await axios.get('https://api.ipify.org?format=json', { timeout: 10000 });
        out.serverIp = ip.data.ip;
    } catch (e) {
        out.serverIpError = e.message;
    }
    res.json(out);
});

app.post('/api/balance', async (req, res) => {
    try {
        const sentPassword = String(req.body?.password || '').trim();

        if (!APP_PASSWORD || sentPassword !== APP_PASSWORD) {
            return res.status(401).json({ status: 'error', code: 401, message: 'Napačno geslo.' });
        }
        if (!BYBIT_API_KEY || !BYBIT_API_SECRET) {
            return res.json({ status: 'error', code: -400, message: 'Na strežniku manjkata BYBIT_API_KEY / BYBIT_API_SECRET.' });
        }

        const timestamp = Date.now().toString();
        const recvWindow = '10000';
        const queryString = 'accountType=UNIFIED';
        const signature = crypto
            .createHmac('sha256', BYBIT_API_SECRET)
            .update(timestamp + BYBIT_API_KEY + recvWindow + queryString)
            .digest('hex');

        const response = await axios.get(
            `${BYBIT_URL}/v5/account/wallet-balance?${queryString}`,
            {
                headers: {
                    'X-BAPI-API-KEY': BYBIT_API_KEY,
                    'X-BAPI-SIGN': signature,
                    'X-BAPI-TIMESTAMP': timestamp,
                    'X-BAPI-RECV-WINDOW': recvWindow
                },
                timeout: 15000,
                validateStatus: () => true
            }
        );

        const data = response.data;
        if (!data || typeof data !== 'object') {
            return res.json({
                status: 'error',
                code: response.status,
                message: `Bybit ni vrnil JSON (HTTP ${response.status}). Odgovor: ${snippet(data)}`
            });
        }
        if (data.retCode === 0) {
            return res.json({ status: 'success', code: 0, message: 'Povezano uspešno!', data: data.result });
        }
        return res.json({ status: 'error', code: data.retCode ?? -1, message: data.retMsg || 'Neznana napaka pri Bybitu' });
    } catch (err) {
        return res.json({ status: 'error', code: -500, message: `Napaka strežnika: ${err.message}` });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Strežnik teče na portu ${PORT}`));
