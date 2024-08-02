# 训练并使用ai模型TFT 来预测加密货币的价格
把比特币所有成交记录和狗庄(做市商)的挂单数据，投喂给ai模型。寻找特征或规律并进行高频预测

主要包括3部分：
1️⃣ 数据获取并清洗，存储. 相关文件：btcdata.js, redisdatatomysql.js, redis.js, mysql ,btcdata.js用ws从binance获取实时比特币行情数据（成交订单记录和orderbook状态数据）并清洗存储.redisdatatomysql.js把redis里的数据持久化存储到mysql。需要同时运行btcdata, redisdatatomysql两个文件，btcdata实时获取数据存到redis中，redisdatatomysql实时处理成合适的数据并存到mysql中.mysql文件说明了mysql table的格式，内容是每笔订单的信息及其前后时间的orderbook 前20档挂单数据

2️⃣ 模型训练. 相关文件：tft.py ,tft_more.py(对已经训练好的模型进行增量训练）。tft.py代码中,时间窗口采用了1秒，使用1小时的数据来预测1分钟的价格，来进行训练模型

3️⃣ 使用训练好的模型预测.相关文件：predict.py。从mysql数据库中获取实时数据，使用训练好的模型进行实时预测

因为个人算力有限，时间有限，不能穷尽大部分的训练参数，无法得到最优模型。所以开源出来，希望有兴趣有算力的人，一起研究进步
如果你有任何问题可以联系我
邮箱： zhezhongjie@gmail.com
微信： MarsKiller7


# Train and Use AI Model TFT for Cryptocurrency Price Prediction

Feed all Bitcoin transaction records and market maker (MM) order book data into an AI model to identify features or patterns and make high-frequency predictions.

The project consists of three main parts:

1️⃣ **Data Acquisition, Cleaning, and Storage**
   - **Relevant Files**: `btcdata.js`, `redisdatatomysql.js`, `redis.js`, `mysql`
   - **Description**: The `btcdata.js` file uses WebSocket (ws) to acquire real-time Bitcoin market data (transaction records and order book status data) from Binance, cleans the data, and stores it. The `redisdatatomysql.js` file persists the data from Redis to MySQL. Both `btcdata` and `redisdatatomysql` files need to run simultaneously: `btcdata` fetches and stores data in Redis in real-time, while `redisdatatomysql` processes this data and stores it in MySQL in a suitable format. The `mysql` file specifies the MySQL table format, which includes each transaction's information and the order book's top 20 levels of bids and asks before and after the transaction.

2️⃣ **Model Training**
   - **Relevant Files**: `tft.py`, `tft_more.py` (for incremental training on an already trained model)
   - **Description**: In the `tft.py` code, a time window of 1 second is used, employing 1 hour of data to predict the price for the next minute, training the model accordingly.

3️⃣ **Using the Trained Model for Prediction**
   - **Relevant File**: `predict.py`
   - **Description**: Fetch real-time data from the MySQL database and use the trained model to make real-time predictions.

Due to personal computational limitations and time constraints, it is not possible to exhaust all training parameters and obtain the optimal model. Therefore, this project is open-source, hoping that interested individuals can contribute and further the research.

If you have any questions, feel free to contact me:
- **Email**: zhezhongjie@gmail.com
- **WeChat**: MarsKiller7



