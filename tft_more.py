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
from lightning.pytorch.callbacks import ModelCheckpoint, EarlyStopping
from lightning.pytorch import loggers as pl_loggers
from datetime import datetime
from sqlalchemy import create_engine


start_timestamp = '1722232800000'  # 开始时间 
end_timestamp = '1722254400000'    # 结束时间
ckpt_path = '/home/yh/TFT/model_checkpoints/tft-best-20240729-080000-20240729-140000-epoch=00-val_loss=0.008394.ckpt'  # 预训练模型路径

# 将时间戳转换为秒（时间戳单位是毫秒）
start_timestamp_sec = int(start_timestamp) / 1000
end_timestamp_sec = int(end_timestamp) / 1000

# 转换为 datetime 对象
start_datetime = datetime.fromtimestamp(start_timestamp_sec)
end_datetime = datetime.fromtimestamp(end_timestamp_sec)

# 格式化为可读的字符串
start_str = start_datetime.strftime('%Y%m%d-%H%M%S')
end_str = end_datetime.strftime('%Y%m%d-%H%M%S')
print(start_str,end_str)


def load_and_process_data():
    
    # 连接到MySQL数据库
    db_connection_string = 'mysql+pymysql://user:password@ip/datebaseName' 
    # db_connection_string = 'mysql+pymysql://yanghao:marskiller@84.248.133.54/btcdata' #eg


    engine = create_engine(db_connection_string)


    query = f"""
    SELECT * FROM tftdata 
    WHERE timestamp BETWEEN {start_timestamp} AND {end_timestamp}
    """

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
    max_encoder_length = 1200  # 根据实际数据调整。如果时间窗口是3秒。就是用3*max_encoder_length的时间，去预测。这里是5分钟
    max_prediction_length =100  # 预测长度

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

    train_dataloader = training.to_dataloader(train=True, batch_size=32, num_workers=8)
    val_dataloader = validation.to_dataloader(train=False, batch_size=32, num_workers=8)

    return train_dataloader, val_dataloader





def train_model(train_dataloader, val_dataloader, ckpt_path):

    # 创建模型
    tft = TemporalFusionTransformer.load_from_checkpoint(ckpt_path)

       
    # 创建 ModelCheckpoint 回调，用于保存训练过程中的最佳模型
    checkpoint_callback = ModelCheckpoint(
        monitor='val_loss',  # 监控的指标，确保与你模型的输出日志一致
        dirpath='./model_checkpoints/',  # 模型保存的路径
        # filename='tft-best-{epoch:02d}-{val_loss:.6f}',  # 文件命名格式
        #filename = 'tft-best-{start_str}-{end_str}-{epoch:02d}-{val_loss:.6f}',# 文件命名格式
        filename = 'tft-best-%s-%s-{epoch:02d}-{val_loss:.6f}' % (start_str, end_str),
        save_top_k=2,  # 只保存最好的2个模型
        mode='min',  # 损失越小越好
        verbose=True,  # 打印保存日志
    )
        # 早停法防止过拟合
    early_stopping = EarlyStopping(
        monitor='val_loss',
        patience=5,
        strict=False,
        verbose=True,
        mode='min'
    )

    tensorboard = pl_loggers.TensorBoardLogger(save_dir="tb_logs", name="my_model")
    # 创建PyTorch Lightning训练器
    trainer = pl.Trainer(
        max_epochs=30,
        accelerator='gpu', # 如果使用GPU
        devices=1, # 如果使用1个GPU
        gradient_clip_val=0.1,
        callbacks=[checkpoint_callback, early_stopping],
        logger=tensorboard
    )

    # 训练模型
    trainer.fit(tft, train_dataloader, val_dataloader)

def main():
    torch.cuda.empty_cache()  # 清空 CUDA 缓存
    # 设置浮点32位矩阵乘法的精度
    torch.set_float32_matmul_precision('high')  # 或 'medium' 根据您对性能和精度的需求
    data = load_and_process_data()
    train_dataloader, val_dataloader = prepare_datasets(data)
    train_model(train_dataloader, val_dataloader, ckpt_path)
if __name__ == "__main__":
    main()


