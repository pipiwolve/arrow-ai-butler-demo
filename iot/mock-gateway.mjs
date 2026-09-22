// 箭牌 IoT 网关 · 本地 mock
// 严格按接口文档的三个 endpoint 实现，鉴权头与响应包体结构都照抄，目的是让
// src/iot-client.mjs 走真实 HTTP，改 .env 里的 IOT_BASE_URL 就能指向箭牌测试环境。
//
//   GET  /ext/v3/ai/device-list?homeId=     设备列表
//   POST /ext/v3/ai/control                 设备控制
//   POST /ext/v3/ai/scene                   场景创建
//   GET  /ext/v3/ai/scene-list              场景列表（demo 补充，接口文档没有）
//
// 请求头（文档要求）：
//   Authorization: bearer <token>
//   appPlatform: arrow | annwa | faenza
//   ArrowDeviceSystemPlatform: 0 | 1 | 2（可选）

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_PLATFORMS = new Set(['arrow', 'annwa', 'faenza']);

const DEFAULT_FIXTURE = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'devices.json'), 'utf8'));

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// 文档里的成功码有两个：200 和 10000
const ok = (data = null) => ({ success: true, code: 200, msg: 'OK', data });
const fail = (msg, code = 500) => ({ success: false, code, msg, data: null });

function checkAuth(headers) {
  const auth = headers.authorization || '';
  if (!/^bearer\s+\S+/i.test(auth)) return '缺少或格式不对的 Authorization（应为 bearer <token>）';
  const platform = headers.appplatform;
  if (!APP_PLATFORMS.has(platform)) return `appPlatform 非法：${platform || '(空)'}，可选 arrow/annwa/faenza`;
  const dsp = headers.arrowdevicesystemplatform;
  if (dsp !== undefined && !['0', '1', '2'].includes(String(dsp))) return `ArrowDeviceSystemPlatform 非法：${dsp}`;
  return null;
}

// 校验一条 cmd 是否合法：设备存在、指令在该设备 capability 内、参数值在允许集合内
function validateCmd(state, commands, item) {
  const dev = state.get(item?.deviceName);
  if (!dev) return `设备不存在：${item?.deviceName}`;
  const spec = commands.find((c) => c.cmd === item.cmd);
  if (!spec) return `未知指令 cmd：${item.cmd}`;
  if (!dev.capability.includes(item.cmd)) return `设备 ${dev.deviceTagName} 不支持指令 ${item.cmd}`;
  // 实测真实网关对离线设备回的是「设备离线」而不是排队下发，这里照它来，
  // 否则 mock 上通过、真实环境报错，联调时白跑一轮
  if (!dev.onlineStatus) return `设备离线`;
  const allowed = spec.params[item.param];
  if (!allowed) return `指令 ${item.cmd} 没有参数 ${item.param}`;
  if (!allowed.includes(String(item.value))) return `参数值非法：${item.param}=${item.value}，可选 ${allowed.join('/')}`;
  return null;
}

// 下发一条 cmd，并更新内存态。真实网关这里是异步下发，mock 里同步生效
function applyCmd(state, item) {
  const dev = state.get(item.deviceName);
  const before = dev.status?.[item.param];
  dev.status = { ...(dev.status || {}), [item.param]: item.value };
  if (item.cmd === 'switch' || item.cmd === 'switch_valve') {
    dev.power = item.value;
    dev.onlineStatus = item.value === 'on' ? 1 : dev.onlineStatus;
  }
  if (item.cmd === 'switch_warm_air' && item.value === 'on') dev.warmAir = 'on';
  return { deviceName: item.deviceName, cmd: item.cmd, param: item.param, value: item.value, before: before ?? null };
}

const readBody = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { return null; }
};

const send = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

// fixture 由调用方注入，好让 mock 也跟着 IOT_FIXTURE 切换（demo 清单 / 真实环境快照）。
// 内存态放在这里而不是模块级：演示期间设备状态和场景会变，重启即复位。
export function createGateway({ commands, fixture = DEFAULT_FIXTURE(), log = () => {} }) {
  const state = new Map(fixture.devices.map((d) => [d.deviceName, { ...d }]));
  const scenes = [];

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const method = req.method;

    const authErr = checkAuth(req.headers);
    if (authErr) {
      log('auth', `${p} 鉴权失败：${authErr}`);
      return send(res, 401, fail(authErr, 401));
    }

    // ---- GET 设备列表 ----
    if (p === '/ext/v3/ai/device-list' && method === 'GET') {
      const homeId = url.searchParams.get('homeId');
      if (!homeId) return send(res, 400, fail('homeId 必填', 400));
      if (Number(homeId) !== fixture.homeId) return send(res, 200, ok([]));
      const data = [...state.values()].map((d) => ({
        deviceName: d.deviceName,
        categoryCode: d.categoryCode,
        deviceTagName: d.deviceTagName,
        onlineStatus: d.onlineStatus,
      }));
      log('device-list', `homeId=${homeId} 返回 ${data.length} 台`);
      return send(res, 200, ok(data));
    }

    // ---- POST 设备控制 ----
    if (p === '/ext/v3/ai/control' && method === 'POST') {
      const body = await readBody(req);
      if (!body) return send(res, 400, fail('请求体不是合法 JSON', 400));
      if (body.homeId === undefined) return send(res, 400, fail('homeId 必填', 400));
      if (!Array.isArray(body.cmdList) || !body.cmdList.length) return send(res, 400, fail('cmdList 必填且非空', 400));

      for (const item of body.cmdList) {
        const err = validateCmd(state, commands, item);
        if (err) {
          log('control', `拒绝：${err}`);
          return send(res, 200, fail(err));
        }
      }
      const applied = body.cmdList.map((it) => applyCmd(state, it));
      log('control', `下发 ${applied.length} 条：${applied.map((a) => `${a.cmd}=${a.value}`).join(', ')}`);
      return send(res, 200, ok({ applied, at: now() }));
    }

    // ---- POST 场景创建 ----
    if (p === '/ext/v3/ai/scene' && method === 'POST') {
      const body = await readBody(req);
      if (!body) return send(res, 400, fail('请求体不是合法 JSON', 400));
      if (body.homeId === undefined) return send(res, 400, fail('homeId 必填', 400));
      if (!Array.isArray(body.conditionList) || !body.conditionList.length) return send(res, 400, fail('conditionList 必填且非空', 400));
      if (!Array.isArray(body.actionList) || !body.actionList.length) return send(res, 400, fail('actionList 必填且非空', 400));

      for (const item of [...body.conditionList, ...body.actionList]) {
        const err = validateCmd(state, commands, item);
        if (err) return send(res, 200, fail(err));
      }
      // time 字段存在即为定时触发，格式 YYYY-MM-DD HH:mm:ss
      const timed = body.conditionList.filter((c) => c.time);
      const scene = {
        sceneId: 'sc_' + String(scenes.length + 1).padStart(4, '0'),
        homeId: body.homeId,
        conditionList: body.conditionList,
        actionList: body.actionList,
        trigger: timed.length ? 'schedule' : 'manual',
        at: now(),
      };
      scenes.unshift(scene);
      log('scene', `创建 ${scene.sceneId}（${scene.trigger}）`);
      return send(res, 200, ok(scene));
    }

    // ---- GET 场景列表（demo 补充接口，接口文档未提供）----
    if (p === '/ext/v3/ai/scene-list' && method === 'GET') {
      return send(res, 200, ok(scenes));
    }

    // ---- GET 设备运行态（demo 补充接口，接口文档未提供）----
    // 真实 device-list 只返回 onlineStatus，不返回开关态。这里是为了让演示面板
    // 能立刻看到「刚下发的指令生效了」，不属于对外契约。
    if (p === '/ext/v3/ai/demo-state' && method === 'GET') {
      return send(res, 200, ok([...state.values()].map((d) => ({
        deviceName: d.deviceName, onlineStatus: d.onlineStatus, power: d.power || null,
        warmAir: d.warmAir || null, status: d.status || null,
      }))));
    }

    return send(res, 404, fail(`没有这个接口：${method} ${p}`, 404));
  });
}

