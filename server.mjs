// 箭牌智家 AI 助手 · 本地编排服务
//
// 这一层是 demo 的全部「判断」所在。模型只负责听懂和表达，设备能不能动由这里决定：
//
//   用户 → DuMate Agent（识意图 / 出结构化动作）→ 安全闸门 → 箭牌 IoT 网关 → 审计
//
// 密钥只留服务端，浏览器只与 localhost 通信。无第三方依赖，Node 22 原生能力即可。
//
// 对外接口：
//   GET  /api/config                场景配置
//   GET  /api/bootstrap             上传资料 + 建 Agent（结果缓存进 state.json）
//   POST /api/ask                   {text, sessionId?}  建会话或续问，SSE 回传
//   POST /api/confirm               {pendingId, decision} 高危动作的二次确认
//   GET  /api/sessions              本场景的会话列表
//   GET  /api/sessions/:id/events   某会话的完整消息历史
//   GET  /api/iot/devices           家庭设备（走 IoT 网关真实接口）
//   GET  /api/iot/scenes            已创建场景
//   GET  /api/audit                 审计日志

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { SCENARIO, DEVICES, ROOT, FIXTURE_NAME } from './scenario.mjs';
import { createGate } from './src/policy.mjs';
import { createAudit } from './src/audit.mjs';
import { createIotClient } from './src/iot-client.mjs';
import { loadEnv } from './src/env.mjs';
import { writeBrief, CATEGORY_NAME } from './src/agent-brief.mjs';
import { createGateway } from './iot/mock-gateway.mjs';

const STATE_FILE = path.join(ROOT, 'state.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const BRIEF_DIR = path.join(ROOT, '.brief');

// ---------- env ----------
const ENV = loadEnv(ROOT);
const BASE = ENV.DUMATE_BASE_URL || 'https://api.dumate.cn/api/v1';
const KEY = ENV.DUMATE_API_KEY;
const PORT = Number(ENV.PORT || 8898);
const IOT_MODE = ENV.IOT_MODE || 'mock';
const IOT_PORT = Number(ENV.IOT_PORT || 18899);
if (!KEY) throw new Error('.env 里没有 DUMATE_API_KEY');

// ---------- 本地状态 ----------
const readJson = (f, dflt) => {
  try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : dflt; } catch { return dflt; }
};
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));
const readState = () => readJson(STATE_FILE, {});
const writeState = (s) => writeJson(STATE_FILE, s);

const audit = createAudit(path.join(ROOT, 'audit.jsonl'));
const gate = createGate({ scenario: SCENARIO, devices: DEVICES.devices });

// ---------- IoT 网关 ----------
// mock 模式起一个本地网关，它按接口文档实现三个 endpoint。
// 换成箭牌测试环境：IOT_MODE=real，IOT_BASE_URL=https://api-uatiot.arrowgroup.com.cn，IOT_TOKEN=真实 token
const gateway = createGateway({
  commands: SCENARIO.commands,
  fixture: DEVICES,
  log: (kind, msg) => console.log(`[iot:${kind}] ${msg}`),
});

const iot = createIotClient({
  baseUrl: IOT_MODE === 'mock' ? `http://127.0.0.1:${IOT_PORT}` : ENV.IOT_BASE_URL,
  token: IOT_MODE === 'mock' ? (ENV.IOT_TOKEN || 'demo-token') : ENV.IOT_TOKEN,
  appPlatform: SCENARIO.iot.appPlatform,
  deviceSystemPlatform: SCENARIO.iot.deviceSystemPlatform,
});

// ---------- DuMate API ----------
async function api(p, init = {}) {
  const res = await fetch(BASE + p, {
    ...init,
    headers: { Authorization: `Bearer ${KEY}`, ...(init.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const msg = body?.error?.message || body?.message || String(text).slice(0, 300);
    const err = new Error(`${init.method || 'GET'} ${p} -> ${res.status} ${msg}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

const json = (p, method, payload) =>
  api(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

async function uploadFile(abs) {
  if (!fs.existsSync(abs)) throw new Error(`找不到要上传的文件 ${abs}`);
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(abs)]), path.basename(abs));
  const res = await fetch(`${BASE}/files`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` }, body: fd });
  const text = await res.text();
  if (!res.ok) throw new Error(`上传 ${path.basename(abs)} 失败 ${res.status}: ${text.slice(0, 300)}`);
  const { fileID } = JSON.parse(text);
  if (!fileID) throw new Error(`上传响应没有 fileID: ${text.slice(0, 300)}`);
  return { fileID, name: path.basename(abs) };
}

// ---------- bootstrap：上传资料 + 建 Agent ----------
// 挂载给 Agent 的东西有两部分：scenario.json 里点名的资料文件，加上从配置生成的
// 设备与指令清单。后者每次重建，保证模型看到的允许值与闸门校验的是同一份。
function agentUploads() {
  const brief = writeBrief({ scenario: SCENARIO, devices: DEVICES.devices, dir: BRIEF_DIR });
  return [...SCENARIO.agent.files.map((f) => path.join(ROOT, f)), brief];
}

async function bootstrap({ force = false } = {}) {
  const st = readState();
  const uploads = agentUploads();
  const want = uploads.map((u) => path.basename(u)).join(',');
  // 只比数量不够：换掉一个挂载文件时数量不变，会错误复用旧 Agent
  const have = (st.files || []).map((f) => f.name).join(',');
  // 设备清单换了一套（demo ↔ real）时文件名不变、内容全变，所以还要比清单版本。
  // 漏了这一步，切到真实清单后模型手里还是那份演示设备表，认得的设备网关不认得。
  const fixtureKey = `${FIXTURE_NAME}:${DEVICES.devices.length}`;
  if (!force && st.agentId && st.scenarioId === SCENARIO.id && want === have && st.fixtureKey === fixtureKey) return st;

  const files = [];
  for (const abs of uploads) files.push(await uploadFile(abs));

  const agent = await json('/agents', 'POST', {
    name: SCENARIO.agent.name,
    description: SCENARIO.agent.description,
    system: SCENARIO.agent.system,
    files: files.map((f) => ({ fileID: f.fileID })),
    skills: [],
    mcpServers: [],
  });

  const next = {
    scenarioId: SCENARIO.id,
    fixtureKey,
    agentId: agent.id,
    agentVersion: agent.version,
    files: files.map((f) => ({ name: f.name, fileID: f.fileID })),
    createdAt: new Date().toISOString(),
  };
  writeState(next);
  return next;
}

// ---------- SSE 解析 ----------
// 事件归属哪个会话。上游信封是 { type, properties }，sid 在 properties 里，
// 位置随事件类型不同，兜底从沙箱工作目录反推。
function sidOf(d) {
  if (!d || typeof d !== 'object') return null;
  const p = d.properties ?? d;
  if (typeof p.sessionID === 'string') return p.sessionID;
  if (typeof p.part?.sessionID === 'string') return p.part.sessionID;
  if (typeof p.info?.sessionID === 'string') return p.info.sessionID;
  const root = p.info?.path?.root || p.part?.path?.root;
  if (typeof root === 'string') {
    const m = root.match(/ses_[A-Za-z0-9]+/);
    if (m) return m[0];
  }
  return null;
}

async function* sseEvents(body) {
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
      let type = 'message';
      const dataLines = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith('event:')) type = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      const raw = dataLines.join('\n');
      let data;
      try { data = JSON.parse(raw); } catch { data = raw; }
      yield { type, data };
    }
  }
}

// ---------- 跑一轮对话 ----------
async function runTurn(sid, text, emit = () => {}) {
  const up = await fetch(`${BASE}/sessions/${sid}/events/stream`, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: 'text/event-stream' },
  });
  if (!up.ok || !up.body) throw new Error(`SSE 建连失败 ${up.status}`);

  let msgSent = false, sawBusy = false, complete = false;
  let answer = '', best = '';
  const guard = setTimeout(() => { try { up.body.cancel(); } catch {} }, 12 * 60 * 1000);

  try {
    for await (const { type, data } of sseEvents(up.body)) {
      // 同一条流里混着 task 子代理自己的会话，别串味
      const evSid = sidOf(data);
      if (evSid && evSid !== sid) continue;

      const evType = (data && typeof data === 'object' && data.type) || type;
      if (evType === 'server.heartbeat') continue;

      const payload = data?.properties ?? data;
      emit(evType, payload);

      // 同一段文本既走全量也走增量，取更长的那份，避免重复又不丢字
      const part = payload?.part;
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.length > best.length) {
        best = part.text;
        answer = best;
      }

      const status = payload?.status?.type ?? payload?.status;
      if (evType === 'server.connected' && !msgSent) {
        msgSent = true;
        await json(`/sessions/${sid}/events`, 'POST', {
          events: [{ type: 'user.message', content: [{ type: 'text', text }] }],
        }).catch((e) => emit('demo.error', { message: String(e.message) }));
        continue;
      }
      if (evType === 'session.status' && status === 'busy') sawBusy = true;
      if (evType === 'session.status' && status === 'idle' && sawBusy) { complete = true; break; }
      if (evType === 'server.disposed') { complete = true; break; }
    }
  } finally {
    clearTimeout(guard);
  }
  return { complete, answer };
}

// ---------- 从回答里取结构化动作 ----------
// Agent 被要求在回答末尾附一个 iot 代码块。这里把块摘出来，正文里不留 JSON。
function extractAction(text) {
  if (!text) return { action: null, clean: text || '' };
  const re = /```(?:iot|json)\s*\n([\s\S]*?)```/g;
  let m, found = null, clean = text;
  while ((m = re.exec(text))) {
    let obj;
    try { obj = JSON.parse(m[1].trim()); } catch { continue; }
    if (obj && typeof obj === 'object' && typeof obj.action === 'string') {
      found = obj;
      clean = clean.replace(m[0], '');
      break;
    }
  }
  return { action: found, clean: clean.replace(/\n{3,}/g, '\n\n').trim() };
}

// ---------- 执行：把动作送过闸门，再落到 IoT 网关 ----------
function execControl(rec) {
  const cmdList = rec.items.map(({ deviceName, cmd, param, value }) => ({ deviceName, cmd, param, value }));
  return iot.control(SCENARIO.iot.homeId, cmdList);
}

function execScene(rec) {
  const pick = (i) => ({ deviceName: i.deviceName, cmd: i.cmd, param: i.param, value: i.value, ...(i.time ? { time: i.time } : {}) });
  const conditionList = (rec.action.conditionList || []).map(pick);
  const actionList = (rec.action.actionList || []).map(pick);
  return iot.createScene(SCENARIO.iot.homeId, conditionList, actionList);
}

// 闸门判 allow 或用户点确认后都会走到这里：下发 + 留审计 + 回一个给前端渲染的结果
async function execute(rec, { trigger, actor = 'app-user', sessionId }) {
  const isScene = rec.action.action === 'scene.create';
  const res = isScene ? await execScene(rec) : await execControl(rec);

  const targets = (isScene
    ? [...(rec.action.conditionList || []), ...(rec.action.actionList || [])]
    : rec.action.targets || []
  ).map((t) => {
    const dev = DEVICES.devices.find((d) => d.deviceName === t.deviceName) || {};
    return { deviceName: t.deviceName, deviceTagName: dev.deviceTagName || '', room: dev.room || '', cmd: t.cmd, param: t.param, value: t.value };
  });

  const entry = {
    kind: isScene ? 'scene.create' : 'device.control',
    actor,
    sessionId,
    homeId: SCENARIO.iot.homeId,
    level: rec.level,
    reasons: rec.reasons,
    decision: 'EXECUTED',
    trigger,
    targets,
    iotRequest: res.request,
    iotResponse: res.response,
    result: res.ok ? 'SUCCEEDED' : 'FAILED',
    error: res.error || null,
    ms: res.ms,
  };
  audit.append(entry);
  return { ...entry, ok: res.ok };
}

// ---------- 会话 ----------
async function listSessions() {
  const st = readState();
  const all = [];
  let cursor = '';
  for (let i = 0; i < 6; i++) {
    const r = await api(`/sessions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    all.push(...(r?.data || []));
    if (!r?.hasMore || !r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return all
    .filter((s) => s.agent?.id === st.agentId && s.metadata?.scenario === SCENARIO.id)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

async function createSession(title) {
  const st = await bootstrap();
  return json('/sessions', 'POST', {
    agent: { id: st.agentId },
    metadata: { title: title.slice(0, 60), scenario: SCENARIO.id },
  });
}

// ---------- 请求体 ----------
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// ---------- POST /api/ask ----------
async function handleAsk(req, res) {
  const { text = '', sessionId } = await readBody(req);
  const q = String(text).trim();
  if (!q) return sendJson(res, 400, { error: 'text 不能为空' });

  const st = await bootstrap();
  const sid = sessionId || (await createSession(q)).id;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const toClient = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

  toClient('demo.session', { sessionId: sid, agentId: st.agentId, resumed: !!sessionId });
  console.log(`[ask] ${sessionId ? 'resume' : 'new'} ${sid} :: ${q.slice(0, 50)}`);

  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    const { complete, answer } = await runTurn(sid, q, (t, d) => { if (!aborted) toClient(t, d); });
    if (aborted) return;

    const { action, clean } = extractAction(answer);
    // 正文里带 JSON 块不好看，替换成摘掉块之后的文本
    if (action) toClient('demo.answer', { text: clean });
    if (!action) {
      toClient('demo.done', { sessionId: sid, incomplete: !complete });
      return;
    }

    toClient('demo.action', { action: action.action, raw: action });

    // 报修只给 deeplink，没有副作用，不用过闸门
    if (action.action === 'repair.open') {
      const kind = action.kind === 'progress' ? 'progress' : 'report';
      audit.append({
        kind: 'repair.open', actor: 'app-user', sessionId: sid, level: 'L',
        decision: 'EXECUTED', trigger: 'gate-auto', reasons: ['报修引导：只给入口，不对接工单'],
        targets: [], result: 'SUCCEEDED', deeplink: SCENARIO.repair.deeplink[kind],
      });
      toClient('demo.repair', { kind, deeplink: SCENARIO.repair.deeplink[kind], note: SCENARIO.repair.note });
      toClient('demo.done', { sessionId: sid, incomplete: !complete });
      return;
    }

    const verdict = gate.evaluate({ ...action, homeId: action.homeId ?? SCENARIO.iot.homeId });
    toClient('demo.gate', {
      decision: verdict.decision, level: verdict.level, reasons: verdict.reasons,
      items: verdict.items, pendingId: verdict.pendingId || null,
    });

    if (verdict.decision === 'deny') {
      audit.append({
        kind: action.action, actor: 'app-user', sessionId: sid, level: verdict.level,
        decision: 'DENIED', trigger: 'gate', reasons: verdict.reasons,
        targets: verdict.items || [], result: 'BLOCKED',
      });
      toClient('demo.done', { sessionId: sid, incomplete: !complete });
      return;
    }

    if (verdict.decision === 'confirm') {
      // 停下等用户点确认。前端拿到 pendingId 后渲染确认卡。
      toClient('demo.done', { sessionId: sid, incomplete: !complete, pendingId: verdict.pendingId });
      return;
    }

    const out = await execute(verdict, { trigger: 'gate-auto', sessionId: sid });
    toClient('demo.exec', out);
    toClient('demo.done', { sessionId: sid, incomplete: !complete });
  } catch (e) {
    if (!aborted) toClient('demo.error', { message: String(e.message || e) });
  } finally {
    res.end();
  }
}

// ---------- POST /api/gate/simulate ----------
// 旁路：手工把一条动作喂进闸门，不经过模型，也不下发。
//
// 为什么需要它：模型被要求「拿不准就反问、越界就说做不到」，所以参数越界、设备离线这两类
// 它自己就拦在前面了，闸门那四道检查反而演示不出来。联调时客户工程师也要能用它验证
// 自己那份指令表和闸门是否一致。
// 只判定不下发，也不写审计——审计要留真实操作的证据，不能被诊断调用稀释。
async function handleSimulate(req, res) {
  // 请求体本身就是动作对象（顶层 action 字段是动作类型），与 gate.evaluate 的入参一致
  const action = await readBody(req);
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    return sendJson(res, 400, { error: '请求体要是一个动作对象，例如 {"action":"device.control","targets":[...]}' });
  }
  // dryRun：不建待确认记录，避免诊断调用在审计里留下没真实发生过的操作
  const verdict = gate.evaluate({ ...action, homeId: action.homeId ?? SCENARIO.iot.homeId }, { dryRun: true });
  return sendJson(res, 200, {
    decision: verdict.decision, level: verdict.level, reasons: verdict.reasons,
    items: verdict.items || [], dryRun: true,
  });
}

// ---------- POST /api/confirm ----------
async function handleConfirm(req, res) {
  const { pendingId, decision, sessionId } = await readBody(req);
  const claimed = decision === 'reject' ? gate.reject(pendingId) : gate.claim(pendingId);
  if (!claimed.ok) return sendJson(res, 400, { error: claimed.error });
  const rec = claimed.rec;

  if (decision === 'reject') {
    const entry = {
      kind: rec.action.action, actor: 'app-user', sessionId, level: rec.level,
      decision: 'REJECTED', trigger: 'gate-confirm', reasons: rec.reasons,
      targets: rec.items, result: 'CANCELLED',
    };
    audit.append(entry);
    return sendJson(res, 200, entry);
  }

  try {
    const out = await execute(rec, { trigger: 'gate-confirm', sessionId });
    gate.settle(pendingId, out.ok ? 'SUCCEEDED' : 'FAILED');
    return sendJson(res, 200, out);
  } catch (e) {
    gate.settle(pendingId, 'FAILED');
    return sendJson(res, 500, { error: String(e.message || e) });
  }
}

// ---------- 静态资源 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon',
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const abs = path.join(PUBLIC_DIR, rel);
  if (!abs.startsWith(PUBLIC_DIR) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
  fs.createReadStream(abs).pipe(res);
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  try {
    if (p === '/api/config') {
      return sendJson(res, 200, {
        brand: SCENARIO.brand,
        source: SCENARIO.source,
        starters: SCENARIO.starters,
        policy: SCENARIO.policy,
        iot: { homeId: SCENARIO.iot.homeId, mode: IOT_MODE, fixture: FIXTURE_NAME, baseUrl: IOT_MODE === 'mock' ? `http://127.0.0.1:${IOT_PORT}` : ENV.IOT_BASE_URL },
        commands: SCENARIO.commands,
        repair: SCENARIO.repair,
        scenario: SCENARIO.id,
      });
    }
    if (p === '/api/bootstrap') {
      const st = await bootstrap({ force: url.searchParams.get('force') === '1' });
      return sendJson(res, 200, { agentId: st.agentId, version: st.agentVersion, files: st.files });
    }
    if (p === '/api/ask' && req.method === 'POST') return await handleAsk(req, res);
    if (p === '/api/gate/simulate' && req.method === 'POST') return await handleSimulate(req, res);
    if (p === '/api/confirm' && req.method === 'POST') return await handleConfirm(req, res);

    if (p === '/api/sessions') {
      const list = await listSessions();
      return sendJson(res, 200, {
        data: list.map((s) => ({ id: s.id, title: s.metadata?.title || '(未命名)', status: s.status, createdAt: s.createdAt, updatedAt: s.updatedAt })),
      });
    }
    const mHist = p.match(/^\/api\/sessions\/([^/]+)\/events$/);
    if (mHist) {
      const items = await api(`/sessions/${mHist[1]}/events`);
      return sendJson(res, 200, { data: items });
    }

    // 设备面板：契约字段走真实接口，运行态走 demo 补充接口
    if (p === '/api/iot/devices') {
      const list = await iot.deviceList(SCENARIO.iot.homeId);
      const live = await iot.demoState();
      const liveMap = new Map((live.response?.data || []).map((d) => [d.deviceName, d]));
      const rows = (list.response?.data || []).map((d) => {
        const fix = DEVICES.devices.find((x) => x.deviceName === d.deviceName) || {};
        return {
          ...d,
          room: fix.room || '', categoryName: CATEGORY_NAME[d.categoryCode] || d.categoryCode,
          power: liveMap.get(d.deviceName)?.power ?? null,
          status: liveMap.get(d.deviceName)?.status ?? null,
        };
      });
      return sendJson(res, 200, { data: rows, ok: list.ok, error: list.error || null, ms: list.ms });
    }
    if (p === '/api/iot/scenes') {
      const r = await iot.sceneList();
      return sendJson(res, 200, { data: r.response?.data || [], ok: r.ok, error: r.error || null });
    }

    if (p === '/api/audit') {
      const limit = Number(url.searchParams.get('limit') || 100);
      return sendJson(res, 200, { data: audit.tail(limit) });
    }

    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'no such api' });
    return serveStatic(res, p);
  } catch (e) {
    console.error('[err]', e);
    if (!res.headersSent) sendJson(res, 500, { error: String(e.message || e) });
    else res.end();
  }
});

// ---------- 起服务 ----------
if (IOT_MODE === 'mock') {
  gateway.listen(IOT_PORT, '127.0.0.1', () => {
    console.log(`  IoT 网关（mock）  http://127.0.0.1:${IOT_PORT}   homeId=${SCENARIO.iot.homeId}   设备清单=${FIXTURE_NAME}`);
  });
  gateway.on('error', (e) => console.error('[iot] 网关启动失败', e.message));
} else {
  console.log(`  IoT 网关（真实）  ${ENV.IOT_BASE_URL}   设备清单=${FIXTURE_NAME}`);
}
if (IOT_MODE === 'real' && FIXTURE_NAME === 'demo') {
  console.log('  提示：走真实网关但用的是演示清单，闸门认得的设备可能网关不认得。联调请加 IOT_FIXTURE=real。');
}

server.listen(PORT, () => {
  console.log(`\n  ${SCENARIO.brand.product} · ${SCENARIO.brand.vendor}`);
  console.log(`  场景 ${SCENARIO.id}    配置 config/scenario.json`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  DuMate API: ${BASE}\n`);
});

const shutdown = () => { try { gateway.close(); } catch {} ; server.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
