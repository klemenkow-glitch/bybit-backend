app.post('/api/trade', async (req, res) => {
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
            // Preverimo, če je vnešen znesek vsaj minimalni zahtevan (običajno 1 ali 5 USD/EUR)
            const minOrderAmt = num(lotFilter?.minOrderAmt || '1');
            const finalAmount = amount < minOrderAmt ? minOrderAmt : amount;

            const qtyQuote = floorToStep(finalAmount, lotFilter?.quotePrecision || '0.01');
            orderBody.qty = qtyQuote;
            orderBody.marketUnit = 'quoteCoin';
        } else {
            // Prodaja / Zapiranje celotne pozicije z Unified računa
            const rWallet = await bybit('GET', '/v5/account/wallet-balance', { query: 'accountType=UNIFIED' });
            const baseCoin = inst.result?.list?.[0]?.baseCoin || symbol.replace(/EUR|USDT|USDC/, '');
            const coinData = (rWallet.result?.list?.[0]?.coin || []).find(c => c.coin === baseCoin);
            const freeQty = num(coinData?.equity || coinData?.walletBalance);

            if (freeQty <= 0) {
                return fail(res, -432, `Nimate več ${baseCoin} na Unified računu.`);
            }

            const minOrderQty = num(lotFilter?.minOrderQty || '0.00001');
            if (freeQty < minOrderQty) {
                return fail(res, -433, `Količina ${baseCoin} je premajhna za trgovanje (Minimum je ${minOrderQty}).`);
            }

            const qtyBase = floorToStep(freeQty, lotFilter?.basePrecision || '0.000001');
            orderBody.qty = qtyBase;
            orderBody.marketUnit = 'baseCoin';
        }

        const order = await bybit('POST', '/v5/order/create', { body: orderBody });
        return order.ok ? ok(res, order.result, `Naročilo uspešno izvedeno!`) : fail(res, order.code, order.message);
    } catch (err) {
        return fail(res, -500, `Napaka strežnika: ${err.message}`);
    }
});
