const Redis = require('ioredis');
const client = new Redis({
  host: '127.0.0.1',
  port: 6379,
  password: 'marskiller'
});

class Database {
  async connect() {
    console.log("开始连接redis");
    client.on("error", function (error) {
      console.log("******error*****");
      console.error(error);
    });
    console.log("连接redis成功!!!");
  }

  async quit() {
    console.log("开始断开redis");
    await client.quit();
    console.log("断开redis成功!!!");
  }

  async set(key, value, time = 260) {
    await client.set(key, value, 'EX', time);
  }

  async set_noExpireTime(key, value) {
    await client.set(key, value);
  }
  async setnx(key,value){   // 存储一个 key value
    let reply = await client.set(key, value,{NX: true});  //// Will return `OK` if the key was successfully set, or `null` if it was not
    return reply;
  }
  async del(key) {
    await client.del(key);
    console.log("delete success");
  }

  async get(key) {
    return await client.get(key);
  }

  async lrange(key, from, to) {
    return await client.lrange(key, from, to);
  }

  async keys(pattern) {
    return await client.keys(pattern);
  }

  async zadd(key, score, member) {
    if (score !== undefined && member !== undefined) {
      await client.zadd(key, score, member); // 使用小写字母
    } else {
      console.error('Invalid score or member:', score, member);
    }
  }

  async zrangebyscore(key, min, max, limit) {
    if (limit) {
      return await client.zrangebyscore(key, min, max, 'LIMIT',limit.offset, limit.count); // 使用小写字母
    } else {
      return await client.zrangebyscore(key, min, max); // 使用小写字母
    }
  }

  async zrevrangebyscore(key, max, min, limit) {
    if (limit) {
      return await client.zrevrangebyscore(key, max, min, 'LIMIT', limit.offset, limit.count); // 使用小写字母
    } else {
      return await client.zrevrangebyscore(key, max, min); // 使用小写字母
    }
  }

  async zrange(key, start, stop) {
    return await client.zrange(key, start, stop); // 使用小写字母
  }

  async zrevrange(key, start, stop) {
    return await client.zrevrange(key, start, stop); // 使用小写字母
  }

  async zrem(key, member) {
    await client.zrem(key, member); // 使用小写字母
  }

  async zscore(key, member) {
    return await client.zscore(key, member); // 使用小写字母
  }
}

let rds = new Database();
module.exports = rds;