// 历史回放发给浏览器之前先瘦身。
// 平台事件里带着思考全文、命令输出和读过的文件，一场对话就能到几百 KB。
// 界面只画角色、正文、工具名、状态和一句短入参，这些大字段丢掉不影响回放。

const DROP = new Set(['output', 'stdout', 'stderr', 'attachments', 'diff', 'content', 'result', 'logs']);

function slimValue(v, depth) {
  if (v == null || depth > 4) return undefined;
  if (typeof v === 'string') return v.length > 240 ? v.slice(0, 240) + '…' : v;
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 12).map((x) => slimValue(x, depth + 1)).filter((x) => x !== undefined);
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (DROP.has(k)) continue;
    if (k === 'metadata' && val && typeof val === 'object') {
      const fe = val.fileExports;
      if (Array.isArray(fe)) {
        out.metadata = {
          fileExports: fe.slice(0, 8).map((f) => ({ filename: f?.filename || '', path: f?.path || '' })),
        };
      }
      continue;
    }
    const next = slimValue(val, depth + 1);
    if (next !== undefined) out[k] = next;
  }
  return out;
}

function slimPart(p) {
  if (!p || typeof p !== 'object') return null;
  if (p.type === 'sandbox-status' || p.type === 'compaction' || p.type === 'snapshot' || p.type === 'patch') return null;
  const base = {};
  if (p.id) base.id = p.id;
  if (p.type) base.type = p.type;
  if (p.tool) base.tool = p.tool;
  if (p.messageID) base.messageID = p.messageID;
  if (p.type === 'reasoning') return { ...base, text: '' };
  if (p.type === 'text') {
    const text = typeof p.text === 'string' ? p.text : '';
    return { ...base, text: text.length > 8000 ? text.slice(0, 8000) : text };
  }
  if (Array.isArray(p.files)) {
    base.files = p.files.slice(0, 8).map((f) => ({
      filename: f?.filename || f?.name || '',
      path: f?.path || f?.filePath || '',
    }));
  }
  if (p.state && typeof p.state === 'object') base.state = slimValue(p.state, 0);
  else if (p.input && typeof p.input === 'object') base.input = slimValue(p.input, 0);
  if (typeof p.status === 'string') base.status = p.status;
  if (typeof p.message === 'string' && p.message) base.message = p.message.slice(0, 300);
  return base;
}

// 每轮发给模型的设备上下文。界面上不能出现这段，模型若复述也要裁掉。
const CONTEXT_HEAD = /【(?:实时在线|本轮设备)】/;
const CONTEXT_BLOCK = /【(?:实时在线|本轮设备)】[\s\S]*?【用户原话】\s*/g;

export function spokenText(raw) {
  let s = String(raw ?? '');
  s = s.replace(CONTEXT_BLOCK, '');
  const cut = s.search(CONTEXT_HEAD);
  if (cut >= 0) s = s.slice(0, cut);
  return s.replace(/^\s+/, '');
}

export function slimEvents(items) {
  if (!Array.isArray(items)) return [];
  return items.map((it) => ({
    info: it?.info ? { id: it.info.id, role: it.info.role, time: it.info.time } : undefined,
    parts: (it?.parts || []).map(slimPart).filter(Boolean),
  }));
}

// demoEpoch 用绝对时间比较。字符串比会把带 Z 和带 +08:00 的时间排错。
export function inDemoWindow(iso, epochMs) {
  if (!Number.isFinite(epochMs)) return true;
  const t = Date.parse(iso || '');
  return Number.isFinite(t) && t >= epochMs;
}
