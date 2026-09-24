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
//   POST /api/asr                   裸 PCM（16k / 单声道 / 16-bit）→ 百度短语音识别 → 文本
//   POST /api/confirm               {pendingId, decision} 高危动作的二次确认
//   GET  /api/sessions              本场景的会话列表
//   GET  /api/sessions/:id/events   某会话的完整消息历史
//   GET  /api/iot/devices           家庭设备（走 IoT 网关真实接口）
//   GET  /api/iot/scenes            已创建场景
//   GET  /api/audit                 审计日志
//
//   —— 技能管理（平台技能库，不只是本场景） ——
//   GET    /api/skills              技能库搜索 / 分页
//   GET    /api/skills/:id          技能详情
//   POST   /api/skills              {url} 新建（平台只收 GitHub / ClawHub / BOS 地址）
//   POST   /api/skills/:id          {url} 换源更新
//   POST   /api/skills/:id/zip      multipart（字段 file）传 ZIP 更新
//   DELETE /api/skills/:id          删技能
//   GET    /api/agent               本场景 Agent 的挂载实况
//   POST   /api/agent/skills        {skillID, releaseID, action} 加挂 / 摘除技能
//
//   —— 生成物管理 ——
//   GET  /api/artifacts             跨会话汇总的产物清单
//   GET  /api/artifacts/resolve     取单个产物的临时下载地址（按会话拉 path-map 再取键）

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { SCENARIO, DEVICES, ROOT, FIXTURE_NAME } from './scenario.mjs';
import { createGate } from './src/policy.mjs';
import { slimEvents, inDemoWindow, spokenText } from './src/history.mjs';
import { createAudit, redact } from './src/audit.mjs';
import { createJournal } from './src/journal.mjs';
import { createStore, storageWarning } from './src/store.mjs';
import { createIotClient } from './src/iot-client.mjs';
import { createAsrClient } from './src/asr-client.mjs';
import { loadEnv } from './src/env.mjs';
import { CATEGORY_NAME } from './src/agent-brief.mjs';
import { createGateway } from './iot/mock-gateway.mjs';

const PUBLIC_DIR = path.join(ROOT, 'public');
// Vercel 上只有 /tmp 可写，仓库目录是只读的。清单是每次现生成、用完就传走，
// 不需要留在仓库里，所以线上落到 tmpdir 就行。

// 没配 KV 时的兜底目录。本地就是仓库目录（行为与改动前一致）；线上换 tmpdir，
// 因为往只读的仓库目录写会直接 EACCES 抛出来，把 bootstrap 和每一轮对话都打成 500。
// 这样兜底之后线上仍能跑，代价是数据只活在本实例里、冷启动即丢 —— 与启动横幅的警告一致。
// 但要注意：审计留痕是需求点名的东西，客户演示前必须把 KV 配上，别靠这个兜底。
const FALLBACK_DIR = process.env.VERCEL ? tmpdir() : ROOT;
const STATE_FILE = path.join(FALLBACK_DIR, 'state.json');

// ---------- env ----------
const ENV = loadEnv(ROOT);
const BASE = ENV.DUMATE_BASE_URL || 'https://api.dumate.cn/api/v1';
const KEY = ENV.DUMATE_API_KEY;
const PORT = Number(ENV.PORT || 8898);
const IOT_MODE = ENV.IOT_MODE || 'mock';
const IOT_PORT = Number(ENV.IOT_PORT || 18899);
if (!KEY) throw new Error('.env 里没有 DUMATE_API_KEY');

// 语音是可选的：没配 Key 也要能起服务，只有按下麦克风时 /api/asr 才报「未配置」，
// 文字对话与整套演示不受影响。
const ASR_KEY = ENV.ASR_API_KEY || '';
const ASR_DEV_PID = Number(ENV.ASR_DEV_PID || 80001);

// ---------- 存储 ----------
// 本地写文件，Vercel 上写 KV，由 src/store.mjs 按环境变量选。两者都是异步接口。
const STATE_STORE = createStore({ name: 'arrow:state', file: STATE_FILE, env: ENV });
const AUDIT_STORE = createStore({ name: 'arrow:audit', file: path.join(FALLBACK_DIR, 'audit.jsonl'), env: ENV });
const CARD_STORE = createStore({ name: 'arrow:cards', file: path.join(FALLBACK_DIR, 'cards.jsonl'), env: ENV });

const readState = () => STATE_STORE.readJson({});
const writeState = (s) => STATE_STORE.writeJson(s);

const audit = createAudit(AUDIT_STORE);
// 闸门卡、执行卡、报修卡的回放流水。平台消息里没有这三段，只能自己落
const journal = createJournal(CARD_STORE);
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

// 真实网关的在线态缓存 20 秒。对话、闸门、设备页共用这一份，避免一轮里连打三次列表。
// mock 模式不走这里，闸门继续用清单里的在线列。
const LIVE_TTL = 20_000;
let liveCache = { at: 0, map: null, rows: null, ok: false, error: null, ms: 0 };

// 技能库列表几乎不变（大量内置技能）。缓存 5 分钟，增删改时清掉。
// 已挂技能的名字另记一份，打开技能页不必按挂载数再逐个打详情。
const SKILL_TTL = 5 * 60 * 1000;
const skillListCache = new Map();
const skillNameCache = new Map();
function dropSkillCache(id) {
  skillListCache.clear();
  if (id) skillNameCache.delete(id);
}

async function liveDevices(force = false) {
  if (!force && liveCache.rows && Date.now() - liveCache.at < LIVE_TTL) return liveCache;
  const started = Date.now();
  try {
    const list = await iot.deviceList(SCENARIO.iot.homeId);
    const rows = Array.isArray(list.response?.data) ? list.response.data : [];
    const map = new Map();
    for (const d of rows) if (d?.deviceName) map.set(d.deviceName, !!d.onlineStatus);
    liveCache = {
      at: Date.now(), map, rows, ok: !!list.ok, error: list.error || null,
      ms: list.ms ?? (Date.now() - started),
    };
  } catch (e) {
    if (liveCache.rows) return liveCache;
    liveCache = {
      at: Date.now(), map: new Map(), rows: [], ok: false,
      error: String(e.message || e), ms: Date.now() - started,
    };
  }
  return liveCache;
}

// 真实模式下闸门只认实时表。接口失败时 map 是空的，全部按离线拦截，不用清单里的演示在线态。
async function onlineForGate() {
  if (IOT_MODE !== 'real') return null;
  const live = await liveDevices();
  return live.map || new Map();
}

const ROSTER_MARK = '【用户原话】';

function roomOf(deviceName) {
  return DEVICES.devices.find((d) => d.deviceName === deviceName)?.room || '';
}

function capsFor(categoryCode) {
  return SCENARIO.commands
    .filter((c) => (c.appliesTo || []).includes(categoryCode))
    .map((c) => c.cmd);
}

// 设备身份和在线态来自物联网平台当时的返回。房间只是本地标注，接口本身不给房间。
// 指令表来自场景配置，平台的设备列表不带 cmd。这段只放进发给模型的消息，界面会裁掉。
function turnContext(live) {
  const lines = ['【本轮设备】这是物联网平台刚刚返回的设备与可下发指令。不要复述本段，不要读取工作目录里的文件。'];
  const rows = Array.isArray(live?.rows) ? live.rows : [];
  if (!live?.ok) {
    lines.push(`查询失败${live?.error ? `（${live.error}）` : ''}。本轮按全部离线处理，不要下发控制，不要声称设备在线。`);
  } else if (!rows.length) {
    lines.push('平台返回 0 台设备。不要编造设备，不要下发控制。');
  } else {
    for (const d of rows) {
      const room = d.room || roomOf(d.deviceName);
      const caps = capsFor(d.categoryCode);
      lines.push(`- ${room ? room + ' ' : ''}${d.deviceTagName || ''} ${d.deviceName} ${d.onlineStatus ? '在线' : '离线'} 可用 ${caps.join('、') || '无'}`);
    }
    lines.push('用户已指定唯一一台时，必须输出 iot 动作，离线也要下发。有多台命中时只反问，不要输出动作，也不要说两台都发。');
  }
  lines.push('指令（参数名都是 switch，取值逐字使用）：');
  for (const c of SCENARIO.commands) {
    const vals = Object.entries(c.params).map(([k, v]) => `${k}=${v.join('/')}`).join(' ');
    lines.push(`- ${c.cmd} ${vals} ${c.desc}`);
  }
  return lines.join('\n') + `\n${ROSTER_MARK}\n`;
}

// ---------- 百度短语音识别 ----------
// 按住说话只是「一句话变文字」，识别完回填输入框，发不发由用户决定。
// 转写不进审计：审计记的是对设备的控制与场景操作，语音本身不是控制动作。
const asr = createAsrClient({
  apiKey: ASR_KEY,
  devPid: ASR_DEV_PID,
  cuid: ENV.ASR_CUID || 'dumate-arrow-demo',
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
// 不再挂「设备与指令清单」。那份 md 会让模型每次 ls / 读文件，在线列还是上传时的快照。
// 设备和指令改由每轮消息里的「本轮设备」提供，在线态来自物联网接口。
// 这里只留产品知识库，给「某型号有哪些功能」用。
const MOUNT_KEY = 'live-iot';
function agentUploads() {
  return SCENARIO.agent.files.map((f) => path.join(ROOT, f));
}

// ---------- 技能：名字 → ID ----------
// Agent 挂载的是 { skillID, releaseID } 两个 ID，scenario.json 里写名字好维护。
// 名字写错不静默跳过：日志里报出来，人一眼能看到少挂了一个。
let wantedSkills = null; // 进程内缓存。每次提问都去查一遍没必要；重启会重新解析，技能发新版也能跟上

async function resolveSkills(names = []) {
  const out = [];
  for (const name of names) {
    let hit = null;
    try {
      const r = await api(`/skills?page=1&pageSize=20&keyword=${encodeURIComponent(name)}`);
      hit = (r?.data || []).find((s) => s.name === name) || null;
    } catch (e) {
      console.warn(`[skills] 查「${name}」失败：${e.message}`);
      continue;
    }
    if (!hit) {
      console.warn(`[skills] 平台技能库里没有「${name}」，本次不挂载。检查 config/scenario.json 的 agent.skills。`);
      continue;
    }
    out.push({ skillID: hit.id, releaseID: hit.releaseId || '', name: hit.name });
  }
  return out;
}

async function scenarioSkills(force = false) {
  if (force || !wantedSkills) wantedSkills = await resolveSkills(SCENARIO.agent.skills || []);
  return wantedSkills;
}

const skillKey = (list) => (list || []).map((s) => `${s.skillID}@${s.releaseID}`).join(',');
const skillPayload = (list) => (list || []).map((s) => ({ skillID: s.skillID, releaseID: s.releaseID }));
const promptKey = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

// 改挂载、改提示词都走更新接口，不重建 Agent：重建会换掉 agentId，历史会话就找不回来了。
// version 是乐观锁，必须带当前版本；数组按全量替换理解，没传的字段不动。
async function updateAgent(st, patch) {
  const body = { version: st.agentVersion };
  if (patch.skills) body.skills = skillPayload(patch.skills);
  if (patch.system) body.system = patch.system;
  if (patch.files) body.files = patch.files.map((f) => ({ fileID: f.fileID }));

  const r = await json(`/agents/${st.agentId}`, 'POST', body);
  const next = {
    ...st,
    agentVersion: r?.version ?? st.agentVersion,
    ...(patch.skills ? { skills: patch.skills, skillsKey: skillKey(patch.skills) } : {}),
    ...(patch.system ? { promptKey: promptKey(patch.system) } : {}),
    ...(patch.files ? { files: patch.files.map((f) => ({ name: f.name, fileID: f.fileID })), briefKey: MOUNT_KEY } : {}),
    updatedAt: new Date().toISOString(),
  };
  await writeState(next);
  if (patch.files) await dropUnusedFiles(st.files, patch.files);
  return next;
}

async function dropUnusedFiles(prev, nextFiles) {
  const keep = new Set((nextFiles || []).map((f) => f.fileID));
  for (const f of prev || []) {
    if (!f?.fileID || keep.has(f.fileID)) continue;
    try {
      await api(`/files/${f.fileID}`, { method: 'DELETE' });
      console.log(`[agent] 已删除挂载文件 ${f.name || f.fileID}`);
    } catch (e) {
      console.warn(`[agent] 删除挂载文件失败 ${f.fileID}：${e.message}`);
    }
  }
}

async function uploadMounts() {
  const files = [];
  for (const abs of agentUploads()) files.push(await uploadFile(abs));
  return files;
}

// 冷启动时 state.json 可能不在（Vercel 上没配 KV 的话，每个新实例都是空的）。
// 那种情况下不能直接建新 Agent —— 每冷启动一次就在客户账号里多一个同名 Agent，
// 演示一上午能攒出十几个。先按名字去列表里找，各项对得上就复用。
//
// 能核对的：skills 的 {skillID, releaseID}、挂载文件个数。
// system 全文变了也复用同一条 Agent，回来再把提示词补上去。只因改了一句提示词就新建，
// agentId 一换，侧栏里的历史会话就对不上了。
// 核对不了的：文件内容 —— GET 只回 fileID，不回文件名，没法确认挂的是不是当前那份清单。
// 所以这只是一层兜底，正路是配 KV 让 state.json 真正持久化。
async function findReusableAgent({ skills, pKey, want, fixtureKey }) {
  let list;
  try {
    list = await api('/agents?page=1&pageSize=50');
  } catch (e) {
    console.warn(`[agent] 查 Agent 列表失败，改为新建：${e.message}`);
    return null;
  }
  const same = (list?.data || []).filter((a) => a.name === SCENARIO.agent.name);
  if (!same.length) return null;

  const candidates = same.filter((a) => skillKey(a.skills) === skillKey(skills));
  const hit = candidates.find((a) => a.system === SCENARIO.agent.system) || candidates[0];
  if (!hit) {
    console.warn(`[agent] 有 ${same.length} 个同名 Agent，但没有一个与当前配置对得上，新建一个。`
      + `（同名 Agent 会越攒越多，确认无用后可去平台删掉）`);
    return null;
  }

  // 用平台返回的实况回填 state，而不是照抄我们以为的配置
  const next = {
    scenarioId: SCENARIO.id,
    fixtureKey,
    briefKey: MOUNT_KEY,
    agentId: hit.id,
    agentVersion: hit.version,
    files: (hit.files || []).map((f) => ({ name: '', fileID: f.fileID })),
    skills,
    skillsKey: skillKey(skills),
    promptKey: pKey,
    reusedByLookup: true,
    createdAt: hit.createdAt || new Date().toISOString(),
  };
  await writeState(next);
  const files = await uploadMounts();
  const updated = await updateAgent(next, {
    ...(hit.system !== SCENARIO.agent.system ? { system: SCENARIO.agent.system } : {}),
    files,
  });
  console.log(`[agent] 冷启动：复用 ${hit.id}，挂载已收成产品知识库，清单文件已卸下`);
  return updated;
}

async function bootstrap({ force = false } = {}) {
  const st = await readState();
  const uploads = agentUploads();
  const want = uploads.map((u) => path.basename(u)).join(',');
  // 只比数量不够：换掉一个挂载文件时数量不变，会错误复用旧 Agent
  const have = (st.files || []).map((f) => f.name).join(',');
  // 设备清单换了一套（demo ↔ real）时文件名不变、内容全变，所以还要比清单版本。
  // 漏了这一步，切到真实清单后模型手里还是那份演示设备表，认得的设备网关不认得。
  const fixtureKey = `${FIXTURE_NAME}:${DEVICES.devices.length}`;
  // 清单文件的内容也要进 key。指令表改了（比如对齐客户的真实指令集）而清单名与台数都没变时，
  // 只比 fixtureKey 会错误复用旧 Agent，模型手里还是旧指令，现场表现为「模型给的指令闸门不认」。
  // 挂在最后一位的就是 agentUploads() 刚生成的那份清单。
  const skills = await scenarioSkills(force);
  const pKey = promptKey(SCENARIO.agent.system);
  // 已有 Agent 就留着，把清单文件从挂载里拿掉。新建会换 agentId，侧栏历史对不上。
  const keep = !force && st.agentId && st.scenarioId === SCENARIO.id;
  if (keep) {
    const patch = {};
    if (st.skillsKey !== skillKey(skills)) patch.skills = skills;
    if (st.promptKey !== pKey) patch.system = SCENARIO.agent.system;
    if (st.briefKey !== MOUNT_KEY || want !== have) patch.files = await uploadMounts();
    if (!Object.keys(patch).length) return st;
    const next = await updateAgent(st, patch);
    console.log(`[agent] 更新 v${st.agentVersion} → v${next.agentVersion}`);
    return next;
  }
  if (!force) {
    const found = await findReusableAgent({ skills, pKey, want, fixtureKey });
    if (found) return found;
  }

  const files = [];
  for (const abs of uploads) files.push(await uploadFile(abs));

  const agent = await json('/agents', 'POST', {
    name: SCENARIO.agent.name,
    description: SCENARIO.agent.description,
    system: SCENARIO.agent.system,
    files: files.map((f) => ({ fileID: f.fileID })),
    skills: skillPayload(skills),
    mcpServers: [],
  });

  const next = {
    scenarioId: SCENARIO.id,
    fixtureKey,
    briefKey: MOUNT_KEY,
    agentId: agent.id,
    agentVersion: agent.version,
    files: files.map((f) => ({ name: f.name, fileID: f.fileID })),
    skills,
    skillsKey: skillKey(skills),
    promptKey: pKey,
    createdAt: new Date().toISOString(),
  };
  await writeState(next);
  if (skills.length) console.log(`[agent] 新建 v${next.agentVersion}，技能：${skills.map((s) => s.name).join('/')}`);
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
async function runTurn(sid, text, emit = () => {}, modelText) {
  const up = await fetch(`${BASE}/sessions/${sid}/events/stream`, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: 'text/event-stream' },
  });
  if (!up.ok || !up.body) throw new Error(`SSE 建连失败 ${up.status}`);

  let msgSent = false, sawBusy = false, complete = false;
  let answer = '', best = '';
  // 这一轮导出的文件。平台没有「列产物」接口，只能从流里翻 file_export 那个 tool part
  const artifacts = [];
  // 这一轮最后一条 assistant 消息的 ID。卡片要挂在这个锚点上，回放才能找回来。
  // 不用时间戳对齐：本地时钟和平台时钟不同源，回放时猜不准。
  let msgId = '';
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
      if (typeof part?.messageID === 'string') msgId = part.messageID;
      const info = payload?.info;
      if (!msgId && info?.role === 'assistant' && typeof info.id === 'string') msgId = info.id;
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.length > best.length) {
        best = part.text;
        answer = best;
      }
      for (const art of artifactsOf(part)) {
        if (!artifacts.some((x) => x.path === art.path)) artifacts.push(art);
      }

      const status = payload?.status?.type ?? payload?.status;
      if (evType === 'server.connected' && !msgSent) {
        msgSent = true;
        await json(`/sessions/${sid}/events`, 'POST', {
          events: [{ type: 'user.message', content: [{ type: 'text', text: modelText || text }] }],
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
  return { complete, answer, msgId, artifacts };
}

// ---------- 产物 ----------
// 平台没有独立的产物列表接口，但会话级的 path-map 就是：不传 path 返回该会话的全部产物，
// 返回体是以沙箱绝对路径为键的 map，值里带临时签名的 downloadUrl / previewUrl / pdfUrl。
// （不传 path 返回 {} 只说明那个会话没有产物，不代表接口要给 path。）
//
// 消息历史里的 file_export part 仍然要用：它带这一轮的时间和文件名，
// 会话内实时出卡要靠它，path-map 给不了时间。
const ARTIFACT_SCAN = 25;

async function artifactMap(sid) {
  const r = await api(`/sessions/${sid}/artifact/path-map`);
  const map = r?.data || r;
  return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
}

// 实测的 part 形状（一轮里会同时出现两个）：
//   { type:"tool", tool:"file_export", state:{ metadata:{ fileExports:[{filename,path}] },
//                                            input:{ files:[{path}] }, time:{start,end} } }
//   { type:"file-export", files:[{filename,path}] }
// 都是数组：一次导出可以带多个文件。两处都收，调用方按路径去重，保证不漏也不重。
function artifactsOf(part) {
  if (!part || typeof part !== 'object') return [];
  let lists;
  if (part.tool === 'file_export') lists = [part.state?.metadata?.fileExports, part.state?.input?.files];
  else if (part.type === 'file-export') lists = [part.files];
  else return [];

  const out = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const f of list) {
      const abs = f?.path || f?.filePath || '';
      if (typeof abs !== 'string' || !abs) continue;
      out.push({
        path: abs,
        filename: f.filename || f.name || path.basename(abs),
        relativePath: f.relativePath || '',
        at: part.state?.time?.end || part.state?.time?.start || null,
      });
    }
  }
  return out;
}

async function listArtifacts(limit) {
  const sessions = await listSessions().catch(() => []);
  const picked = sessions.slice(0, ARTIFACT_SCAN);
  const rows = [];
  // 串行翻 25 个会话要好几秒，分 5 个一批并发。翻不动的会话只记日志，不整页失败
  for (let i = 0; i < picked.length; i += 5) {
    const batch = await Promise.all(picked.slice(i, i + 5).map(async (s) => {
      try {
        const map = await artifactMap(s.id);
        return Object.entries(map).map(([p, v]) => ({
          path: v.path || p,
          filename: v.filename || path.basename(p),
          relativePath: v.relativePath || '',
          mimeType: v.mimeType || '',
          fileType: v.fileType || '',
          size: v.size ?? null,
          uploadStatus: v.uploadStatus || '',
          previewStatus: v.previewStatus || '',
          artifactID: v.artifactID || '',
          sessionId: s.id,
          title: s.metadata?.title || '(未命名)',
          // path-map 不带时间，只能拿会话的更新时间当序。会话内那张产物卡用的是 part 自己的时间
          at: s.updatedAt || s.createdAt || '',
        }));
      } catch (e) { console.error('[artifacts]', s.id, e.message); return []; }
    }));
    for (const one of batch) rows.push(...one);
  }
  // 同一个会话里同名同路径不会重复，但平台可能重复登记，去一次重
  const byKey = new Map();
  for (const r of rows) byKey.set(`${r.sessionId}::${r.path}`, r);
  return [...byKey.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
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
    httpStatus: res.httpStatus ?? null,
    error: res.error || null,
    ms: res.ms,
    // 平台没有场景查询接口，设备页那屏只能列我们建过的，靠这里把条件与动作分开存下来，
    // 不然 targets 是一锅烩，回看时分不出哪条是触发条件
    ...(isScene ? { scene: { conditionList: rec.action.conditionList || [], actionList: rec.action.actionList || [] } } : {}),
  };
  entry.receipt = controlReceipt(entry);
  await audit.append(entry);
  return { ...entry, ok: res.ok };
}

// 模型没交出 iot 块时，不要一律说「请指定其中一台」。
// 暖风、座温这类平台不认的功能，和主卫两台镜柜没选中，是两种回答。
function missingCommandNote(q) {
  const unsupported = [
    [/暖风|烘干/, '暖风烘干'],
    [/座温|座圈/, '座温'],
    [/小冲/, '小冲'],
    [/浴霸/, '浴霸'],
    [/除雾/, '除雾'],
    [/毛巾架/, '毛巾架'],
  ];
  for (const [re, name] of unsupported) {
    if (re.test(q)) return `平台没有「${name}」这条可下发指令，只能在 App 或设备面板上操作。`;
  }
  if (!/打开|关闭|开启|关掉|开机|关机|夜灯|大冲|进水|翻盖|脚触|润瓷/.test(q)) return null;
  const room = /主卫/.test(q) ? '主卫' : /客卫/.test(q) ? '客卫' : '';
  let cats = null;
  if (/镜柜/.test(q)) cats = new Set(['06']);
  else if (/浴缸/.test(q)) cats = new Set(['04']);
  else if (/马桶|坐便/.test(q)) cats = new Set(['01']);
  else if (/夜灯/.test(q)) cats = new Set(['01', '06']);
  else if (/大冲|翻盖|脚触|润瓷/.test(q)) cats = new Set(['01']);
  else if (/进水/.test(q)) cats = new Set(['04']);
  const hits = DEVICES.devices.filter((d) => (!room || d.room === room) && (!cats || cats.has(d.categoryCode)));
  if (hits.length > 1) {
    const names = hits.slice(0, 4).map((d) => `${d.room ? d.room + ' ' : ''}${d.deviceTagName}`).join('、');
    return `有 ${hits.length} 台符合：${names}${hits.length > 4 ? ' 等' : ''}。请指定其中一台。本次没有向物联网平台发送指令。`;
  }
  return '没有形成可下发指令，物联网平台没有收到请求。';
}

// 模型的正文写在请求之前，不能当结果。这句用网关的 HTTP 状态和 msg 补上。
function controlReceipt(out) {
  const http = out.httpStatus ? `HTTP ${out.httpStatus}` : '';
  const body = out.iotResponse && typeof out.iotResponse === 'object' ? out.iotResponse : null;
  const msg = body?.msg || body?.message || '';
  const accepted = body && (body.code === 200 || body.code === 10000) && body.success !== false;
  const who = (out.targets || [])
    .map((t) => `${t.room ? t.room + ' ' : ''}${t.deviceTagName || t.deviceName}（${t.cmd}）`)
    .join('、');
  if (!out.ok) return `没有发到物联网平台。${http || out.error || '请求失败'}。`;
  if (accepted) return `已下发${who ? '：' + who : ''}。平台 ${http}，已受理。`;
  return `已请求物联网平台${who ? '：' + who : ''}。平台 ${http}${msg ? '，返回「' + msg + '」' : ''}。指令没有在设备上执行。`;
}

// ---------- 会话 ----------
async function listSessions() {
  const st = await readState();
  const all = [];
  let cursor = '';
  for (let i = 0; i < 6; i++) {
    const r = await api(`/sessions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    all.push(...(r?.data || []));
    if (!r?.hasMore || !r.nextCursor) break;
    cursor = r.nextCursor;
  }
  const epochMs = Date.parse(SCENARIO.demoEpoch || '');
  return all
    .filter((s) => s.agent?.id === st.agentId && s.metadata?.scenario === SCENARIO.id
      && inDemoWindow(s.createdAt, epochMs))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

async function createSession(title) {
  const st = await bootstrap();
  return json('/sessions', 'POST', {
    agent: { id: st.agentId },
    metadata: { title: title.slice(0, 60), scenario: SCENARIO.id, demoEpoch: SCENARIO.demoEpoch || '' },
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

// 语音是二进制裸 PCM，不能按 JSON 读
async function readRawBody(req, limit = 4 * 1024 * 1024, tooBig = '音频过大（上限 4MB，约 2 分钟）') {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new Error(tooBig);
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// ---------- POST /api/asr ----------
// 浏览器按住说话采到的是 16k 单声道 16-bit 小端裸 PCM，这里原样转给百度，不做格式转换。
// 走文档推荐的裸 PCM 路径，省掉百度那侧的解码，也省掉本地的 ffmpeg。
async function handleAsr(req, res) {
  const rate = Number(req.headers['x-audio-rate'] || 16000);
  let pcm;
  try {
    pcm = await readRawBody(req);
  } catch (e) {
    return sendJson(res, 413, { error: String(e.message || e) });
  }
  try {
    const r = await asr.recognize(pcm, { rate });
    console.log(`[asr] ${pcm.length}B ${r.ms}ms :: ${r.text.slice(0, 40) || '(空)'}`);
    return sendJson(res, 200, { text: r.text, ms: r.ms, sn: r.sn });
  } catch (e) {
    console.error('[asr]', e.message);
    return sendJson(res, 400, { error: String(e.message || e) });
  }
}

// ---------- POST /api/ask ----------
async function handleAsk(req, res) {
  const { text = '', sessionId } = await readBody(req);
  const q = String(text).trim();
  if (!q) return sendJson(res, 400, { error: 'text 不能为空' });

  const st = await bootstrap();
  const sid = sessionId || (await createSession(q)).id;
  // 真实在线态写进发给模型的那一条，界面上的用户气泡仍是原话（前端按标记摘掉前缀）。
  const live = IOT_MODE === 'real'
    ? await liveDevices()
    : { ok: true, rows: DEVICES.devices, error: null };
  const modelText = turnContext(live) + q;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const toClient = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  // 卡片边推边攒，一轮收尾时整批落盘。只推不存，这几张卡回看历史时就没了
  // 执行卡里带着网关请求头，先抹掉 bearer token 再推：落盘那侧 journal.write 也会抹一次，
  // 但实时 SSE 是直接写进浏览器 Network 面板的，不在这里抹客户就能看见自家 token 的明文
  const cards = [];
  const card = (type, data) => {
    const safe = redact(data);
    cards.push({ event: type, data: safe });
    toClient(type, safe);
  };
  // 这一轮导出的文件。产物卡即时推，下载地址要等平台登记，收尾时再补推一条
  const exported = [];

  toClient('demo.session', { sessionId: sid, agentId: st.agentId, resumed: !!sessionId });
  console.log(`[ask] ${sessionId ? 'resume' : 'new'} ${sid} :: ${q.slice(0, 50)}`);

  let aborted = false;
  req.on('close', () => { aborted = true; });

  let msgId = '';
  try {
    const r = await runTurn(sid, q, (t, d) => { if (!aborted) toClient(t, d); }, modelText);
    const { complete, answer } = r;
    msgId = r.msgId;
    if (aborted) return;

    const { action, clean } = extractAction(answer);
    // 正文里带 JSON 块不好看，替换成摘掉块之后的文本。
    // 无动作的那一轮也要发：前端拿到这个覆盖才不必靠「最长的 text part」猜正文，
    // 而那个猜法会把思考过程（reasoning，通常比正文长）当成回答。
    const visible = spokenText(clean).trim();
    const sameAsAsk = visible.replace(/\s+/g, ' ') === q.replace(/\s+/g, ' ');
    if (visible && !sameAsAsk) toClient('demo.answer', { text: visible });

    // 产物卡要发在动作分支之前：整理报表那一轮没有 iot 动作，会从下面第一个分支早退。
    // 补 sessionId：runTurn 只管解析 part，不知道自己在哪个会话；前端取下载地址要用它。
    exported.push(...(r.artifacts || []).map((a) => ({ ...a, sessionId: sid })));
    for (const a of exported) card('demo.artifact', { ...a, downloadUrl: null });

    // 模型忘了附 repair.open 时，正文已经在说报修，仍然补一张跳转预览。
    // 不补的话用户只看到「可以跳到报修页」，页面上没有入口。
    const repairKindFrom = (text) => {
      const s = String(text || '');
      if (!/报修/.test(s)) return null;
      if (/进度/.test(s) && !/提交|报修单|跳/.test(s)) return 'progress';
      return 'report';
    };
    const openRepair = async (kind, summary) => {
      const which = kind === 'progress' ? 'progress' : 'report';
      const deeplink = SCENARIO.repair.deeplink[which];
      await audit.append({
        kind: 'repair.open', actor: 'app-user', sessionId: sid, level: 'L',
        decision: 'EXECUTED', trigger: 'gate-auto', reasons: ['报修引导：只给入口，不对接工单'],
        targets: [], result: 'SUCCEEDED', deeplink,
      });
      card('demo.repair', {
        kind: which,
        deeplink,
        deeplinks: SCENARIO.repair.deeplink,
        note: SCENARIO.repair.note,
        summary: String(summary || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      });
    };

    if (!action) {
      const inferred = repairKindFrom(clean);
      if (inferred) await openRepair(inferred, q);
      else {
        const note = missingCommandNote(q);
        if (note) card('demo.note', { text: note });
      }
      toClient('demo.done', { sessionId: sid, incomplete: !complete });
      return;
    }

    toClient('demo.action', { action: action.action, raw: action });

    // 报修只给 deeplink，没有副作用，不用过闸门
    if (action.action === 'repair.open') {
      const kind = action.kind === 'progress' ? 'progress' : 'report';
      await openRepair(kind, action.say || q);
      toClient('demo.done', { sessionId: sid, incomplete: !complete });
      return;
    }

    const verdict = gate.evaluate(
      { ...action, homeId: action.homeId ?? SCENARIO.iot.homeId },
      { online: await onlineForGate() },
    );
    card('demo.gate', {
      decision: verdict.decision, level: verdict.level, reasons: verdict.reasons,
      items: verdict.items, pendingId: verdict.pendingId || null,
    });

    if (verdict.decision === 'deny') {
      await audit.append({
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
    card('demo.exec', out);
    toClient('demo.done', { sessionId: sid, incomplete: !complete });
  } catch (e) {
    if (!aborted) toClient('demo.error', { message: String(e.message || e) });
  } finally {
    // 落盘放在最后：确认卡那一轮 cards 只有闸门卡，执行卡是用户点确认后才产生的，
    // 由 /api/confirm 另记一条 resolve，回放时再拼起来。
    await journal.appendTurn({ sessionId: sid, msgId, cards });
    // 补推下载地址。四条早退分支都会流到这里，写一处就够。
    // demo.done 已经发过了，这里多等几秒不会让界面卡在「思考中」；
    // 这条例外事件不进 cards，临时签名地址落盘没有意义，回放时前端自己再取一次。
    //
    // 平台侧登记是异步的，所以最多试三次；每次只拉一次 path-map（不传 path 就是该会话的全量），
    // 不要一个产物一次调用。
    for (let i = 0; i < 3 && !aborted && exported.some((a) => !a.ready); i++) {
      if (i) await new Promise((r) => setTimeout(r, 2000));
      let map;
      try { map = await artifactMap(sid); } catch { continue; }
      const vals = Object.values(map);
      for (const a of exported) {
        if (a.ready || aborted) continue;
        const v = map[a.path] || vals.find((x) => x.filename === a.filename);
        if (!v?.downloadUrl) continue;
        a.ready = true;
        try {
          toClient('demo.artifact.ready', {
            sessionId: sid, path: a.path,
            downloadUrl: v.downloadUrl, previewUrl: v.previewUrl || '', pdfUrl: v.pdfUrl || '',
            mimeType: v.mimeType || '', size: v.size ?? null,
          });
        } catch { /* 客户端已经走了，前端那个手动取的按钮兜底 */ }
      }
    }
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
  const verdict = gate.evaluate(
    { ...action, homeId: action.homeId ?? SCENARIO.iot.homeId },
    { dryRun: true, online: await onlineForGate() },
  );
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
    await audit.append(entry);
    await journal.appendResolve({ sessionId, pendingId, decision: 'reject' });
    return sendJson(res, 200, entry);
  }

  try {
    const again = gate.evaluate(rec.action, { dryRun: true, online: await onlineForGate() });
    if (again.decision === 'deny') {
      gate.settle(pendingId, 'FAILED');
      return sendJson(res, 409, { error: again.reasons.join('；') });
    }
    const out = await execute(rec, { trigger: 'gate-confirm', sessionId });
    gate.settle(pendingId, out.ok ? 'SUCCEEDED' : 'FAILED');
    // 回放时靠这条把待确认卡改成「已确认」，并补出确认后才有的那张执行卡
    await journal.appendResolve({ sessionId, pendingId, decision: 'approve', out });
    // out 里有 iotRequest.headers.Authorization。journal 和 audit 落盘前都会抹掉，
    // 这条响应是直接回给浏览器的，漏了就会让客户在自己的 Network 面板里看见自家 token。
    return sendJson(res, 200, redact(out));
  } catch (e) {
    gate.settle(pendingId, 'FAILED');
    return sendJson(res, 500, { error: String(e.message || e) });
  }
}

// ---------- 技能管理 ----------
// 技能库是整个租户共享的（含 99 个内置技能），这里的增删改动的是真实平台资源，
// 不是本地 mock。演示前想清楚再点。
async function handleSkillWrite(req, res, skillId) {
  const { url: src } = await readBody(req);
  if (!src || typeof src !== 'string') {
    return sendJson(res, 400, { error: '新建和换源都只收 JSON {url}，地址可以是 GitHub / ClawHub / BOS' });
  }
  let r;
  try {
    r = skillId ? await json(`/skills/${skillId}`, 'POST', { url: src }) : await json('/skills', 'POST', { url: src });
  } catch (e) {
    // 地址是用户自己填的，平台挑地址的毛病（4xx）不该在界面上显示成 500
    const code = e.status >= 400 && e.status < 500 ? e.status : 500;
    return sendJson(res, code, { error: e.message });
  }
  console.log(`[skills] ${skillId ? '换源' : '新建'} ${skillId || r?.id} <- ${src}`);
  dropSkillCache(skillId || r?.id);
  return sendJson(res, 200, r || {});
}

// ZIP 只在更新时收（multipart，字段名 file），新建只能给 URL。
// 这里原样转发字节和 content-type（里面带着 boundary），不重新拼 multipart。
async function handleSkillZip(req, res, skillId) {
  const ct = req.headers['content-type'] || '';
  if (!ct.startsWith('multipart/form-data')) {
    return sendJson(res, 400, { error: '要 multipart/form-data，字段名 file' });
  }
  let buf;
  try { buf = await readRawBody(req, 8 * 1024 * 1024, '技能包过大（上限 8MB）'); }
  catch (e) { return sendJson(res, 413, { error: String(e.message || e) }); }

  const up = await fetch(`${BASE}/skills/${skillId}/update`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': ct },
    body: buf,
  });
  const text = await up.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!up.ok) return sendJson(res, up.status, { error: body?.error?.message || body?.message || String(text).slice(0, 300) });
  console.log(`[skills] 传包更新 ${skillId} (${buf.length}B)`);
  dropSkillCache(skillId);
  return sendJson(res, 200, body || {});
}

// ---------- Agent 挂载 ----------
// 挂载实况以平台为准（GET /agents/{id}），不以 state.json 为准。
// 平台上的 skills 只有 ID，名字要回技能库补一次，界面上才看得懂挂了什么。
async function agentMounted(st) {
  const a = await api(`/agents/${st.agentId}`);
  const mounted = Array.isArray(a?.skills) ? a.skills : [];
  const skills = await Promise.all(mounted.map(async (s) => {
    const id = s.skillID || s.skillId || s.id || '';
    const cached = skillNameCache.get(id);
    if (cached && Date.now() - cached.at < SKILL_TTL) {
      const d = cached.rec;
      return { skillID: id, releaseID: s.releaseID || d.releaseId || '', name: d.name || id, version: d.version || '', builtin: !!d.builtin };
    }
    try {
      const d = await api(`/skills/${id}`);
      const rec = { name: d.name || id, releaseId: d.releaseId || '', version: d.version || '', builtin: !!d.builtin };
      skillNameCache.set(id, { at: Date.now(), rec });
      return { skillID: id, releaseID: s.releaseID || rec.releaseId, name: rec.name, version: rec.version, builtin: rec.builtin };
    } catch (e) {
      return { skillID: id, releaseID: s.releaseID || '', name: id, error: String(e.message || e) };
    }
  }));
  return {
    agentId: a?.id || st.agentId,
    version: a?.version ?? st.agentVersion,
    name: a?.name || '',
    description: a?.description || '',
    systemChars: (a?.system || '').length,
    files: (a?.files || []).map((f) => ({
      fileID: f.fileID,
      // 平台不回文件名，只有 fileID，名字从 state.json 里补
      name: f.name || f.filename || (st.files || []).find((x) => x.fileID === f.fileID)?.name || '',
    })),
    mcpServers: a?.mcpServers || [],
    skills,
  };
}

async function mountSkill(st, { skillID, releaseID, name, action }) {
  if (!skillID) throw new Error('skillID 必填');
  const mounted = await agentMounted(st);
  let list = mounted.skills.map((s) => ({ skillID: s.skillID, releaseID: s.releaseID, name: s.name }));
  if (action === 'remove') {
    list = list.filter((s) => s.skillID !== skillID);
  } else {
    let label = name;
    if (!label) {
      try { label = (await api(`/skills/${skillID}`)).name || skillID; } catch { label = skillID; }
    }
    list = [...list.filter((s) => s.skillID !== skillID), { skillID, releaseID: releaseID || '', name: label }];
  }
  const next = await updateAgent({ ...st, agentVersion: mounted.version }, { skills: list });
  const after = await agentMounted(next);
  // 把内存里的「场景点名技能」跟着改掉。不改的话，下一次提问时 bootstrap 会拿
  // scenario.json 那份去比，刚在界面上加挂的技能当场被撤掉。
  wantedSkills = after.skills.map((s) => ({ skillID: s.skillID, releaseID: s.releaseID, name: s.name }));
  console.log(`[agent] ${action === 'remove' ? '摘除' : '加挂'} ${skillID} → v${after.version}，现有：${after.skills.map((s) => s.name).join('/') || '(无)'}`);
  return after;
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

// ---------- 访问口令 ----------
// 部署到公网后这个地址就是一个 IoT 控制入口：拿到 URL 的人能操控客户家里 homeId 933 的设备。
// 所以线上必须带口令。没配 ACCESS_PASSWORD 时不启用，本地开发照旧。
//
// 口令本身不进 Cookie，Cookie 里放的是它的 HMAC。知道 Cookie 值反推不出口令。
const ACCESS_PASSWORD = ENV.ACCESS_PASSWORD || '';
const AUTH_COOKIE = 'arrow_auth';
const authToken = () => createHmac('sha256', ACCESS_PASSWORD).update('arrow-demo-v1').digest('hex');

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function isAuthed(req) {
  if (!ACCESS_PASSWORD) return true;
  const got = parseCookies(req)[AUTH_COOKIE] || '';
  const want = authToken();
  // 长度不等时 timingSafeEqual 会抛，先挡掉
  return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

async function handleLogin(req, res) {
  const body = await readBody(req);
  const given = String(body?.password ?? '');
  const want = ACCESS_PASSWORD;
  const ok = given.length === want.length && timingSafeEqual(Buffer.from(given), Buffer.from(want));
  if (!ok) {
    // 失败时拖一下，挡住脚本化的快速猜测。serverless 上没有进程内计数可用，够用了
    await new Promise((r) => setTimeout(r, 700));
    console.warn('[auth] 口令错误');
    return sendJson(res, 401, { error: '口令不对' });
  }
  res.setHeader('Set-Cookie',
    `${AUTH_COOKIE}=${authToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 12}`
    + (req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''));
  return sendJson(res, 200, { ok: true });
}

// ---------- 路由 ----------
function requestUrl(req) {
  const base = `http://localhost:${PORT}`;
  const direct = new URL(req.url || '/', base);
  if (direct.pathname.startsWith('/api/')) return direct;
  // 嵌套函数有时只带文件名那段，原始路径在这些头里
  const hinted = ['x-forwarded-uri', 'x-invoke-path', 'x-original-uri', 'x-vercel-original-path']
    .map((h) => req.headers?.[h])
    .find((v) => typeof v === 'string' && v.startsWith('/api/'));
  return hinted ? new URL(hinted, base) : direct;
}

export async function handler(req, res) {
  const url = requestUrl(req);
  const p = url.pathname;
  try {
    if (p === '/api/login' && req.method === 'POST') return await handleLogin(req, res);
    if (p === '/api/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
      return sendJson(res, 200, { ok: true });
    }
    // 口令门挡在所有 /api 前面。静态页不挡 —— 挡了就看不到输口令的界面了
    if (p.startsWith('/api/') && !isAuthed(req)) {
      return sendJson(res, 401, { error: '需要访问口令', needAuth: true });
    }
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
        // 场景里点名要挂的技能（名字）。挂载实况以 /api/agent 为准，这里是配置意图
        agent: {
          name: SCENARIO.agent.name,
          description: SCENARIO.agent.description,
          skills: SCENARIO.agent.skills || [],
          systemChars: SCENARIO.agent.system.length,
          systemLimit: 1000,
        },
        // 没配 ASR Key 时前端直接把麦克风置灰，不要让人按下去才看到报错
        voice: { enabled: !!ASR_KEY },
        auth: { enabled: !!ACCESS_PASSWORD },
      });
    }
    if (p === '/api/bootstrap') {
      const st = await bootstrap({ force: url.searchParams.get('force') === '1' });
      return sendJson(res, 200, { agentId: st.agentId, version: st.agentVersion, files: st.files, skills: st.skills || [] });
    }
    if (p === '/api/ask' && req.method === 'POST') return await handleAsk(req, res);
    if (p === '/api/asr' && req.method === 'POST') return await handleAsr(req, res);
    if (p === '/api/gate/simulate' && req.method === 'POST') return await handleSimulate(req, res);
    if (p === '/api/confirm' && req.method === 'POST') return await handleConfirm(req, res);

    if (p === '/api/sessions') {
      const list = await listSessions();
      return sendJson(res, 200, {
        data: list.map((s) => ({ id: s.id, title: s.metadata?.title || '(未命名)', status: s.status, createdAt: s.createdAt, updatedAt: s.updatedAt })),
      });
    }
    // 公开文档没写删除，但 DELETE /sessions/{id} 对不存在的 id 回的是 session not found，
    // 不是 405。侧栏的删除按钮走这一条，平台上的会话会真正去掉。
    const mDel = p.match(/^\/api\/sessions\/([^/]+)$/);
    if (mDel && req.method === 'DELETE') {
      await api(`/sessions/${mDel[1]}`, { method: 'DELETE' });
      return sendJson(res, 200, { ok: true });
    }
    const mHist = p.match(/^\/api\/sessions\/([^/]+)\/events$/);
    if (mHist) {
      const sid = mHist[1];
      // 事件和卡片互不依赖。卡片流水失败时仍把正文回放出来，不要整页空白。
      const [raw, cards] = await Promise.all([
        api(`/sessions/${sid}/events`),
        journal.bySession(sid).catch((e) => { console.error('[cards]', e.message); return []; }),
      ]);
      const items = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : []);
      return sendJson(res, 200, { data: slimEvents(items), cards });
    }

    // 设备面板：全部字段走真实接口，room 与品类名是本地补的显示字段
    // 曾经还并一路 demo 补充接口取开关态，列已删，那一路也撤了——真实网关没有这个接口，
    // 留着就是每次开面板都往客户平台发一个必然 404 的请求
    if (p === '/api/iot/devices') {
      const list = await liveDevices(url.searchParams.get('fresh') === '1');
      const live = list.rows || [];
      const seen = new Set();
      const rows = [];
      const push = (d, onlineStatus) => {
        if (!d?.deviceName || seen.has(d.deviceName)) return;
        seen.add(d.deviceName);
        const fix = DEVICES.devices.find((x) => x.deviceName === d.deviceName) || {};
        const code = d.categoryCode || fix.categoryCode;
        rows.push({
          deviceName: d.deviceName,
          categoryCode: code || '',
          deviceTagName: d.deviceTagName || fix.deviceTagName || '',
          onlineStatus: onlineStatus ? 1 : 0,
          room: fix.room || '',
          categoryName: CATEGORY_NAME[code] || code || '',
        });
      };
      for (const d of live) push(d, d.onlineStatus);
      // 平台列表可能只带在线设备，全离线时甚至是空数组。清单里有、这次没返回的，按离线补上。
      for (const d of DEVICES.devices) push(d, 0);
      return sendJson(res, 200, { data: rows, ok: list.ok, error: list.error || null, ms: list.ms });
    }
    // 场景列表没有对应的平台接口（文档里只有 POST /scene，没有查询），所以这一屏
    // 列的是本编排层自己建过的场景，从审计流水里取。真实平台建完场景后返回什么结构
    // 我们没有样本，所以这里只回我们确定发出去的那几个字段，不假装知道平台的回执。
    if (p === '/api/iot/scenes') {
      const epochMs = Date.parse(SCENARIO.demoEpoch || '');
      const rows = (await audit.tail(500))
        .filter((e) => inDemoWindow(e.at, epochMs) && e.kind === 'scene.create' && e.result === 'SUCCEEDED')
        .map((e) => {
          // 新记录带 scene 分列。早于这次改动的记录只有 targets（条件与动作混在一起），
          // 但条件才带 time 字段、动作从不带，所以按有没有 time 拆就是准的。
          const cond = e.scene?.conditionList ?? (e.targets || []).filter((t) => t.time);
          const act = e.scene?.actionList ?? (e.targets || []).filter((t) => !t.time);
          return {
            sceneId: e.iotResponse?.data?.sceneId || `本地记录 ${String(e.at || '').slice(11, 19)}`,
            trigger: cond.some((c) => c.time) ? 'schedule' : 'manual',
            conditionList: cond,
            actionList: act,
            at: e.at,
          };
        });
      return sendJson(res, 200, { data: rows, ok: true, error: null });
    }

    if (p === '/api/audit') {
      const limit = Number(url.searchParams.get('limit') || 100);
      const epochMs = Date.parse(SCENARIO.demoEpoch || '');
      const data = (await audit.tail(limit)).filter((e) => inDemoWindow(e.at, epochMs));
      return sendJson(res, 200, { data });
    }

    // ---- 技能管理 ----
    if (p === '/api/skills' && req.method === 'GET') {
      const page = url.searchParams.get('page') || '1';
      const pageSize = url.searchParams.get('pageSize') || '20';
      const keyword = url.searchParams.get('keyword') || '';
      // page / pageSize 都是必填，平台不给默认值；搜索参数名是 keyword，
      // name / search 会被静默忽略（total 不动），别写错
      const qs = new URLSearchParams({ page, pageSize });
      if (keyword) qs.set('keyword', keyword);
      const cacheKey = qs.toString();
      const hit = skillListCache.get(cacheKey);
      if (hit && Date.now() - hit.at < SKILL_TTL) return sendJson(res, 200, hit.body);
      const r = await api(`/skills?${qs}`);
      const body = { data: r?.data || [], total: r?.total ?? (r?.data || []).length, page: Number(page), pageSize: Number(pageSize) };
      skillListCache.set(cacheKey, { at: Date.now(), body });
      return sendJson(res, 200, body);
    }
    // 新建。没有 :id，走的是同一段处理，handleSkillWrite 按 skillId 有没有来分新建 / 换源
    if (p === '/api/skills' && req.method === 'POST') return await handleSkillWrite(req, res, '');
    // zip 要排在 /api/skills/:id 前面，否则会被那条吃掉
    const mZip = p.match(/^\/api\/skills\/([^/]+)\/zip$/);
    if (mZip && req.method === 'POST') return await handleSkillZip(req, res, mZip[1]);
    const mSkill = p.match(/^\/api\/skills\/([^/]+)$/);
    if (mSkill && req.method === 'GET') return sendJson(res, 200, await api(`/skills/${mSkill[1]}`));
    if (mSkill && req.method === 'POST') return await handleSkillWrite(req, res, mSkill[1]);
    if (mSkill && req.method === 'DELETE') {
      const r = await api(`/skills/${mSkill[1]}`, { method: 'DELETE' });
      console.log(`[skills] 删除 ${mSkill[1]}`);
      wantedSkills = null; // 缓存里可能还留着刚删掉的那个
      dropSkillCache(mSkill[1]);
      return sendJson(res, 200, r || {});
    }

    // ---- Agent 挂载 ----
    if (p === '/api/agent') {
      const st = await readState();
      if (!st.agentId) return sendJson(res, 400, { error: '还没 bootstrap，先 GET /api/bootstrap' });
      return sendJson(res, 200, await agentMounted(st));
    }
    if (p === '/api/agent/skills' && req.method === 'POST') {
      const st = await readState();
      if (!st.agentId) return sendJson(res, 400, { error: '还没 bootstrap' });
      return sendJson(res, 200, await mountSkill(st, await readBody(req)));
    }

    // ---- 生成物 ----
    if (p === '/api/artifacts') {
      const limit = Number(url.searchParams.get('limit') || 100);
      return sendJson(res, 200, { data: await listArtifacts(limit), scanned: ARTIFACT_SCAN });
    }
    if (p === '/api/artifacts/resolve') {
      const sid = url.searchParams.get('sessionId');
      const abs = url.searchParams.get('path');
      if (!sid || !abs) return sendJson(res, 400, { error: 'sessionId 和 path 都要给' });
      // path-map 的返回体是以路径为键的 map（传 path 时只有一个键），不是对象本身
      const map = await artifactMap(sid);
      const info = map[abs] || Object.values(map).find((v) => v.path === abs || v.filename === path.basename(abs)) || {};
      return sendJson(res, 200, {
        downloadUrl: info.downloadUrl || '', previewUrl: info.previewUrl || '', pdfUrl: info.pdfUrl || '',
        previewMode: info.previewMode || '', filename: info.filename || '', mimeType: info.mimeType || '',
        fileType: info.fileType || '', size: info.size ?? null,
      });
    }

    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'no such api' });
    return serveStatic(res, p);
  } catch (e) {
    console.error('[err]', e);
    if (!res.headersSent) sendJson(res, 500, { error: String(e.message || e) });
    else res.end();
  }
}

// ---------- 起服务 ----------
// Vercel 上没有常驻进程，入口是 api/[...path].mjs，它直接调上面的 handler。
// 这一段只在本地跑，不然 import 这个文件就会去 listen 一个端口。
const ON_VERCEL = !!process.env.VERCEL;

const warn = storageWarning(ENV, ON_VERCEL);
if (warn) console.warn(`\n  ⚠ ${warn}\n`);

if (!ON_VERCEL) {
  if (IOT_MODE === 'mock') {
    gateway.listen(IOT_PORT, '127.0.0.1', () => {
      console.log(`  IoT 网关（mock）  http://127.0.0.1:${IOT_PORT}   homeId=${SCENARIO.iot.homeId}   设备清单=${FIXTURE_NAME}`);
    });
    gateway.on('error', (e) => console.error('[iot] 网关启动失败', e.message));
  } else {
    console.log(`  IoT 网关（真实）  ${ENV.IOT_BASE_URL}   设备清单=${FIXTURE_NAME}`);
  }
  if (IOT_MODE === 'real' && FIXTURE_NAME === 'demo') {
    console.log('  提示：真实网关 + 演示清单。演示清单把主卫 5 台标成在线，闸门会放行，请求真发到箭牌；');
    console.log('        但真实环境这 11 台全离线，平台会回「设备离线」。设备页的在线态取自真实接口，和闸门判定不一致。');
  }
  if (IOT_MODE === 'real' && FIXTURE_NAME === 'real') {
    console.log('  提示：真实网关 + 真实清单。11 台全离线，闸门会在下发前就拦掉，请求到不了箭牌。');
  }

  const server = http.createServer(handler);

  server.listen(PORT, () => {
    console.log(`\n  ${SCENARIO.brand.product} · ${SCENARIO.brand.vendor}`);
    console.log(`  场景 ${SCENARIO.id}    配置 config/scenario.json`);
    console.log(`  → http://localhost:${PORT}`);
    console.log(`  存储 ${STATE_STORE.kind}    访问口令 ${ACCESS_PASSWORD ? '已启用' : '未启用（本地默认）'}`);
    console.log(`  DuMate API: ${BASE}\n`);
  });

  const shutdown = () => { try { gateway.close(); } catch {} ; server.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
