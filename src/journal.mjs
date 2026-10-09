// 编排层卡片流水。历史回放要用它。
//
// 「闸门判定 → 下发 → 结果」和报修 deeplink 都是本编排层产生的事件，平台消息里没有这三段，
// 只往浏览器推一次就没了，回看历史时那几张卡凭空消失。这里把它们按轮次落盘。
//
// 与 audit.jsonl 分开存：审计是需求 3.4 的操作留痕，要留给客户看，
// 只记真实发生的设备与场景操作（/api/gate/simulate 这类诊断调用刻意不写）。
// 这里是回放用的界面状态，两者判据不同，混在一起两边都会脏。
//
// 一条记录 = 一轮收尾时产出的全部卡片，挂在那一轮最后一条 assistant 消息 ID 上。
// 回放时平台历史里能找到同一个 ID，据此精确贴回对应轮次，不靠时间戳猜（本地与服务端时钟不同源）。
//
// 存储后端由 src/store.mjs 决定，本地是 cards.jsonl，线上是 KV。

import { redact } from './audit.mjs';

export function createJournal(store) {
  // 一轮的卡片。msgId 是那一轮最后一条 assistant 消息的 ID，也是回放时的锚点。
  async function appendTurn({ sessionId, msgId, cards }) {
    if (!sessionId || !msgId || !cards?.length) return;
    await write({ sessionId, msgId, type: 'cards', cards });
  }

  // 用户点了确认或取消。待确认卡在回放里据此变成终态，并补上确认后才产生的那张执行卡。
  async function appendResolve({ sessionId, pendingId, decision, out }) {
    if (!sessionId || !pendingId) return;
    await write({ sessionId, pendingId, decision, out: out || null });
  }

  async function write(rec) {
    // 执行卡里带着网关请求头，和审计一样必须先抹掉 bearer token
    await store.append(JSON.stringify(redact({ at: new Date().toISOString(), ...rec })));
  }

  // 删会话时把这一路的卡片一起清掉。平台删的是会话元数据和沙箱，
  // 闸门卡、执行卡存在本层，不删的话旧 id 再被打开仍会贴回来。
  // 审计流水不在这里：那是已发生的设备操作，会话没了也要留。
  async function dropSession(sessionId) {
    if (!sessionId) return 0;
    const kept = [];
    let dropped = 0;
    for (const line of await store.all()) {
      let rec;
      try { rec = JSON.parse(line); } catch { kept.push(line); continue; }
      if (rec.sessionId === sessionId) { dropped += 1; continue; }
      kept.push(line);
    }
    if (dropped) await store.replaceAll(kept);
    return dropped;
  }

  // 全量取再按会话筛。顺序即写入顺序，回放要靠它还原卡片先后
  async function bySession(sessionId) {
    const out = [];
    for (const line of await store.all()) {
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.sessionId === sessionId) out.push(rec);
    }
    return out;
  }

  return { appendTurn, appendResolve, bySession, dropSession };
}
