// 审计留痕。需求 3.4：所有设备控制与场景操作都要记录操作人、时间、设备与动作。
// 追加写，一条一行，崩溃也不丢已写的记录。
//
// 存储后端由 src/store.mjs 决定：本地是 JSONL 文件，线上是 KV。
// 这里只负责「抹敏感字段 + 拼一行 JSON」，不关心落到哪儿。

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

export function createAudit(store) {
  async function append(rec) {
    const line = JSON.stringify(redact({ at: new Date().toISOString(), ...rec }));
    await store.append(line);
    return rec;
  }

  // 倒序取最近的 n 条
  async function tail(n = 100) {
    const lines = await store.tail(n);
    return lines.map((l) => {
      try { return JSON.parse(l); } catch { return { at: '', raw: l }; }
    });
  }

  return { append, tail };
}
