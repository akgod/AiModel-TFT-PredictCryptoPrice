from asyncio.log import logger
import pandas as pd
from glob import glob
# 导入 PyTorch Forecasting 相关库
from pytorch_forecasting import TimeSeriesDataSet
from pytorch_forecasting.data import GroupNormalizer
from pytorch_forecasting.models.temporal_fusion_transformer import TemporalFusionTransformer
from pytorch_forecasting.metrics import QuantileLoss
# 导入 PyTorch 相关库
import torch
import lightning.pytorch as pl
from lightning.pytorch.callbacks import ModelCheckpoint
from lightning.pytorch import loggers as pl_loggers
import pymysql
from datetime import datetime
import matplotlib.pyplot as plt
import numpy as np
from sqlalchemy import create_engine



def load_real_time_data():
    # 连接到MySQL数据库
    print("Data loading . . . . .")

    # 连接到MySQL数据库
    db_connection_string = 'mysql+pymysql://user:password@ip/datebaseName' 
    # db_connection_string = 'mysql+pymysql://yanghao:marskiller@84.248.133.54/btcdata' #eg

    # 创建 SQLAlchemy 引擎
    engine = create_engine(db_connection_string)

    # 计算最近5分钟的时间戳
    current_timestamp = int(datetime.now().timestamp() * 1000)  # 当前时间的 Unix 毫秒时间戳
    five_minutes_ago_timestamp = current_timestamp - (60*60* 1000)  # 

    query = f"""
    SELECT * FROM tftdata 
    WHERE timestamp BETWEEN {five_minutes_ago_timestamp} AND {current_timestamp}
    """

    # 加载数据
    data = pd.read_sql(query, engine)
    engine.dispose()
    print("Data loaded from database.")
    print(data)
    if 'timestamp' in data.columns:
        data['timestamp'] = pd.to_datetime(data['timestamp'], unit='ms')  # 假设Unix时间戳以毫秒秒为单位
        # 调整时间窗口为每分钟
        data['time_window'] = data['timestamp'].dt.floor('3s')  # 将时间向下取整到最近的1秒
        print("Timestamp converted and time window created.")
    else:
        raise ValueError("Timestamp column is missing.")

    if 'id' in data.columns:
        data['unique_idx'] = data['time_window'].astype(str)  # 使用时间窗口作为 unique_idx
        data['time_idx'] = data.groupby('unique_idx').cumcount()
        print("Unique index and time index created.")
    else:
        raise ValueError("Order ID column is missing.")

    if 'price' in data.columns:
        data['target'] = data['price'].astype(float)
        print("Target column created.")
    else:
        raise ValueError("Price column is missing.")

    # print(data)
    return data
def prepare_datasets(data):
    max_encoder_length = 3600  # 根据实际数据调整。如果时间窗口是3秒。就是用3*max_encoder_length的时间，去预测。
    max_prediction_length =60  # 预测长度

    # 确保时间索引是连续的整数序列
    data = data.sort_values(by=['unique_idx', 'time_idx']).reset_index(drop=True)

    if data.empty:
        raise ValueError("Data is empty after sorting. Check your data processing steps.")
    print(data)    
    print("训练集时间索引最大值 data[time_idx].max()=",data["time_idx"].max())

    training_cutoff = data["time_idx"].max() - max_prediction_length
    print("训练集时间索引截止值training_cutoff",training_cutoff)
    if training_cutoff < 0:
        raise ValueError("Training cutoff is less than 0, indicating not enough data points. Adjust your data or parameters.")

    # 初始化 time_varying_known_reals 列表
    time_varying_known_reals = [
        "quantity", "type_buysell", "prev_timestamp", "next_timestamp",
        "prev_bid_1_price", "prev_bid_1_quantity", "prev_ask_1_price", "prev_ask_1_quantity",
        "next_bid_1_price", "next_bid_1_quantity", "next_ask_1_price", "next_ask_1_quantity"
    ]

    # 使用循环来添加第2层到第20层的数据
    for i in range(2, 21):  # 从第二层开始到第20层
        time_varying_known_reals.extend([
            f"prev_bid_{i}_price", f"prev_bid_{i}_quantity", 
            f"prev_ask_{i}_price", f"prev_ask_{i}_quantity",
            f"next_bid_{i}_price", f"next_bid_{i}_quantity", 
            f"next_ask_{i}_price", f"next_ask_{i}_quantity"
        ])

    # 创建时间序列数据集
    training = TimeSeriesDataSet(
        data[lambda x: x.time_idx <= training_cutoff],
        time_idx="time_idx",
        target="target",
        group_ids=["unique_idx"],  # 使用 unique_idx 作为分组变量
        min_encoder_length=1,  # 最小长度设置为1
        max_encoder_length=max_encoder_length,
        min_prediction_length=1,
        max_prediction_length=max_prediction_length,
        static_categoricals=[],
        static_reals=[],
        time_varying_known_categoricals=[],
        time_varying_known_reals=time_varying_known_reals,
        time_varying_unknown_categoricals=[],
        time_varying_unknown_reals=["target"],
        target_normalizer=GroupNormalizer(
            groups=["unique_idx"], transformation="softplus"
        ),
        add_relative_time_idx=True,
        add_target_scales=True,
        add_encoder_length=True,
    )

    validation = TimeSeriesDataSet.from_dataset(training, data, predict=True, stop_randomization=True)

    # train_dataloader = training.to_dataloader(train=True, batch_size=32, num_workers=8)
    val_dataloader = validation.to_dataloader(train=False, batch_size=32, num_workers=8)

    # return train_dataloader, val_dataloader
    return val_dataloader


def predict(model_path, dataloader):
    model = TemporalFusionTransformer.load_from_checkpoint(model_path)
    model.eval()  # 设置为评估模式
    predictions = model.predict(dataloader, mode="prediction")  # 使用 DataLoader 进行预测
    return predictions


def main():
    data = load_real_time_data()
    val_dataloader = prepare_datasets(data)
    last_actual_value = data['target'].iloc[-1]
    last_time = data['timestamp'].iloc[-1]
    # print("Last actual value from data:", last_actual_value)
    model_path = '/home/yh/TFT/model_checkpoints/tft-best-20240801-105000-20240801-135000-epoch=04-val_loss=0.006762.ckpt'  # 使用实际模型路径替换
    predictions_gpu = predict(model_path, val_dataloader)
    predictions = np.array(predictions_gpu.cpu())  # 假设 predictions 已经是一个 numpy 数组

    print("Predictions:", predictions)
    print("Predictions shape:", predictions.shape)
    print("lastone_predictions:",predictions[-1, :])

    # 计算每组预测的第一个值与所给数据最后一个值之间的差异
    differences = np.abs(predictions[:, 0] - last_actual_value)

    # 找出差异最小的预测索引
    min_diff_index = np.argmin(differences)

    # 选择差异最小的预测结果
    most_coherent_predictions = predictions[min_diff_index]

    # 打印结果
    print(f"Most Coherent Predictions (Index {min_diff_index}):", most_coherent_predictions)

    # 计算平均值
    mean_predictions = np.mean(predictions, axis=0)
    # print("Mean Predictions:", mean_predictions)

    # 计算中位数
    median_predictions = np.median(predictions, axis=0)
    # print("Median Predictions:", median_predictions)
    # 打印最大值和最小值
    print("************-----------*************")
    print(last_time)
    print("last_actual_value---most_coherent_predictions min-max:",last_actual_value,np.min(most_coherent_predictions), np.max(most_coherent_predictions))
    print("Predictions min-max:",np.min(predictions), np.max(predictions))
    print("Mean Predictions min-max:",np.min(mean_predictions), np.max(mean_predictions))
    print("Median Predictions min-max:",np.min(median_predictions), np.max(median_predictions))
    # 绘图
    # print("开始绘图")
    # plt.figure(figsize=(12, 8))
    # time_steps = np.arange(predictions.shape[1])  # 假设每个预测长度相同

    # for i in range(predictions.shape[0]):
    #     plt.plot(time_steps, predictions[i], label=f'Series {i+1}')

    # plt.title('Prediction of Bitcoin Prices')
    # plt.xlabel('Time Steps')
    # plt.ylabel('Predicted Price')
    # plt.legend()

    # # 保存图形到文件
    # print("开始保存图片")
    # plt.savefig('/home/yh/TFT/ai.png')  # 指定保存路径
    # plt.close()  # 关闭图形，释放内存

if __name__ == "__main__":
    main()
