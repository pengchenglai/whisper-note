// 本机语音识别的后台线程。
// 引擎是开源项目 sherpa-onnx 的 WebAssembly 版（同目录下三个 sherpa-onnx-* 文件，未改动），
// 模型是中英双语流式模型，切成小块放在 models/<名称>/ 里。所有计算都在本机完成，不联网。

/* global createOnlineRecognizer, importScripts */

var Module = {}; // sherpa-onnx 的启动脚本会读取这个全局对象

const SAMPLE_RATE = 16000;
const BASE = new URL('./', self.location.href).href;
// 引擎启动脚本里写死的捆绑文件名
const PLACEHOLDERS = ['/encoder.onnx', '/decoder.onnx', '/joiner.onnx', '/tokens.txt', '/README.md', '/.gitignore'];

let recognizer = null;
let stream = null;
let currentId = null;
let lastText = '';
let loadedStyle = 'raw';

const post = (msg) => self.postMessage(msg);

// 把模型分块读进一整块内存；读过的分块存进浏览器缓存，下次离线也能用
async function fetchModel(manifest, dir) {
  const buf = new Uint8Array(manifest.size);
  let cache = null;
  try {
    cache = await caches.open(manifest.cache);
  } catch (e) {
    cache = null;
  }
  let offset = 0;
  let lastReport = 0;
  let cacheFailed = !cache;
  let downloaded = false;

  for (const part of manifest.parts) {
    const url = dir + part.name;
    for (let attempt = 0; ; attempt++) {
      const start = offset;
      let res = cache ? await cache.match(url) : null;
      const fromCache = !!res;
      if (!res) {
        res = await fetch(url);
        if (!res.ok) throw new Error('模型下载失败（' + res.status + '）');
        downloaded = true;
      }
      let got = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (got + value.length > part.size) {
          got += value.length;
          break;
        }
        buf.set(value, start + got);
        got += value.length;
        const now = Date.now();
        if (now - lastReport > 150) {
          lastReport = now;
          post({ t: 'progress', phase: fromCache ? 'reading' : 'downloading', loaded: start + got, total: manifest.size });
        }
      }
      if (got === part.size) {
        offset = start + got;
        if (!fromCache && cache) {
          try {
            await cache.put(
              url,
              new Response(buf.slice(start, offset), { headers: { 'Content-Type': 'application/octet-stream' } })
            );
          } catch (e) {
            cacheFailed = true; // 多半是存储空间不够；这次仍能用，下次需要重新下载
          }
        }
        break;
      }
      // 大小对不上：缓存坏了就删掉重下一次，网络传坏了就报错
      if (fromCache && cache && attempt === 0) {
        await cache.delete(url);
        continue;
      }
      throw new Error('模型文件不完整，请检查网络后重试');
    }
  }
  post({ t: 'progress', phase: 'downloading', loaded: manifest.size, total: manifest.size });
  return { buf, cacheFailed, downloaded };
}

async function load(opts) {
  if (recognizer) {
    post({ t: 'ready', cached: true, style: loadedStyle });
    return;
  }
  const dir = BASE + opts.dir; // 例如 models/small/
  const manifestRes = await fetch(dir + 'manifest.json');
  if (!manifestRes.ok) throw new Error('读取模型清单失败');
  const manifest = await manifestRes.json();
  const { buf, cacheFailed } = await fetchModel(manifest, dir);

  // 换过模型的话，把旧模型的缓存清掉，不占用户的存储空间
  try {
    for (const key of await caches.keys()) {
      if (key.startsWith('wn-local-model') && key !== manifest.cache) await caches.delete(key);
    }
  } catch (e) {
    /* 忽略 */
  }

  post({ t: 'progress', phase: 'starting' });
  let data = buf;
  // 引擎的启动脚本原本会自己去下载它捆绑的模型包。这里给它一个空包，
  // 等引擎起来之后再把我们自己下载的模型文件放进它的虚拟文件系统。
  Module.getPreloadedPackage = () => new ArrayBuffer(8);
  Module.locateFile = (path) => BASE + path;
  Module.setStatus = () => {};
  Module.print = () => {};
  Module.printErr = (s) => console.warn('[sherpa-onnx]', s);

  await new Promise((resolve, reject) => {
    Module.onRuntimeInitialized = resolve;
    Module.onAbort = (what) => reject(new Error('识别引擎启动失败：' + what));
    try {
      importScripts(BASE + 'sherpa-onnx-asr.js', BASE + 'sherpa-onnx-wasm-main-asr.js');
    } catch (e) {
      reject(e);
    }
  });

  // 空包会留下几个 0 字节的占位文件，先删掉，再放入真正的模型文件
  for (const f of PLACEHOLDERS) {
    try {
      Module.FS_unlink(f);
    } catch (e) {
      /* 忽略 */
    }
  }
  for (const f of manifest.files) {
    Module.FS_createDataFile('/', f.name, data.subarray(f.start, f.end), true, true, true);
  }

  recognizer = createOnlineRecognizer(Module, {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: './encoder.onnx', decoder: './decoder.onnx', joiner: './joiner.onnx' },
      paraformer: { encoder: '', decoder: '' },
      zipformer2Ctc: { model: '' },
      nemoCtc: { model: '' },
      toneCtc: { model: '' },
      tokens: './tokens.txt',
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
      modelType: '',
      modelingUnit: 'cjkchar',
      bpeVocab: '',
    },
    decodingMethod: 'greedy_search',
    maxActivePaths: 4,
    // 实时录音时由录音端按停顿断句；这里的断句规则只在转写整段音频文件时使用
    enableEndpoint: 1,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: (opts && opts.fileEndpointSilence) || 1.0,
    rule3MinUtteranceLength: 20,
    hotwordsFile: '',
    hotwordsScore: 1.5,
    ctcFstDecoderConfig: { graph: '', maxActive: 3000 },
    ruleFsts: '',
    ruleFars: '',
  });

  // 模型已经加载进引擎，把虚拟文件系统里的那份副本删掉，省下约 200MB 内存（对手机很重要）
  for (const f of manifest.files) {
    try {
      Module.FS_unlink('/' + f.name);
    } catch (e) {
      /* 忽略 */
    }
  }
  data = null;
  Module.getPreloadedPackage = null;

  stream = recognizer.createStream();
  loadedStyle = manifest.style || 'raw';
  post({ t: 'ready', cached: !cacheFailed, style: loadedStyle });
}

// 每一句话都从全新的识别状态开始。
// 引擎自带的 reset() 会保留上一句的上下文（为连续听写设计），
// 在中文句子后面紧跟英文句子时，会把新句子的开头带偏甚至吞掉。
function freshStream() {
  if (stream) stream.free();
  stream = recognizer.createStream();
}

function decodeAll(s) {
  while (recognizer.isReady(s)) recognizer.decode(s);
}

function onAudio(m) {
  if (m.id !== currentId) return;
  stream.acceptWaveform(SAMPLE_RATE, m.samples);
  decodeAll(stream);
  const text = recognizer.getResult(stream).text;
  if (text !== lastText) {
    lastText = text;
    post({ t: 'partial', id: m.id, text });
  }
}

function onEnd(m) {
  if (m.id !== currentId) {
    post({ t: 'final', id: m.id, text: '' });
    return;
  }
  // 补一小段静音，把模型里还没吐出来的最后几个字逼出来
  stream.acceptWaveform(SAMPLE_RATE, new Float32Array(SAMPLE_RATE * 0.5));
  decodeAll(stream);
  const text = recognizer.getResult(stream).text;
  currentId = null;
  lastText = '';
  post({ t: 'final', id: m.id, text });
}

// 转写一整段音频（导入的文件、重新转写）：用单独的识别流，不打扰正在进行的实时识别
function onFile(m) {
  let s = recognizer.createStream();
  const samples = m.samples;
  const step = SAMPLE_RATE / 2;
  const out = [];
  let lastReport = 0;
  const take = () => {
    const text = recognizer.getResult(s).text;
    if (text && text.trim()) {
      out.push(text);
      // 说完一句后换一个全新的识别状态，理由同 freshStream()
      s.free();
      s = recognizer.createStream();
    } else {
      recognizer.reset(s);
    }
  };
  for (let off = 0; off < samples.length; off += step) {
    s.acceptWaveform(SAMPLE_RATE, samples.subarray(off, Math.min(samples.length, off + step)));
    decodeAll(s);
    if (recognizer.isEndpoint(s)) take();
    const now = Date.now();
    if (now - lastReport > 300) {
      lastReport = now;
      post({ t: 'fileProgress', id: m.id, done: off, total: samples.length });
    }
  }
  s.acceptWaveform(SAMPLE_RATE, new Float32Array(SAMPLE_RATE * 0.8));
  decodeAll(s);
  take();
  s.free();
  post({ t: 'fileDone', id: m.id, segments: out });
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'load') {
    load(m).catch((err) => post({ t: 'loadError', message: String((err && err.message) || err) }));
    return;
  }
  try {
    if (!recognizer) throw new Error('识别引擎还没有准备好');
    if (m.t === 'begin') {
      freshStream();
      currentId = m.id;
      lastText = '';
    } else if (m.t === 'audio') {
      onAudio(m);
    } else if (m.t === 'end') {
      onEnd(m);
    } else if (m.t === 'cancel') {
      if (m.id === currentId) {
        currentId = null;
        lastText = '';
      }
    } else if (m.t === 'file') {
      onFile(m);
    }
  } catch (err) {
    post({ t: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
