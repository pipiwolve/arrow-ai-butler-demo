// .env 读取。服务端与抓清单脚本共用，避免两处各写一遍解析逻辑。
import fs from 'node:fs';
import path from 'node:path';

// 文件给默认值，真实环境变量可以覆盖。有覆盖才能一条命令切模式：
//   IOT_MODE=real IOT_FIXTURE=real node server.mjs
// 只覆盖 .env 里已声明的键，避免把 shell 里一堆无关变量灌进来。
//
// Vercel 上没有 .env 文件，配置全在项目的环境变量里，所以那种情况下直接读 process.env，
// 不做键名白名单——那份环境本来就是人工配的，比本地 shell 干净。
// 这几个键通常不写进 .env（本地口令、KV 凭证、纯开关），写了也常被本地 .env 盖掉。
// 照 IOT_FIXTURE 的先例，一律以 process.env 为准 —— 否则
// `ACCESS_PASSWORD=xxx node server.mjs` 会被静默忽略，现象是「明明设了口令，线上还是裸的」。
const ALWAYS_FROM_PROCESS = [
  'IOT_FIXTURE', 'ACCESS_PASSWORD',
  'KV_REST_API_URL', 'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
];

export function loadEnv(root) {
  const p = path.join(root, '.env');
  if (!fs.existsSync(p)) {
    // Vercel 上没有 .env，配置全在项目的环境变量里，直接读 process.env，
    // 不做键名白名单——那份环境本来就是人工配的，比本地 shell 干净。
    if (process.env.VERCEL) return { ...process.env };
    throw new Error('缺少 .env（照 .env.example 建一份）');
  }
  const out = {};
  for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    out[k] = line.slice(i + 1).trim();
  }
  for (const k of Object.keys(out)) {
    if (process.env[k] !== undefined && process.env[k] !== '') out[k] = process.env[k];
  }
  for (const k of ALWAYS_FROM_PROCESS) {
    if (process.env[k] !== undefined && process.env[k] !== '') out[k] = process.env[k];
  }
  return out;
}
