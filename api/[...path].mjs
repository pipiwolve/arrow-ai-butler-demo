// Vercel 函数入口。所有 /api/* 的请求都落到这里，再交给 server.mjs 的 handler。
//
// 为什么用 catch-all 而不是一个路由一个文件：路由表在 server.mjs 里，已经按本地服务写好了，
// 拆成十几个函数文件等于把同一张表维护两遍。一个入口转一下，本地与线上走的是同一份代码。
//
// 静态资源不走这里 —— vercel.json 里把 public/ 设为输出目录，Vercel 直接发，比过函数快。

import { handler } from '../server.mjs';

// 一轮 Agent 要 30–90 秒（建会话 + 模型思考 + 闸门 + 下发），默认的 10/60 秒不够。
// 300 秒是 Pro 及以上配合 Fluid compute 的上限；Hobby 会在部署时拒绝这个值，
// 那种情况下把这里和 vercel.json 里的 maxDuration 一起改小。
export const config = { maxDuration: 300, memory: 1024 };

export default handler;
