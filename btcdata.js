const moment = require("moment");
const fs = require("fs");
const rp = require('request-promise');
const redis = require("./redis");
const WebSocket = require('ws'); 
let wssUrl = "wss://stream.binance.com:9443/stream?streams=btcusdt@aggTrade/btcusdt@depth20@100ms";
// 本地 Orderbook 副本
let orderbook = {
    bids: {},
    asks: {}
};
// 缓存更新
let cachedUpdates = [];
// 定义全局 lastUpdateId
let ws;
let timeConnect = 0;
let lockReconnect = false; //避免ws重复连接

class Runner {

    async run() {
        await redis.connect();
        function createWebSocket(){
        try {
            ws = new WebSocket(wssUrl);
            websocketInit();
        } catch (e) {
            console.log('catch');
            websocketReconnect(wssUrl);
        }
        }
        createWebSocket();          // 创建websocket
        function websocketInit () {      
        ws.onopen = function (evt) { // 建立 web socket 连接成功触发事件
            onOpen(evt);
        };      
        ws.onclose = function (evt) {  // 断开 web socket 连接成功触发事件
            onClose(evt);  
            websocketReconnect(wssUrl);          
        };      
        ws.onmessage = function (evt) {  // 接收服务端数据时触发事件
            onMessage(evt);
        };      
        ws.onerror = function (evt) {  // 通信发生错误时触发
            websocketReconnect(wssUrl);
            onError(evt);
        };
        };

        function onOpen(evt) {
        console.log("建立连接");
        //心跳检测重置
        heartCheck.start();
        console.log("biannce ws连接成功----");
        }

        function onClose(evt) {
            console.log("连接已关闭...");
        }

        const onMessage = async (event) =>{   
            heartCheck.reset();
          //  console.log(`\n[${moment().format("YYYY-MM-DD HH:mm:ss")}] Binance`);
            let res = JSON.parse(event.data);
        // console.log(res);
            if (res) {
                if(res.stream.includes("@aggTrade")){
                let data_json = res.data;
               // console.log("$$$$$$$$$",res.data);  
                let timestamp = data_json.T;
                let ID = data_json.a;
                let price = data_json.p;
                let quantity = data_json.q;
                let type = "1";
                if(data_json.m){
                    type="2";
                }
                let TradeInfo= {timestamp,price,quantity,type}
                await redis.set("BtcTrade:"+ID,JSON.stringify(TradeInfo),60*5);
                await redis.zadd('BtcTrade_orderid', ID, `BtcTrade:${ID}`);

              //  console.log(Date.now(),"BtcTrade saved");
                }  

                if(res.stream.includes("@depth20@100ms")){
                    if(!res.data){
                        return false;
                    }
                    // console.log(res.data);
                    // console.log(typeof(res.data));
                    let timestamp=Date.now();
                    let key = 'orderbook:'+ timestamp;
                    // let key = 'orderbook:8';
                    let orderbook = res.data;
                    await redis.set(key, JSON.stringify(orderbook),60*5);
                    await redis.zadd('orderbook_timestamps', timestamp.toString(), key);

                }
    
    
    
            
            }

        }


        function onError(evt) {
        console.log('通信错误' + evt);
        }


        function websocketReconnect() {
            if (lockReconnect) {  return;};     // 是否已经执行重连
            timeConnect ++;
            console.log("第"+timeConnect+"次重连");        
            lockReconnect = true;
            tt && clearTimeout(tt);
            var tt = setTimeout(function () {
                createWebSocket();
                lockReconnect = false;
            }, 1000);
        }
        //心跳检测
        var heartCheck = {
            timeout: 20000,
            timeoutObj:null,
            serverTimeoutObj:null,
            reset:function(){
                clearTimeout(this.timeoutObj);
                clearTimeout(this.serverTimeoutObj);
                this.start();
            },
            start: function(){
                var self = this;
                this.timeoutObj = setTimeout(function(){
                    //ws.send("pong");
                    ws.pong();
                    console.log("send pong---");
                    self.serverTimeoutObj = setTimeout(function(){ //如果超过一定时间还没重置，说明后端主动断开了
                        ws.close();//如果onclose会执行reconnect，我们执行ws.close()就行了.如果直接执行reconnect 会触发onclose导致重连两次
                    }, self.timeout)
                }, this.timeout)
            },
        }  

    }
}


let ba = new Runner();
module.exports = ba;


ba.run();

