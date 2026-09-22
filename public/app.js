// 箭牌智家 AI 助手 · 前端
// 三个视图：对话 / 家庭设备 / 安全审计。
// 对话一屏里能看到三层：执行过程（Agent 干了什么）、安全闸门（能不能下发）、正文（结论）。

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

const T = { sid: null, turn: null, ctl: null, busy: false, follow: null };
let CFG = {};

/* ================= 小工具 ================= */

// 沙箱绝对路径在界面上没有信息量，先摘掉前缀；工作目录下还套了一层会话 id，也一并摘掉
const SANDBOX_RE = /\/home\/work\/dumate\/[A-Za-z0-9_]+(?:\/workspace)?\//g;
const relPath = (s) => String(s ?? '')
  .replace(SANDBOX_RE, '')
  .replace(/^ses_[A-Za-z0-9]+\//, '')
  .replace(/\/{2,}/g, '/');
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
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
};

// 纯内部记账的片段，展示出来只是噪音
const HIDDEN = new Set([
  'todowrite', 'requirementwrite', 'requirementread', 'file_export',
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
    if (t.userMsgs.has(r.messageID) || flat(partText(r)) === t.userText) return null;
    const txt = plain(partText(r));
    if (!txt) return null;
    s = { k: 'say', label: clip(txt, 56), raw: partText(r) };
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
    live, running: live, startedAt: Date.now(), endedAt: 0,
    open: false, manual: false, openRows: new Set(), override: null, pendings: new Map(),
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
    const n = partText(r).trim().length;
    if (n > len) { len = n; best = id; }
  }
  return best;
}

function answerText(t) {
  if (t.override != null) return t.override;
  const id = answerId(t);
  return id ? partText(t.parts.get(id)) : '';
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

function addGateCard(t, g) {
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
    const pend = el('div', 'gate-act');
    const yes = el('button', null, '确认执行');
    const no = el('button', 'ghost', '取消');
    yes.type = 'button'; no.type = 'button';
    pend.append(yes, no);
    yes.onclick = () => decide(t, g.pendingId, 'approve', card, pend);
    no.onclick = () => decide(t, g.pendingId, 'reject', card, pend);
    b.append(pend);
    b.append(el('div', 'pend', `待确认编号 ${g.pendingId} · 5 分钟内有效`));
  } else if (g.decision === 'deny') {
    b.append(el('div', 'pend', '本次不上发任何指令到 IoT 网关，事件已记入安全审计'));
  } else {
    b.append(el('div', 'pend', '闸门放行，已下发到 IoT 网关'));
  }
  card.append(b);
  t.cardsEl.append(card);
  scrollBottom();
  return card;
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
    card.querySelector('.dec').textContent = decision === 'approve' ? '已确认' : '已取消';
    actBox.remove();
    const old = card.querySelector('.pend');
    if (old) old.textContent = decision === 'approve'
      ? `已确认执行（编号 ${pendingId}）`
      : `用户取消，未下发任何指令（编号 ${pendingId}）`;
    if (decision === 'approve') addExecCard(t, out);
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
    io2.append(el('div', 'lbl', '← 网关返回'));
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

function addRepairCard(t, d) {
  const card = el('div', 'repair');
  card.append(el('b', null, d.kind === 'progress' ? '打开报修进度' : '打开报修入口'));
  card.append(el('p', null, d.note || ''));
  const a = el('a', null, `唤起箭牌智家 APP（${d.deeplink}）`);
  a.href = d.deeplink;
  card.append(a);
  t.cardsEl.append(card);
  scrollBottom();
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

// 五条推荐问各自打一个场景标签，客户一眼看出覆盖了四个核心场景
const STARTER_TAG = ['设备控制', '高危指令 · 二次确认', '场景创建', '产品百科', '报修引导'];

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
      if (delta) upsert(t, { ...(d?.part || {}), id: d?.partID || d?.partId || d?.part?.id, type: d?.part?.type || 'text' }, true, delta);
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
    case 'demo.done':
      endTurn(t, !!d?.incomplete, null, d?.pendingId);
      break;
    case 'demo.error':
      endTurn(t, true, d?.message || String(d));
      break;
  }
}

async function ask(text) {
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
  chatTitle.textContent = clip(title || '对话', 40);
  setStatus('', '已载入');

  const busy = await renderHistory(sid);
  if (!busy) { loadSessions(); return; }

  setStatus('on', '运行中');
  T.follow = setInterval(async () => {
    if (T.busy || T.sid !== sid) return;
    if (await renderHistory(sid)) return;
    stopFollow();
    setStatus('done', '已完成');
    loadSessions();
  }, 8000);
}

function stopFollow() {
  if (T.follow) { clearInterval(T.follow); T.follow = null; }
}

// 历史里读不回「闸门 → 执行」那一段：那是本编排层的事件，不在平台消息里。
// 审计视图承担了这部分，所以回放只还原对话本身。
async function renderHistory(sid) {
  streamEl.innerHTML = '';
  wrap = null;
  ensureWrap();

  let items = [];
  try {
    const r = await fetch('/api/sessions/' + encodeURIComponent(sid) + '/events');
    ({ data: items = [] } = await r.json());
  } catch { setStatus('err', '读取失败'); }

  // 一个回合在历史里是连着的好几条 assistant 消息，必须并成一个气泡
  const turns = [];
  let turn = null;
  for (const it of items) {
    const role = it?.info?.role;
    const parts = it?.parts || [];
    if (role === 'user') {
      const txt = parts.filter((p) => p.type === 'text').map((p) => p.text).filter(Boolean).join('\n');
      if (txt) addUser(txt);
      turn = null;
      continue;
    }
    if (role !== 'assistant') continue;
    const keep = parts.filter((p) => p.type !== 'sandbox-status');
    if (!keep.length && !turn) continue;
    const tm = it?.info?.time || {};
    if (!turn) {
      turn = newTurn(false);
      addTurn(turn);
      turns.push(turn);
      turn.startedAt = tm.created || Date.now();
    } else if (tm.created) turn.startedAt = Math.min(turn.startedAt, tm.created);
    if (tm.completed) turn.endedAt = Math.max(turn.endedAt, tm.completed);
    if (!keep.length) continue;
    for (const p of keep) upsert(turn, p, false);
  }
  for (const t of turns) paint(t);
  scrollBottom();
  const last = items[items.length - 1];
  return !!last && last?.info?.role === 'assistant' && !last?.info?.time?.completed;
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
  const data = q ? allSessions.filter((s) => String(s.title || '').toLowerCase().includes(q)) : allSessions;
  sessionsEl.innerHTML = '';
  if (!allSessions.length) { sessionsEl.append(el('div', 'hint', '还没有对话')); return; }
  if (!data.length) { sessionsEl.append(el('div', 'hint', '没有匹配的会话')); return; }
  for (const s of data) {
    const b = el('button', 'sitem' + (s.id === T.sid ? ' on' : ''));
    b.type = 'button';
    b.append(el('div', 't', s.title), el('div', 'd', fmtWhen(s.updatedAt || s.createdAt)));
    b.onclick = () => { switchView('chat'); openSession(s.id, s.title); };
    sessionsEl.append(b);
  }
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
  try { dev = await (await fetch('/api/iot/devices')).json(); } catch {}
  try { sc = await (await fetch('/api/iot/scenes')).json(); } catch {}

  box.innerHTML = '';
  const p = el('div', 'pane-inner');
  box.append(p);

  const online = dev.data.filter((d) => d.onlineStatus).length;
  $('#devCount').textContent = dev.data.length || '';

  if (dev.error) {
    const c = el('div', 'card');
    c.append(el('h3', null, '网关调用失败'));
    c.append(el('div', 'kv', `GET /ext/v3/ai/device-list → ${dev.error}`));
    p.append(c);
    return;
  }

  const head = el('div', 'card');
  head.append(el('h3', null, `家庭设备 · homeId ${CFG.iot?.homeId ?? ''}`));
  const kv = (k, v, mono) => {
    const row = el('div', 'kv');
    row.append(el('span', 'k', k), el('span', 'v' + (mono ? ' mono' : ''), v));
    head.append(row);
  };
  kv('在线', `${online} / ${dev.data.length} 台`);
  kv('接口', `GET /ext/v3/ai/device-list（${dev.ms ?? 0} ms）`, true);
  kv('网关', CFG.iot?.baseUrl || '');
  p.append(head);

  const c = el('div', 'card');
  const tb = el('table', 'grid');
  tb.innerHTML = '<thead><tr><th>房间</th><th>设备名</th><th>deviceName</th><th>品类</th><th>状态</th><th>演示态</th></tr></thead>';
  const tbody = el('tbody');
  const catName = (code) => ({ '01': '坐便器', '02': '浴霸', '04': '浴缸', '06': '镜柜' }[code] || code);
  for (const d of dev.data) {
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
    const pw = el('td', 'mono');
    pw.textContent = d.power ? `switch=${d.power}` : (d.status ? Object.entries(d.status).map(([k, v]) => `${k}=${v}`).join(' ') : '—');
    tr.append(pw);
    tbody.append(tr);
  }
  tb.append(tbody);
  c.append(tb);
  p.append(c);

  const sc2 = el('div', 'card');
  sc2.append(el('h3', null, `已创建场景（${sc.data.length}）`));
  if (!sc.data.length) {
    sc2.append(el('div', 'hint', '还没有场景。在对话里说一句「每天晚上 10 点自动给主卫浴缸放水」试试。'));
  }
  for (const s of sc.data) {
    const row = el('div', 'kv');
    row.append(el('span', 'k', s.trigger === 'schedule' ? '定时' : '手动'));
    row.append(el('span', 'v mono',
      `${s.sceneId} · 条件 ${s.conditionList.map((c) => `${c.cmd}${c.time ? '@' + c.time : ''}`).join(',')} → 执行 ${s.actionList.map((a) => `${a.cmd}=${a.value}`).join(',')}`));
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

/* ================= 视图切换 ================= */

function switchView(name) {
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('on', v.id === 'view-' + name);
  for (const b of document.querySelectorAll('.nav button')) b.classList.toggle('on', b.dataset.view === name);
  $('#secSessions').style.display = name === 'chat' ? '' : 'none';
  if (name === 'devices') loadDevices();
  if (name === 'audit') loadAudit();
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
$('#btnNew').onclick = () => {
  if (T.ctl) { T.ctl.abort(); T.ctl = null; }
  stopFollow();
  T.sid = null; T.busy = false; T.turn = null;
  sendBtn.disabled = false;
  chatTitle.textContent = '新对话';
  setStatus('', '空闲');
  switchView('chat');
  showEmpty();
  loadSessions();
};
$('#btnReloadDev').onclick = () => loadDevices();
$('#btnReloadAudit').onclick = loadAudit;
$('#sessFind').oninput = paintSessions;

for (const b of document.querySelectorAll('.nav button')) b.onclick = () => switchView(b.dataset.view);

/* ================= 启动 ================= */

(async () => {
  try {
    CFG = await (await fetch('/api/config')).json();
    document.title = `${CFG.brand.product} · ${CFG.brand.vendor}`;
    $('#brandProduct').textContent = CFG.brand.product;
    $('#brandVendor').textContent = CFG.brand.vendor + ' · ' + (CFG.brand.tagline || 'DuMate Agent');
    $('#srcFile').textContent = CFG.source.file;
    $('#srcSummary').textContent = CFG.source.summary;
    // 设备清单有两份（demo / real），演示和联调的判断结果不一样，界面上必须看得见当前是哪份
    $('#iotLine').textContent = `IoT 网关 ${CFG.iot?.mode === 'mock' ? '（本地 mock）' : '（真实环境）'} · homeId ${CFG.iot?.homeId ?? ''} · 清单 ${CFG.iot?.fixture === 'real' ? '真实快照' : '演示'}`;
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
