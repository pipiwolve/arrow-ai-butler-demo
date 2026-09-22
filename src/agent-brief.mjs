// 生成给 Agent 看的设备与指令清单。
//
// 为什么不在 scenario.json 里手写一份：指令表在闸门那一侧是权威（policy.mjs 拿它校验
// param 与 value），如果挂给模型的副本手写，两边迟早漂移，现场就会出现「模型给了个
// 闸门不认的值」。这里从同一份配置生成，只有一个事实来源。
//
// 实测踩到过：模型看到 capability 里有 switch_warm_air，就把 value 猜成 "1"，
// 闸门按 on/off 拒掉。清单里把允许值写全，模型就不用猜。

import fs from 'node:fs';
import path from 'node:path';

// 品类编码含义。接口文档只说「见说明文档」，并没有真的给出这张表，
// 是从 deviceTagName 反推的，属于待客户确认项——所以只用在界面显示，不参与任何判定。
export const CATEGORY_NAME = { '01': '智能坐便器', '02': '智能浴霸', '04': '智能浴缸', '06': '智能镜柜' };

export function buildBrief({ scenario, devices }) {
  const { homeId } = scenario.iot;
  // 真实清单没有 room，接口不返回房间。没有就不列这一列，
  // 免得表头挂着空栏、模型以为房间信息可用。
  const hasRoom = devices.some((d) => d.room);
  const L = [];

  L.push('# 箭牌智家 · 家庭设备与指令清单');
  L.push('');
  L.push(`本清单由系统生成，是设备的唯一事实来源。下发指令时 deviceName、cmd、param、value 必须逐字使用本文件里的值，不要改写、不要猜测、不要用别的写法。`);
  L.push('');
  L.push(`homeId = ${homeId}`);
  L.push('');
  L.push('## 设备');
  L.push('');
  L.push(hasRoom
    ? '| deviceName | 型号 | 房间 | 品类 | 在线 | 可用指令 |'
    : '| deviceName | 型号 | 品类 | 在线 | 可用指令 |');
  L.push(hasRoom
    ? '| --- | --- | --- | --- | --- | --- |'
    : '| --- | --- | --- | --- | --- |');
  for (const d of devices) {
    const cat = CATEGORY_NAME[d.categoryCode] || d.categoryCode;
    const online = d.onlineStatus ? '在线' : '离线';
    const caps = d.capability.join('、');
    L.push(hasRoom
      ? `| ${d.deviceName} | ${d.deviceTagName} | ${d.room} | ${cat} | ${online} | ${caps} |`
      : `| ${d.deviceName} | ${d.deviceTagName} | ${cat} | ${online} | ${caps} |`);
  }
  L.push('');
  if (hasRoom) {
    L.push('同一型号可能有多台（比如主卫有两台 AKB1357），用户只说型号时要先反问是哪一个房间、哪一台。');
  } else {
    L.push('这份清单里没有房间信息（接口不返回），不要按房间猜设备。用户只描述位置或型号时，把清单里可能命中的 deviceName 列出来让他确认。');
  }
  L.push('');
  L.push('## 指令');
  L.push('');
  L.push('| cmd | 参数名 | 允许的取值 | 用途 |');
  L.push('| --- | --- | --- | --- |');
  for (const c of scenario.commands) {
    for (const [param, values] of Object.entries(c.params)) {
      L.push(`| ${c.cmd} | ${param} | ${values.join(' / ')} | ${c.desc} |`);
    }
  }
  L.push('');
  L.push('要点：');
  L.push('- 开关类指令的参数名固定是 `switch`，取值只能是字符串 `on` 或 `off`。不要写 `1`、`0`、`true`、`open`。');
  L.push('- 温度类指令的参数名是 `temperature`，取值是字符串形式的数字，见上表。');
  L.push('- 温度相关的指令都属于高危操作，用户提出时正常输出结构化动作即可，是否需要二次确认由系统判断，不要自行拒绝也不要自行执行。');
  L.push('');
  L.push('## 场景');
  L.push('');
  L.push('`scene.create` 的 conditionList 是触发条件，actionList 是执行动作，两边的元素结构和设备控制完全相同：deviceName、cmd、param、value 四个字段都必填，取值同样逐字用上面的表。');
  L.push('');
  L.push('定时触发不是独立的计时器，而是在触发条件的那个设备指令上多加一个 `time` 字段，格式 `YYYY-MM-DD HH:mm:ss`。只写 `{"time": "..."}` 是不合法的条件，会被拒。');
  L.push('即时触发的场景不要带 `time` 字段。');
  L.push('');
  L.push('接口只接受一个具体时刻，没有「每天重复」这种周期写法。用户说「每天晚上 10 点」时，按最近一次的时刻下发，并在回答里说明当前只支持单次定时。');
  L.push('');

  return L.join('\n');
}

export function writeBrief({ scenario, devices, dir }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '设备与指令清单.md');
  fs.writeFileSync(file, buildBrief({ scenario, devices }));
  return file;
}
