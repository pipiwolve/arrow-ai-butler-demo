// 箭牌 IoT 网关客户端。按接口文档的三个接口封装，走真实 HTTP。
// 现在指向 iot/mock-gateway.mjs，把 .env 的 IOT_BASE_URL / IOT_TOKEN 换成箭牌测试环境
// 的值即可指向 https://api-uatiot.arrowgroup.com.cn，代码不用动。
// 只有文档里的这三个接口，没有旁路。

export function createIotClient({ baseUrl, token, appPlatform, deviceSystemPlatform }) {
  async function call(method, p, { query, body } = {}) {
    const url = new URL(p, baseUrl);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));

    const headers = {
      Authorization: `bearer ${token}`,
      appPlatform,
      Accept: 'application/json',
    };
    if (deviceSystemPlatform !== undefined && deviceSystemPlatform !== null) {
      headers.ArrowDeviceSystemPlatform = String(deviceSystemPlatform);
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const started = Date.now();
    let res, text;
    try {
      res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      text = await res.text();
    } catch (e) {
      return { ok: false, ms: Date.now() - started, request: { method, url: url.href, body }, error: `网关不可达：${e.message}` };
    }

    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }

    // 鉴权失败时网关不返回信封，而是一段 XML：<InvalidTokenException><error>invalid_token</error>...
    // 不特判的话，界面上只会看到「HTTP 401」加一段 XML，看不出是 token 的问题。
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false, ms: Date.now() - started,
        request: { method, url: url.href, headers, body },
        response: parsed ?? text.slice(0, 500),
        error: `鉴权失败 HTTP ${res.status}：token 无效或已过期`,
      };
    }

    // 文档：code 为 200 或 10000 才算成功，HTTP 200 也可能是业务失败。
    // 实测业务失败返回的是 code 500，msg 是「处理失败，请稍后重试。」这种笼统文案，
    // 不指出是哪个字段错了——所以给用户看的参数级提示只能由闸门出，不能指望网关。
    const bizOk = parsed && (parsed.code === 200 || parsed.code === 10000) && parsed.success !== false;
    return {
      ok: res.ok && !!bizOk,
      ms: Date.now() - started,
      request: { method, url: url.href, headers, body },
      response: parsed ?? text.slice(0, 500),
      error: res.ok && parsed && !bizOk ? `业务失败 code=${parsed.code} msg=${parsed.msg}` : (res.ok ? null : `HTTP ${res.status}`),
    };
  }

  return {
    deviceList: (homeId) => call('GET', '/ext/v3/ai/device-list', { query: { homeId } }),
    control: (homeId, cmdList) => call('POST', '/ext/v3/ai/control', { body: { homeId, cmdList } }),
    createScene: (homeId, conditionList, actionList) => call('POST', '/ext/v3/ai/scene', { body: { homeId, conditionList, actionList } }),
  };
}
