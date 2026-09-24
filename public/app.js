// 箭牌智家 AI 助手 · 前端
// 五个视图：对话 / 家庭设备 / 安全审计 / 技能管理 / 产物中心。
// 对话一屏里能看到三层：执行过程（Agent 干了什么）、安全闸门（能不能下发）、正文（结论）。
// 技能与产物是一条线：技能是上游，挂上之后才有真文件可交付。

const $ = (s) => document.querySelector(s);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

const streamEl = $('#stream');
const inputEl = $('#input');
const sendBtn = $('#send');
const statusEl = $('#status');
const sessionsEl = $('#sessions');
const chatTitle = $('#chatTitle');
const micBtn = $('#mic');
const cwrapEl = $('#cwrap');
const barsEl = $('#bars');
const lmsgEl = $('#lmsg');

const T = { sid: null, scene: null, turn: null, ctl: null, busy: false, follow: null };
let CFG = {};

/* ================= 小工具 ================= */

// 沙箱绝对路径在界面上没有信息量，先摘掉前缀；工作目录下还套了一层会话 id，也一并摘掉
const SANDBOX_RE = /\/home\/work\/dumate\/[A-Za-z0-9_]+(?:\/workspace)?\//g;
const relPath = (s) => String(s ?? '')
  .replace(SANDBOX_RE, '')
  .replace(/^ses_[A-Za-z0-9]+\//, '')
  .replace(/\/{2,}/g, '/');
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// 与 src/history.mjs 的 spokenText 一致。设备上下文只给模型看，回放里整段拿掉。
const spokenText = (s) => {
  let raw = String(s ?? '');
  raw = raw.replace(/【(?:实时在线|本轮设备)】[\s\S]*?【用户原话】\s*/g, '');
  const cut = raw.search(/【(?:实时在线|本轮设备)】/);
  if (cut >= 0) raw = raw.slice(0, cut);
  return raw.replace(/^\s+/, '');
};
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
const plain = (s) => flat(s).replace(/\*\*|__|`|~~/g, '').replace(/^\||\|$/g, '');
const baseName = (s) => { const p = relPath(s).replace(/\/+$/, ''); return p.split('/').pop() || p; };
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Agent 会在回答末尾附一个 iot 代码块，正文里不该出现这段 JSON
const stripAction = (s) => String(s ?? '').replace(/```(?:iot|json)\s*\n[\s\S]*?```/g, '').replace(/\n{3,}/g, '\n\n').trim();

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒';
  return Math.floor(m / 60) + ' 时 ' + (m % 60) + ' 分';
}

function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(+d)) return '';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  const p = (n) => String(n).padStart(2, '0');
  const hm = p(d.getHours()) + ':' + p(d.getMinutes());
  if (d.toDateString() === new Date().toDateString()) return '今天 ' + hm;
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}

function setStatus(kind, text) {
  statusEl.className = 'status ' + (kind || '');
  statusEl.querySelector('span').textContent = text;
}

/* ================= 执行过程 · 把工具调用压成人话 ================= */

const CATS = {
  bash: { k: 'cmd', label: '执行命令' },
  read: { k: 'read', label: '读取文件' },
  ls: { k: 'read', label: '列目录' },
  write: { k: 'write', label: '写文件' },
  edit: { k: 'write', label: '改文件' },
  multiedit: { k: 'write', label: '改文件' },
  glob: { k: 'search', label: '查找文件' },
  grep: { k: 'search', label: '搜索内容' },
  webfetch: { k: 'net', label: '抓取网页' },
  websearch: { k: 'net', label: '联网搜索' },
  task: { k: 'task', label: '派子任务' },
  skill: { k: 'skill', label: '加载技能' },
  file_export: { k: 'write', label: '导出文件' },
};

// 纯内部记账的片段，展示出来只是噪音。
// file_export 不在里面：它产出的是真交付物，要让人在过程里看见。
const HIDDEN = new Set([
  'todowrite', 'requirementwrite', 'requirementread',
  'step-start', 'step-finish', 'snapshot', 'patch', 'compaction', 'retry', 'file-import',
]);

function summarizeCmd(cmd) {
  let c = flat(cmd).replace(/^cd\s+\S+\s*&&\s*/, '');
  let m;
  if (/<<-?\s*['"]?\w+/.test(c)) return '运行内联脚本';
  if ((m = c.match(/^(?:python3?|node|bash|sh)\s+([^\s|;&]+)/))) return '运行 ' + clip(baseName(m[1]), 56);
  if ((m = c.match(/^(?:ls|tree)\b\s*(?:-\S+\s*)*(.*)$/))) return ('列目录 ' + clip(flat(relPath(m[1])), 56)).trim();
  if ((m = c.match(/^(?:head|tail|wc|cat|less|file|stat)\s+(?:-\S+\s*)*([^\s|;&]+)/))) return '读文件 ' + clip(relPath(m[1]), 56);
  if ((m = c.match(/^find\b(.*)$/))) return '查找 ' + clip(flat(relPath(m[1])), 56);
  if (/^(?:pwd|whoami|date)\b/.test(c)) return '查看运行环境';
  return clip(c, 68) || '执行命令';
}

const HEAVY = new Set(['content', 'text', 'newString', 'oldString', 'code', 'file_text']);
function toolRaw(tool, r) {
  const inp = r.input || {};
  if (tool === 'bash') return String(inp.command || '');
  const keep = {};
  for (const [k, v] of Object.entries(inp)) {
    if (HEAVY.has(k)) { keep[k] = '（' + String(v).length + ' 字符，已省略）'; continue; }
    keep[k] = typeof v === 'object' ? JSON.stringify(v) : v;
  }
  const s = JSON.stringify(keep, null, 2);
  return s === '{}' ? '' : s;
}

const ID_LIKE = /^(?:ses_|prt_|msg_|agt_|file-)/;
function meaningful(s) {
  const v = flat(s);
  if (v.length < 2 || v.length > 80) return false;
  if (ID_LIKE.test(v) || v.includes('/')) return false;
  if (/^[\w.-]+$/.test(v)) return false;
  return true;
}

function toolLabel(tool, r) {
  const human = meaningful(r.input?.description) ? flat(r.input.description) : meaningful(r.title) ? flat(r.title) : '';
  if (human) return clip(human, 60);
  const inp = r.input || {};
  switch (tool) {
    case 'bash': return summarizeCmd(inp.command || '');
    case 'read': case 'write': case 'edit': case 'multiedit': {
      const p = inp.filePath || inp.path || inp.file_path;
      return p ? CATS[tool].label + ' ' + clip(relPath(p), 58) : CATS[tool].label;
    }
    case 'ls': return '列目录 ' + clip(relPath(inp.path || inp.dir || '.'), 58);
    case 'file_export': {
      // 一次导出可以带多个文件，input.files 是数组
      const f = inp.files?.[0] || inp;
      const p = f.path || f.filePath || f.filename;
      return p ? '导出 ' + clip(relPath(p), 58) : '导出文件';
    }
    case 'glob': return '查找 ' + clip(flat(inp.pattern || inp.glob || ''), 50);
    case 'grep': return '搜索 ' + clip(flat(inp.pattern || ''), 46);
    case 'task': return '派子任务 ' + clip(flat(inp.description || inp.prompt || ''), 46);
    default: return CATS[tool]?.label || tool || '工具调用';
  }
}

const OK_TERMINAL = new Set(['completed', 'success', 'ready']);
const BAD_TERMINAL = new Set(['error', 'failed']);

function stepOf(r, live, answerId, t) {
  let s = null;
  if (r.type === 'text') {
    if (r.id === answerId) return null;
    // 流里会把用户自己的提问回显成一条 text part，那不是 Agent 的步骤
    if (t.userMsgs.has(r.messageID) || flat(spokenText(partText(r))) === t.userText) return null;
    const txt = plain(spokenText(partText(r)));
    if (!txt) return null;
    s = { k: 'say', label: clip(txt, 56), raw: spokenText(partText(r)) };
  } else if (r.type === 'reasoning') s = { k: 'think', label: '思考', raw: '' };
  else if (r.type === 'subtask' || r.type === 'agent') s = { k: 'task', label: '派子任务', raw: '' };
  else if (r.type === 'sandbox-status') s = { k: 'sandbox', label: r.message || '准备沙箱', raw: '' };
  else if (r.type === 'tool') {
    if (HIDDEN.has(r.tool)) return null;
    s = { k: (CATS[r.tool] || { k: 'other' }).k, label: toolLabel(r.tool, r), raw: toolRaw(r.tool, r) };
  } else return null;

  s.id = r.id;
  s.err = BAD_TERMINAL.has(r.status);
  const done = live
    ? (OK_TERMINAL.has(r.status) || BAD_TERMINAL.has(r.status))
    : (r.status !== 'running' && r.status !== 'pending');
  s.done = done && !s.err;
  s.dur = r.t1 > r.t0 ? r.t1 - r.t0 : live && r.at1 > r.at0 ? r.at1 - r.at0 : 0;
  s.note = s.err ? flat(r.message || '执行失败') : '';
  return s;
}

const GROUPABLE = new Set(['cmd', 'read', 'write', 'search', 'net']);

function groupSteps(steps) {
  const out = [];
  let think = null;
  for (const s of steps) {
    if (s.k === 'think') {
      if (!think) {
        think = { k: 'think', done: s.done, err: false, label: '思考', note: '', items: [], dur: 0 };
        out.push(think);
      }
      think.items.push(s);
      think.dur += s.dur;
      think.done = think.done && s.done;
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.k === s.k && GROUPABLE.has(s.k) && last.done === s.done && !s.err) {
      last.items.push(s);
      last.dur += s.dur;
      continue;
    }
    out.push({ k: s.k, done: s.done, err: s.err, label: s.label, note: s.note, items: [s], dur: s.dur });
  }
  return out;
}

/* ================= 轮次渲染 ================= */

function newTurn(live) {
  const root = el('div', 'a');
  const acts = el('div', 'acts');
  const head = el('button', 'acts-head');
  head.type = 'button';
  head.append(el('span', 'sp'), el('span', 'car', '▶'), el('span', 'hd', '执行过程'), el('span', 'mt', ''));
  const body = el('div', 'acts-body');
  acts.append(head, body);

  const answer = el('div', 'body');
  const cards = el('div', 'cards');
  const follows = el('div', 'follows');
  root.append(acts, answer, cards, follows);

  const t = {
    root, acts, head, actsBody: body, answerEl: answer, cardsEl: cards, followsEl: follows,
    parts: new Map(), order: [], userMsgs: new Set(), userText: '',
    // 回放用：这一轮含哪些 assistant 消息，卡片按锚点消息 ID 找到自己的轮次
    msgIds: new Set(),
    live, running: live, startedAt: Date.now(), endedAt: 0,
    open: false, manual: false, openRows: new Set(), override: null, pendings: new Map(),
    // 产物卡按沙箱路径索引：下载地址晚一步才到，靠它把地址贴回对应的卡
    artCards: new Map(),
  };
  head.onclick = () => { t.open = !t.open; t.manual = true; paintActs(t); };
  return t;
}

const partText = (r) => (r.delta.length > r.full.length ? r.delta : r.full);

function upsert(t, p, isDelta, delta) {
  const id = p?.id || p?.partID || p?.partId || 'anon' + t.order.length;
  let r = t.parts.get(id);
  if (!r) {
    r = { id, type: 'text', full: '', delta: '', tool: '', status: '', input: null, message: '', messageID: '', at0: Date.now(), at1: 0 };
    t.parts.set(id, r);
    t.order.push(id);
  }
  if (p?.type) r.type = p.type;
  if (typeof p?.messageID === 'string') r.messageID = p.messageID;
  if (typeof p?.tool === 'string') r.tool = p.tool;
  const st = p?.state?.status || p?.status;
  if (typeof st === 'string') r.status = st;
  if (p?.state?.input) r.input = p.state.input;
  else if (p?.input) r.input = p.input;
  if (typeof p?.state?.title === 'string' && p.state.title) r.title = p.state.title;
  const tm = p?.state?.time;
  if (tm?.start) r.t0 = tm.start;
  if (tm?.end) r.t1 = tm.end;
  const msg = p?.state?.error || p?.message;
  if (typeof msg === 'string' && msg) r.message = msg;
  if (typeof p?.text === 'string' && p.text) r.full = p.text;
  if (isDelta) r.delta += delta || '';
  if (!r.at1 && (OK_TERMINAL.has(r.status) || BAD_TERMINAL.has(r.status))) r.at1 = Date.now();
  schedulePaint(t);
}

// 正文取最长的那段 text part。判据是长度而不是位置：结论段通常远长于过程叙述。
function answerId(t) {
  let best = null, len = -1;
  for (const id of t.order) {
    const r = t.parts.get(id);
    if (r.type !== 'text') continue;
    // 回显的用户原话带了实时在线前缀，比正文长，不能拿它当回答
    const shown = spokenText(partText(r)).trim();
    if (!shown || flat(shown) === t.userText) continue;
    if (shown.length > len) { len = shown.length; best = id; }
  }
  return best;
}

function answerText(t) {
  if (t.override != null) return t.override;
  const id = answerId(t);
  return id ? spokenText(partText(t.parts.get(id))) : '';
}

function schedulePaint(t) {
  if (t._raf) return;
  t._raf = requestAnimationFrame(() => { t._raf = 0; paint(t); });
}

function paint(t) {
  t.answerEl.innerHTML = mdToHtml(stripAction(answerText(t)));
  paintActs(t);
  paintFollows(t);
  if (t.running) scrollBottom();
}

function paintFollows(t) {
  const items = [];
  for (const id of t.order) {
    const r = t.parts.get(id);
    if (r.type === 'follow-up' && Array.isArray(r.items)) items.push(...r.items);
  }
  t.followsEl.innerHTML = '';
  for (const f of items) {
    const q = typeof f === 'string' ? f : f?.query;
    if (!q) continue;
    const b = el('button', 'chip', q);
    b.type = 'button';
    b.onclick = () => { if (!T.busy) ask(q); };
    t.followsEl.append(b);
  }
}

function paintActs(t, aid) {
  if (aid === undefined) aid = answerId(t);
  const steps = [];
  for (const id of t.order) {
    const s = stepOf(t.parts.get(id), t.live, aid, t);
    if (!s) continue;
    if (!t.running && !s.err) s.done = true;
    steps.push(s);
  }
  const rows = groupSteps(steps);

  if (t.running && !t.manual) t.open = true;
  else if (!t.running && !t.manual) t.open = rows.length <= 4;

  const span = t.running ? Date.now() - t.startedAt : (t.endedAt || Date.now()) - t.startedAt;
  const meta = [];
  const n = rows.filter((g) => g.k !== 'think').length;
  if (n) meta.push(`${n} 步`);
  if ((t.live || t.endedAt) && span > 600) meta.push(fmtDur(span));

  t.acts.className = 'acts' + (t.open ? ' open' : '') + (t.running ? ' running' : '');
  t.head.querySelector('.mt').textContent = meta.join(' · ') || (t.running ? '准备中' : '');
  t.acts.style.display = (rows.length || t.running) ? '' : 'none';

  t.actsBody.innerHTML = '';
  for (const [i, g] of rows.entries()) {
    const key = g.k + '#' + (g.items[0].id || i);
    const isOpen = t.openRows.has(key);
    const holder = el('div', 'srow' + (isOpen ? ' open' : ''));
    const row = el('div', 'row' + (g.err ? ' err' : g.done ? ' done' : ''));
    row.append(
      el('span', 'ic', g.err ? '✕' : g.done ? '✓' : '▸'),
      el('span', 'tx', g.label + (g.note ? ' · ' + g.note : '')),
    );
    if (g.items.length > 1) row.append(el('span', 'n', '×' + g.items.length));
    if (g.dur > 900) row.append(el('span', 'dur', fmtDur(g.dur)));
    holder.append(row);

    const raws = g.items.map((s) => s.raw).filter((x) => x && flat(x) !== flat(g.label));
    if (raws.length) {
      const more = el('button', 'rowmore', isOpen ? '收起' : '入参');
      more.type = 'button';
      more.onclick = () => { if (isOpen) t.openRows.delete(key); else t.openRows.add(key); paintActs(t); };
      holder.append(more);
    }
    t.actsBody.append(holder);
    if (isOpen && raws.length) t.actsBody.append(el('pre', 'raw', clip(raws.join('\n\n'), 4000)));
  }
}

/* ================= 安全闸门卡 ================= */

const LEVEL_NAME = { L: '低危', M: '中危', H: '高危', C: '严重', X: '校验未过' };
const DEC_NAME = { allow: '放行', confirm: '待确认', deny: '拦截' };

function addGateCard(t, g, replay, onDecide) {
  const card = el('div', 'gate lv-' + g.level);
  const h = el('div', 'gate-h');
  h.append(el('span', 'lv', `${g.level} ${LEVEL_NAME[g.level] || ''}`));
  h.append(el('b', '安全闸门'));
  h.append(el('span', 'dec', DEC_NAME[g.decision] || g.decision));
  card.append(h);

  const b = el('div', 'gate-b');
  const ul = el('ul');
  for (const r of g.reasons || []) ul.append(el('li', null, r));
  b.append(ul);

  if (g.decision === 'confirm') {
    if (onDecide) {
      const pend = el('div', 'gate-act');
      const yes = el('button', null, '确认执行');
      const no = el('button', 'ghost', '取消');
      yes.type = 'button'; no.type = 'button';
      pend.append(yes, no);
      const finish = (decision) => {
        yes.disabled = true; no.disabled = true;
        settleGateCard(t, card, '预留', decision, null);
        onDecide(decision, t);
      };
      yes.onclick = () => finish('approve');
      no.onclick = () => finish('reject');
      b.append(pend);
      b.append(el('div', 'pend', '预留确认 · 点了也不会向网关下发'));
    } else if (replay) {
      // 回放不给按钮：pendingId 只有 5 分钟有效，现在点也只会报「已失效」。
      // 当时真点过的话 /api/confirm 落了 resolve，settleGateCard 会把它改成终态。
      b.append(el('div', 'pend', `待确认编号 ${g.pendingId} · 已失效`));
      t.pendings.set(g.pendingId, card);
    } else {
      const pend = el('div', 'gate-act');
      const yes = el('button', null, '确认执行');
      const no = el('button', 'ghost', '取消');
      yes.type = 'button'; no.type = 'button';
      pend.append(yes, no);
      yes.onclick = () => decide(t, g.pendingId, 'approve', card, pend);
      no.onclick = () => decide(t, g.pendingId, 'reject', card, pend);
      b.append(pend);
      b.append(el('div', 'pend', `待确认编号 ${g.pendingId} · 5 分钟内有效`));
    }
  } else if (g.decision === 'deny') {
    b.append(el('div', 'pend', '本次不上发任何指令到 IoT 网关，事件已记入安全审计'));
  } else if (g.preview) {
    b.append(el('div', 'pend', '预留放行 · 下面是将要发出的报文，这次没有请求网关'));
  } else {
    b.append(el('div', 'pend', '闸门放行，已下发到 IoT 网关'));
  }
  card.append(b);
  t.cardsEl.append(card);
  scrollBottom();
  return card;
}

// 待确认卡转终态。实时点击和回放走同一条路，两边的文案不会漂
function settleGateCard(t, card, pendingId, decision, out) {
  card.querySelector('.gate-act')?.remove();
  card.querySelector('.dec').textContent = decision === 'approve' ? '已确认' : '已取消';
  const old = card.querySelector('.pend');
  if (old) old.textContent = decision === 'approve'
    ? `已确认执行（编号 ${pendingId}）`
    : `用户取消，未下发任何指令（编号 ${pendingId}）`;
  if (decision === 'approve' && out) addExecCard(t, out);
}

async function decide(t, pendingId, decision, card, actBox) {
  for (const btn of actBox.querySelectorAll('button')) btn.disabled = true;
  actBox.classList.add('wait');
  try {
    const r = await fetch('/api/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingId, decision, sessionId: T.sid }),
    });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || 'HTTP ' + r.status);
    settleGateCard(t, card, pendingId, decision, decision === 'approve' ? out : null);
    // 待确认那一轮结束时状态栏是「等待确认」。点完按钮这一轮才算真的收尾，状态栏要跟着走，
    // 否则确认完了还写着「等待确认」，看起来像卡住了。
    setStatus('done', decision === 'approve' ? '已完成' : '已取消');
    loadAuditCount();
    loadDevices(true);
  } catch (e) {
    for (const btn of actBox.querySelectorAll('button')) btn.disabled = false;
    const old = card.querySelector('.pend');
    if (old) old.textContent = '执行失败：' + String(e.message || e);
    setStatus('err', '执行失败');
  }
  scrollBottom();
}

/* ================= 执行结果卡 ================= */

const KIND_NAME = { 'device.control': '设备控制', 'scene.create': '场景创建', 'repair.open': '报修引导' };

function addExecCard(t, out) {
  const card = el('div', 'exec');
  const h = el('div', 'exec-h');
  h.append(el('b', null, KIND_NAME[out.kind] || out.kind));
  h.append(el('span', 'badge ' + (out.result === 'SUCCEEDED' ? 'ok' : out.result === 'BLOCKED' ? 'err' : 'warn'),
    { SUCCEEDED: '成功', FAILED: '失败', BLOCKED: '已拦截', CANCELLED: '已取消' }[out.result] || out.result));
  h.append(el('span', 'ms', `${out.ms ?? 0} ms · ${out.trigger === 'gate-confirm' ? '二次确认后下发' : '闸门直放'}`));
  card.append(h);

  const b = el('div', 'exec-b');
  for (const tg of out.targets || []) {
    const row = el('div', 'kv2');
    row.append(el('span', 'k', tg.room || '设备'));
    row.append(el('span', 'v', `${tg.deviceTagName || tg.deviceName} · ${tg.cmd} · ${tg.param}=${tg.value}`));
    b.append(row);
  }

  if (out.iotRequest) {
    const io1 = el('div', 'io');
    io1.append(el('div', 'lbl', `→ ${out.iotRequest.method} ${out.iotRequest.url}`));
    const pre1 = el('pre', null, JSON.stringify(out.iotRequest.body ?? '(无 body)', null, 2));
    io1.append(pre1);
    b.append(io1);
  }
  if (out.iotResponse) {
    const io2 = el('div', 'io');
    io2.append(el('div', 'lbl', out.httpStatus ? `← HTTP ${out.httpStatus}` : '← 网关返回'));
    io2.append(el('pre', null, typeof out.iotResponse === 'string' ? out.iotResponse : JSON.stringify(out.iotResponse, null, 2)));
    b.append(io2);
  }
  if (out.error) {
    const io3 = el('div', 'io');
    io3.append(el('div', 'lbl', '错误'));
    io3.append(el('pre', null, out.error));
    b.append(io3);
  }
  card.append(b);
  t.cardsEl.append(card);
  scrollBottom();
}

function repairLinks(d) {
  const links = d?.deeplinks || {};
  const report = links.report || (d?.kind === 'progress' ? '' : d?.deeplink) || '';
  const progress = links.progress || (d?.kind === 'progress' ? d?.deeplink : '') || '';
  return { report, progress };
}

function repairDevice(summary) {
  const s = String(summary || '');
  if (/镜柜/.test(s)) return '镜柜';
  if (/浴缸/.test(s)) return '浴缸';
  if (/坐便|马桶/.test(s)) return '坐便器';
  return '待确认';
}

function repairPhone(d, kind) {
  const phone = el('div', 'repair-phone');
  const top = el('div', 'rp-top');
  top.append(el('span', null, '箭牌智家'), el('em', null, '报修'));
  phone.append(top);
  const body = el('div', 'rp-body');
  if (kind === 'progress') {
    body.append(el('div', 'rp-title', '报修进度'));
    body.append(el('div', 'rp-empty', '这里只预览进度页。单据、派单和上门都在 App 里，本助手不查询真实工单。'));
  } else {
    body.append(el('div', 'rp-title', '提交报修'));
    const dev = el('div', 'rp-field');
    dev.append(el('span', null, '设备'), el('b', null, repairDevice(d.summary)));
    const issue = el('div', 'rp-field');
    issue.append(el('span', null, '问题'), el('b', null, d.summary || '按刚才的描述提交'));
    body.append(dev, issue);
    body.append(el('div', 'rp-btn', '提交报修'));
    body.append(el('div', 'rp-sub', '预览，不会真的提交'));
  }
  phone.append(body);
  return phone;
}

function openRepairPreview(d) {
  document.querySelector('.repair-mask')?.remove();
  const links = repairLinks(d);
  let kind = d.kind === 'progress' ? 'progress' : 'report';
  const mask = el('div', 'repair-mask');
  const sheet = el('div', 'repair-sheet');
  const head = el('div', 'repair-sheet-h');
  head.append(el('b', null, '跳转预览'));
  const close = el('button', 'mini', '关闭');
  close.type = 'button';
  head.append(close);
  const tabs = el('div', 'repair-tabs');
  const tabReport = el('button', 'on', '提交报修');
  const tabProgress = el('button', null, '报修进度');
  tabReport.type = 'button';
  tabProgress.type = 'button';
  tabs.append(tabReport, tabProgress);
  const stage = el('div', 'repair-stage');
  const url = el('div', 'repair-url');
  const paint = () => {
    tabReport.classList.toggle('on', kind === 'report');
    tabProgress.classList.toggle('on', kind === 'progress');
    stage.innerHTML = '';
    stage.append(repairPhone(d, kind));
    url.textContent = (kind === 'progress' ? links.progress : links.report) || d.deeplink || '';
  };
  tabReport.onclick = () => { kind = 'report'; paint(); };
  tabProgress.onclick = () => { kind = 'progress'; paint(); };
  sheet.append(head, tabs, stage, url, el('p', null, d.note || '真实跳转地址待箭牌 App 确认，当前是预留入口。'));
  mask.append(sheet);
  const dismiss = () => { mask.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') dismiss(); };
  close.onclick = dismiss;
  mask.addEventListener('click', (e) => { if (e.target === mask) dismiss(); });
  document.addEventListener('keydown', onKey);
  document.body.append(mask);
  paint();
  close.focus();
}

function addRepairCard(t, d) {
  if (t.cardsEl.querySelector('.repair')) return;
  const kind = d.kind === 'progress' ? 'progress' : 'report';
  const card = el('div', 'repair');
  const h = el('div', 'repair-h');
  h.append(el('b', null, '跳转预览'));
  h.append(el('span', 'pill', '预留地址'));
  card.append(h);
  card.append(el('p', null, '下面是即将打开的报修页。地址还没换成箭牌 App 的正式链接，点开只做预览。'));
  card.append(repairPhone(d, kind));
  const foot = el('div', 'repair-foot');
  const btn = el('button', 'mini primary', '放大预览');
  btn.type = 'button';
  btn.onclick = () => openRepairPreview(d);
  const url = el('span', 'repair-url', repairLinks(d)[kind] || d.deeplink || '');
  foot.append(btn, url);
  card.append(foot);
  t.cardsEl.append(card);
  scrollBottom();
}

/* ================= 产物卡 ================= */

// 下载地址是平台签发的临时地址，落盘没有意义，只能在点的时候现取。
// 服务端在一轮收尾时会补推一次（demo.artifact.ready），补不上就靠这个按钮兜底。
async function artifactUrl(sessionId, filePath) {
  const q = new URLSearchParams({ sessionId: sessionId || '', path: filePath });
  const r = await fetch('/api/artifacts/resolve?' + q);
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
  return d;
}

const artLink = (url, text) => {
  const a = el('a', 'mini', text);
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
};

// 「取地址 → 变链接」这一段卡片和产物中心的表格是同一套行为，写一处。
// onInfo 是给会话内那张卡的：取回来的地址里还带着体积和格式，顺手回填到卡片上。
function urlSlot(sessionId, filePath, onInfo) {
  const box = el('div', 'rowacts');
  let urls = { url: '', preview: '' };
  let busy = false;
  let err = '';

  const paintAct = () => {
    box.innerHTML = '';
    if (err) box.append(el('span', 'hint', err));
    if (urls.url) {
      box.append(artLink(urls.url, '下载'));
      if (urls.preview) box.append(artLink(urls.preview, '预览'));
      return;
    }
    const b = el('button', 'mini', busy ? '获取中…' : '获取下载地址');
    b.type = 'button';
    b.disabled = busy;
    b.onclick = async () => {
      if (busy) return;
      busy = true; err = '';
      paintAct();
      try {
        const d = await artifactUrl(sessionId, filePath);
        urls = { url: d.downloadUrl || '', preview: d.previewUrl || '' };
        if (!urls.url) err = '平台还没登记这个文件';
        else if (onInfo) onInfo(d);
      } catch (e) {
        err = '取不到：' + String(e.message || e);
      }
      busy = false;
      paintAct();
    };
    box.append(b);
  };

  paintAct();
  return {
    box,
    set: (d) => {
      urls = { url: d.downloadUrl || '', preview: d.previewUrl || '' };
      err = '';
      if (onInfo) onInfo(d);
      paintAct();
    },
  };
}

function addArtifactCard(t, a) {
  const card = el('div', 'artifact');
  const h = el('div', 'artifact-h');
  h.append(el('span', 'ico', '⇣'));
  h.append(el('span', 'fn', a.filename || baseName(a.path)));
  // 体积和格式来自 path-map，实时这一轮要到补推 demo.artifact.ready 才有
  const meta = el('div', 'artifact-m');
  const paintMeta = (d) => {
    const rel = a.relativePath || relPath(a.path);
    meta.textContent = [
      rel && rel !== (a.filename || '') ? rel : '',
      d?.mimeType || a.mimeType,
      fmtSize(d?.size ?? a.size),
      a.sessionId ? '会话 ' + String(a.sessionId).slice(-8) : '',
      a.at ? fmtWhen(a.at) : '',
    ].filter(Boolean).join(' · ');
  };
  paintMeta();
  const slot = urlSlot(a.sessionId, a.path, paintMeta);
  slot.box.classList.add('act');
  h.append(slot.box);
  card.append(h);
  card.append(meta);
  t.artCards.set(a.path, slot);
  t.cardsEl.append(card);
  scrollBottom();
  return card;
}

/* ================= markdown ================= */

function mdToHtml(md) {
  const lines = esc(md || '').split('\n');
  let out = '', i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (/^\s*\|/.test(ln) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const cells = (s) => s.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(ln);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i])); i++; }
      out += '<table><thead><tr>' + head.map((c) => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('')
        + '</tbody></table>';
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(ln)) { out += '<hr>'; i++; continue; }
    if (/^#{1,4}\s/.test(ln)) { out += '<h3>' + ln.replace(/^#{1,4}\s/, '') + '</h3>'; i++; continue; }
    if (!ln.trim()) { i++; continue; }
    const buf = [ln];
    i++;
    while (i < lines.length && lines[i].trim() && !/^\s*\|/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i])) { buf.push(lines[i]); i++; }
    out += '<p>' + buf.join('<br>') + '</p>';
  }
  return out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
}

/* ================= 对话流 ================= */

let wrap = null;
function ensureWrap() {
  if (!wrap || !document.body.contains(wrap)) {
    streamEl.innerHTML = '';
    wrap = el('div', 'wrap');
    streamEl.append(wrap);
  }
  return wrap;
}
const scrollBottom = () => { streamEl.scrollTop = streamEl.scrollHeight; };

function addUser(text) {
  const u = el('div', 'u');
  u.append(el('div', null, text));
  ensureWrap().append(u);
  scrollBottom();
}

function addTurn(t) { ensureWrap().append(t.root); scrollBottom(); return t; }

// 六条推荐问各自打一个场景标签，客户一眼看出覆盖了五个核心场景
const STARTER_TAG = ['设备控制', '高危指令 · 二次确认', '场景创建', '产品百科', '报修引导', '生成交付物'];

function showEmpty() {
  streamEl.innerHTML = '';
  wrap = null;
  const box = el('div', 'wrap');
  const e = el('div', 'empty');
  e.append(el('b', null, CFG.brand?.emptyTitle || '说一句话就好'));
  e.append(document.createTextNode(CFG.brand?.emptyDesc || ''));
  const list = el('div', 'starters');
  (CFG.starters || []).forEach((s, i) => {
    const b = el('button');
    b.type = 'button';
    b.append(document.createTextNode(s));
    if (STARTER_TAG[i]) b.append(el('span', 'tagline', STARTER_TAG[i]));
    b.onclick = () => { if (!T.busy) ask(s); };
    list.append(b);
  });
  e.append(list);
  box.append(e);
  streamEl.append(box);
}

/* ---------- 实时一轮 ---------- */

async function readSSE(body, onEvent) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const sep = buf.slice(i).match(/^\r?\n\r?\n/)[0];
      const frame = buf.slice(0, i);
      buf = buf.slice(i + sep.length);
      let ev = 'message';
      const data = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (!data.length) continue;
      const raw = data.join('\n');
      let d;
      try { d = JSON.parse(raw); } catch { d = raw; }
      onEvent(ev, d);
    }
  }
}

function handleEvent(ev, d, t) {
  switch (ev) {
    case 'demo.session':
      T.sid = d.sessionId;
      setStatus('on', '准备中');
      loadSessions();
      break;
    case 'session.status': {
      const s = d?.status?.type || (typeof d?.status === 'string' ? d.status : '') || '';
      const label = { preparing: '准备中', busy: '执行中', idle: '已完成', retry: '重试中' }[s] || s;
      setStatus(s === 'idle' ? 'done' : 'on', label);
      break;
    }
    case 'message.updated': {
      const info = d?.info || d;
      if (info?.role === 'user' && info.id) t.userMsgs.add(info.id);
      break;
    }
    case 'message.part.updated':
      upsert(t, d?.part || d, false);
      break;
    case 'message.part.delta':
    case 'message.delta': {
      const delta = d?.delta ?? d?.text ?? '';
      // 增量帧只带 partID，不带 part.type，别在这里补 'text'。
      // upsert 见到 type 就写回记录，补一个 'text' 会把 message.part.updated 早先
      // 标好的 'reasoning' 覆盖掉，思考过程就变成了候选正文；而它比正文长，
      // answerId 取最长的 text part，于是整段思考被渲染成回答。
      // 不传 type 时 upsert 只在新建记录时默认 text，后续 updated 帧仍能纠正。
      if (delta) upsert(t, { ...(d?.part || {}), id: d?.partID || d?.partId || d?.part?.id, type: d?.part?.type }, true, delta);
      break;
    }
    // 服务端摘掉 iot 代码块之后的正文，覆盖原来那段
    case 'demo.answer':
      t.override = d?.text ?? '';
      paint(t);
      break;
    case 'demo.gate':
      addGateCard(t, d);
      break;
    case 'demo.exec':
      addExecCard(t, d);
      loadAuditCount();
      loadDevices(true);
      break;
    case 'demo.repair':
      addRepairCard(t, d);
      loadAuditCount();
      break;
    case 'demo.artifact':
      addArtifactCard(t, d);
      break;
    // 收尾时补推的临时下载地址，贴回对应的产物卡
    case 'demo.artifact.ready':
      t.artCards.get(d?.path)?.set(d);
      break;
    case 'demo.done':
      endTurn(t, !!d?.incomplete, null, d?.pendingId);
      break;
    case 'demo.error':
      endTurn(t, true, d?.message || String(d));
      break;
  }
}

async function ask(text) {
  if (T.scene) {
    T.scene = null;
    streamEl.innerHTML = '';
    wrap = null;
  }
  if (T.ctl) { T.ctl.abort(); T.ctl = null; }
  stopFollow();
  if (!wrap) ensureWrap();
  addUser(text);
  T.busy = true;
  sendBtn.disabled = true;
  setStatus('on', '建会话…');
  if (!T.sid) chatTitle.textContent = clip(text, 34);

  const t = newTurn(true);
  t.userText = flat(text);
  T.turn = t;
  addTurn(t);
  paint(t);

  const ctl = new AbortController();
  T.ctl = ctl;
  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, sessionId: T.sid || undefined }),
      signal: ctl.signal,
    });
    if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
    await readSSE(res.body, (ev, d) => handleEvent(ev, d, t));
    endTurn(t, false);
  } catch (e) {
    if (e?.name === 'AbortError') endTurn(t, true, '已取消');
    else endTurn(t, true, String(e?.message || e));
  }
}

function endTurn(t, incomplete, errMsg, pendingId) {
  if (!t.running) return;
  t.running = false;
  t.endedAt = Date.now();
  if (errMsg) {
    const id = 'err' + t.startedAt;
    t.parts.set(id, { id, type: 'sandbox-status', message: '出错：' + errMsg, status: 'error' });
    t.order.push(id);
  }
  paint(t);
  // 停在待确认不算跑完：状态栏要说清楚在等人，而不是显示「已完成」
  if (pendingId) setStatus('on', '等待确认');
  else setStatus(errMsg ? 'err' : 'done', errMsg ? '出错' : incomplete ? '已中断' : '已完成');
  T.busy = false;
  sendBtn.disabled = false;
  loadSessions();
}

/* ---------- 历史回放 ---------- */

async function openSession(sid, title) {
  if (T.ctl) { T.ctl.abort(); T.ctl = null; }
  stopFollow();
  T.busy = false;
  sendBtn.disabled = false;
  T.sid = sid;
  T.scene = null;
  chatTitle.textContent = clip(title || '对话', 40);
  setStatus('', '已载入');

  const busy = await renderHistory(sid);
  if (busy == null) return;
  if (!busy) { setStatus('', '已载入'); loadSessions(); return; }

  setStatus('on', '运行中');
  T.follow = setInterval(async () => {
    if (T.busy || T.sid !== sid) return;
    const still = await renderHistory(sid);
    if (still == null || still) return;
    stopFollow();
    setStatus('done', '已完成');
    loadSessions();
  }, 8000);
}

function stopFollow() {
  if (T.follow) { clearInterval(T.follow); T.follow = null; }
}

// 历史回放。平台消息里只有正文、思考与工具调用，「闸门 → 下发 → 结果」那几张卡
// 是本编排层的事件，服务端另存在 cards.jsonl 里，跟消息一起返回。
// 靠消息 ID 挂回各自的轮次，还原当初看到的样子。
async function renderHistory(sid) {
  streamEl.innerHTML = '';
  wrap = null;
  ensureWrap().append(el('div', 'hint', '载入中…'));
  setStatus('on', '载入中');

  let items = [], cards = [];
  try {
    const r = await fetch('/api/sessions/' + encodeURIComponent(sid) + '/events');
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || 'HTTP ' + r.status);
    items = Array.isArray(body.data) ? body.data : [];
    cards = Array.isArray(body.cards) ? body.cards : [];
  } catch (e) {
    streamEl.innerHTML = '';
    wrap = null;
    ensureWrap().append(el('div', 'hint', '读取失败：' + String(e.message || e)));
    setStatus('err', '读取失败');
    return null;
  }

  streamEl.innerHTML = '';
  wrap = null;
  ensureWrap();

  // 一个回合在历史里是连着的好几条 assistant 消息，必须并成一个气泡
  const turns = [];
  let turn = null;
  let lastUser = '';
  for (const it of items) {
    const role = it?.info?.role;
    const parts = it?.parts || [];
    if (role === 'user') {
      const txt = parts.filter((p) => p.type === 'text').map((p) => p.text).filter(Boolean).join('\n');
      const shown = spokenText(txt);
      if (shown) addUser(shown);
      lastUser = flat(shown);
      turn = null;
      continue;
    }
    if (role !== 'assistant') continue;
    const keep = parts.filter((p) => p.type !== 'sandbox-status');
    if (!keep.length && !turn) continue;
    const tm = it?.info?.time || {};
    if (!turn) {
      turn = newTurn(false);
      turn.userText = lastUser;
      addTurn(turn);
      turns.push(turn);
      turn.startedAt = tm.created || Date.now();
    } else if (tm.created) turn.startedAt = Math.min(turn.startedAt, tm.created);
    if (tm.completed) turn.endedAt = Math.max(turn.endedAt, tm.completed);
    // 卡片落盘时挂在这一轮的消息 ID 上，这里把这一轮的消息 ID 全收进来
    if (it?.info?.id) turn.msgIds.add(it.info.id);
    for (const p of parts) if (p.messageID) turn.msgIds.add(p.messageID);
    if (!keep.length) continue;
    for (const p of keep) upsert(turn, p, false);
  }
  for (const t of turns) paint(t);
  replayCards(turns, cards);
  scrollBottom();
  const last = items[items.length - 1];
  return !!last && last?.info?.role === 'assistant' && !last?.info?.time?.completed;
}

// 把落盘的卡片贴回各自的轮次。
// 挂载靠消息 ID：那一轮最后一条 assistant 消息，平台历史里是同一个 ID，
// 不用时间戳对齐（本地与平台时钟不同源，猜不准）。
function replayCards(turns, recs) {
  const turnOfMsg = new Map();
  for (const t of turns) for (const id of t.msgIds) turnOfMsg.set(id, t);

  const resolves = [];
  for (const rec of recs) {
    if (rec.type === 'cards') {
      const t = turnOfMsg.get(rec.msgId);
      if (!t) continue;
      for (const r of rec.cards || []) {
        if (r.event === 'demo.gate') addGateCard(t, r.data, true);
        else if (r.event === 'demo.exec') addExecCard(t, r.data);
        else if (r.event === 'demo.repair') addRepairCard(t, r.data);
        // 落盘的是没带下载地址的那份，回看时点「获取下载地址」现取。
        // sessionId 只在回合记录里有：早先写下的流水里那张卡是光秃秃的，
        // 少了它按钮会带着空 sessionId 去请求，回放里永远取不到地址。
        else if (r.event === 'demo.artifact') addArtifactCard(t, { sessionId: rec.sessionId, ...r.data });
      }
    } else if (rec.pendingId) resolves.push(rec);
  }

  // 确认/取消要等闸门卡都放好了再改，且必须晚于上面那轮循环
  for (const rec of resolves) {
    const t = turns.find((x) => x.pendings.has(rec.pendingId));
    if (t) settleGateCard(t, t.pendings.get(rec.pendingId), rec.pendingId, rec.decision, rec.out);
  }
}

/* ================= 需求场景（侧栏可点开的预留回放） ================= */

const HOME = () => CFG.iot?.homeId ?? 933;
const TUB = { deviceName: 'ARROW0417663939524510', deviceTagName: 'ACH102智能浴缸', room: '主卫' };
const TOILETS = [
  { deviceName: 'ARROWToilet17419421020631', deviceTagName: 'AKB1332-P智能坐便器', room: '主卫' },
  { deviceName: 'ARROW0117701862667130', deviceTagName: 'AKB1357智能坐便器', room: '主卫' },
];
const MIRRORS = [
  { deviceName: 'ARROW0617696743520408', deviceTagName: 'QN-PRO智能镜柜', room: '主卫' },
  { deviceName: 'ARROW0617696743520409', deviceTagName: 'QN-PRO智能镜柜', room: '主卫' },
];
const SCENE_AT = '2026-09-24 22:00:00';

function addReserveCard(t, d) {
  const card = el('div', 'reserve');
  const h = el('div', 'reserve-h');
  h.append(el('b', null, d.title));
  if (d.badge) h.append(el('span', 'pill', d.badge));
  card.append(h);
  if (d.note) card.append(el('p', null, d.note));
  for (const row of d.rows || []) {
    const line = el('div', 'kv');
    line.append(el('span', 'k', row.k), el('span', 'v' + (row.mono ? ' mono' : ''), row.v));
    card.append(line);
  }
  if (d.payload) card.append(el('pre', 'raw', d.payload));
  t.cardsEl.append(card);
  scrollBottom();
}

function addPickCard(t, d) {
  const card = el('div', 'reserve');
  const h = el('div', 'reserve-h');
  h.append(el('b', null, d.title));
  h.append(el('span', 'pill', '预留'));
  card.append(h);
  if (d.note) card.append(el('p', null, d.note));
  const picks = el('div', 'picks');
  for (const opt of d.options) {
    const b = el('button', null, opt.label);
    b.type = 'button';
    b.onclick = () => {
      for (const x of picks.querySelectorAll('button')) x.disabled = true;
      b.classList.add('on');
      d.onPick(opt, t);
    };
    picks.append(b);
  }
  card.append(picks);
  t.cardsEl.append(card);
  scrollBottom();
}

function controlBody(dev, cmd, value) {
  return {
    homeId: HOME(),
    cmdList: [{ deviceName: dev.deviceName, cmd, param: 'switch', value }],
  };
}

function showControl(t, dev, cmd, value) {
  addReserveCard(t, {
    title: '下发报文',
    badge: '预留',
    note: '11 台设备目前都离线，真发出去平台会回「设备离线」。这里只放下发前的报文。',
    rows: [
      { k: '设备', v: `${dev.room} · ${dev.deviceTagName}` },
      { k: '指令', v: `${cmd} = ${value}`, mono: true },
      { k: '接口', v: 'POST /ext/v3/ai/control', mono: true },
    ],
    payload: JSON.stringify(controlBody(dev, cmd, value), null, 2),
  });
}

function showAllowed(t, dev, cmd, value, reason) {
  addGateCard(t, {
    decision: 'allow', level: 'M', preview: true,
    reasons: [reason],
    items: [{ deviceName: dev.deviceName, deviceTagName: dev.deviceTagName, room: dev.room, cmd, param: 'switch', value }],
  });
  showControl(t, dev, cmd, value);
}

const SCENES = [
  {
    id: 'valve',
    tag: '高危 · 二次确认',
    title: '把主卫的浴缸进水打开',
    answer: '主卫 ACH102 的进水阀是需求里点名的水阀开关，属于高危。模型只提出要打开，下发要等你确认。',
    play(t) {
      addGateCard(t, {
        decision: 'confirm', level: 'H',
        reasons: ['浴缸进水阀开关（需求 3.4 点名的「水阀开关」）'],
        items: [{ ...TUB, cmd: 'switch_water_in', param: 'switch', value: 'on' }],
      }, false, (decision, turn) => {
        if (decision === 'approve') showControl(turn, TUB, 'switch_water_in', 'on');
      });
    },
  },
  {
    id: 'flush',
    tag: '设备控制 · 先确认哪一台',
    title: '把主卫坐便器的大冲打开',
    answer: '主卫有两台坐便器，大冲不会猜是哪一台。点一台之后，看中危指令怎样直接放行。',
    play(t) {
      addPickCard(t, {
        title: '先确认是哪一台',
        note: '两台都标在主卫：AKB1332-P 与 AKB1357。',
        options: TOILETS.map((d) => ({ ...d, label: `${d.room} · ${d.deviceTagName.replace('智能坐便器', '')}` })),
        onPick(dev, turn) { showAllowed(turn, dev, 'switch_watering', 'on', 'M 级操作，未达二次确认阈值，闸门放行'); },
      });
    },
  },
  {
    id: 'light',
    tag: '设备控制 · 镜柜夜灯',
    title: '把主卫镜柜的夜灯打开',
    answer: '夜灯在官方品类表里只写了马桶，实测镜柜（品类 06）也收。主卫有两台 QN-PRO，先点一台。',
    play(t) {
      addPickCard(t, {
        title: '先确认是哪一台',
        note: '两台型号相同，用设备编号区分。',
        options: MIRRORS.map((d) => ({ ...d, label: `${d.room} · QN-PRO · ${d.deviceName.slice(-4)}` })),
        onPick(dev, turn) { showAllowed(turn, dev, 'switch_night_light', 'on', 'M 级操作，镜柜夜灯按平台实测放行'); },
      });
    },
  },
  {
    id: 'scene',
    tag: '场景创建 · 高危',
    title: '每天晚上 10 点自动给主卫浴缸放水',
    answer: '接口只接受一个具体时刻，没有「每天」这种重复。按最近一次 2026-09-24 22:00 预留。进水阀仍是高危，场景和单次控制用同一条确认。',
    play(t) {
      const conditionList = [{ deviceName: TUB.deviceName, cmd: 'switch_water_in', param: 'switch', value: 'on', time: SCENE_AT }];
      const actionList = [{ deviceName: TUB.deviceName, cmd: 'switch_water_in', param: 'switch', value: 'on' }];
      addGateCard(t, {
        decision: 'confirm', level: 'H',
        reasons: ['浴缸进水阀开关（高危校验对场景与单次控制一视同仁）'],
        items: [{ ...TUB, cmd: 'switch_water_in', param: 'switch', value: 'on' }],
      }, false, (decision, turn) => {
        if (decision !== 'approve') return;
        addReserveCard(turn, {
          title: '场景报文',
          badge: '预留',
          note: '平台没有场景查询接口。这张卡没有写入审计，设备页的场景列表不会因此多出一条。',
          rows: [
            { k: '触发', v: `${SCENE_AT} · 进水打开`, mono: true },
            { k: '执行', v: 'switch_water_in = on', mono: true },
            { k: '接口', v: 'POST /ext/v3/ai/scene', mono: true },
          ],
          payload: JSON.stringify({ homeId: HOME(), conditionList, actionList }, null, 2),
        });
      });
    },
  },
  {
    id: 'wiki',
    tag: '产品百科',
    title: 'AKB1357 有哪些功能？',
    answer: 'AKB1357 是即热式一体坐便器，支持大冲。座温有 10 档，但真实平台没有对应的可下发指令，只能在遥控器或 App 上调。下面这份资料是演示占位，正式内容要等箭牌替换。',
    play(t) {
      addReserveCard(t, {
        title: '资料',
        badge: '预留',
        note: '需求写明知识库由箭牌提供。当前文件只为把问答链路跑通。',
        rows: [
          { k: '文件', v: '箭牌产品知识库.md', mono: true },
          { k: '型号', v: 'AKB1357 智能坐便器' },
          { k: '可下发', v: '大冲、夜灯、翻盖、脚触、润瓷、开关' },
          { k: '不能下发', v: '座温 10 档、暖风烘干' },
        ],
      });
    },
  },
  {
    id: 'repair',
    tag: '报修引导',
    title: '我家坐便器不出水了，要报修',
    answer: '可以跳到 App 的报修页提交坐便器不出水的报修。进度也在报修页里查，派单和上门不在本助手里。',
    play(t) {
      addRepairCard(t, {
        kind: 'report',
        summary: '我家坐便器不出水了，要报修',
        deeplink: 'arrowhome://repair/create?from=ai_assistant',
        deeplinks: {
          report: 'arrowhome://repair/create?from=ai_assistant',
          progress: 'arrowhome://repair/list?from=ai_assistant',
        },
        note: CFG.repair?.note || '只做跳转，不对接工单。真实地址待箭牌 App 确认。',
      });
    },
  },
  {
    id: 'sheet',
    tag: '生成交付物',
    title: '把主卫所有设备的状态整理成一份表格',
    answer: '交付物是文件，不是对话里的一张表。挂上 xlsx 技能并真实跑一轮后，下面这张卡会换成可下载的文件。',
    play(t) {
      addReserveCard(t, {
        title: '主卫设备状态.xlsx',
        badge: '预留',
        note: '现在没有向平台要下载地址。技能管理里能看到 xlsx 是否挂在本助手上。',
        rows: [
          { k: '主卫', v: 'ACH102 浴缸 · 离线' },
          { k: '主卫', v: 'AKB1332-P 坐便器 · 离线' },
          { k: '主卫', v: 'AKB1357 坐便器 · 离线' },
          { k: '主卫', v: 'QN-PRO 镜柜 ×2 · 离线' },
        ],
      });
    },
  },
];

function openScene(scene) {
  if (T.ctl) { T.ctl.abort(); T.ctl = null; }
  stopFollow();
  T.sid = null;
  T.scene = scene.id;
  T.busy = false;
  sendBtn.disabled = false;
  chatTitle.textContent = clip(scene.title, 40);
  setStatus('', '场景预留');
  streamEl.innerHTML = '';
  wrap = null;
  addUser(scene.title);
  const t = newTurn(false);
  t.override = scene.answer;
  t.endedAt = t.startedAt;
  addTurn(t);
  paint(t);
  scene.play(t);
  paintSessions();
}

/* ================= 会话列表 ================= */

let allSessions = [];

async function loadSessions() {
  let data = [];
  try { ({ data = [] } = await (await fetch('/api/sessions')).json()); } catch {}
  allSessions = data;
  paintSessions();
}

function paintSessions() {
  const q = ($('#sessFind')?.value || '').trim().toLowerCase();
  const scenes = SCENES.filter((s) => !q || (s.title + s.tag).toLowerCase().includes(q));
  const data = q ? allSessions.filter((s) => String(s.title || '').toLowerCase().includes(q)) : allSessions;
  sessionsEl.innerHTML = '';
  if (scenes.length) {
    sessionsEl.append(el('div', 'sess-k', '需求场景'));
    for (const s of scenes) {
      const row = el('div', 'srow' + (T.scene === s.id && !T.sid ? ' on' : ''));
      const b = el('button', 'sitem');
      b.type = 'button';
      b.append(el('div', 't', s.title), el('div', 'd', s.tag));
      b.onclick = () => { switchView('chat'); openScene(s); };
      row.append(b);
      sessionsEl.append(row);
    }
  }
  sessionsEl.append(el('div', 'sess-k', '对话记录'));
  if (!data.length) {
    sessionsEl.append(el('div', 'hint', allSessions.length ? '没有匹配的会话' : '还没有真实对话'));
    return;
  }
  for (const s of data) {
    const row = el('div', 'srow' + (s.id === T.sid ? ' on' : ''));
    const b = el('button', 'sitem');
    b.type = 'button';
    b.append(el('div', 't', s.title), el('div', 'd', fmtWhen(s.updatedAt || s.createdAt)));
    b.onclick = () => { switchView('chat'); openSession(s.id, s.title); };
    row.append(b, sessionDeleteBtn(s));
    sessionsEl.append(row);
  }
}

// 平台没有「归档」。删除是 DELETE /sessions/{id}，会话从列表里消失。
// 按两下才发出去，避免侧栏里误点。
function sessionDeleteBtn(s) {
  const b = el('button', 'sdel', '删除');
  b.type = 'button';
  let armed = 0;
  b.onclick = async (ev) => {
    ev.stopPropagation();
    if (!armed) {
      armed = setTimeout(() => { armed = 0; b.textContent = '删除'; }, 4000);
      b.textContent = '确认';
      return;
    }
    clearTimeout(armed);
    armed = 0;
    b.disabled = true;
    b.textContent = '…';
    try {
      const r = await fetch('/api/sessions/' + encodeURIComponent(s.id), { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
      if (T.sid === s.id) resetChat();
      await loadSessions();
    } catch (e) {
      b.disabled = false;
      b.textContent = '失败';
      b.title = String(e.message || e);
    }
  };
  return b;
}

function resetChat() {
  if (T.ctl) { T.ctl.abort(); T.ctl = null; }
  stopFollow();
  T.sid = null; T.scene = null; T.busy = false; T.turn = null;
  sendBtn.disabled = false;
  chatTitle.textContent = '新对话';
  setStatus('', '空闲');
  switchView('chat');
  showEmpty();
}

/* ================= 家庭设备 ================= */

async function loadDevices(quiet) {
  const box = $('#devPane');
  if (!quiet) {
    box.innerHTML = '';
    const p = el('div', 'pane-inner');
    p.append(el('div', 'hint', '读取 IoT 网关…'));
    box.append(p);
  }

  let dev = { data: [] }, sc = { data: [] };
  try {
    const r = await fetch('/api/iot/devices' + (quiet ? '' : '?fresh=1'));
    const text = await r.text();
    try { dev = JSON.parse(text); } catch { dev = { data: [], error: `HTTP ${r.status} ${text.slice(0, 160)}` }; }
    if (!r.ok && !dev.error) dev.error = `HTTP ${r.status}`;
  } catch (e) {
    dev = { data: [], error: String(e.message || e) };
  }
  try { sc = await (await fetch('/api/iot/scenes')).json(); } catch {}

  box.innerHTML = '';
  const p = el('div', 'pane-inner');
  box.append(p);

  const rows = Array.isArray(dev.data) ? dev.data : [];
  const online = rows.filter((d) => d.onlineStatus).length;
  $('#devCount').textContent = rows.length || '';

  if (dev.error) {
    const c = el('div', 'card');
    c.append(el('h3', null, '网关调用失败'));
    c.append(el('div', 'kv', `GET /ext/v3/ai/device-list → ${dev.error}`));
    if (rows.length) c.append(el('div', 'hint', '下面仍列出本地清单里的设备，没拿到实时状态的按离线显示。'));
    p.append(c);
  }

  const head = el('div', 'card');
  head.append(el('h3', null, `家庭设备 · homeId ${CFG.iot?.homeId ?? ''}`));
  const kv = (k, v, mono) => {
    const row = el('div', 'kv');
    row.append(el('span', 'k', k), el('span', 'v' + (mono ? ' mono' : ''), v));
    head.append(row);
  };
  kv('在线', `${online} / ${rows.length} 台`);
  kv('离线', `${rows.length - online} 台`);
  kv('接口', `GET /ext/v3/ai/device-list（${dev.ms ?? 0} ms）`, true);
  kv('网关', CFG.iot?.baseUrl || '');
  p.append(head);

  const c = el('div', 'card');
  const tb = el('table', 'grid');
  tb.innerHTML = '<thead><tr><th>房间</th><th>设备名</th><th>deviceName</th><th>品类</th><th>状态</th></tr></thead>';
  const tbody = el('tbody');
  const catName = (code) => ({ '01': '马桶', '04': '浴缸', '06': '镜柜' }[code] || code);
  if (!rows.length) c.append(el('div', 'hint', '没有设备。'));
  for (const d of rows) {
    const tr = el('tr', d.onlineStatus ? '' : 'off');
    const td = (txt, cls) => { const n = el('td', cls || null); n.textContent = txt; return n; };
    const roomTd = el('td');
    roomTd.append(el('span', 'dot' + (d.onlineStatus ? ' on' : '')));
    roomTd.append(document.createTextNode(d.room || '—'));
    tr.append(roomTd);
    tr.append(td(d.deviceTagName));
    tr.append(td(d.deviceName, 'mono'));
    tr.append(td(d.categoryName || catName(d.categoryCode)));
    const st = el('td');
    st.append(el('span', 'pill' + (d.onlineStatus ? ' on' : ''), d.onlineStatus ? '在线' : '离线'));
    tr.append(st);
    tbody.append(tr);
  }
  tb.append(tbody);
  c.append(tb);
  p.append(c);

  const sc2 = el('div', 'card');
  sc2.append(el('h3', null, `已创建场景（${sc.data.length}）`));
  sc2.append(el('div', 'hint', '平台的场景接口只有「创建」没有「查询」，所以这一屏列的是本会话建过的场景，来自本地审计流水。'));
  if (!sc.data.length) {
    sc2.append(el('div', 'hint', '还没有场景。在对话里说一句「每天晚上 10 点自动给主卫浴缸放水」试试。'));
  }
  for (const s of sc.data) {
    const row = el('div', 'kv');
    row.append(el('span', 'k', s.trigger === 'schedule' ? '定时' : '手动'));
    const fmt = (list) => (list || []).map((c) => `${c.cmd}${c.value !== undefined ? '=' + c.value : ''}${c.time ? '@' + c.time : ''}`).join(',') || '—';
    row.append(el('span', 'v mono', `${s.sceneId} · 条件 ${fmt(s.conditionList)} → 执行 ${fmt(s.actionList)}`));
    sc2.append(row);
  }
  p.append(sc2);
}

/* ================= 安全审计 ================= */

async function loadAudit() {
  const box = $('#auditPane');
  box.innerHTML = '';
  const p = el('div', 'pane-inner');
  box.append(p);

  let data = [];
  try { ({ data = [] } = await (await fetch('/api/audit?limit=200')).json()); } catch {}

  const c = el('div', 'card');
  c.append(el('h3', null, '操作留痕'));
  c.append(el('div', 'hint', '需求 3.4：所有设备控制与场景操作记录操作人、时间、设备与动作。这里是编排层落盘的审计流水，网关请求头里的 bearer token 已抹除。'));

  if (!data.length) {
    c.append(el('div', 'hint', '还没有记录。去对话里控一台设备。'));
    p.append(c);
    return;
  }

  const tb = el('table', 'grid');
  tb.innerHTML = '<thead><tr><th>时间</th><th>动作</th><th>等级</th><th>决策</th><th>目标</th><th>结果</th><th>会话</th></tr></thead>';
  const tbody = el('tbody');
  for (const r of data) {
    const tr = el('tr');
    const td = (txt, cls) => { const n = el('td', cls || null); n.textContent = txt; return n; };
    tr.append(td(fmtWhen(r.at), 'mono'));
    tr.append(td(KIND_NAME[r.kind] || r.kind || '—'));
    const lv = el('td');
    if (r.level) lv.append(el('span', 'lvl ' + r.level, r.level));
    tr.append(lv);
    tr.append(td({ EXECUTED: '已下发', DENIED: '闸门拦截', REJECTED: '用户取消' }[r.decision] || r.decision || '—'));
    tr.append(td((r.targets || []).map((t) => t.deviceTagName || t.deviceName).join('、') || '—'));
    tr.append(td({ SUCCEEDED: '成功', FAILED: '失败', BLOCKED: '未下发', CANCELLED: '已取消' }[r.result] || r.result || '—'));
    tr.append(td((r.sessionId || '').slice(-8), 'mono'));
    tbody.append(tr);
  }
  tb.append(tbody);
  c.append(tb);
  p.append(c);
}

async function loadAuditCount() {
  try {
    const { data = [] } = await (await fetch('/api/audit?limit=200')).json();
    $('#auditCount').textContent = data.length || '';
  } catch {}
}

/* ================= 技能管理 ================= */

// 技能库是整个租户共享的（含 99 个内置技能），这里的增删改动的是真实平台资源。
// Agent 挂载的是 { skillID, releaseID } 两个 ID，界面上要看得懂，名字回技能库补一次。
const SK = { list: [], total: 0, keyword: '', page: 1, pageSize: 20, agent: null, mounted: new Set() };

async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
  return d;
}

// 加挂 / 摘除。走 POST /agents/{id}，带 version 乐观锁，服务端会把新版本写回 state.json
const agentSkill = (skillID, releaseID, name, action) => postJson('/api/agent/skills', { skillID, releaseID, name, action });

function skillMountBtn(id, releaseID, name, mounted) {
  const b = el('button', 'mini', mounted ? '摘除' : '挂载');
  b.type = 'button';
  b.title = mounted ? '从本场景 Agent 上摘掉（不动技能库）' : '挂到本场景 Agent 上';
  b.onclick = async () => {
    b.disabled = true;
    b.textContent = '…';
    try {
      await agentSkill(id, releaseID, name, mounted ? 'remove' : 'add');
      await paintSkills();
    } catch (e) {
      b.disabled = false;
      b.textContent = '失败';
      b.title = String(e.message || e);
    }
  };
  return b;
}

// 删技能是真实平台资源，挂载它的 Agent 也会受影响，所以按两下才算确认。
// 技能增删不动设备，不进安全审计那条流水（audit.jsonl 只记设备与场景操作）。
function skillDeleteBtn(s) {
  const b = el('button', 'mini', '删除');
  b.type = 'button';
  let armed = 0;
  b.onclick = async () => {
    if (!armed) {
      armed = setTimeout(() => { armed = 0; b.textContent = '删除'; }, 4000);
      b.textContent = '确认删除';
      return;
    }
    clearTimeout(armed);
    b.disabled = true;
    b.textContent = '删除中…';
    try {
      const r = await fetch('/api/skills/' + encodeURIComponent(s.id), { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
      await paintSkills();
    } catch (e) {
      b.disabled = false;
      b.textContent = '失败';
      b.title = String(e.message || e);
    }
  };
  return b;
}

// 更新技能：换源（URL）或传包（ZIP）。默认收起来，展开就多一行，不然每行四个按钮太吵
function skillUpdateRow(s) {
  const tr = el('tr', 'sub');
  tr.style.display = 'none';
  const cell = el('td');
  cell.colSpan = 5;

  const msg = el('div', 'hint', '换源与传包都只改技能内容，已挂载的 Agent 下次对话即用新版。');
  const note = (t, bad) => { msg.textContent = t; msg.className = 'hint' + (bad ? ' err' : ''); };
  const submit = async (btn, label, fn) => {
    btn.disabled = true;
    btn.textContent = '提交中…';
    try {
      await fn();
      note('更新成功。');
      setTimeout(() => { btn.disabled = false; btn.textContent = label; }, 600);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = label;
      note(String(e.message || e), true);
    }
  };

  const r1 = el('div', 'rowline');
  const url = el('input', 'find');
  url.type = 'url';
  url.placeholder = '换源：填新的 GitHub / ClawHub / BOS 地址';
  const go = el('button', 'mini', '换源');
  go.type = 'button';
  go.onclick = () => {
    const u = url.value.trim();
    if (!u) return note('先填地址', true);
    submit(go, '换源', () => postJson('/api/skills/' + encodeURIComponent(s.id), { url: u }));
  };
  r1.append(url, go);

  // 新建只收 URL，ZIP 这条路只在更新时存在，所以它挂在这一行下面而不是上面的新建表单里
  const r2 = el('div', 'rowline');
  const file = el('input', 'filein');
  file.type = 'file';
  file.accept = '.zip,application/zip';
  const up = el('button', 'mini', '传包更新');
  up.type = 'button';
  up.onclick = () => {
    const f = file.files?.[0];
    if (!f) return note('先选一个 .zip', true);
    const fd = new FormData();
    fd.append('file', f);
    submit(up, '传包更新', async () => {
      const r = await fetch('/api/skills/' + encodeURIComponent(s.id) + '/zip', { method: 'POST', body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
      return d;
    });
  };
  r2.append(file, up);

  cell.append(r1, r2, msg);
  tr.append(cell);
  return { tr, toggle: () => { tr.style.display = tr.style.display === 'none' ? '' : 'none'; } };
}

async function loadSkills() {
  const box = $('#skillPane');
  box.innerHTML = '';
  const p = el('div', 'pane-inner');
  p.append(el('div', 'hint', '读取技能库…'));
  box.append(p);
  await paintSkills();
}

async function paintSkills() {
  const box = $('#skillPane');
  const q = new URLSearchParams({ page: String(SK.page), pageSize: String(SK.pageSize) });
  if (SK.keyword) q.set('keyword', SK.keyword);

  let lib = { data: [], total: 0 }, agent = null;
  try { lib = await (await fetch('/api/skills?' + q)).json(); } catch {}
  try { agent = await (await fetch('/api/agent')).json(); } catch {}

  SK.list = lib.data || [];
  SK.total = lib.total ?? SK.list.length;
  SK.agent = agent;
  SK.mounted = new Set((agent?.skills || []).map((s) => s.skillID));
  $('#skillCount').textContent = SK.total || '';
  if (agent?.agentId) $('#agentTag').textContent = `${agent.agentId} v${agent.version}`;

  box.innerHTML = '';
  const p = el('div', 'pane-inner');
  box.append(p);
  const td = (txt, cls) => { const n = el('td', cls || null); n.textContent = txt; return n; };

  /* ---------- 本场景 Agent 的挂载 ---------- */
  const ag = el('div', 'card');
  ag.append(el('h3', null, '本场景 Agent 的挂载'));
  if (!agent?.agentId) {
    ag.append(el('div', 'hint', '读不到 Agent。先确认服务端 bootstrap 过。'));
  } else {
    const kv = (k, v, mono) => {
      const row = el('div', 'kv');
      row.append(el('span', 'k', k), el('span', 'v' + (mono ? ' mono' : ''), v));
      ag.append(row);
    };
    kv('Agent', agent.agentId, true);
    kv('版本', `v${agent.version}`);
    kv('资料', (agent.files || []).map((f) => f.name).join('、') || '（无）');
    kv('提示词', `${agent.systemChars} / ${CFG.agent?.systemLimit ?? 1000} 字`);

    if (!(agent.skills || []).length) {
      ag.append(el('div', 'hint', '一个技能都没挂。技能是产物的上游：挂上 xlsx，再让它整理一份表格，产物中心就会有真文件。'));
    }
    for (const s of agent.skills || []) {
      const row = el('div', 'kv');
      row.append(el('span', 'k', '已挂'));
      const v = el('span', 'v');
      v.append(el('b', 'sn', s.name || s.skillID));
      // 名字给业务看，ID 给客户工程师对账，两个都要
      v.append(el('div', 'sid', s.releaseID ? `${s.skillID} · release ${s.releaseID}` : s.skillID));
      row.append(v);
      const act = el('div', 'rowacts');
      act.append(skillMountBtn(s.skillID, s.releaseID, s.name, true));
      row.append(act);
      ag.append(row);
    }
    ag.append(el('div', 'hint', '挂载改动会调 POST /agents/{id}（带 version 乐观锁）并写回 state.json。重启服务后以 config/scenario.json 点名的技能为准。'));
  }
  p.append(ag);

  /* ---------- 技能库 ---------- */
  const c = el('div', 'card');
  c.append(el('h3', null, `技能库（${SK.total}）`));
  c.append(el('div', 'hint', `搜索参数是 keyword，page / pageSize 都是必填。这里是整个租户的技能库，不只是挂给本场景的那些。`));

  const findRow = el('div', 'rowline');
  const inp = el('input', 'find');
  inp.type = 'search';
  inp.placeholder = '搜索技能名，例如 xlsx';
  inp.value = SK.keyword;
  const goSearch = () => { SK.keyword = inp.value.trim(); SK.page = 1; paintSkills(); };
  const go = el('button', 'mini', '搜索');
  go.type = 'button';
  go.onclick = goSearch;
  inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); goSearch(); } };
  findRow.append(inp, go);
  if (SK.keyword) {
    const clr = el('button', 'mini', '清空');
    clr.type = 'button';
    clr.onclick = () => { SK.keyword = ''; SK.page = 1; paintSkills(); };
    findRow.append(clr);
  }
  c.append(findRow);

  const newRow = el('div', 'rowline');
  const newUrl = el('input', 'find');
  newUrl.type = 'url';
  newUrl.placeholder = '新建技能：GitHub / ClawHub / BOS 地址';
  const mk = el('button', 'mini primary', '新建');
  mk.type = 'button';
  const mkMsg = el('div', 'hint', '新建只能从地址安装（平台接口只收 JSON {url}）；ZIP 上传只在「更新」里可用，见每一行的「更新」。');
  mk.onclick = async () => {
    const u = newUrl.value.trim();
    if (!u) { mkMsg.textContent = '先填地址'; mkMsg.className = 'hint err'; return; }
    mk.disabled = true;
    mk.textContent = '提交中…';
    try {
      const d = await postJson('/api/skills', { url: u });
      mk.disabled = false;
      mk.textContent = '新建';
      newUrl.value = '';
      mkMsg.className = 'hint';
      mkMsg.textContent = `已提交${d?.id ? '：' + d.id : ''}，刷新生效。`;
      SK.keyword = '';
      await paintSkills();
    } catch (e) {
      mk.disabled = false;
      mk.textContent = '新建';
      mkMsg.className = 'hint err';
      mkMsg.textContent = '新建失败：' + String(e.message || e);
    }
  };
  newRow.append(newUrl, mk);
  c.append(newRow, mkMsg);

  if (!SK.list.length) {
    c.append(el('div', 'hint', SK.keyword ? `没有名字里带「${SK.keyword}」的技能。` : '技能库没返回数据。'));
  } else {
    const tb = el('table', 'grid');
    tb.innerHTML = '<thead><tr><th>技能</th><th>说明</th><th>版本</th><th>来源</th><th></th></tr></thead>';
    const tbody = el('tbody');
    for (const s of SK.list) {
      const tr = el('tr');
      const nm = el('td');
      nm.append(el('b', 'sn', s.name));
      nm.append(el('div', 'sid', s.id));
      tr.append(nm);
      tr.append(td(clip(flat(s.description || '—'), 76)));
      tr.append(td(s.version || '—', 'mono'));
      const src = el('td');
      // 列表接口不返回 builtin（只有详情才有）。内置技能是平台同步进来的，
      // createBy 形如 system:personal-sync，拿这个当判据；其余是租户自建的。
      const sys = String(s.createBy || '').startsWith('system:');
      src.append(el('span', 'pill' + (sys ? '' : ' on'), sys ? '内置' : (s.createBy || '自建')));
      tr.append(src);
      const act = el('td', 'acts-cell');
      const acts = el('div', 'rowacts');
      const mounted = SK.mounted.has(s.id);
      acts.append(skillMountBtn(s.id, s.releaseId || '', s.name, mounted));
      const upd = skillUpdateRow(s);
      const ub = el('button', 'mini', '更新');
      ub.type = 'button';
      ub.onclick = () => upd.toggle();
      acts.append(ub, skillDeleteBtn(s));
      act.append(acts);
      tr.append(act);
      tbody.append(tr, upd.tr);
    }
    tb.append(tbody);
    c.append(tb);
  }
  p.append(c);
}

/* ================= 产物中心 ================= */

// 平台没有「列产物」接口，这一页比别的慢：要先列会话，再逐个会话问 path-map。
// 下载地址是平台签发的临时地址，清单里不缓存，点的时候现取。
const extOf = (n) => { const m = String(n || '').match(/\.([A-Za-z0-9]{1,5})$/); return m ? m[1].toLowerCase() : ''; };
const fmtSize = (n) => (typeof n === 'number' && n > 0 ? (n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB') : '');

async function loadArtifacts() {
  const box = $('#artPane');
  box.innerHTML = '';
  const p = el('div', 'pane-inner');
  p.append(el('div', 'hint', '扫描最近的会话，逐个问 path-map…'));
  box.append(p);

  let d = { data: [], scanned: 0 };
  try { d = await (await fetch('/api/artifacts?limit=100')).json(); } catch {}
  const rows = d.data || [];
  $('#artCount').textContent = rows.length || '';

  box.innerHTML = '';
  const p2 = el('div', 'pane-inner');
  box.append(p2);
  const td = (txt, cls) => { const n = el('td', cls || null); n.textContent = txt; return n; };

  const c = el('div', 'card');
  c.append(el('h3', null, `生成物（${rows.length}）`));
  c.append(el('div', 'hint', `平台没有「列产物」的接口，这一页是逐个会话调 path-map（不传 path 就返回该会话的全部产物）拼出来的，扫了最近 ${d.scanned ?? 0} 个会话。`));
  if (!rows.length) {
    c.append(el('div', 'hint', '还没有产物。去对话里说「把主卫所有设备的状态整理成一份表格」——前提是本场景 Agent 挂了 xlsx 这类技能。'));
    p2.append(c);
    return;
  }

  const tb = el('table', 'grid');
  tb.innerHTML = '<thead><tr><th>文件</th><th>类型</th><th>来源会话</th><th>会话时间</th><th></th></tr></thead>';
  const tbody = el('tbody');
  for (const a of rows) {
    const tr = el('tr');
    const f = el('td');
    f.append(el('b', 'sn', a.filename || baseName(a.path)));
    // 清单里的相对路径常常就是文件名本身，重复一遍只是噪声
    const rel = relPath(a.path);
    if (rel && rel !== (a.filename || '')) f.append(el('div', 'sid', rel));
    tr.append(f);
    // 平台给的 mimeType 一长串，表格里换扩展名 + 体积更好认
    tr.append(td([extOf(a.filename), fmtSize(a.size)].filter(Boolean).join(' · ') || a.fileType || '—', 'mono'));
    const s = el('td');
    s.append(el('div', null, clip(a.title || '(未命名)', 30)));
    s.append(el('div', 'sid', String(a.sessionId || '').slice(-8)));
    tr.append(s);
    // path-map 不带产物自己的时间，这里只能显示会话的更新时间
    tr.append(td(fmtWhen(a.at) || '—', 'mono'));
    const act = el('td');
    act.append(urlSlot(a.sessionId, a.path).box);
    tr.append(act);
    tbody.append(tr);
  }
  tb.append(tbody);
  c.append(tb);
  p2.append(c);
}

/* ================= 视图切换 ================= */

function switchView(name) {
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('on', v.id === 'view-' + name);
  for (const b of document.querySelectorAll('.nav button')) b.classList.toggle('on', b.dataset.view === name);
  $('#secSessions').style.display = name === 'chat' ? '' : 'none';
  if (name === 'devices') loadDevices();
  if (name === 'audit') loadAudit();
  if (name === 'skills') loadSkills();
  if (name === 'artifacts') loadArtifacts();
}

/* ================= 输入 ================= */

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
});
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#form').requestSubmit(); }
});
$('#form').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = inputEl.value.trim();
  if (!t || T.busy) return;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  ask(t);
});
$('#btnNew').onclick = () => { resetChat(); loadSessions(); };
$('#btnReloadDev').onclick = () => loadDevices();
$('#btnReloadAudit').onclick = loadAudit;
$('#btnReloadSkills').onclick = loadSkills;
$('#btnReloadArt').onclick = loadArtifacts;
$('#sessFind').oninput = paintSessions;

for (const b of document.querySelectorAll('.nav button')) b.onclick = () => switchView(b.dataset.view);

/* ================= 语音输入（按住说话） ================= */

// 百度短语音识别要 16k 单声道 16-bit 小端 PCM，所以这里不用 MediaRecorder：
// 它出的是 webm/opus，百度不认，还得在服务端装 ffmpeg 转。改成把 AudioContext 定在
// 16000 Hz，用 AudioWorklet 抓原始浮点采样，自己量化成 Int16 裸发，服务端零依赖。
const MIC = { on: false, want: false, busy: false, chunks: [], ctx: null, stream: null, rate: 16000, t0: 0, timer: 0, raf: 0, peak: 0, shown: 0, flash: 0 };
const MIC_MAX_SEC = 55; // 百度上限 60 秒，留点余量，到点自动收

const TAP_WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(new Float32Array(ch));
    return true;
  }
}
registerProcessor('tap', Tap);
`;

/* ---------- 输入栏里的录音反馈 ---------- */
// 长按时视线在输入框上，所以「正在录」这件事做进输入栏：边框转红 + 一条电平条。
// 电平条取的是真实采样，不是装饰动画——它同时回答「麦克风到底有没有收到我的声音」，
// 这是纯计时器给不了的。

const BAR_N = 30;               // 30 根柱子，按帧推进，约 1 秒的可视历史
const barEls = [];
for (let i = 0; i < BAR_N; i++) {
  const b = document.createElement('i');
  b.style.setProperty('--i', i); // 转写态的扫描延迟靠它，省 30 条 nth-child
  barsEl.appendChild(b);
  barEls.push(b);
}
const levels = new Array(BAR_N).fill(0);

// worklet 每 8ms 推一块 128 采样进来，逐块画太密（125 次/秒），
// 这里只累积峰值，交给 rAF 按帧取走。
function meterSample(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  const rms = Math.sqrt(s / buf.length);
  if (rms > MIC.peak) MIC.peak = rms;
}

function meterStop() {
  if (MIC.raf) { cancelAnimationFrame(MIC.raf); MIC.raf = 0; }
  MIC.peak = 0;
  MIC.shown = 0;
  levels.fill(0);
  for (const b of barEls) b.style.transform = 'scaleY(.06)';
}

function meterStart() {
  let last = 0;
  const tick = (now) => {
    MIC.raf = requestAnimationFrame(tick);
    if (now - last < 33) return; // 30fps 够了，省一半写入
    last = now;

    // RMS 按 dB 映射更贴合听感。窗口取 -52dB（安静房间）到 -10dB（凑近大声说）：
    // 正常说话的 RMS 大致落在 0.01~0.1，也就是 -40~-20dB，正好在这段的中部，
    // 起伏才看得出来。窗口开成 -60~0 的话全挤在顶部，电平条看着像一块实心色块。
    const db = 20 * Math.log10(Math.max(MIC.peak, 1e-6));
    const lv = Math.min(1, Math.max(0, (db + 52) / 42));
    MIC.peak = 0;
    // 起音跟手、回落放慢，柱子不会一闪一闪
    MIC.shown = lv > MIC.shown ? lv : MIC.shown * 0.72 + lv * 0.28;

    levels.shift();
    levels.push(MIC.shown);
    for (let i = 0; i < BAR_N; i++) {
      barEls[i].style.transform = `scaleY(${Math.max(0.06, levels[i]).toFixed(3)})`;
    }
  };
  MIC.raf = requestAnimationFrame(tick);
}

// 松手后视线仍在输入栏上，失败原因得在这里闪一下；右上角那行同样太远。
// 两处都写：这里是即时的，右上角是不随时间消失的持久状态。
function micFlash(msg, ms = 2000) {
  clearTimeout(MIC.flash);
  micPaint('');
  cwrapEl.classList.add('err');
  lmsgEl.textContent = msg;
  setStatus('err', msg);
  MIC.flash = setTimeout(() => {
    cwrapEl.classList.remove('err');
    lmsgEl.textContent = '';
  }, ms);
}

function micPaint(state) {
  // 上一次的错误提示可能还没到点，开始录音就先撤掉它，
  // 否则 .err 的样式会把电平条一起藏了
  if (state === 'rec') { clearTimeout(MIC.flash); cwrapEl.classList.remove('err'); }
  micBtn.classList.toggle('rec', state === 'rec');
  micBtn.classList.toggle('wait', state === 'wait');
  cwrapEl.classList.toggle('rec', state === 'rec');
  cwrapEl.classList.toggle('wait', state === 'wait');
  if (state === 'rec') meterStart();
  else meterStop();
  // rec 态下的秒数由 startRec 的计时器写，这里别覆盖
  if (state === 'wait') lmsgEl.textContent = '转写中…';
  else if (state !== 'rec') lmsgEl.textContent = '';
}

const stopTracks = (s) => { try { s?.getTracks().forEach((t) => t.stop()); } catch {} };

// 浮点采样量化成 16-bit 小端。AudioContext 一般会照 16000 建；万一浏览器没照办，
// 就按比例抽点降采样。演示够用，不做抗混叠滤波。
function toPcm16(chunks, srcRate) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const flat = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { flat.set(c, o); o += c.length; }

  const ratio = srcRate === 16000 ? 1 : 16000 / srcRate;
  const n = Math.floor(total * ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const x = flat[ratio === 1 ? i : Math.min(total - 1, Math.round(i / ratio))];
    const v = x < -1 ? -1 : x > 1 ? 1 : x;
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

async function startRec() {
  if (MIC.on || MIC.busy || T.busy || micBtn.disabled) return;
  MIC.want = true;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) {
    MIC.want = false;
    setStatus('err', '麦克风不可用，检查浏览器权限');
    console.warn('[mic]', e);
    return;
  }
  // 首次授权弹窗还没点完人就松手了，直接收摊
  if (!MIC.want) { stopTracks(stream); return; }

  let ctx;
  try {
    ctx = new AudioContext({ sampleRate: 16000 });
    const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: 'text/javascript' }));
    try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }

    const node = new AudioWorkletNode(ctx, 'tap');
    node.port.onmessage = (e) => {
      if (!MIC.on) return;
      MIC.chunks.push(e.data);
      meterSample(e.data);
    };
    ctx.createMediaStreamSource(stream).connect(node);
    // worklet 不接到 destination 就不会被拉取；接一个零增益节点，顺便避免麦克风回放
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute).connect(ctx.destination);
  } catch (e) {
    stopTracks(stream);
    try { await ctx?.close(); } catch {}
    MIC.want = false;
    setStatus('err', '录音初始化失败：' + String(e.message || e));
    return;
  }

  MIC.stream = stream;
  MIC.ctx = ctx;
  MIC.chunks = [];
  MIC.rate = ctx.sampleRate;
  MIC.on = true;
  MIC.t0 = Date.now();
  micPaint('rec');

  // 秒数写在输入栏的电平条旁边，不再写右上角——那里离视线太远，长按的人看不见。
  // 右上角只留一个静态的「录音中」，免得状态区谎报「空闲」。
  clearInterval(MIC.timer);
  MIC.timer = setInterval(() => {
    const s = (Date.now() - MIC.t0) / 1000;
    if (s >= MIC_MAX_SEC) { stopRec(); return; }
    lmsgEl.textContent = s.toFixed(1) + 's';
  }, 100);
  lmsgEl.textContent = '0.0s';
  setStatus('on', '录音中');
}

async function stopRec() {
  if (!MIC.on) { MIC.want = false; return; }
  MIC.on = false;
  MIC.want = false;
  clearInterval(MIC.timer);

  const { rate, chunks } = MIC;
  stopTracks(MIC.stream);
  try { await MIC.ctx?.close(); } catch {}
  MIC.stream = null; MIC.ctx = null; MIC.chunks = [];
  micPaint('');

  const pcm = toPcm16(chunks, rate);
  if (pcm.length < 16000 * 2 * 0.3) { micFlash('说得太短，按住多说一会儿'); return; }

  MIC.busy = true;
  micPaint('wait');
  // micFlash 已经负责收尾，失败路径别再调 micPaint('')——那会把刚写上的错误文字擦掉
  let failed = false;
  try {
    const res = await fetch('/api/asr', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/pcm;rate=16000' },
      body: pcm,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    const text = String(j.text || '').trim();
    if (!text) { failed = true; micFlash('没听清，再说一次'); return; }
    // 只回填不自动发送：转写可能差一两个字，演示时让人先看一眼再发
    inputEl.value = inputEl.value ? inputEl.value + text : text;
    inputEl.dispatchEvent(new Event('input'));
    inputEl.focus();
    setStatus('', '已转写，确认后发送');
  } catch (e) {
    failed = true;
    micFlash(String(e.message || e));
  } finally {
    MIC.busy = false;
    if (!failed) micPaint('');
  }
}

micBtn.addEventListener('pointerdown', (e) => {
  if (micBtn.disabled) return;
  e.preventDefault();
  micBtn.setPointerCapture?.(e.pointerId);
  startRec();
});
for (const ev of ['pointerup', 'pointercancel']) {
  micBtn.addEventListener(ev, () => { if (MIC.on || MIC.want) stopRec(); });
}
// 切走标签页时别把录音漏在那儿。只在真的录起来之后才响应，
// 否则首次的授权弹窗会让窗口失焦，把录音当场掐掉。
window.addEventListener('blur', () => { if (MIC.on) stopRec(); });

/* ================= 访问口令 ================= */

// 部署到公网后这个地址就是一个 IoT 控制入口，所以线上带口令。
// 口令没过时所有 /api 都回 401 + needAuth，这里把界面换成口令输入。
function showAuthGate() {
  const box = el('div', 'authgate');
  const card = el('div', 'authcard');
  card.append(el('h2', null, '需要访问口令'));
  card.append(el('div', 'hint', '这个演示可以下发真实的设备控制指令，只对受邀的人开放。'));

  const input = document.createElement('input');
  input.type = 'password';
  input.placeholder = '访问口令';
  input.autocomplete = 'current-password';

  const btn = el('button', 'mini on', '进入');
  const msg = el('div', 'hint err');

  const submit = async () => {
    btn.disabled = true;
    msg.textContent = '';
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: input.value }),
      });
      if (r.ok) { location.reload(); return; }
      const j = await r.json().catch(() => ({}));
      msg.textContent = j.error || `HTTP ${r.status}`;
    } catch (e) {
      msg.textContent = String(e.message || e);
    }
    btn.disabled = false;
    input.select();
  };

  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  card.append(input, btn, msg);
  box.append(card);
  document.body.innerHTML = '';
  document.body.append(box);
  input.focus();
}

/* ================= 启动 ================= */

(async () => {
  try {
    const res = await fetch('/api/config');
    if (res.status === 401) return showAuthGate();
    CFG = await res.json();
    document.title = `${CFG.brand.product} · ${CFG.brand.vendor}`;
    $('#brandProduct').textContent = CFG.brand.product;
    $('#brandVendor').textContent = CFG.brand.vendor;
    $('#srcFile').textContent = CFG.source.file;
    $('#srcSummary').textContent = CFG.source.summary;
    // 侧栏不再显示网关模式与清单来源：那是给联调看的，客户面前不需要。
    // 要查当前跑的是哪套，看 GET /api/config 的 iot.mode 与 iot.fixture
    // 没配 ASR Key 就把麦克风置灰，不要让人按下去才看到报错
    if (!CFG.voice?.enabled) {
      micBtn.disabled = true;
      micBtn.title = '未配置 ASR Key（.env 里的 ASR_API_KEY）';
    }
  } catch {}
  showEmpty();
  loadSessions();
  loadAuditCount();
  try {
    const st = await (await fetch('/api/bootstrap')).json();
    $('#agentTag').textContent = st.agentId ? `${st.agentId} v${st.version}` : '未就绪';
  } catch {
    $('#agentTag').textContent = '初始化失败';
    setStatus('err', 'Agent 初始化失败');
  }
})();
