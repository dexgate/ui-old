var Immutable = require("immutable");
var alt = require("../alt-instance");
var MarketsActions = require("../actions/MarketsActions");
var SettingsActions = require("../actions/SettingsActions");
var market_utils = require("../common/market_utils");
import utils from "common/utils";

import {
    LimitOrder,
    ShortOrder,
    CallOrder
}
from "./tcomb_structs";

class MarketsStore {
    constructor() {
        this.markets = Immutable.Map();
        this.asset_symbol_to_id = {};
        this.pendingOrders = Immutable.Map();
        this.activeMarketLimits = Immutable.Map();
        this.activeMarketCalls = Immutable.Map();
        this.activeMarketSettles = Immutable.Map();
        this.activeMarketHistory = Immutable.Map();
        this.bids = [];
        this.asks = [];
        this.flat_bids = [];
        this.totalBids = 0;
        this.flat_asks = [];
        this.priceData = [];
        this.volumeData = [];
        this.pendingCreateLimitOrders = [];
        this.pendingCancelLimitOrders = {};
        this.activeMarket = null;
        this.inverseMarket = true;
        this.quoteAsset = null;
        this.pendingCounter = 0;
        this.bucketSize = 60;
        this.priceHistory = [];

        this.baseAsset = {
            id: "1.3.0",
            symbol: "CORE",
            precision: 5
        };

        this.bindListeners({
            onSubscribeMarket: MarketsActions.subscribeMarket,
            onUnSubscribeMarket: MarketsActions.unSubscribeMarket,
            onGetMarkets: MarketsActions.getMarkets,
            onChangeBase: MarketsActions.changeBase,
            onInverseMarket: SettingsActions.changeSetting,
            onChangeBucketSize: MarketsActions.changeBucketSize
        });
    }

    onInverseMarket(payload) {
        if (payload.setting === "inverseMarket") {
            this.inverseMarket = payload.value;

            // TODO: Handle market inversion
        } else {
            return false;
        }
    }

    onChangeBase(market) {
        this.baseAsset = market;
    }

    onChangeBucketSize(size) {
        this.bucketSize = size;
    }

    onUnSubscribeMarket(payload) {

        // Optimistic removal of activeMarket
        if (payload.unSub) {
            this.activeMarket = null;
        } else { // Unsub failed, restore activeMarket
            this.activeMarket = payload.market;
        }
    }

    onSubscribeMarket(result) {
        console.log("onSubscribeMarket:", result, this.activeMarket);
        if (result.market && (result.market !== this.activeMarket)) {
            console.log("switch active market from", this.activeMarket, "to", result.market);
            this.activeMarket = result.market;
            this.quoteAsset = {
                id: result.quote.id,
                precision: result.quote.precision
            };
            this.baseAsset = {
                id: result.base.id,
                symbol: result.base.symbol,
                precision: result.base.precision
            };
            this.activeMarketLimits = this.activeMarketLimits.clear();
            this.activeMarketCalls = this.activeMarketCalls.clear();
            this.activeMarketSettles = this.activeMarketSettles.clear();
            this.activeMarketHistory = this.activeMarketHistory.clear();
            this.bids = [];
            this.asks = [];
            this.pendingCreateLimitOrders = [];
            this.flat_bids = [];
            this.flat_asks = [];
            this.priceHistory =[];
        }

        if (result.limits) {
            // Keep an eye on this as the number of orders increases, it might not scale well
            let limitStart = new Date();
            this.activeMarketLimits = this.activeMarketLimits.clear();
            result.limits.forEach(order => {
                order.for_sale = parseInt(order.for_sale, 10);
                order.expiration = new Date(order.expiration);
                this.activeMarketLimits = this.activeMarketLimits.set(
                    order.id,
                    LimitOrder(order)
                );
            });

            // Loop over pending orders to remove temp order from orders map and remove from pending
            for (let i = this.pendingCreateLimitOrders.length - 1; i >= 0; i--) {
                let myOrder = this.pendingCreateLimitOrders[i];
                let order = this.activeMarketLimits.find((order, key) => {
                    return myOrder.seller === order.seller && myOrder.expiration === order.expiration;
                });

                // If the order was found it has been confirmed, delete it from pending
                if (order) {
                    this.pendingCreateLimitOrders.splice(i, 1);
                }
            }

            if (this.pendingCreateLimitOrders.length === 0) {
                this.pendingCounter = 0;
            }

            console.log("time to process limit orders:", new Date() - limitStart, "ms");
        }

        if (result.calls) {
            result.calls.forEach(call => {
                if (typeof call.collateral === "string") {
                    call.collateral = parseInt(call.collateral, 10);
                }
                this.activeMarketCalls = this.activeMarketCalls.set(
                    call.id,
                    CallOrder(call)
                );
            });
        }

        if (result.settles) {
            result.settles.forEach(settle => {
                settle.expiration = new Date(settle.expiration);
                this.activeMarketSettles = this.activeMarketSettles.set(
                    settle.id,
                    ShortOrder(settle)
                );
            });
        }

        if (result.fillOrders) {
            result.fillOrders.forEach(fill => {
                console.log("fill:", fill);
                this.activeMarketHistory = this.activeMarketHistory.set(
                    fill[0][1].order_id,
                    fill[0][1]
                );
            });
        }

        // Update orderbook
        this._orderBook();

        // Update depth chart data
        this._depthChart();

        // Update pricechart data
        if (result.price) {
            this.priceHistory = result.price;
            this._priceChart();
        }
        // if (result.sub) {
        //     result.sub.forEach(newOrder => {
        //         let {order, orderType} = market_utils.parse_order(newOrder);

        //         switch (orderType) {
        //             case "limit_order":
        //                 this.activeMarketLimits = this.activeMarketLimits.set(
        //                     order.id,
        //                     LimitOrder(order)
        //                 );
        //                 break;

        //             case "short_order":
        //                 this.activeMarketShorts = this.activeMarketShorts.set(
        //                     order.id,
        //                     ShortOrder(order)
        //                 );
        //                 break;

        //             default:
        //                 break;
        //         }

        //     });

        // }

    }

    // onCreateLimitOrder(e) {
    //     this.pendingCounter++;
    //     if (e.newOrder) { // Optimistic update
    //         e.newOrder.id = `${e.newOrder.seller}_${this.pendingCounter}`;
    //         this.pendingCreateLimitOrders.push({id: e.newOrder.id, seller: e.newOrder.seller, expiration: e.newOrder.expiration});
    //         e.newOrder.for_sale = parseInt(e.newOrder.for_sale, 10);
    //         e.newOrder.expiration = new Date(e.newOrder.expiration);
    //         this.activeMarketLimits = this.activeMarketLimits.set(
    //             e.newOrder.id,
    //             LimitOrder(e.newOrder)
    //         );
    //     }

    //     if (e.failedOrder) { // Undo order if failed
    //         let uid;
    //         for (var i = this.pendingCreateLimitOrders.length - 1; i >= 0; i--) {
    //             if (this.pendingCreateLimitOrders[i].expiration === e.failedOrder.expiration) {
    //                 console.log("found failed order to remove", this.pendingCreateLimitOrders[i]);
    //                 uid = this.pendingCreateLimitOrders[i].id;
    //                 this.pendingCreateLimitOrders.splice(i, 1);
    //                 this.activeMarketLimits = this.activeMarketLimits.delete(uid);
    //                 break;
    //             }
    //         }

    //         if (this.pendingCreateLimitOrders.length === 0) {
    //             this.pendingCounter = 0;
    //         }
    //     }

    //     // Update orderbook
    //     this._orderBook();

    //     // Update depth chart data
    //     this._depthChart();

    // }

    // onCancelLimitOrder(e) {
    //     if (e.newOrderID) { // Optimistic update
    //         this.pendingCancelLimitOrders[e.newOrderID] = this.activeMarketLimits.get(e.newOrderID);
    //         this.activeMarketLimits = this.activeMarketLimits.delete(e.newOrderID);
    //     }

    //     if (e.failedOrderID) { // Undo removal if cancel failed
    //         this.activeMarketLimits = this.activeMarketLimits.set(
    //             e.failedOrderID,
    //             this.pendingCancelLimitOrders[e.failedOrderID]
    //         );

    //         delete this.pendingCancelLimitOrders[e.failedOrderID];
    //     }

    //     // Update orderbook
    //     this._orderBook();

    //     // Update depth chart data
    //     this._depthChart();

    // }

    onGetMarkets(markets) {
        markets.forEach(market => {
            this.markets = this.markets.set(
                market.id,
                market);
        });
    }

    _priceChart() {
        let volumeData = [];
        let price = [];

        // Fake data
        // priceData = [
        //     {time: new Date(2015, 5, 26, 14, 30).getTime(), open: 1, close: 1.5, high: 1.7, low: 1, volume: 10000},
        //     {time: new Date(2015, 5, 26, 15, 0).getTime(), open: 1.5, close: 1.6, high: 1.6, low: 1.4, volume: 15000},
        //     {time: new Date(2015, 5, 26, 15, 30).getTime(), open: 1.6, close: 1.4, high: 1.7, low: 1.4, volume: 8000},
        //     {time: new Date(2015, 5, 26, 16, 0).getTime(), open: 1.4, close: 1.4, high: 1.4, low: 1.1, volume: 20000},
        //     {time: new Date(2015, 5, 26, 16, 30).getTime(), open: 1.4, close: 1.5, high: 1.7, low: 1.3, volume: 17000},
        //     {time: new Date(2015, 5, 26, 17, 0).getTime(), open: 1.5, close: 1.35, high: 1.5, low: 1.3, volume: 25000},
        //     {time: new Date(2015, 5, 26, 17, 30).getTime(), open: 1.35, close: 1.5, high: 1.55, low: 1.33, volume: 32000},
        //     {time: new Date(2015, 5, 26, 18, 0).getTime(), open: 1.5, close: 1.8, high: 1.84, low: 1.5, volume: 37000},
        //     {time: new Date(2015, 5, 26, 18, 30).getTime(), open: 1.8, close: 1.99, high: 1.99, low: 1.76, volume: 54000}
        // ]

        // for (var i = 0; i < priceData.length; i++) {
        //     price.push([priceData[i].time, priceData[i].open, priceData[i].high, priceData[i].low, priceData[i].close]);
        //     volume.push([priceData[i].time, priceData[i].volume]);
        // };

        // Real data
        // console.log("priceData:", this.priceHistory);
        let open, high, low, close, volume;
        
        for (var i = 0; i < this.priceHistory.length; i++) {
            let date = new Date(this.priceHistory[i].key.open).getTime();
            if (this.quoteAsset.id === this.priceHistory[i].key.quote) {
                high = utils.get_asset_price(this.priceHistory[i].high_base, this.baseAsset, this.priceHistory[i].high_quote, this.quoteAsset);
                low = utils.get_asset_price(this.priceHistory[i].low_base, this.baseAsset, this.priceHistory[i].low_quote, this.quoteAsset);
                open = utils.get_asset_price(this.priceHistory[i].open_base, this.baseAsset, this.priceHistory[i].open_quote, this.quoteAsset);
                close = utils.get_asset_price(this.priceHistory[i].close_base, this.baseAsset, this.priceHistory[i].close_quote, this.quoteAsset);
                volume = utils.get_asset_amount(this.priceHistory[i].quote_volume, this.quoteAsset);
            } else {
                low = utils.get_asset_price(this.priceHistory[i].high_quote, this.baseAsset, this.priceHistory[i].high_base, this.quoteAsset);
                high = utils.get_asset_price(this.priceHistory[i].low_quote, this.baseAsset, this.priceHistory[i].low_base, this.quoteAsset);
                open = utils.get_asset_price(this.priceHistory[i].open_quote, this.baseAsset, this.priceHistory[i].open_base, this.quoteAsset);
                close = utils.get_asset_price(this.priceHistory[i].close_quote, this.baseAsset, this.priceHistory[i].close_base, this.quoteAsset);
                volume = utils.get_asset_amount(this.priceHistory[i].base_volume, this.quoteAsset);
            }

            price.push([date, open, high, low, close]);
            volumeData.push([date, volume]);
        }

        this.priceData = price;
        this.volumeData = volumeData;

    }

    _orderBook() {

        // var bidStart = new Date();
        let asks = [], bids = [];

        // Loop over limit orders and return array containing bids with formatted values
        this.activeMarketLimits.filter(a => {
            return a.sell_price.base.asset_id === this.baseAsset.id;
        }).sort((a, b) => {
            let {price: a_price} = market_utils.parseOrder(a, this.baseAsset, this.quoteAsset);
            let {price: b_price} = market_utils.parseOrder(b, this.baseAsset, this.quoteAsset);

            return a_price.full - b_price.full;
        }).map(order => {
            // let isAskOrder = market_utils.isAsk(order, this.baseAsset);
            let {value, price, amount} = market_utils.parseOrder(order, this.baseAsset, this.quoteAsset);
            bids.push({
                value: value,
                price_full: price.full,
                price_dec: price.dec,
                price_int: price.int,
                amount: amount
            });
        });

        // Sum bids at same price
        for (let i = bids.length - 2; i >= 0; i--) {
            if (bids[i].price_full === bids[i + 1].price_full) {
                bids[i].amount += bids[i + 1].amount;
                bids[i].value += bids[i + 1].value;
                bids.splice(i + 1, 1);
            }
        }


        // console.log("store bids time taken:", new Date() - bidStart, "ms");

        // let askStart = new Date();

        // Loop over limit orders and return array containing asks with formatted values
        this.activeMarketLimits.filter(a => {
            return a.sell_price.base.asset_id !== this.baseAsset.id;
        }).sort((a, b) => {
            let {price: a_price} = market_utils.parseOrder(a, this.baseAsset, this.quoteAsset);
            let {price: b_price} = market_utils.parseOrder(b, this.baseAsset, this.quoteAsset);

            return a_price.full - b_price.full;
        }).map(order => {
            // let isAskOrder = market_utils.isAsk(order, this.baseAsset);
            let {value, price, amount} = market_utils.parseOrder(order, this.baseAsset, this.quoteAsset);
            asks.push({
                value: value,
                price_full: price.full,
                price_dec: price.dec,
                price_int: price.int,
                amount: amount
            });
        });

        // Sum asks at same price
        for (let i = asks.length - 2; i >= 0; i--) {
            if (asks[i].price_full === asks[i + 1].price_full) {
                asks[i].amount += asks[i + 1].amount;
                asks[i].value += asks[i + 1].value;
                asks.splice(i + 1, 1);
            }
        }

        // Assign to store variables
        this.bids = bids;
        this.asks = asks;

        // console.log("store asks time taken:", new Date() - askStart, "ms");
    }

    _depthChart() {
        // let depthStart = new Date();

        let bids = [], asks = [], totalBids = 0;
        if (this.activeMarketLimits) {

            this.bids.map(order => {

                // d3 format
                // bids.push({
                //     x: order.,
                //     y: order.amount
                // });

                // highcharts format
                bids.push([order.price_full, order.amount]);
                totalBids += order.value;
            });

            // console.log("store depth bids time taken:", new Date() - depthStart, "ms");

            // let askStart = new Date();

            this.asks.map(order => {

                // d3 format
                // asks.push({
                //     x: order.,
                //     y: order.amount
                // });
                // highcharts format

                asks.push([order.price_full, order.amount]);

            });

            // console.log("store depth asks time taken:", new Date() - askStart, "ms");

            // Make sure the arrays are sorted properly
            asks.sort((a, b) => {
                return a[0] - b[0];
            });

            bids.sort((a, b) => {
                return a[0] - b[0];
            });


            // Flatten the arrays to get the step plot look
            let flat_bids = market_utils.flatten_orderbookchart_highcharts(bids, true, true, 1000);
            if (flat_bids.length > 0) {
                flat_bids.unshift([0, flat_bids[0][1]]);
            }
            let flat_asks = market_utils.flatten_orderbookchart_highcharts(asks, true, false, 1000);

            if (flat_asks.length > 0) {
                flat_asks.push([flat_asks[flat_asks.length - 1][0] * 1.5, flat_asks[flat_asks.length - 1][1]]);
            }

            // react-d3-components area chart hack
            // let bidsLength = flat_bids.length;
            // let asksLength = flat_asks.length;

            // for (let i = 0; i < asksLength; i++) {
            //     if (i === asksLength - 1) {
            //         flat_bids.push({x: flat_bids[i].x, y: 0});    
            //     }
            //     flat_bids.push({x: flat_asks[i].x, y: 0});
            // }

            // for (let i = bidsLength; i >= 0; i--) {
            //     flat_asks.unshift({x: flat_bids[i].x, y: 0});
            // }

            // Assign to store variables
            this.flat_asks = flat_asks;
            this.flat_bids = flat_bids;
            this.totalBids = totalBids;

            // console.log("store depth chart time taken:", new Date() - askStart, "ms");

        }
    }
}

module.exports = alt.createStore(MarketsStore, "MarketsStore");
