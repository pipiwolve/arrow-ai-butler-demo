// 存储层。审计流水、卡片流水、bootstrap 缓存都从这里走，好让同一份代码既跑在
// 本地（写文件）又跑在 Vercel（写外部 KV）。
//
// 为什么要分两层：Vercel 的函数实例是即用即弃的，写本地文件下一次请求就看不见了。
// 审计留痕是需求 3.4 点名的东西，不能随实例消失，所以线上必须落到外部存储。
//
// 后端由环境变量选，不用改代码：
//   配了 KV_REST_API_URL + KV_REST_API_TOKEN → Redis（Vercel KV / Upstash 都是这套 REST 接口）
//   没配                                      → 本地文件，行为与改动前完全一致
//
// 两个后端的语义对齐在「追加 + 倒序取尾部 + 全量取 + 整表覆盖」上。
// 覆盖给删会话用：卡片流水按 sessionId 筛掉再写回，审计流水不动。

import fs from 'node:fs';

// Redis 那侧把日志存成 list：RPUSH 追加、LRANGE 取。取尾部用负数下标。
function createRedisStore({ url, token, key }) {
  async function cmd(...args) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args.map(String)),
    });
    if (!r.ok) throw new Error(`KV HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`KV ${j.error}`);
    return j.result;
  }

  return {
    kind: 'redis',
    async append(line) {
      await cmd('RPUSH', key, line);
    },
    async all() {
      const list = await cmd('LRANGE', key, 0, -1);
      return Array.isArray(list) ? list : [];
    },
    // LRANGE 取出来是正序，要翻一下才和文件后端的「倒序取尾部」一致。
    // 漏了这一步的现象很隐蔽：本地看审计页是最新在上，上了 Vercel 变成最旧在上，
    // 不报错、不丢数据，只是顺序反了。
    async tail(n) {
      const list = await cmd('LRANGE', key, -n, -1);
      return Array.isArray(list) ? list.reverse() : [];
    },
    // 先写临时键再改名，替换失败时旧列表还在。空列表直接删键：
    // 临时键不存在时 RENAME 会失败。
    async replaceAll(lines) {
      if (!lines.length) {
        await cmd('DEL', key);
        return;
      }
      const tmp = `${key}:swap`;
      await cmd('DEL', tmp);
      await cmd('RPUSH', tmp, ...lines);
      await cmd('RENAME', tmp, key);
    },
    async readJson(dflt) {
      const v = await cmd('GET', key);
      if (!v) return dflt;
      try { return JSON.parse(v); } catch { return dflt; }
    },
    async writeJson(v) {
      await cmd('SET', key, JSON.stringify(v));
    },
  };
}

function createFileStore({ file }) {
  const read = () => {
    try { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; } catch { return ''; }
  };
  const lines = () => read().split('\n').filter(Boolean);

  return {
    kind: 'file',
    async append(line) {
      fs.appendFileSync(file, line + '\n');
    },
    async all() {
      return lines();
    },
    // 倒序读最近的 n 条。文件不大，直接全读再切
    async tail(n) {
      return lines().slice(-n).reverse();
    },
    async replaceAll(next) {
      fs.writeFileSync(file, next.length ? next.join('\n') + '\n' : '');
    },
    async readJson(dflt) {
      try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : dflt; } catch { return dflt; }
    },
    async writeJson(v) {
      fs.writeFileSync(file, JSON.stringify(v, null, 2));
    },
  };
}

// file 是本地兜底路径；name 是 Redis 里的键名。两者都要给，好让同一处调用两边都能落。
export function createStore({ name, file, env }) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return createRedisStore({ url, token, key: name });
  return createFileStore({ file });
}

// 线上没配 KV 时给个明确提示，别让人以为审计在正常留痕、实际每次冷启动都清空
export function storageWarning(env, hasVercel) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return null;
  if (hasVercel) {
    return '跑在 Vercel 上但没配 KV_REST_API_URL / KV_REST_API_TOKEN：审计流水与卡片流水'
      + '只写在本实例的临时盘上，冷启动即丢，安全审计页会时有时无。接一个 Vercel KV 即可。';
  }
  return null;
}
