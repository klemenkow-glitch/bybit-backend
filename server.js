const express = require('express');
const cors = require('cors');
const CryptoJS = require('crypto-js');

const app = express();
app.use(cors());
app.use(express.json());

// Pridobivanje stanja na računu
app.post('/api/balance', async (req, res) => {
    const { apiKey, apiSecret } = req.body;
    if (!apiKey || !apiSecret) {
        return res.status(400).json({ error: 'Manjkajo ključi' });
    }

    const timestamp = Date.now().toString();
    const recvWindow = "5000";
    const queryString = "accountType=UNIFIED";
    const signOrigin = timestamp + apiKey + recvWindow + queryString;
    const signature = CryptoJS.HmacSHA256(signOrigin, apiSecret).toString(CryptoJS.enc.Hex);

    try {
        let response = await fetch(`https://api.bybit.com/v5/account/wallet-balance?${queryString}`, {
            method: 'GET',
            headers: {
                'X-BAPI-API-KEY': apiKey,
                'X-BAPI-SIGN': signature,
                'X-BAPI-TIMESTAMP': timestamp,
                'X-BAPI-RECV-WINDOW': recvWindow
            }
        });
        let data = await response.json();

        // Če je račun klasičen SPOT in ne UNIFIED
        if (data.retCode !== 0) {
            const querySpot = "accountType=SPOT";
            const signSpot = timestamp + apiKey + recvWindow + querySpot;
            const sigSpotHex = CryptoJS.HmacSHA256(signSpot, apiSecret).toString(CryptoJS.enc.Hex);

            response = await fetch(`https://api.bybit.com/v5/account/wallet-balance?${querySpot}`, {
                method: 'GET',
                headers: {
                    'X-BAPI-API-KEY': apiKey,
                    'X-BAPI-SIGN': sigSpotHex,
                    'X-BAPI-TIMESTAMP': timestamp,
                    'X-BAPI-RECV-WINDOW': recvWindow
                }
            });
            data = await response.json();
        }

        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Izvedba trgovalnega naročila
app.post('/api/order', async (req, res) => {
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

    try {
        const response = await fetch('https://api.bybit.com/v5/order/create', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-BAPI-API-KEY': apiKey,
                'X-BAPI-SIGN': signature,
                'X-BAPI-TIMESTAMP': timestamp,
                'X-BAPI-RECV-WINDOW': recvWindow
            },
            body: bodyString
        });
        const data = await response.json();
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend strežnik teče na portu ${PORT}`));
