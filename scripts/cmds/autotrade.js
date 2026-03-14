const axios = require('axios');
const crypto = require('crypto');

module.exports = {
    config: {
        name: "trade",
        version: "1.0",
        author: "VincePradas",
        countDown: 5,
        role: 0,
        shortDescription: "Automated trading on BingX",
        description: {
            en: "Command for balanced automated trading on BingX."
        },
        category: "owner",
        guide: { en: "-trade to start trading on BingX." }
    },

    onStart: async function ({ api, message }) {
        console.log("Trade command initiated.");
        const apiKey = String(process.env.BINGX_API_KEY || "").trim();
        const secretKey = String(process.env.BINGX_SECRET_KEY || "").trim();
        if (!apiKey || !secretKey)
            return message.reply("BingX credentials are missing. Set BINGX_API_KEY and BINGX_SECRET_KEY in environment variables.");

        const baseUrl = 'https://open-api.bingx.com';
        const symbol = 'BTC-USDT';  //

        const stopLossPercentage = 2;  //2% loss
        const takeProfitPercentage = 5;  // 5% gain
        const trailingStopPercentage = 1.5;

        // Function to get the parameters for the API request
        function getParameters(API, timestamp, urlEncode) {
            let parameters = "";
            for (const key in API.payload) {
                if (urlEncode) {
                    parameters += key + "=" + encodeURIComponent(API.payload[key]) + "&";
                } else {
                    parameters += key + "=" + API.payload[key] + "&";
                }
            }
            if (parameters) {
                parameters = parameters.substring(0, parameters.length - 1);
                parameters = parameters + "&timestamp=" + timestamp;
            } else {
                parameters = "timestamp=" + timestamp;
            }
            return parameters;
        }

        // execute trading strategy
        async function executeTradingStrategy() {
            try {

                const marketDataResponse = await axios.get(`${baseUrl}/v1/market/ticker`, {
                    params: { symbol: symbol }
                });

                const marketPrice = parseFloat(marketDataResponse.data[0].price);
                console.log(`Current ${symbol} market price: $${marketPrice}`);

                //stop-loss and take-profit lvls
                const stopLossPrice = marketPrice - (marketPrice * (stopLossPercentage / 100));
                const takeProfitPrice = marketPrice + (marketPrice * (takeProfitPercentage / 100));
                let trailingStopPrice = stopLossPrice;

                console.log(`Stop-Loss Price: $${stopLossPrice}`);
                console.log(`Take-Profit Price: $${takeProfitPrice}`);

                // Place order
                const quantity = 0.01;
                const testOrderParams = {
                    symbol: symbol,
                    side: 'BUY',
                    positionSide: 'LONG',
                    type: 'MARKET',
                    quantity: quantity,
                    takeProfit: JSON.stringify({
                        type: "TAKE_PROFIT_MARKET",
                        stopPrice: takeProfitPrice,
                        price: takeProfitPrice,
                        workingType: "MARK_PRICE"
                    })
                };

                const timestamp = new Date().getTime();
                const signature = crypto
                    .createHmac("sha256", secretKey)
                    .update(getParameters({ payload: testOrderParams }, timestamp))
                    .digest("hex");
                const testOrderUrl = `${baseUrl}/openApi/swap/v2/trade/order/test?${getParameters({ payload: testOrderParams }, timestamp, true)}&signature=${signature}`;

                const testOrderResponse = await axios.post(testOrderUrl, null, {
                    headers: {
                        'X-BingX-APIKey': apiKey
                    }
                });

                console.log('Demo test order placed:', testOrderResponse.data);

                // Step 4: Monitor price and adjust trailing stop
                let isPositionOpen = true;
                while (isPositionOpen) {
                    const priceResponse = await axios.get(`${baseUrl}/v1/market/ticker`, {
                        params: { symbol: symbol }
                    });
                    const currentPrice = parseFloat(priceResponse.data[0].price);

                    // Check if take-profit is reached
                    if (currentPrice >= takeProfitPrice) {
                        console.log('Take-profit target reached in demo. Selling...');
                        await placeDemoSellOrder(quantity, currentPrice);
                        isPositionOpen = false;
                        break;
                    }

                    // Update trailing stop-loss if price goes higher
                    if (currentPrice > marketPrice) {
                        trailingStopPrice = Math.max(trailingStopPrice, currentPrice - (currentPrice * (trailingStopPercentage / 100)));
                    }

                    // Check if trailing stop-loss is hit
                    if (currentPrice <= trailingStopPrice) {
                        console.log('Trailing stop-loss hit in demo. Selling...');
                        await placeDemoSellOrder(quantity, currentPrice);
                        isPositionOpen = false;
                        break;
                    }

                    console.log(`Demo Price: $${currentPrice}, Trailing Stop Price: $${trailingStopPrice}`);

                    // Sleep before checking price again
                    await sleep(10000);  // Check every 10 seconds
                }

                message.reply('Demo trading operation completed.');

            } catch (error) {
                console.error('Error executing demo trading strategy:', error);
                message.reply('An error occurred during demo trading.');
            }
        }

        // Helper function to place a sell order (Demo)
        async function placeDemoSellOrder(quantity, price) {
            const sellOrderParams = {
                symbol: symbol,
                side: 'SELL',
                positionSide: 'LONG',
                type: 'MARKET',
                quantity: quantity,
            };

            const timestamp = new Date().getTime();
            const sellOrderSignature = crypto
                .createHmac("sha256", secretKey)
                .update(getParameters({ payload: sellOrderParams }, timestamp))
                .digest("hex");
            const sellOrderUrl = `${baseUrl}/openApi/swap/v2/trade/order/test?${getParameters({ payload: sellOrderParams }, timestamp, true)}&signature=${sellOrderSignature}`;

            const sellOrderResponse = await axios.post(sellOrderUrl, null, {
                headers: {
                    'X-BingX-APIKey': apiKey
                }
            });

            console.log('Demo sell order placed:', sellOrderResponse.data);
        }

        // Helper function to sleep
        function sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        // Start the demo trading strategy
        executeTradingStrategy();
    }
};
