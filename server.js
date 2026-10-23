const express = require('express');
const cors = require('cors');
const CryptoJS = require('crypto-js');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Seznam Bybitovih alternativnih domenskih točk
const BYBIT_ENDPOINTS = [
    'https://api.bytick.com',
    'https://api.bybit.com'
];

app.post('/api/balance', async (req, res) => {
    try {
        const { apiKey, apiSecret } = req.body;
        if (!apiKey || !apiSecret) {
            return res.status(400).json({ retCode: -1, retMsg: 'Manjkajo API ključi' });
        }

        const timestamp = Date.now().toString();
        const recvWindow = "5000";

        async function callBybit(accountType, baseUrl) {
            const queryString = `accountType=${accountType}`;
            const signOrigin = timestamp + apiKey + recvWindow + queryString;
            const signature = CryptoJS.HmacSHA256(signOrigin, apiSecret).toString(CryptoJS.enc.Hex);

            return await axios.get(`${baseUrl}/v5/account/wallet-balance?${queryString}`, {
                headers: {
                    'X-BAPI-API-KEY': apiKey,
                    'X-BAPI-SIGN': signature,
                    'X-BAPI-TIMESTAMP': timestamp,
                    'X-BAPI-RECV-WINDOW': recvWindow,
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                },
                validateStatus: () => true,
                timeout: 10000
            });
        }

        let data = null;
        let lastStatus = 500;

        // Poskusimo preko obeh domenskih točk
        for (const baseUrl of BYBIT_ENDPOINTS) {
            let response = await callBybit("UNIFIED", baseUrl);
            lastStatus = response.status;
            data = response.data;

            if (data && typeof data === 'object' && data.retCode === 0) {
                return res.json(data);
            }

            // Če UNIFIED ne vrne 0, poskusimo s SPOT
            response = await callBybit("SPOT", baseUrl);
            lastStatus = response.status;
            data = response.data;

            if (data && typeof data === 'object' && data.retCode === 0) {
                return res.json(data);
            }
        }

        if (data && typeof data === 'object') {
            return res.json(data);
        } else {
            return res.status(500).json({ retCode: -500, retMsg: `Neveljaven odziv Bybita (HTTP ${lastStatus})` });
        }
    } catch (err) {
        return res.status(500).json({ retCode: -500, retMsg: `Strežniška napaka: ${err.message}` });
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

        let response = null;
        for (const baseUrl of BYBIT_ENDPOINTS) {
            response = await axios.post(`${baseUrl}/v5/order/create`, body, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-BAPI-API-KEY': apiKey,
                    'X-BAPI-SIGN': signature,
                    'X-BAPI-TIMESTAMP': timestamp,
                    'X-BAPI-RECV-WINDOW': recvWindow,
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                },
                validateStatus: () => true,
                timeout: 10000
            });

            if (response.data && response.data.retCode === 0) {
                break;
            }
        }

        return res.json(response.data);
    } catch (err) {
        return res.status(500).json({ retCode: -500, retMsg: `Napaka pri naročilu: ${err.message}` });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Backend strežnik teče na portu ${PORT}`));
