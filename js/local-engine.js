// 本机识别引擎的主线程一侧：管理后台线程、模型下载状态，并把识别结果整理成可读的文字

const WORKER_URL = new URL('../local-asr/worker.js', import.meta.url);
const BATCH = 2400; // 攒够 150ms 的音频再发给后台线程

// 可选的本机模型。目录对应 local-asr/models/<id>/
export const LOCAL_MODELS = {
  small: { label: '轻巧（约 60MB，速度快）', sizeMB: 60 },
  accurate: { label: '精准（约 170MB，带标点，较慢）', sizeMB: 170 },
};
export const DEFAULT_LOCAL_MODEL = 'small';

const modelDir = (id) => new URL(`../local-asr/models/${id}/`, import.meta.url).href;

const CJK = '㐀-鿿';
const CJK_PUNCT = '，。？！、；：';

// 把模型的原始输出整理成正常的中英文排版。
// style = 'raw'：模型没有标点、英文全大写；style = 'punct'：模型自带标点和大小写
export function polish(raw, style) {
  let t = (raw || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (style !== 'punct') t = t.toLowerCase().replace(/\bi\b/g, 'I');
  t = t.replace(new RegExp(`\\s+([${CJK_PUNCT},.?!;:])`, 'g'), '$1'); // 标点前不留空格
  t = t.replace(new RegExp(`([${CJK_PUNCT}])\\s+`, 'g'), '$1'); // 中文标点后不留空格
  t = t.replace(new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'g'), '$1'); // 汉字之间不留空格
  t = t.replace(new RegExp(`([${CJK}])\\s*([A-Za-z0-9])`, 'g'), '$1 $2'); // 中英之间留一个空格
  t = t.replace(new RegExp(`([A-Za-z0-9'])\\s*([${CJK}])`, 'g'), '$1 $2');
  return t;
}

// 一句说完（停顿）时补上句末标点、句首大写
export function finish(raw, style) {
  let t = polish(raw, style);
  if (!t) return '';
  if (/^[a-z]/.test(t)) t = t[0].toUpperCase() + t.slice(1);
  const last = t[t.length - 1];
  if (new RegExp(`[${CJK}]`).test(last)) t += '。';
  else if (/[A-Za-z0-9]/.test(last)) t += '.';
  else if (last === '，' || last === '、') t = t.slice(0, -1) + '。';
  else if (last === ',') t = t.slice(0, -1) + '.';
  return t;
}

class LocalEngine {
  constructor() {
    this.state = 'idle'; // idle | loading | ready | error
    this.modelId = null; // 当前加载（或正在加载）的模型
    this.style = 'raw';
    this.error = '';
    this.progress = null; // {phase, loaded, total}
    this.listeners = new Set();
    this.partials = new Map(); // 句子 id → 预览回调
    this.finals = new Map(); // 句子 id → {resolve, reject}
    this.files = new Map();
    this.batch = new Float32Array(BATCH);
    this.batchFill = 0;
    this.batchId = null;
    this.manifests = {};
  }

  get supported() {
    return typeof Worker !== 'undefined' && typeof WebAssembly === 'object' && typeof caches !== 'undefined';
  }

  // 指定的模型是否已经加载好、可以直接用
  isReady(id) {
    return this.state === 'ready' && this.modelId === id;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    this.listeners.forEach((fn) => {
      try {
        fn(this);
      } catch (e) {
        /* 忽略 */
      }
    });
  }

  async _manifest(id) {
    if (!this.manifests[id]) {
      const res = await fetch(modelDir(id) + 'manifest.json');
      if (!res.ok) throw new Error('读取模型清单失败');
      this.manifests[id] = await res.json();
    }
    return this.manifests[id];
  }

  sizeMB(id) {
    return (LOCAL_MODELS[id] || LOCAL_MODELS[DEFAULT_LOCAL_MODEL]).sizeMB;
  }

  // 模型是否已经完整下载到本机
  async isDownloaded(id) {
    try {
      const m = await this._manifest(id);
      if (!(await caches.has(m.cache))) return false;
      const cache = await caches.open(m.cache);
      for (const p of m.parts) {
        if (!(await cache.match(modelDir(id) + p.name))) return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  // 下载（如有需要）并启动引擎。可重复调用，进行中时返回同一个 Promise
  load(id) {
    if (!LOCAL_MODELS[id]) id = DEFAULT_LOCAL_MODEL;
    if (this.modelId === id) {
      if (this.state === 'ready') return Promise.resolve();
      if (this.loading) return this.loading;
    } else if (this.worker) {
      this._reset(); // 换了模型：先把旧的引擎关掉
    }
    if (!this.supported) return Promise.reject(new Error('这个浏览器不支持本机识别'));
    this.modelId = id;
    this.state = 'loading';
    this.error = '';
    this.progress = { phase: 'reading', loaded: 0, total: 0 };
    this._emit();

    const promise = new Promise((resolve, reject) => {
      const fail = (message) => {
        if (this.loading !== promise) return; // 已经被新的加载请求取代
        this._teardown();
        this.state = 'error';
        this.error = message;
        this.loading = null;
        this._emit();
        reject(new Error(message));
      };
      let worker;
      try {
        worker = new Worker(WORKER_URL);
      } catch (e) {
        setTimeout(() => fail('无法启动本机识别'), 0);
        return;
      }
      this.worker = worker;
      worker.onerror = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        if (this.state === 'loading') fail('识别引擎启动失败，可能是设备内存不足');
        else this._crashed('识别引擎意外停止，可能是设备内存不足');
      };
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.t === 'progress') {
          this.progress = m;
          this._emit();
        } else if (m.t === 'ready') {
          this.state = 'ready';
          this.style = m.style || 'raw';
          this.cached = m.cached;
          this.progress = null;
          this.loading = null;
          this._emit();
          resolve();
        } else if (m.t === 'loadError') {
          fail(m.message || '模型加载失败');
        } else {
          this._onMessage(m);
        }
      };
      worker.postMessage({ t: 'load', dir: `models/${id}/` });
    });
    this.loading = promise;
    return promise;
  }

  _onMessage(m) {
    if (m.t === 'partial') {
      const cb = this.partials.get(m.id);
      if (cb) cb(polish(m.text, this.style));
    } else if (m.t === 'final') {
      const p = this.finals.get(m.id);
      this.finals.delete(m.id);
      this.partials.delete(m.id);
      if (p) p.resolve(finish(m.text, this.style));
    } else if (m.t === 'fileProgress') {
      const f = this.files.get(m.id);
      if (f && f.onProgress) f.onProgress(m.done / m.total);
    } else if (m.t === 'fileDone') {
      const f = this.files.get(m.id);
      this.files.delete(m.id);
      if (f) f.resolve(m.segments.map((s) => finish(s, this.style)).filter(Boolean));
    } else if (m.t === 'error') {
      const p = this.finals.get(m.id) || this.files.get(m.id);
      this.finals.delete(m.id);
      this.files.delete(m.id);
      this.partials.delete(m.id);
      if (p) p.reject(new Error(m.message || '本机识别出错'));
    }
  }

  _teardown() {
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
    this.batchFill = 0;
    this.batchId = null;
  }

  _rejectAll(message) {
    const err = new Error(message);
    this.finals.forEach((p) => p.reject(err));
    this.files.forEach((p) => p.reject(err));
    this.finals.clear();
    this.files.clear();
    this.partials.clear();
  }

  _crashed(message) {
    this._teardown();
    this.state = 'error';
    this.error = message;
    this._rejectAll(message);
    this._emit();
  }

  // 关掉引擎，回到「未加载」状态（不删除已下载的模型）
  _reset() {
    this._teardown();
    this._rejectAll('识别引擎已关闭');
    this.state = 'idle';
    this.modelId = null;
    this.error = '';
    this.progress = null;
    this.loading = null;
    this._emit();
  }

  // ---------- 实时识别：一句话的生命周期 begin → push… → end ----------

  begin(id, onPartial) {
    if (this.state !== 'ready') return;
    this._flushBatch();
    this.partials.set(id, onPartial);
    this.batchId = id;
    this.worker.postMessage({ t: 'begin', id });
  }

  push(id, frame) {
    if (this.state !== 'ready' || id !== this.batchId) return;
    let off = 0;
    while (off < frame.length) {
      const take = Math.min(frame.length - off, BATCH - this.batchFill);
      this.batch.set(frame.subarray(off, off + take), this.batchFill);
      this.batchFill += take;
      off += take;
      if (this.batchFill === BATCH) this._flushBatch();
    }
  }

  _flushBatch() {
    if (!this.batchFill || this.batchId == null || !this.worker) {
      this.batchFill = 0;
      return;
    }
    const samples = this.batch.slice(0, this.batchFill);
    this.batchFill = 0;
    this.worker.postMessage({ t: 'audio', id: this.batchId, samples }, [samples.buffer]);
  }

  end(id) {
    if (this.state !== 'ready') return Promise.reject(new Error(this.error || '识别引擎还没有准备好'));
    if (id === this.batchId) {
      this._flushBatch();
      this.batchId = null;
    }
    return new Promise((resolve, reject) => {
      this.finals.set(id, { resolve, reject });
      this.worker.postMessage({ t: 'end', id });
    });
  }

  cancel(id) {
    this.partials.delete(id);
    if (id === this.batchId) {
      this.batchFill = 0;
      this.batchId = null;
    }
    if (this.state === 'ready') this.worker.postMessage({ t: 'cancel', id });
  }

  // ---------- 整段音频（16kHz 单声道采样）→ 文字 ----------

  async transcribeSamples(samples, onProgress, modelId) {
    await this.load(modelId || this.modelId || DEFAULT_LOCAL_MODEL);
    const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const copy = new Float32Array(samples);
    const segments = await new Promise((resolve, reject) => {
      this.files.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ t: 'file', id, samples: copy }, [copy.buffer]);
    });
    let out = '';
    for (const s of segments) {
      const needSpace = out && /[A-Za-z0-9.,?!]$/.test(out);
      out += (needSpace ? ' ' : '') + s;
    }
    return out;
  }

  // 删除已下载的模型；如果它正在使用，同时关闭引擎
  async remove(id) {
    if (this.modelId === id) this._reset();
    try {
      const m = await this._manifest(id);
      await caches.delete(m.cache);
    } catch (e) {
      /* 忽略 */
    }
    this._emit();
  }
}

export const localEngine = new LocalEngine();
