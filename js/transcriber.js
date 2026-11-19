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

/**
 * @param {Blob} blob 音频
 * @param {{baseUrl:string, apiKey:string, model:string}} cfg
 * @param {{language?:string, vocab?:string, filename?:string, signal?:AbortSignal}} opts
 * @returns {Promise<string>} 识别出的文字（可能为空字符串）
 */
export async function transcribe(blob, cfg, opts = {}) {
  if (!cfg.apiKey) throw new TranscribeError('还没有设置 API Key', 0);
  if (!cfg.baseUrl || !cfg.model) throw new TranscribeError('转写服务设置不完整', 0);
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
