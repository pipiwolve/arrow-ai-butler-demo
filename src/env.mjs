// .env 读取。服务端与抓清单脚本共用，避免两处各写一遍解析逻辑。
import fs from 'node:fs';
import path from 'node:path';

// 文件给默认值，真实环境变量可以覆盖。有覆盖才能一条命令切模式：
//   IOT_MODE=real IOT_FIXTURE=real node server.mjs
// 只覆盖 .env 里已声明的键，避免把 shell 里一堆无关变量灌进来。
export function loadEnv(root) {
  const p = path.join(root, '.env');
  if (!fs.existsSync(p)) throw new Error('缺少 .env（照 .env.example 建一份）');
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
  return out;
}
