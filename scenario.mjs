// 场景配置加载器。换客户只改 config/scenario.json，其他文件不动。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './src/env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SCENARIO_FILE = path.join(__dirname, 'config', 'scenario.json');
export const ROOT = __dirname;

export const SCENARIO = JSON.parse(fs.readFileSync(SCENARIO_FILE, 'utf8'));

for (const k of ['id', 'brand', 'source', 'iot', 'agent', 'policy', 'starters']) {
  if (!SCENARIO[k]) throw new Error(`config/scenario.json 缺字段：${k}`);
}

// Agent 的 system 上限 1000 字符，接口会直接拒
const sysLen = (SCENARIO.agent.system || '').length;
if (sysLen > 1000) throw new Error(`agent.system 超长：${sysLen} / 1000 字符`);

// 风险等级必须是四档之一，否则闸门排序会静默出错
for (const r of SCENARIO.riskRules || []) {
  if (!['L', 'M', 'H', 'C'].includes(r.level)) throw new Error(`riskRules 里等级非法：${r.level}`);
}
for (const k of ['confirmAtOrAbove', 'denyAtOrAbove', 'defaultRiskLevel']) {
  if (!['L', 'M', 'H', 'C'].includes(SCENARIO.policy[k])) throw new Error(`policy.${k} 非法：${SCENARIO.policy[k]}`);
}
if (!SCENARIO.commands?.length) throw new Error('commands 不能为空，闸门靠它校验参数');

// 设备清单有两份，用途不同，别混：
//   demo —— 演示用。设备与真实测试家庭是同一批，另加 room 与「部分在线」的演示态。
//           真实测试家庭里 11 台全部离线，全离线就演示不出成功下发。
//   real —— 联调/验收用。从真实接口抓下来的快照，只有接口真会返回的字段，
//           没有 room（接口不返回），在线态是抓取那一刻的真值。
// 用 IOT_FIXTURE 选。先看命令行，再看 .env——
// loadEnv 只对 .env 里已声明的键做命令行覆盖，而 IOT_FIXTURE 是个纯开关、通常不写进 .env，
// 只读 loadEnv 的结果会让 `IOT_FIXTURE=real node server.mjs` 被静默忽略掉。
const ENV = loadEnv(ROOT);
const FIXTURE = (process.env.IOT_FIXTURE || ENV.IOT_FIXTURE) === 'real' ? 'real' : 'demo';
const fixtureFile = FIXTURE === 'real' ? 'iot/devices.real.json' : SCENARIO.iot.devices;
const fixturePath = path.join(ROOT, fixtureFile);
if (!fs.existsSync(fixturePath)) {
  throw new Error(
    FIXTURE === 'real'
      ? `缺少 ${fixtureFile}。先跑 node iot/fetch-devices.mjs 从真实环境抓一份。`
      : `缺少设备清单 ${fixtureFile}`,
  );
}

export const FIXTURE_NAME = FIXTURE;
export const DEVICES = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
