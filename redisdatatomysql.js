const redis = require('./redis');
const ProgressBar = require('progress');

const BATCH_SIZE = 60; // 每批处理的数据条数
const mysql = require('mysql2/promise');

const connection = mysql.createPool({
  host: 'localhost',
  user: 'yh',
  password: 'marskiller',
  database: 'btcdata',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

async function getTradeDataWithRetry(start, end, retries = 3, delay = 200) {
  for (let i = 0; i < retries; i++) {
    const trades = await getTradeData(start, end);
    //console.log("trades=",trades);
    if (trades.length > 0) {
      return trades;
    }
    console.log(`No trade data found from ${start} to ${end}. Retrying in ${delay}ms...`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  return [];
}

async function getTradeData(startOrderId, endOrderId) {
  // 获取指定范围内的所有键
  const keys = await redis.zrangebyscore('BtcTrade_orderid', startOrderId, endOrderId);

  // 使用 Promise.all 来并发获取和处理数据
  const trades = await Promise.all(keys.map(async (key) => {
    try {
      // 获取每个键对应的数据
      let tradedata = await redis.get(key);
      if (tradedata) {
        let tradeData = JSON.parse(tradedata);
        tradeData.orderid = key.split(':')[1];
        tradeData.timestamp = parseInt(tradeData.timestamp);
        tradeData.price = parseFloat(tradeData.price);
        tradeData.quantity = parseFloat(tradeData.quantity);
        tradeData.type_buysell = tradeData.type;
        return tradeData;
      } else {
        console.error(`Key ${key} trades is null`);
        return null;
      }
    } catch (error) {
      console.error(`Error processing key ${key}:`, error);
      return null;
    }
  }));

  // 过滤掉空值（如果有任何 key 处理失败）
  return trades.filter(trade => trade !== null);
}

async function getAdjacentOrderbooksWithRetry(timestamp, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    const { prevOrderbook, nextOrderbook,prev_timestamp, next_timestamp  } = await getAdjacentOrderbooks(timestamp);
    if (prevOrderbook && nextOrderbook) {
      return { prevOrderbook, nextOrderbook,prev_timestamp, next_timestamp  };
    }
    // 如果未找到相邻的 orderbook 数据，等待一段时间后重试
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  console.log(timestamp,'附近orderbook数据缺失');
  return {};
}

async function getAdjacentOrderbooks(timestamp) {
  try {
    const prevOrderbookKey = await redis.zrevrangebyscore('orderbook_timestamps', timestamp, '-inf', { offset: 0, count: 1 });
    const nextOrderbookKey = await redis.zrangebyscore('orderbook_timestamps', timestamp, '+inf', { offset: 0, count: 1 });

    let prevOrderbook = null;
    let nextOrderbook = null;
    let prev_timestamp = null;
    let next_timestamp = null;

    if (prevOrderbookKey.length > 0) {
      const prevOrderbookData = await redis.get(prevOrderbookKey[0]);
      if(prevOrderbookData){
        prevOrderbook = JSON.parse(prevOrderbookData);
        prev_timestamp = parseInt(prevOrderbookKey[0].split(':')[1]);
      }
    }

    if (nextOrderbookKey.length > 0) {
      const nextOrderbookData = await redis.get(nextOrderbookKey[0]);
      if(nextOrderbookData){
        nextOrderbook = JSON.parse(nextOrderbookData);
        next_timestamp = parseInt(nextOrderbookKey[0].split(':')[1]);
      }
    }

    return { prevOrderbook, nextOrderbook,prev_timestamp, next_timestamp  };
  } catch (error) {
    console.error('Error fetching adjacent orderbooks:', error);
    return { prevOrderbook: null, nextOrderbook: null };
  }
}

async function saveToMySQL(trade) {
  // const connection = await pool.getConnection();
  try {
        // 定义基础列数组
       // console.log(trade);
        const baseColumns = ['id', 'timestamp', 'price', 'quantity', 'type_buysell', 'prev_timestamp', 'next_timestamp'];
        const columns = [...baseColumns];
        const values = [trade.orderid, trade.timestamp, trade.price, trade.quantity, trade.type, trade.prev_timestamp, trade.next_timestamp];
    
        // 使用循环生成动态列和对应的值
        for (let i = 1; i <= 20; i++) {
          columns.push(
            `prev_bid_${i}_price`, `prev_bid_${i}_quantity`, `prev_ask_${i}_price`, `prev_ask_${i}_quantity`,
            `next_bid_${i}_price`, `next_bid_${i}_quantity`, `next_ask_${i}_price`, `next_ask_${i}_quantity`
          );
    
          values.push(
            trade[`prev_bid_${i}_price`], trade[`prev_bid_${i}_quantity`], trade[`prev_ask_${i}_price`], trade[`prev_ask_${i}_quantity`],
            trade[`next_bid_${i}_price`], trade[`next_bid_${i}_quantity`], trade[`next_ask_${i}_price`], trade[`next_ask_${i}_quantity`]
          );
        }
    
        // 检查列和值数量是否匹配
        if (columns.length !== values.length) {
          console.error('Columns and values length mismatch:', columns.length, values.length);
          return;
        }
        // 构建 SQL 查询
        const query = `
          INSERT INTO tftdata (${columns.join(', ')})
          VALUES (${columns.map(() => '?').join(', ')})
        `;
    
       // console.log('SQL Query:', query);
    
        // 执行插入操作
        // console.log(values);
        await connection.query(query, values);
        const key = `tftdata:${trade.orderid}`;
        await redis.zadd('tftdata_orderid', trade.orderid, key);

    return true;
  } catch (error) {
    console.error('Error saving trade to MySQL:', error);
    return false;
  } finally {
    // connection.release();
  }
}

async function processBatch(startOrderId, endOrderId) {
  const currentDateTime = new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" });
  console.log(`[${currentDateTime}] Fetching trade data starting from ${startOrderId} to ${endOrderId}...`);
  const trades = await getTradeDataWithRetry(startOrderId, endOrderId);

  if (trades.length === 0) {
    console.log('No trades fetched. Exiting processBatch.');
    return trades;
  }
  let dif_time= Date.now() - trades[0].timestamp;

  console.log(`Processing data...误差 ${dif_time/1000} 秒`);
  const bar = new ProgressBar('Processing transactions: [:bar] :percent :etas | Remaining: :remaining', { total: trades.length, width: 40 });

  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i];
    try {
      const { prevOrderbook, nextOrderbook, prev_timestamp, next_timestamp } = await getAdjacentOrderbooksWithRetry(trade.timestamp);
      if (prevOrderbook && nextOrderbook) {
        const timeDiffPrev = Math.abs(trade.timestamp - prevOrderbook.timestamp);
        const timeDiffNext = Math.abs(nextOrderbook.timestamp - trade.timestamp);
        if (timeDiffPrev >  60 * 1000 || timeDiffNext > 60 * 1000) {
          console.warn(`Warning: Time difference for orderbook data exceeds 3 minutes for trade at ${trade.timestamp}`);
          continue;
        }

        const result = { ...trade, prev_timestamp, next_timestamp };

        for (let j = 0; j < 20; j++) {
          result[`prev_bid_${j+1}_price`] = prevOrderbook.bids[j][0] || null;
          result[`prev_bid_${j+1}_quantity`] = prevOrderbook.bids[j][1] || null;
          result[`prev_ask_${j+1}_price`] = prevOrderbook.asks[j][0] || null;
          result[`prev_ask_${j+1}_quantity`] = prevOrderbook.asks[j][1] || null;
          result[`next_bid_${j+1}_price`] = nextOrderbook.bids[j][0] || null;
          result[`next_bid_${j+1}_quantity`] = nextOrderbook.bids[j][1] || null;
          result[`next_ask_${j+1}_price`] = nextOrderbook.asks[j][0] || null;
          result[`next_ask_${j+1}_quantity`] = nextOrderbook.asks[j][1] || null;
        }

        const success = await saveToMySQL(result);
        // console.log(result);
        // await redis.set("tftdata:8",result.toString());
        if (!success) {
          console.error(`Failed to save trade data for trade ID: ${trade.orderid}`);
        }
      }
    } catch (error) {
      console.error(`Error processing trade ID: ${trade.orderid}`, error);
    }

    bar.tick(1, { remaining: trades.length - i - 1 });
  }

  return trades;
}



async function getLastOrderIdFromTFTData() {
  const latestData = await redis.zrevrangebyscore('tftdata_orderid', '+inf', '-inf',{ offset: 0, count: 1 });
  //console.log("TFTdata last orderdata:",latestData);
  if (latestData.length > 0) {
    const latestKey = latestData[0];
    const orderid = latestKey.split(':')[1];  // 提取orderid部分
    return parseInt(orderid);
  }
  return 0;
}
async function getFirstTradeOrderId() {
  const firstTrade = await redis.zrangebyscore('BtcTrade_orderid', '-inf', '+inf', { offset: 0, count: 1 });
  //console.log("firstTradeOrder=",firstTrade);
  if (firstTrade.length > 0) {
    const key = firstTrade[0];
    const orderid = key.split(':')[1];  // 提取orderid部分
    return parseInt(orderid);

  }
  return null;
}
async function getLastTradeOrderId() {
  const LastTrade = await redis.zrevrangebyscore('BtcTrade_orderid', '+inf', '-inf', { offset: 0, count: 1 });
  //console.log("LastTradeOrder=",LastTrade);
  if (LastTrade.length > 0) {
    const key = LastTrade[0];
    const orderid = key.split(':')[1];  // 提取orderid部分
    return parseInt(orderid);
  }
  return null;
}


async function main() {
  await redis.connect();
  await connection.getConnection();

  // await delete_keys_with_prefix(redis, "BtcTrade:")
  // await delete_keys_with_prefix(redis, "orderbook:")
  // await delete_keys_with_prefix(redis, "tftdata:")
  // await redis.del("orderbook_timestamps");
  // await redis.del("BtcTrade_orderid");
  // await redis.del("tftdata_timestamp");

  try {
    // 获取 tftdata 表中最后插入的orderid作为起点
    let lastProcessedOrderId = await getLastOrderIdFromTFTData();


    if (!lastProcessedOrderId) {
      lastProcessedOrderId = await getFirstTradeOrderId();
    }
    if(!lastProcessedOrderId){
      console.log("no data----no data-------err----请启动btcdata_redis");
      return;
    }
    console.log("lastProcessedOrderId=", lastProcessedOrderId);

    let noNewdata_tryTimes=0;

    for (;;) {
      const endOrderId = parseInt(lastProcessedOrderId) + BATCH_SIZE;
      const tradesProcessed = await processBatch(lastProcessedOrderId, endOrderId);
     // console.log("tradesProcessed:",tradesProcessed);


      // 如果没有处理任何数据，则退出循环
      if (tradesProcessed.length === 0) {
        if(noNewdata_tryTimes>3){
          noNewdata_tryTimes=0;
          lastProcessedOrderId = await getLastTradeOrderId();
          continue;
        }
        console.log('No new trade data found. Waiting for new data...');
        noNewdata_tryTimes++;
        await new Promise(resolve => setTimeout(resolve, 1000)); // 等待5秒
        continue;
      }

      // 更新最后处理的时间戳,+1是防止批处理的开头重复处理了，mysql保存时会报错，不像redis
      lastProcessedOrderId = parseInt(tradesProcessed[tradesProcessed.length - 1].orderid) + 1;
      //console.log("done------------",lastProcessedOrderId);
    }

  } catch (error) {
    console.error('Error:', error);
  }
}

main();
