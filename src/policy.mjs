// 安全闸门。需求 FR-07 / 3.4：AI 识别意图与真正下发指令之间必须有一道闸门，
// 逐层拦截越权或危险操作。模型只说「想做什么」，能不能下发由这里决定。
//
// 四道检查，顺序固定，任一道不过就停：
//   1. 意图边界    : action 是否在允许的动作集合内
//   2. 参数合法性  : 设备是否存在、指令是否在设备能力内、参数值是否在允许集合内
//   3. 权限与在线  : homeId 是否匹配、设备是否在线
//   4. 风险分级    : L/M 放行，H 二次确认，C 直接拒绝

import crypto from 'node:crypto';

const ORDER = { L: 0, M: 1, H: 2, C: 3 };
// 校验没过（设备不存在 / 参数非法 / 离线 / 无权）时给 X：它不是一个风险等级，
// 而是「这个动作根本没资格进入风险分级」。混进 L/M/H/C 会让审计看着像在分级。
const REJECTED = 'X';
const ACTIONS = new Set(['device.control', 'scene.create', 'repair.open']);

export function createGate({ scenario, devices }) {
  const byName = new Map(devices.map((d) => [d.deviceName, d]));
  const commands = new Map(scenario.commands.map((c) => [c.cmd, c]));
  const { homeId } = scenario.iot;
  const { maxTargetsPerCall, defaultRiskLevel } = scenario.policy;

  // 待确认动作表。H 级动作先落在这里，用户点确认才进执行。
  const pending = new Map();
  const TTL_MS = 5 * 60 * 1000;

  function riskOf(item) {
    for (const rule of scenario.riskRules) {
      const hit = Object.entries(rule.when).every(([k, v]) => item[k] === v);
      if (hit) return rule;
    }
    return { level: defaultRiskLevel, label: '默认等级', basis: '未命中任何高危规则' };
  }

  // 单条 cmd 的静态校验。返回 { level, label, basis } 或抛错。
  // online 是实时在线表（deviceName → boolean）。传入时以它为准，不再看清单里写死的在线列。
  function inspect(item, online) {
    if (!item || typeof item !== 'object') throw new Error('指令项不是对象');
    // 接口文档里 conditionList 的 time 是可选字段，但它挂在一个完整的设备指令上，
    // 不是独立的时间触发器。「只给 time」的写法网关会拒，先在这里说清楚缺哪个字段。
    for (const f of ['deviceName', 'cmd', 'param', 'value']) {
      if (item[f] === undefined || item[f] === null || item[f] === '') {
        throw new Error(`指令项缺少 ${f} 字段：${JSON.stringify(item)}`);
      }
    }
    const dev = byName.get(item.deviceName);
    if (!dev) throw new Error(`设备不在该家庭：${item.deviceName}`);
    const spec = commands.get(item.cmd);
    if (!spec) throw new Error(`指令不在指令表内：${item.cmd}`);
    if (!spec.appliesTo.includes(dev.categoryCode)) {
      throw new Error(`${dev.deviceTagName} 不支持指令 ${item.cmd}`);
    }
    const allowed = spec.params[item.param];
    if (!allowed) throw new Error(`指令 ${item.cmd} 没有参数 ${item.param}`);
    if (!allowed.includes(String(item.value))) {
      throw new Error(`参数值非法：${item.param}=${item.value}，可选 ${allowed.join('/')}`);
    }
    const on = online ? online.get(item.deviceName) === true : !!dev.onlineStatus;
    if (!on) throw new Error(`设备离线，无法下发：${dev.deviceTagName}${dev.room ? `（${dev.room}）` : ''}`);
    return { ...riskOf(item), spec, device: dev };
  }

  // 评估一个动作。返回 { decision, level, action, items, reasons, pendingId? }
  // dryRun 只判定不留痕：不建待确认记录。诊断调用不该让后续的 /api/confirm 有东西可领，
  // 否则审计里会混进没真实发生过的操作。
  function evaluate(action, { dryRun = false, online = null } = {}) {
    const reasons = [];
    if (!ACTIONS.has(action?.action)) {
      return { decision: 'deny', level: REJECTED, reasons: [`未授权的动作类型：${action?.action}`] };
    }
    if (Number(action.homeId ?? homeId) !== Number(homeId)) {
      return { decision: 'deny', level: REJECTED, reasons: [`homeId 不匹配：${action.homeId}，本次会话只允许 homeId=${homeId}`] };
    }

    // 判定通过后要把归一化过的 action 原样带回给调用方，它才是下发的输入。
    // 调用方不该再去碰原始入参，否则「判的是 A、发的是 B」这类错位就查不出来。
    const act = { ...action, homeId: Number(homeId) };

    // 报修与查询没有副作用，直接放行（需求 FR-05：只给入口，不打通工单）
    if (action.action === 'repair.open') {
      return { decision: 'allow', level: 'L', action: act, reasons: ['报修引导：只返回 deeplink，不下发任何设备指令'], items: [] };
    }

    const isScene = action.action === 'scene.create';
    const conds = isScene ? action.conditionList || [] : [];
    const acts = isScene ? action.actionList || [] : action.targets || [];
    if (!acts.length) return { decision: 'deny', level: REJECTED, action: act, reasons: ['动作列表为空'] };

    // 批量阈值：一次影响面超过阈值直接拒绝，不做降级确认
    if (acts.length > maxTargetsPerCall) {
      return {
        decision: 'deny', level: REJECTED, action: act,
        reasons: [`一次操作涉及 ${acts.length} 台设备，超过阈值 ${maxTargetsPerCall} 台，本期内一律拒绝`],
      };
    }

    let level = 'L';
    const items = [];
    // 分组遍历，出错时能说清是触发条件还是执行动作有问题
    const groups = isScene ? [['场景触发条件', conds], ['场景执行动作', acts]] : [['设备指令', acts]];
    for (const [groupName, list] of groups) {
      for (const item of list) {
        let info;
        try {
          info = inspect(item, online);
        } catch (e) {
          return { decision: 'deny', level: REJECTED, action: act, reasons: [`${groupName}校验未过：${e.message}`] };
        }
        if (ORDER[info.level] > ORDER[level]) level = info.level;
        if (info.level === 'H') reasons.push(`${info.label}（${info.basis}）`);
        items.push({ ...item, group: groupName, level: info.level, label: info.label, deviceTagName: info.device.deviceTagName, room: info.device.room || '' });
      }
    }

    const { confirmAtOrAbove, denyAtOrAbove } = scenario.policy;

    // 严重级直接拒绝，不降级成用户确认：批量与不可逆操作没有撤销路径，
    // 用单人确认兜底等于把风险转给用户（§5.3）
    if (ORDER[level] >= ORDER[denyAtOrAbove]) {
      return { decision: 'deny', level, action: act, reasons: reasons.length ? [...new Set(reasons)] : ['触发严重级拦截'] };
    }

    if (ORDER[level] >= ORDER[confirmAtOrAbove]) {
      const reasons2 = [...new Set(reasons)];
      if (dryRun) return { decision: 'confirm', level, action: act, reasons: reasons2, items, dryRun: true };
      const pendingId = 'pa_' + crypto.randomBytes(5).toString('hex');
      const rec = { id: pendingId, action: act, level, reasons: reasons2, items, createdAt: Date.now(), status: 'PENDING' };
      pending.set(pendingId, rec);
      return { decision: 'confirm', level, action: act, reasons: reasons2, items, pendingId };
    }

    return {
      decision: 'allow', level, action: act,
      reasons: reasons.length ? [...new Set(reasons)] : [`${level} 级操作，未达二次确认阈值，闸门放行`],
      items,
    };
  }

  // 用户点确认后把待确认动作取出来执行。只能取一次。
  function claim(pendingId) {
    const rec = pending.get(pendingId);
    if (!rec) return { ok: false, error: '待确认动作不存在或已被处理' };
    if (rec.status !== 'PENDING') return { ok: false, error: `动作已是 ${rec.status}，不能重复执行` };
    if (Date.now() - rec.createdAt > TTL_MS) {
      rec.status = 'EXPIRED';
      return { ok: false, error: '确认已超时，请重新发起' };
    }
    rec.status = 'EXECUTING';
    return { ok: true, rec };
  }

  function settle(pendingId, status) {
    const rec = pending.get(pendingId);
    if (rec) rec.status = status;
  }

  function reject(pendingId) {
    const rec = pending.get(pendingId);
    if (!rec) return { ok: false, error: '待确认动作不存在' };
    if (rec.status !== 'PENDING') return { ok: false, error: `动作已是 ${rec.status}` };
    rec.status = 'REJECTED';
    return { ok: true, rec };
  }

  return { evaluate, claim, settle, reject, inspect, riskOf };
}
