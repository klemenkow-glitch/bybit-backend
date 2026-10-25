const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BYBIT_URL = 'https://api.bybit.com'; // MAINNET
const { BYBIT_API_KEY, BYBIT_API_SECRET, APP_PASSWORD } = process.env;

app.post('/api/balance', async (req, res) => {
    try {
        if (!APP_PASSWORD || req.body?.password !== APP_PASSWORD) {
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
            return res.json({ status: 'error', code: response.status,
                message: `Bybit ni vrnil JSON (HTTP ${response.status}). Verjetno blokada regije/IP strežnika.` });
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
