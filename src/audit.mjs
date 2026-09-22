// 审计留痕。需求 3.4：所有设备控制与场景操作都要记录操作人、时间、设备与动作。
// 追加写 JSONL，一条一行，崩溃也不丢已写的记录。

import fs from 'node:fs';

// 网关请求头里有 bearer token，落盘前必须抹掉，审计日志是要给客户看的
export function redact(v) {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = /^(authorization|token|api[_-]?key)$/i.test(k) ? '***' : redact(val);
    }
    return out;
  }
  if (typeof v === 'string') return v.replace(/bearer\s+\S+/gi, 'bearer ***');
  return v;
}

export function createAudit(file) {
  function append(rec) {
    const line = JSON.stringify(redact({ at: new Date().toISOString(), ...rec }));
    fs.appendFileSync(file, line + '\n');
    return rec;
  }

  // 倒序读最近的 n 条。文件不大，直接全读再切
  function tail(n = 100) {
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n).reverse().map((l) => {
      try { return JSON.parse(l); } catch { return { at: '', raw: l }; }
    });
  }

  return { append, tail };
}
