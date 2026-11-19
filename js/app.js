// 界面：笔记列表 / 录音 / 笔记详情 / 设置

import * as db from './db.js';
import { loadSettings, saveSettings, activeConfig, isConfigured, PRESETS } from './settings.js';
import { transcribe } from './transcriber.js';
import { Session, separator, uid, isIOS } from './session.js';
import { encodeWav } from './recorder.js';

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');
const MAX_UPLOAD = 25 * 1024 * 1024;

let session = null;
let cleanup = null; // 离开当前页面时要做的收尾
let renderSeq = 0;

// ---------- 小工具 ----------

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pad = (n) => String(n).padStart(2, '0');

function fmtDur(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (h ? h + ':' + pad(m) : pad(m)) + ':' + pad(s % 60);
}

function fmtDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const time = pad(d.getHours()) + ':' + pad(d.getMinutes());
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return '今天 ' + time;
  if (diff === 1) return '昨天 ' + time;
  const md = d.getMonth() + 1 + '月' + d.getDate() + '日 ' + time;
  return d.getFullYear() === now.getFullYear() ? md : d.getFullYear() + '年' + md;
}

function countWords(text) {
  const cjk = (text.match(/[㐀-鿿]/g) || []).length;
  const en = (text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
  return cjk + en;
}

function noteTitle(n) {
  if (n.title) return n.title;
  const first = (n.text || '').trim().split('\n')[0];
  return first ? first.slice(0, 28) : '新录音';
}

let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function busy(msg) {
  let el = $('#busy');
  if (!msg) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = 'busy';
    el.innerHTML = '<div class="busy-card"><div class="spinner"></div><div class="busy-text"></div></div>';
    document.body.appendChild(el);
  }
  $('.busy-text', el).textContent = msg;
}

// 底部弹出的操作菜单
function sheet(items) {
  const el = document.createElement('div');
  el.className = 'sheet-backdrop';
  el.innerHTML =
    '<div class="sheet">' +
    items.map((it, i) => `<button class="sheet-item${it.danger ? ' danger' : ''}" data-i="${i}">${esc(it.label)}</button>`).join('') +
    '<button class="sheet-item cancel" data-i="-1">取消</button></div>';
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('.sheet-item');
    if (!btn && e.target !== el) return;
    el.remove();
    const i = btn ? Number(btn.dataset.i) : -1;
    if (i >= 0) items[i].run();
  });
  document.body.appendChild(el);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e2) {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

// 优先走系统分享面板（iPhone 上可以「存储到文件」），不支持时退回普通下载
async function saveFile(blob, filename) {
  try {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function audioExt(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('webm')) return 'webm';
  if (t.includes('wav')) return 'wav';
  if (t.includes('mpeg') || t.includes('mp3')) return 'mp3';
  if (t.includes('ogg')) return 'ogg';
  return 'm4a';
}

function safeName(s) {
  return (s || 'note').replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 40) || 'note';
}

const ICON = {
  mic: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2.5" width="6" height="12" rx="3" fill="currentColor" stroke="none"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5"/></svg>',
  gear: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  back: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><rect x="6" y="5" width="4.2" height="14" rx="1.2"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.2"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M8 5.2v13.6a1 1 0 0 0 1.5.9l11-6.8a1 1 0 0 0 0-1.8l-11-6.8A1 1 0 0 0 8 5.2z"/></svg>',
  file: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4M8 8l4-4 4 4M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/></svg>',
};

// ---------- 路由 ----------

function route() {
  if (cleanup) {
    try {
      cleanup();
    } catch (e) {
      /* 忽略 */
    }
    cleanup = null;
  }
  const seq = ++renderSeq;
  const h = location.hash.replace(/^#/, '') || '/';
  window.scrollTo(0, 0);
  if (h.startsWith('/note/')) return renderNote(decodeURIComponent(h.slice(6)), seq);
  if (h === '/settings') return renderSettings();
  return renderList(seq);
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

// ---------- 列表页 ----------

async function renderList(seq) {
  const settings = loadSettings();
  let notes = [];
  try {
    notes = await db.listNotes();
  } catch (e) {
    toast('读取笔记失败：浏览器可能禁用了本地存储');
  }
  if (seq !== renderSeq) return;

  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const showInstall = isIOS && !standalone && !localStorage.getItem('wn.hideInstallTip');

  app.innerHTML = `
  <div class="view list-view">
    <header class="topbar">
      <h1>Whisper Note</h1>
      <button class="icon-btn" id="btn-settings" aria-label="设置">${ICON.gear}</button>
    </header>
    <main class="content">
      ${
        isConfigured(settings)
          ? ''
          : `<button class="banner" id="banner-setup"><b>还差一步：设置转写服务</b><span>填入 API Key 后，录音才能实时转成文字。点这里去设置 ›</span></button>`
      }
      ${
        showInstall
          ? `<div class="banner tip" id="banner-install"><b>装到主屏幕</b><span>点 Safari 底部的「分享」按钮，选「添加到主屏幕」，就能像 App 一样全屏使用。</span><button class="banner-close" id="install-close" aria-label="关闭">×</button></div>`
          : ''
      }
      ${notes.length > 4 ? `<input type="search" id="q" class="search" placeholder="搜索笔记" autocomplete="off">` : ''}
      <ul class="notes" id="notes"></ul>
    </main>
    <footer class="dock">
      <button class="dock-side" id="btn-import">${ICON.file}<span>导入音频</span></button>
      <button class="rec-btn" id="btn-rec" aria-label="开始录音">${ICON.mic}</button>
      <div class="dock-side"></div>
    </footer>
    <input type="file" id="file" hidden accept="audio/*,video/mp4,video/quicktime,.m4a,.mp3,.wav,.aac,.flac,.ogg,.webm,.mp4">
  </div>`;

  const listEl = $('#notes');
  const draw = (q) => {
    const kw = (q || '').trim().toLowerCase();
    const shown = kw ? notes.filter((n) => (noteTitle(n) + '\n' + (n.text || '')).toLowerCase().includes(kw)) : notes;
    if (!shown.length) {
      listEl.innerHTML = kw
        ? `<li class="empty">没有找到包含「${esc(q)}」的笔记</li>`
        : `<li class="empty"><div class="empty-title">还没有笔记</div>点下面的红色按钮开始录音，<br>说的话会实时变成文字。</li>`;
      return;
    }
    listEl.innerHTML = shown
      .map((n) => {
        const body = (n.text || '').trim().replace(/\s+/g, ' ');
        const title = noteTitle(n);
        const snippet = n.title ? body : body.slice(title.length);
        return `<li><a class="note-card" href="#/note/${encodeURIComponent(n.id)}">
          <div class="note-title">${esc(title)}</div>
          ${snippet ? `<div class="note-snippet">${esc(snippet.slice(0, 90))}</div>` : ''}
          <div class="note-meta">${fmtDate(n.createdAt)}${n.duration ? ' · ' + fmtDur(n.duration) : ''}${n.text ? '' : ' · 仅录音'}</div>
        </a></li>`;
      })
      .join('');
  };
  draw('');

  const q = $('#q');
  if (q) q.addEventListener('input', () => draw(q.value));
  $('#btn-settings').addEventListener('click', () => go('#/settings'));
  const setup = $('#banner-setup');
  if (setup) setup.addEventListener('click', () => go('#/settings'));
  const closeTip = $('#install-close');
  if (closeTip)
    closeTip.addEventListener('click', () => {
      localStorage.setItem('wn.hideInstallTip', '1');
      $('#banner-install').remove();
    });
  $('#btn-rec').addEventListener('click', startRecording);
  const fileInput = $('#file');
  $('#btn-import').addEventListener('click', () => {
    if (!isConfigured(loadSettings())) {
      toast('请先在设置里填好转写服务');
      return;
    }
    fileInput.click();
  });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (f) importFile(f);
  });
}

function probeDuration(blob) {
  return new Promise((resolve) => {
    const a = document.createElement('audio');
    const url = URL.createObjectURL(blob);
    const done = (v) => {
      URL.revokeObjectURL(url);
      resolve(isFinite(v) && v > 0 ? v : 0);
    };
    const timer = setTimeout(() => done(0), 4000);
    a.preload = 'metadata';
    a.onloadedmetadata = () => {
      clearTimeout(timer);
      done(a.duration);
    };
    a.onerror = () => {
      clearTimeout(timer);
      done(0);
    };
    a.src = url;
  });
}

async function importFile(file) {
  const settings = loadSettings();
  if (file.size > MAX_UPLOAD) {
    toast('文件超过 25MB，转写服务不接受。请先压缩或剪短。', 4500);
    return;
  }
  const note = {
    id: uid(),
    title: file.name.replace(/\.[^.]+$/, ''),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    duration: 0,
    text: '',
    hasAudio: false,
    audioType: file.type,
    audioName: file.name,
  };
  busy('正在转写「' + file.name + '」，长录音需要等一会儿…');
  try {
    try {
      await db.putAudio(note.id, file);
      note.hasAudio = true;
      note.audioSize = file.size;
    } catch (e) {
      /* 存不下音频时仍然保留文字 */
    }
    note.duration = await probeDuration(file);
    await db.putNote(note);
    note.text = await transcribe(file, activeConfig(settings), {
      language: settings.language,
      vocab: settings.vocab,
      filename: file.name,
    });
    note.updatedAt = Date.now();
    await db.putNote(note);
    if (!note.text) toast('转写完成，但没有识别到语音');
  } catch (e) {
    toast('转写失败：' + ((e && e.message) || e), 5000);
  } finally {
    busy(null);
  }
  go('#/note/' + encodeURIComponent(note.id));
}

// ---------- 录音界面 ----------

const BARS = 36;
let recUI = null;

function micErrorMessage(e) {
  const name = e && e.name;
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return '没有麦克风权限。请在系统「设置 › Safari › 麦克风」里允许，或在弹窗里点「允许」。';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '没有找到可用的麦克风';
  if (name === 'NotReadableError') return '麦克风正被其他应用占用';
  return '无法开始录音：' + ((e && e.message) || name || '未知错误');
}

async function startRecording() {
  if (session) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast(window.isSecureContext ? '这个浏览器不支持录音' : '需要通过 https 网址打开才能使用麦克风', 4500);
    return;
  }
  const settings = loadSettings();
  session = new Session(settings, {
    onUpdate: () => recUI && recUI.drawText(),
    onLevel: (rms) => recUI && recUI.level(rms),
    onState: () => recUI && recUI.drawState(),
    onNotice: (msg) => toast(msg, 4000),
    onForceStop: () => finishRecording(),
  });
  openRecorder();
  try {
    await session.start();
  } catch (e) {
    closeRecorder();
    session = null;
    toast(micErrorMessage(e), 5500);
  }
}

function openRecorder() {
  const el = document.createElement('div');
  el.className = 'recorder';
  el.innerHTML = `
    <header class="rec-top">
      <button class="text-btn" id="rec-discard">丢弃</button>
      <div class="rec-status"><span class="dot"></span><span id="rec-state">正在启动麦克风…</span></div>
      <div class="rec-time" id="rec-time">00:00</div>
    </header>
    <button class="rec-banner" id="rec-banner" hidden></button>
    <div class="transcript" id="rec-text"></div>
    <div class="meter" id="rec-meter">${'<i></i>'.repeat(BARS)}</div>
    <div class="rec-controls">
      <button class="round-btn" id="rec-pause" aria-label="暂停">${ICON.pause}</button>
      <button class="stop-btn" id="rec-stop" aria-label="完成并保存"><span></span></button>
      <div class="round-btn ghost"></div>
    </div>
    <div class="rec-hint" id="rec-hint">点红色按钮完成并保存</div>`;
  document.body.appendChild(el);
  document.body.classList.add('recording');

  const textEl = $('#rec-text', el);
  const bars = Array.from($('#rec-meter', el).children);
  const levels = new Array(BARS).fill(0);
  let peak = 0;
  let stick = true; // 用户没往上翻时，自动滚到最新一行
  textEl.addEventListener('scroll', () => {
    stick = textEl.scrollHeight - textEl.scrollTop - textEl.clientHeight < 60;
  });

  const meterTimer = setInterval(() => {
    levels.push(session && session.state === 'recording' ? peak : 0);
    levels.shift();
    peak = 0;
    for (let i = 0; i < BARS; i++) bars[i].style.transform = `scaleY(${Math.max(0.06, levels[i]).toFixed(3)})`;
  }, 70);
  const clockTimer = setInterval(() => {
    if (session) $('#rec-time', el).textContent = fmtDur(session.elapsed);
  }, 250);

  recUI = {
    el,
    level(rms) {
      const v = Math.min(1, Math.sqrt(rms) * 2.4);
      if (v > peak) peak = v;
    },
    drawState() {
      const st = session.state;
      el.dataset.state = st;
      $('#rec-state', el).textContent =
        { starting: '正在启动麦克风…', recording: '录音中', paused: '已暂停', stopping: '正在完成转写…', stopped: '已结束' }[st] || '';
      const pauseBtn = $('#rec-pause', el);
      pauseBtn.innerHTML = st === 'paused' ? ICON.play : ICON.pause;
      pauseBtn.setAttribute('aria-label', st === 'paused' ? '继续' : '暂停');
      const frozen = st === 'starting' || st === 'stopping' || st === 'stopped';
      pauseBtn.disabled = frozen;
      $('#rec-stop', el).disabled = st === 'stopping' || st === 'stopped';
      $('#rec-hint', el).textContent = st === 'stopping' ? '请稍候，正在转写最后几句…' : '点红色按钮完成并保存';
    },
    drawText() {
      let html = '';
      let prev = '';
      let lastEnd = null;
      for (const e of session.entries) {
        let cls;
        let text;
        if (e.status === 'done') {
          if (!e.text) continue;
          cls = 'done';
          text = e.text;
        } else if (e.status === 'error') {
          cls = 'err';
          text = '［这一句转写失败］';
        } else if (e.status === 'skipped') {
          continue;
        } else {
          cls = 'live';
          text = e.preview || '…';
        }
        const sep = separator(prev, text, lastEnd != null && e.t0 - lastEnd >= 3);
        html += (sep === '\n' ? '<br>' : sep) + `<span class="${cls}">${esc(text)}</span>`;
        prev = text;
        lastEnd = e.t1;
      }
      if (!html) {
        html = `<p class="placeholder">${
          session.canTranscribe ? '开始说话，文字会实时出现在这里…<br>中文、English 或者混着说都可以。' : '正在录音。<br>还没有设置转写服务，所以这次只保存录音，不会出文字。'
        }</p>`;
      }
      textEl.innerHTML = html;
      if (stick) textEl.scrollTop = textEl.scrollHeight;

      const banner = $('#rec-banner', el);
      if (session.hasErrors) {
        banner.hidden = false;
        banner.textContent = (session.lastError || '部分句子转写失败') + ' — 点这里重试';
      } else {
        banner.hidden = true;
      }
    },
    destroy() {
      clearInterval(meterTimer);
      clearInterval(clockTimer);
      el.remove();
      document.body.classList.remove('recording');
    },
  };

  $('#rec-pause', el).addEventListener('click', () => {
    if (!session) return;
    if (session.state === 'recording') session.pause();
    else if (session.state === 'paused') session.resume();
  });
  $('#rec-stop', el).addEventListener('click', finishRecording);
  $('#rec-banner', el).addEventListener('click', () => session && session.retryFailed());
  $('#rec-discard', el).addEventListener('click', async () => {
    if (!session) return;
    if (session.elapsed > 3 && !confirm('丢弃这次录音？录音和文字都不会保存。')) return;
    const s = session;
    session = null;
    closeRecorder();
    await s.discard();
    route();
  });

  recUI.drawState();
  recUI.drawText();
}

function closeRecorder() {
  if (recUI) recUI.destroy();
  recUI = null;
}

async function finishRecording() {
  const s = session;
  if (!s || s.state === 'stopping' || s.state === 'stopped') return;
  let note = null;
  try {
    note = await s.stop();
  } catch (e) {
    toast('保存失败：' + ((e && e.message) || e), 5000);
  }
  if (session !== s) return; // 期间被丢弃了
  const failed = s.hasErrors;
  session = null;
  closeRecorder();
  if (note) {
    if (failed) toast('有几句没转写成功，可以在笔记里点「重新转写」', 4500);
    go('#/note/' + encodeURIComponent(note.id));
  } else {
    toast('没有录到内容，未保存');
    route();
  }
}

// ---------- 笔记详情 ----------

async function renderNote(id, seq) {
  const note = await db.getNote(id).catch(() => null);
  if (seq !== renderSeq) return;
  if (!note) {
    go('#/');
    return;
  }
  let audioBlob = null;
  if (note.hasAudio) audioBlob = await db.getAudio(id).catch(() => null);
  if (seq !== renderSeq) return;
  const audioUrl = audioBlob ? URL.createObjectURL(audioBlob) : '';

  app.innerHTML = `
  <div class="view note-view">
    <header class="topbar">
      <button class="icon-btn" id="back" aria-label="返回">${ICON.back}</button>
      <div class="topbar-title">${fmtDate(note.createdAt)}</div>
      <button class="icon-btn" id="del" aria-label="删除">${ICON.trash}</button>
    </header>
    <main class="content">
      <input class="title-input" id="title" placeholder="标题" value="${esc(note.title)}" maxlength="80" enterkeyhint="done">
      <div class="meta" id="meta"></div>
      ${audioUrl ? `<audio class="player" controls preload="metadata" src="${audioUrl}"></audio>` : ''}
      <textarea class="body-input" id="text" placeholder="（没有文字。可以直接在这里输入，或点下面的「重新转写」）"></textarea>
    </main>
    <footer class="actionbar">
      <button id="copy">复制</button>
      <button id="share">分享</button>
      <button id="export">导出</button>
      <button id="redo"${audioBlob ? '' : ' disabled'}>重新转写</button>
    </footer>
  </div>`;

  const ta = $('#text');
  const titleEl = $('#title');
  const metaEl = $('#meta');
  ta.value = note.text || '';
  const fit = () => {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 2 + 'px';
  };
  const drawMeta = () => {
    const parts = [];
    if (note.duration) parts.push('时长 ' + fmtDur(note.duration));
    parts.push(countWords(ta.value) + ' 字');
    metaEl.textContent = parts.join(' · ');
  };
  fit();
  drawMeta();

  let dirty = false;
  let saveTimer;
  const save = async () => {
    clearTimeout(saveTimer);
    if (!dirty) return;
    dirty = false;
    note.title = titleEl.value.trim();
    note.text = ta.value;
    note.updatedAt = Date.now();
    try {
      await db.putNote(note);
    } catch (e) {
      toast('保存失败');
    }
  };
  const touch = () => {
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 600);
  };
  ta.addEventListener('input', () => {
    fit();
    drawMeta();
    touch();
  });
  titleEl.addEventListener('input', touch);
  titleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') titleEl.blur();
  });
  const onHide = () => save();
  window.addEventListener('pagehide', onHide);
  document.addEventListener('visibilitychange', onHide);

  let deleted = false;
  cleanup = () => {
    window.removeEventListener('pagehide', onHide);
    document.removeEventListener('visibilitychange', onHide);
    if (!deleted) save();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  };

  $('#back').addEventListener('click', () => go('#/'));
  $('#del').addEventListener('click', async () => {
    if (!confirm('删除这条笔记？录音和文字都会删除，无法恢复。')) return;
    deleted = true;
    await db.deleteNote(id);
    toast('已删除');
    go('#/');
  });
  $('#copy').addEventListener('click', async () => {
    if (!ta.value) return toast('没有可复制的文字');
    toast((await copyText(ta.value)) ? '已复制全部文字' : '复制失败，请长按文字手动复制');
  });
  $('#share').addEventListener('click', async () => {
    if (!ta.value) return toast('没有可分享的文字');
    if (navigator.share) {
      try {
        await navigator.share({ title: noteTitle(note), text: ta.value });
      } catch (e) {
        /* 用户取消 */
      }
    } else {
      toast((await copyText(ta.value)) ? '这个浏览器不支持分享，已复制到剪贴板' : '这个浏览器不支持分享');
    }
  });
  $('#export').addEventListener('click', () => {
    const base = safeName(titleEl.value.trim() || noteTitle(note));
    const items = [
      {
        label: '导出文字（.txt）',
        run: () => (ta.value ? saveFile(new Blob([ta.value], { type: 'text/plain;charset=utf-8' }), base + '.txt') : toast('没有文字可导出')),
      },
    ];
    if (audioBlob) {
      items.push({
        label: '导出录音文件',
        run: () => saveFile(audioBlob, note.audioName || base + '.' + audioExt(audioBlob.type)),
      });
    }
    sheet(items);
  });
  $('#redo').addEventListener('click', async () => {
    const settings = loadSettings();
    if (!audioBlob) return;
    if (!isConfigured(settings)) return toast('请先在设置里填好转写服务');
    if (audioBlob.size > MAX_UPLOAD) return toast('录音超过 25MB，无法整段重新转写', 4000);
    if (ta.value.trim() && !confirm('用整段录音重新转写，并替换现在的文字？')) return;
    busy('正在重新转写整段录音…');
    try {
      const text = await transcribe(audioBlob, activeConfig(settings), {
        language: settings.language,
        vocab: settings.vocab,
        filename: note.audioName || undefined,
      });
      if (seq !== renderSeq) return;
      if (!text) {
        toast('没有识别到语音，原文字保持不变');
        return;
      }
      ta.value = text;
      fit();
      drawMeta();
      dirty = true;
      await save();
      toast('已重新转写');
    } catch (e) {
      toast('转写失败：' + ((e && e.message) || e), 5000);
    } finally {
      busy(null);
    }
  });
}

// ---------- 设置 ----------

function renderSettings() {
  const s = loadSettings();
  const preset = PRESETS[s.provider];
  const cfg = activeConfig(s);
  const isCustom = s.provider === 'custom';
  const modelOptions = preset.models.slice();
  if (cfg.model && !modelOptions.includes(cfg.model)) modelOptions.push(cfg.model);
  const opt = (value, label, current) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;

  app.innerHTML = `
  <div class="view settings-view">
    <header class="topbar">
      <button class="icon-btn" id="back" aria-label="返回">${ICON.back}</button>
      <div class="topbar-title">设置</div>
      <span class="icon-btn ghost"></span>
    </header>
    <main class="content">
      <section class="group">
        <h2>转写服务</h2>
        <label class="field"><span>服务商</span>
          <select id="s-provider">${Object.keys(PRESETS).map((k) => opt(k, PRESETS[k].label, s.provider)).join('')}</select>
        </label>
        ${
          isCustom
            ? `<label class="field"><span>接口地址</span><input id="s-base" type="url" inputmode="url" placeholder="https://example.com/v1" value="${esc(s.customBaseUrl)}" autocapitalize="off" autocorrect="off" spellcheck="false"></label>`
            : ''
        }
        <label class="field"><span>API Key</span>
          <input id="s-key" type="password" placeholder="粘贴你的 Key" value="${esc(s.keys[s.provider] || '')}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
        </label>
        <label class="field"><span>模型</span>
          ${
            isCustom
              ? `<input id="s-model-text" type="text" placeholder="例如 whisper-large-v3" value="${esc(cfg.model)}" autocapitalize="off" autocorrect="off" spellcheck="false">`
              : `<select id="s-model">${modelOptions.map((m) => opt(m, m, cfg.model)).join('')}<option value="__other__">其他模型…</option></select>`
          }
        </label>
        <p class="help">Key 只保存在这台设备上，录音时只会直接发给你选的服务商。${
          preset.keyUrl ? `<a href="${preset.keyUrl}" target="_blank" rel="noopener">去申请 Key ›</a>` : ''
        }</p>
        <button class="btn" id="s-test">测试连接</button>
        <p class="help" id="s-test-result"></p>
      </section>

      <section class="group">
        <h2>识别</h2>
        <label class="field"><span>语言</span>
          <select id="s-lang">
            ${opt('mixed', '中英混合（推荐）', s.language)}
            ${opt('zh', '中文', s.language)}
            ${opt('en', 'English', s.language)}
            ${opt('auto', '自动检测', s.language)}
          </select>
        </label>
        <label class="field"><span>专有名词</span>
          <textarea id="s-vocab" rows="2" placeholder="人名、产品名、术语，用逗号分隔。例如：Claude, 鸿蒙, Kubernetes">${esc(s.vocab)}</textarea>
        </label>
        <p class="help">填上常说但容易被听错的词，识别会更准。</p>
      </section>

      <section class="group">
        <h2>录音</h2>
        <label class="field switch"><span>边说边预览<small>说话过程中先显示灰色的临时文字</small></span>
          <input id="s-interim" type="checkbox"${s.interim ? ' checked' : ''}>
        </label>
        <label class="field"><span>断句速度</span>
          <select id="s-pause">
            ${opt('500', '快（停顿 0.5 秒就出字）', String(s.pauseMs))}
            ${opt('800', '标准（0.8 秒）', String(s.pauseMs))}
            ${opt('1200', '慢（1.2 秒，适合边想边说）', String(s.pauseMs))}
          </select>
        </label>
        <label class="field"><span>麦克风灵敏度</span>
          <select id="s-sens">
            ${opt('high', '高（安静环境、小声说话）', s.sensitivity)}
            ${opt('medium', '标准', s.sensitivity)}
            ${opt('low', '低（环境比较吵）', s.sensitivity)}
          </select>
        </label>
      </section>

      <section class="group about">
        <h2>说明</h2>
        <p>笔记和录音都只保存在这台设备的浏览器里，不会同步到其他设备；清除网站数据或删除主屏幕图标会一并清掉，重要内容请及时导出。</p>
        <p>录音时请保持屏幕亮着、停留在本应用内。iPhone 锁屏或切到其他 App 时，系统会暂停网页的麦克风。</p>
        <p><b>装到手机桌面：</b>iPhone 用 Safari 打开 → 分享 → 添加到主屏幕；安卓 / 鸿蒙用浏览器菜单里的「添加到主屏幕」或「安装应用」；Mac 用 Safari 的「文件 › 添加到程序坞」。</p>
      </section>
    </main>
  </div>`;

  const update = (fn, rerender) => {
    const cur = loadSettings();
    fn(cur);
    saveSettings(cur);
    if (rerender) {
      const y = window.scrollY;
      renderSettings();
      window.scrollTo(0, y);
    }
  };

  $('#back').addEventListener('click', () => go('#/'));
  $('#s-provider').addEventListener('change', (e) => update((c) => (c.provider = e.target.value), true));
  $('#s-key').addEventListener('input', (e) => update((c) => (c.keys[c.provider] = e.target.value.trim())));
  if (isCustom) {
    $('#s-base').addEventListener('input', (e) => update((c) => (c.customBaseUrl = e.target.value.trim())));
    $('#s-model-text').addEventListener('input', (e) => update((c) => (c.models.custom = e.target.value.trim())));
  } else {
    $('#s-model').addEventListener('change', (e) => {
      if (e.target.value === '__other__') {
        const name = (prompt('输入模型名称（以服务商文档为准）：', cfg.model) || '').trim();
        update((c) => {
          if (name) c.models[c.provider] = name;
        }, true);
      } else {
        update((c) => (c.models[c.provider] = e.target.value));
      }
    });
  }
  $('#s-lang').addEventListener('change', (e) => update((c) => (c.language = e.target.value)));
  $('#s-vocab').addEventListener('input', (e) => update((c) => (c.vocab = e.target.value)));
  $('#s-interim').addEventListener('change', (e) => update((c) => (c.interim = e.target.checked)));
  $('#s-pause').addEventListener('change', (e) => update((c) => (c.pauseMs = Number(e.target.value))));
  $('#s-sens').addEventListener('change', (e) => update((c) => (c.sensitivity = e.target.value)));

  $('#s-test').addEventListener('click', async () => {
    const cur = loadSettings();
    const out = $('#s-test-result');
    const btn = $('#s-test');
    if (!isConfigured(cur)) {
      out.className = 'help bad';
      out.textContent = '请先把上面的内容填完整。';
      return;
    }
    btn.disabled = true;
    out.className = 'help';
    out.textContent = '正在连接…';
    try {
      // 发一秒钟的静音过去，只要服务正常返回就说明 Key 和模型都没问题
      await transcribe(encodeWav(new Float32Array(16000), 16000), activeConfig(cur), { language: 'auto' });
      out.className = 'help good';
      out.textContent = '连接成功，可以开始录音了。';
    } catch (e) {
      out.className = 'help bad';
      out.textContent = (e && e.message) || '连接失败';
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------- 启动 ----------

window.addEventListener('hashchange', route);
route();

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// 离线缓存只在正式的 https 网址上启用，本机调试时不缓存
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
