// Vercel 函数入口。所有 /api/* 的请求都落到这里，再交给 server.mjs 的 handler。
//
// 为什么用 catch-all 而不是一个路由一个文件：路由表在 server.mjs 里，已经按本地服务写好了，
// 拆成十几个函数文件等于把同一张表维护两遍。一个入口转一下，本地与线上走的是同一份代码。
//
// 静态资源不走这里 —— vercel.json 里把 public/ 设为输出目录，Vercel 直接发，比过函数快。
//
// 用动态 import 而不是顶部静态 import，是为了能接住「模块加载阶段就抛异常」这件事。
// server.mjs 与 scenario.mjs 在加载时就会校验配置：缺 DUMATE_API_KEY、找不到设备清单、
// config/ 没随函数打包，任意一条命中都会让 import 直接失败。静态 import 抛出来无法捕获，
// Vercel 只回一个不透明的 FUNCTION_INVOCATION_FAILED，不说为什么。改成动态 import 之后
// 至少能把原因回给调用方，省得去翻运行日志。

// 启动时把环境变量的「名字」列出来（只要名字，不要值），一眼能看出平台有没有把变量传进来。
const WATCHED = [
  'DUMATE_API_KEY', 'DUMATE_BASE_URL', 'IOT_MODE', 'IOT_BASE_URL', 'IOT_TOKEN',
  'IOT_FIXTURE', 'ACCESS_PASSWORD', 'KV_REST_API_URL', 'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'ASR_API_KEY',
];

let handler = null;
let bootError = null;
try {
  ({ handler } = await import('../server.mjs'));
} catch (e) {
  bootError = e;
}

// 一轮 Agent 要 30–90 秒（建会话 + 模型思考 + 闸门 + 下发），默认的 10/60 秒不够。
// 300 秒是 Pro 及以上配合 Fluid compute 的上限；Hobby 会在部署时拒绝这个值，
// 那种情况下把这里和 vercel.json 里的 maxDuration 一起改小。
export const config = { maxDuration: 300, memory: 1024 };

export default async function entry(req, res) {
  if (bootError) {
    const present = WATCHED.filter((k) => process.env[k] !== undefined && process.env[k] !== '');
    const missing = WATCHED.filter((k) => !present.includes(k));
    // 这里回的是环境变量名与文件路径，不含任何值，所以可以直接给出去。
    // 函数已经起不来了，遮着原因只会让人去翻日志。
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      error: '函数启动失败（模块加载阶段抛异常）',
      reason: String((bootError && bootError.message) || bootError),
      envPresent: present,
      envMissing: missing,
      hint: '逐条对照：DUMATE_API_KEY 必填；IOT_MODE 在 Vercel 上必须是 real；'
        + 'IOT_FIXTURE 用 demo（real 要的 iot/devices.real.json 含真实序列号、已 gitignore，'
        + '不会随仓库上云）；config/ 与 iot/ 靠 vercel.json 的 includeFiles 打进函数。',
    }, null, 2));
    return;
  }
  return handler(req, res);
}
