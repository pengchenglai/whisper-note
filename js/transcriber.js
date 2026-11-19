// 调用语音转文字接口（OpenAI 的 /audio/transcriptions 及兼容接口）

export class TranscribeError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'TranscribeError';
    this.status = status;
  }
}

// 记住哪些「接口 + 模型」不接受附加参数，之后只发最基本的字段
const minimalOnly = new Set();

const norm = (s) => s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

// Whisper 类模型在静音或噪音上常见的「幻觉」输出
const HALLUCINATIONS = [
  /^(谢谢|感谢)(大家)?(观看|收看)$/,
  /^(thanks|thankyou)forwatching$/,
  /amaraorg/,
  /点赞订阅/,
  /字幕by/,
  /明镜与点点/,
];

function splitVocab(vocab) {
  return (vocab || '')
    .split(/[\n,，、;；]+/)
    .map((w) => w.replace(/[<>\r\n]/g, '').trim())
    .filter(Boolean)
    .slice(0, 50);
}

// 不同模型接受的「语言提示」字段不一样，这里统一换算
function hintFields(model, language, vocab) {
  const words = splitVocab(vocab);
  const fields = [];
  let prompt = '';

  if (/^gpt-transcribe/i.test(model)) {
    // OpenAI 新模型：languages[] 可同时指定多种语言，keywords[] 传专有名词
    const langs = { mixed: ['zh', 'en'], zh: ['zh'], en: ['en'] }[language] || [];
    langs.forEach((l) => fields.push(['languages[]', l]));
    words.forEach((w) => fields.push(['keywords[]', w]));
    if (language === 'mixed') prompt = '简体中文与 English 混合的口述内容。';
    else if (language === 'zh') prompt = '简体中文口述内容。';
  } else {
    // Whisper 及早期模型：language 只能填一种，混说时留空让模型自己判断
    if (language === 'zh' || language === 'en') fields.push(['language', language]);
    if (language === 'mixed') prompt = '以下是普通话和 English 混合的句子。我们明天开个 meeting，讨论一下 project 的进度。';
    else if (language === 'zh') prompt = '以下是普通话的句子。';
    if (words.length) prompt += (prompt ? ' ' : '') + words.join(', ') + '。';
  }
  if (prompt) fields.push(['prompt', prompt]);
  return { fields, prompt };
}

function cleanText(text, prompt) {
  let t = (text || '').replace(/<\|[^|]*\|>/g, '').trim();
  if (!t) return '';
  const n = norm(t);
  if (!n) return '';
  if (HALLUCINATIONS.some((re) => re.test(n))) return '';
  // 没听清时模型偶尔会把提示语原样吐回来
  if (prompt && n.length >= 10 && norm(prompt).includes(n)) return '';
  return t;
}

async function readError(res) {
  try {
    const data = await res.json();
    const msg = (data && data.error && (data.error.message || data.error)) || data.message || '';
    return typeof msg === 'string' ? msg : JSON.stringify(msg);
  } catch (e) {
    return '';
  }
}

function friendly(status, detail) {
  const tail = detail ? `（${detail.slice(0, 160)}）` : '';
  if (status === 401 || status === 403) return 'API Key 无效或没有权限' + tail;
  if (status === 404) return '接口地址或模型名称不对' + tail;
  if (status === 413) return '音频文件太大' + tail;
  if (status === 429) return '请求太频繁或额度已用完' + tail;
  if (status >= 500) return '转写服务暂时不可用' + tail;
  return `转写失败 ${status}` + tail;
}

function extFor(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('wav')) return 'wav';
  if (t.includes('webm')) return 'webm';
  if (t.includes('ogg')) return 'ogg';
  if (t.includes('mpeg') || t.includes('mp3')) return 'mp3';
  if (t.includes('flac')) return 'flac';
  return 'mp4';
}

// ---------- 豆包（火山引擎）大模型录音文件极速版 ----------
// 协议和 OpenAI 不同：音频用 base64 放在 JSON 里，鉴权用 APP ID + Access Token 两个请求头，
// 成功与否看响应头 X-Api-Status-Code。接口只收 WAV / MP3 / OGG。

const DOUBAO_OK = '20000000';
const DOUBAO_SILENT = '20000003';
const DOUBAO_CONVERT_MAX = 8 * 1024 * 1024;

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(new TranscribeError('读取音频失败', 0));
    fr.readAsDataURL(blob);
  });
}

function wavFromSamples(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (off, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// 把 m4a / webm 等格式在本机解码成 16kHz 单声道 WAV
async function toWav16k(blob) {
  if (blob.size > DOUBAO_CONVERT_MAX) {
    throw new TranscribeError('豆包只接受 WAV / MP3 / OGG；这段录音太长，无法在手机上转换格式，请换用其他服务商转写', 0);
  }
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) throw new TranscribeError('这个浏览器无法转换音频格式', 0);
  let decoded;
  try {
    const ctx = new OAC(1, 16000, 16000);
    const data = await blob.arrayBuffer();
    decoded = await new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(data, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  } catch (e) {
    throw new TranscribeError('无法解码这个音频文件', 0);
  }
  const n = decoded.length;
  const mono = new Float32Array(n);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const ch = decoded.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += ch[i] / decoded.numberOfChannels;
  }
  return wavFromSamples(mono, decoded.sampleRate);
}

function doubaoFormat(blob, filename) {
  const hint = ((blob.type || '') + ' ' + (filename || '')).toLowerCase();
  if (/wav/.test(hint)) return 'wav';
  if (/mpeg|mp3/.test(hint)) return 'mp3';
  if (/ogg|opus/.test(hint) && !/webm/.test(hint)) return 'ogg';
  return '';
}

function doubaoMessage(code, message, httpStatus) {
  const tail = message ? `（${String(message).slice(0, 160)}）` : '';
  if (httpStatus === 401 || httpStatus === 403 || /auth|token|permission|grant|resource/i.test(message || ''))
    return 'APP ID 或 Access Token 不对，或者还没有开通「大模型录音文件极速版」' + tail;
  if (code === '45000001') return '请求参数不被接受' + tail;
  if (code === '45000002') return '音频是空的' + tail;
  if (code === '45000151') return '音频格式不对' + tail;
  if (code === '55000031') return '豆包服务繁忙，请稍后再试' + tail;
  return `豆包转写失败 ${code || httpStatus}` + tail;
}

async function transcribeDoubao(blob, cfg, opts) {
  if (!cfg.appId) throw new TranscribeError('还没有填写豆包的 APP ID', 0);
  let audio = blob;
  if (!doubaoFormat(blob, opts.filename)) audio = await toWav16k(blob);
  const data = await blobToBase64(audio);
  const requestId =
    window.crypto && crypto.randomUUID
      ? crypto.randomUUID()
      : Date.now().toString(16) + '-' + Math.random().toString(16).slice(2);

  let res;
  try {
    res = await fetch(cfg.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-App-Key': cfg.appId,
        'X-Api-Access-Key': cfg.apiKey,
        'X-Api-Resource-Id': cfg.model,
        'X-Api-Request-Id': requestId,
        'X-Api-Sequence': '-1',
      },
      body: JSON.stringify({
        user: { uid: cfg.appId },
        audio: { data },
        request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true },
      }),
      signal: opts.signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new TranscribeError('网络连接失败，请检查网络', -1);
  }

  const code = res.headers.get('X-Api-Status-Code') || '';
  const message = res.headers.get('X-Api-Message') || '';
  const body = await res.json().catch(() => ({}));
  if (code === DOUBAO_SILENT) return ''; // 这一段里没有人说话
  const ok = code ? code.startsWith('2') : res.ok;
  if (!ok) {
    // 映射成和其他服务商一致的状态，方便上层决定要不要重试
    const status = code === '55000031' ? 429 : code.startsWith('55') ? 500 : res.status >= 400 ? res.status : 400;
    throw new TranscribeError(doubaoMessage(code, message || body.message, res.status), status);
  }
  return cleanText(body.result && body.result.text, '');
}

/**
 * @param {Blob} blob 音频
 * @param {{baseUrl:string, apiKey:string, model:string}} cfg
 * @param {{language?:string, vocab?:string, filename?:string, signal?:AbortSignal}} opts
 * @returns {Promise<string>} 识别出的文字（可能为空字符串）
 */
export async function transcribe(blob, cfg, opts = {}) {
  if (!cfg.apiKey) throw new TranscribeError('还没有设置 API Key', 0);
  if (!cfg.baseUrl || !cfg.model) throw new TranscribeError('转写服务设置不完整', 0);
  if (cfg.kind === 'doubao') return transcribeDoubao(blob, cfg, opts);
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/audio/transcriptions';
  const cacheKey = url + '|' + cfg.model;
  const filename = opts.filename || 'audio.' + extFor(blob.type);
  const hints = hintFields(cfg.model, opts.language || 'mixed', opts.vocab);
  let minimal = minimalOnly.has(cacheKey) || /sensevoice|telespeech/i.test(cfg.model) || !hints.fields.length;

  for (;;) {
    const fd = new FormData();
    fd.append('file', blob, filename);
    fd.append('model', cfg.model);
    if (!minimal) hints.fields.forEach(([k, v]) => fd.append(k, v));

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + cfg.apiKey },
        body: fd,
        signal: opts.signal,
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw new TranscribeError('网络连接失败，请检查网络', -1);
    }

    if (res.ok) {
      if (minimal && hints.fields.length) minimalOnly.add(cacheKey);
      const data = await res.json().catch(() => ({}));
      return cleanText(data.text, minimal ? '' : hints.prompt);
    }
    const detail = await readError(res);
    if (res.status === 400 && !minimal) {
      // 可能是这个服务不认识附加参数，去掉再试一次
      minimal = true;
      continue;
    }
    throw new TranscribeError(friendly(res.status, detail), res.status);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 网络抖动、限流、服务端错误时自动重试
export async function transcribeWithRetry(blob, cfg, opts = {}, retries = 2) {
  for (let i = 0; ; i++) {
    try {
      return await transcribe(blob, cfg, opts);
    } catch (e) {
      const retryable = e instanceof TranscribeError && (e.status === -1 || e.status === 429 || e.status >= 500);
      if (!retryable || i >= retries) throw e;
      await sleep(1000 * Math.pow(3, i));
      if (opts.signal && opts.signal.aborted) throw e;
    }
  }
}
