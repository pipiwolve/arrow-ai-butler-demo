// 从箭牌真实环境抓一份设备清单，写成 iot/devices.real.json。
//
//   node iot/fetch-devices.mjs
//
// 为什么要有这个脚本而不是手抄一份：真实环境里设备会上下线、会增减，手抄的快照一旦过期，
// 联调时就会出现「闸门认得的设备、网关不认得」。重新抓一次比对着界面改文件可靠。
//
// 抓下来的字段只有接口真会返回的那四个（deviceName / categoryCode / deviceTagName /
// onlineStatus），外加从 config/scenario.json 的指令表推导出来的 capability。
// capability 是推导不是编造：它就是「这张指令表里 appliesTo 命中该品类的指令」。
// room 不写——接口不返回房间，凭空填一个房间只会让消歧逻辑看起来能用其实不能用。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIO, ROOT } from '../scenario.mjs';
import { createIotClient } from '../src/iot-client.mjs';
import { loadEnv } from '../src/env.mjs';

const ENV = loadEnv(ROOT);
const baseUrl = (ENV.IOT_BASE_URL || '').replace(/\/+$/, '');
const token = ENV.IOT_TOKEN;
const homeId = SCENARIO.iot.homeId;

if (!baseUrl || /127\.0\.0\.1|localhost/.test(baseUrl)) {
  console.error('IOT_BASE_URL 没指向真实环境（当前：' + (baseUrl || '空') + '）');
  console.error('这个脚本是抓真实清单用的，抓本地 mock 没意义。先在 .env 里填真实 Base URL。');
  process.exit(1);
}
if (!token) {
  console.error('.env 里没有 IOT_TOKEN');
  process.exit(1);
}

const iot = createIotClient({
  baseUrl,
  token,
  appPlatform: SCENARIO.iot.appPlatform,
  deviceSystemPlatform: SCENARIO.iot.deviceSystemPlatform,
});

const res = await iot.deviceList(homeId);
if (!res.ok) {
  console.error('抓取失败：' + res.error);
  console.error(JSON.stringify(res.response, null, 2));
  process.exit(1);
}

const rows = res.response.data || [];
const devices = rows.map((d) => ({
  deviceName: d.deviceName,
  categoryCode: d.categoryCode,
  deviceTagName: d.deviceTagName,
  onlineStatus: d.onlineStatus,
  capability: SCENARIO.commands.filter((c) => c.appliesTo.includes(d.categoryCode)).map((c) => c.cmd),
}));

const out = {
  _note: `真实环境快照，由 iot/fetch-devices.mjs 生成，勿手改。baseUrl=${baseUrl} homeId=${homeId} 抓取时间=${new Date().toISOString()}`,
  _warning: '这份清单只有接口真会返回的字段。没有 room，接口不返回房间；onlineStatus 是抓取那一刻的真值。',
  homeId,
  devices,
};

const file = path.join(ROOT, 'iot', 'devices.real.json');
fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');

const online = devices.filter((d) => d.onlineStatus === 1).length;
console.log(`写入 ${path.relative(ROOT, file)}：${devices.length} 台设备，其中在线 ${online} 台`);
console.log(`耗时 ${res.ms} ms`);
const cats = [...new Set(devices.map((d) => d.categoryCode))].sort();
console.log('品类编码：' + cats.join(' / '));
if (!online) console.log('注意：这次一台在线的都没有，闸门会拦下所有控制指令。');
