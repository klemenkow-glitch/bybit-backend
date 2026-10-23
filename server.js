const express = require('express');
const cors = require('cors');
const CryptoJS = require('crypto-js');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/balance', async (req, res) => {
    try {
        const { apiKey, apiSecret } = req.body;
        if (!apiKey || !apiSecret) {
            return res.status(400).json({ retCode: -1, retMsg: 'Manjkajo API ključi' });
        }

        const timestamp = Date.now().toString();
        const recvWindow = "5000";

        async function callBybit(accountType) {
            const queryString = `accountType=${accountType}`;
            const signOrigin = timestamp + apiKey + recvWindow + queryString;
            const signature = CryptoJS.HmacSHA256(signOrigin, apiSecret).toString(CryptoJS.enc.Hex);

            return await axios.get(`https://api.bybit.com/v5/account/wallet-balance?${queryString}`, {
                headers: {
                    'X-BAPI-API-KEY': apiKey,
                    'X-BAPI-SIGN': signature,
                    'X-BAPI-TIMESTAMP': timestamp,
                    'X-BAPI-RECV-WINDOW': recvWindow,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                validateStatus: () => true
            });
        }

        let response = await callBybit("UNIFIED");
        let data = response.data;

        if (!data || typeof data !== 'object' || data.retCode !== 0) {
            response = await callBybit("SPOT");
            data = response.data;
        }

        if (data && typeof data === 'object') {
            return res.json(data);
        } else {
            return res.status(500).json({ retCode: -500, retMsg: `Neveljaven odziv Bybita (HTTP ${response.status})` });
        }
    } catch (err) {
        return res.status(500).json({ retCode: -500, retMsg: `Napaka na strežniku: ${err.message}` });
    }
});

app.post('/api/order', async (req, res) => {
    try {
        const { apiKey, apiSecret, symbol, side, qty } = req.body;
        
        const timestamp = Date.now().toString();
        const recvWindow = "5000";
        const body = {
            category: "spot",
            symbol: symbol,
            side: side,
            orderType: "Market",
            qty: qty.toString()
        };

        const bodyString = JSON.stringify(body);
        const signOrigin = timestamp + apiKey + recvWindow + bodyString;
        const signature = CryptoJS.HmacSHA256(signOrigin, apiSecret).toString(CryptoJS.enc.Hex);

        const response = await axios.post('https://api.bybit.com/v5/order/create', body, {
            headers: {
                'Content-Type': 'application/json',
                'X-BAPI-API-KEY': apiKey,
                'X-BAPI-SIGN': signature,
                'X-BAPI-TIMESTAMP': timestamp,
                'X-BAPI-RECV-WINDOW': recvWindow,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            validateStatus: () => true
        });

        return res.json(response.data);
    } catch (err) {
        return res.status(500).json({ retCode: -500, retMsg: `Napaka pri naročilu: ${err.message}` });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Backend strežnik teče na portu ${PORT}`));
