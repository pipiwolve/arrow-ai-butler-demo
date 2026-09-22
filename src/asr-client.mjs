// 百度短语音识别极速版客户端。裸 PCM 进，文本出。
// 文档：https://cloud.baidu.com/doc/SPEECH/s/4lbxdz34z
//
// 鉴权：文档只写了用 AppID/API Key/Secret Key 去 oauth/2.0/token 换 access_token 那条路，
// 但控制台发的 IAM 新式 API Key（bce-v3/ALTAK-.../...）可以直接做 Bearer，实测可用，
// 少一次换 token 的往返，也不用存 AppID。
//
// 音频要求：pcm / wav / amr / m4a，16000 Hz，16-bit，单声道，≤60 秒。
// 浏览器侧直接采 16k 单声道 PCM 发过来，走文档推荐的裸 PCM 路径，
// 省掉百度那侧的解码转换，也省掉本地的 ffmpeg。

const ENDPOINT = 'https://vop.baidu.com/pro_api';

// err_no 的码表文档里有，但没有面向用户的文案。这里按语义归并成人话，
// 让界面能分清「没配 Key」「说得太短」「环境太吵」这几种完全不同的失败。
const ERR = {
  2000: '没有识别到内容，再说一次',
  3300: '请求参数不正确',
  3301: '音频质量太差，换个安静的地方再说一次',
  3302: '鉴权失败：Key 无效或超额，也可能是采样率不是 16000',
  3303: '语音服务后端繁忙，稍后再试',
  3304: '请求太频繁，超过并发限制',
  3305: '今日调用量已用完',
  3307: '服务端识别出错',
  3308: '音频超过 60 秒',
  3309: '音频数据有问题（需 16000 Hz、单声道、16-bit、小端）',
  3310: '音频文件过大',
  3311: '采样率不支持，只认 16000 和 8000',
  3312: '音频格式不支持，只认 pcm / wav / amr',
  3314: '音频太短，按住多说一会儿',
  3316: '音频转 pcm 失败',
};

// 短于这个长度基本是误触，本地就拦掉，不浪费一次调用
const MIN_BYTES = 16000 * 2 * 0.3;

export function createAsrClient({ apiKey, devPid = 80001, cuid = 'dumate-arrow-demo' }) {
  // pcm: 16000 Hz 单声道 16-bit 小端的裸字节
  async function recognize(pcm, { rate = 16000 } = {}) {
    if (!apiKey) throw new Error('.env 里没有 ASR_API_KEY，语音输入不可用');
    if (!pcm || pcm.length < MIN_BYTES) throw new Error('录音太短，按住多说一会儿');

    const url = new URL(ENDPOINT);
    url.searchParams.set('dev_pid', String(devPid));
    url.searchParams.set('cuid', cuid);

    const started = Date.now();
    let res, text;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          // 极速版的 RAW 模式：格式与采样率写在 Content-Type 里，音频本体就是 body
          'Content-Type': `audio/pcm;rate=${rate}`,
          Authorization: `Bearer ${apiKey}`,
        },
        body: pcm,
      });
      text = await res.text();
    } catch (e) {
      throw new Error(`语音服务不可达：${e.message}`);
    }

    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    // 鉴权失败有时回非 JSON，直接看 HTTP 状态比看包体有用
    if (!parsed) throw new Error(`语音服务返回了非 JSON：HTTP ${res.status} ${text.slice(0, 200)}`);

    const errNo = parsed.err_no ?? parsed.error_code;
    if (errNo !== 0) {
      const hint = ERR[errNo] || parsed.err_msg || '未知错误';
      throw new Error(`识别失败 err_no=${errNo}：${hint}`);
    }

    return {
      text: (parsed.result || []).join('').trim(),
      ms: Date.now() - started,
      sn: parsed.sn,
    };
  }

  return { recognize };
}
