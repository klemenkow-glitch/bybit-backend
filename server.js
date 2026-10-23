const express = require('express');
const cors = require('cors');
const CryptoJS = require('crypto-js');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Zahteva za stanje denarnice
app.post('/api/balance', async (req, res) => {
    try {
        const { apiKey, apiSecret } = req.body;
        if (!apiKey || !apiSecret) {
            return res.status(400).json({ retCode: -1, retMsg: 'Manjkajo API ključi' });
        }

        const timestamp = Date.now().toString();
        const recvWindow = "5000";
        
        // Najprej poskusimo z UNIFIED računom
        let queryString = "accountType=UNIFIED";
        let signOrigin = timestamp + apiKey + recvWindow + queryString;
        let signature = CryptoJS.HmacSHA256(signOrigin, apiSecret).toString(CryptoJS.enc.Hex);

        let response = await axios.get(`https://api.bybit.com/v5/account/wallet-balance?${queryString}`, {
            headers: {
                'X-BAPI-API-KEY': apiKey,
                'X-BAPI-SIGN': signature,
                'X-BAPI-TIMESTAMP': timestamp,
                'X-BAPI-RECV-WINDOW': recvWindow
            },
            validateStatus: () => true
        });

        let data = response.data;

        // Če UNIFIED ni omogočen ali vrne napako, poskusimo s SPOT
        if (!data || data.retCode !== 0) {
            queryString = "accountType=SPOT";
            signOrigin = timestamp + apiKey + recvWindow + queryString;
            signature = CryptoJS.HmacSHA256(signOrigin, apiSecret).toString(CryptoJS.enc.Hex);

            response = await axios.get(`https://api.bybit.com/v5/account/wallet-balance?${queryString}`, {
                headers: {
                    'X-BAPI-API-KEY': apiKey,
                    'X-BAPI-SIGN': signature,
                    'X-BAPI-TIMESTAMP': timestamp,
                    'X-BAPI-RECV-WINDOW': recvWindow
                },
                validateStatus: () => true
            });
            data = response.data;
        }

        return res.json(data);
    } catch (err) {
        return res.status(500).json({ retCode: -500, retMsg: `Napaka na strežniku: ${err.message}` });
    }
});

// Zahteva za izvedbo naročila
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
                'X-BAPI-RECV-WINDOW': recvWindow
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
