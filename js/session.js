// 一次录音会话：把录音器切出来的每一句送去转写，拼成笔记并随时存盘

import { Recorder, encodeWav, RATE } from './recorder.js';
import { transcribe, transcribeWithRetry } from './transcriber.js';
import { activeConfig, isConfigured } from './settings.js';
import * as db from './db.js';

const MAX_PARALLEL = 2;
const PARAGRAPH_GAP_S = 3; // 停顿超过 3 秒就另起一段

export const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 两段文字之间该放什么：中文之间不加空格，碰到英文单词加空格
export function separator(prev, next, newParagraph) {
  if (!prev || !next) return '';
  if (newParagraph) return '\n';
  const last = prev[prev.length - 1];
  const first = next[0];
  if (/\s/.test(last) || /\s/.test(first)) return '';
  const alnum = /[A-Za-z0-9]/;
  if (alnum.test(last) && !/[，。！？、；：,.!?;:）)\]”’]/.test(first)) return ' ';
  if (/[.,!?;:]/.test(last)) return ' ';
  if (alnum.test(first) && /[㐀-鿿]/.test(last)) return ' ';
  return '';
}

export class Session {
  constructor(settings, handlers) {
    this.s = settings;
    this.cfg = activeConfig(settings);
    this.canTranscribe = isConfigured(settings);
    this.h = Object.assign({ onUpdate() {}, onLevel() {}, onState() {}, onNotice() {}, onForceStop() {} }, handlers);
    this.entries = []; // 每一句：{id, t0, t1, status, text, preview, samples}
    this.current = null;
    this.queue = [];
    this.active = 0;
    this.aborts = new Set();
    this.idleWaiters = [];
    this.state = 'idle';
    this.lastError = '';
    this.interimBusy = false;
    this.interimBlockedUntil = 0;
    this.note = {
      id: uid(),
      title: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      duration: 0,
      text: '',
      hasAudio: false,
      audioType: '',
    };
    this.noteSaved = false;
    this._onVisibility = this._onVisibility.bind(this);
  }

  get elapsed() {
    return this.rec ? this.rec.elapsed : 0;
  }

  get text() {
    let out = '';
    let lastEnd = null;
    for (const e of this.entries) {
      if (e.status !== 'done' || !e.text) continue;
      out += separator(out, e.text, lastEnd != null && e.t0 - lastEnd >= PARAGRAPH_GAP_S) + e.text;
      lastEnd = e.t1;
    }
    return out;
  }

  get hasErrors() {
    return this.entries.some((e) => e.status === 'error');
  }

  _setState(state) {
    this.state = state;
    this.h.onState(state);
  }

  async start() {
    this._setState('starting');
    this.rec = new Recorder({
      endSilenceMs: this.s.pauseMs,
      sensitivity: this.s.sensitivity,
      onLevel: (rms) => this.h.onLevel(rms),
      onSpeechStart: (t0) => this._onSpeechStart(t0),
      onSpeechDiscard: () => this._onSpeechDiscard(),
      onSegment: (seg) => this._onSegment(seg),
      onInterrupted: (why) => this._onInterrupted(why),
    });
    try {
      await this.rec.start();
    } catch (e) {
      this._setState('stopped');
      throw e;
    }
    this._setState('recording');
    this.interimTimer = setInterval(() => this._tickInterim(), 400);
    document.addEventListener('visibilitychange', this._onVisibility);
    this._acquireWake();
  }

  // ---------- 录音器回调 ----------

  _onSpeechStart(t0) {
    this.current = { id: uid(), t0, t1: t0, status: 'speaking', text: '', preview: '', samples: null, interimLen: 0 };
    this.entries.push(this.current);
    this.h.onUpdate();
  }

  _onSpeechDiscard() {
    const cur = this.current;
    this.current = null;
    if (cur) this.entries = this.entries.filter((e) => e !== cur);
    this.h.onUpdate();
  }

  _onSegment(seg) {
    const entry = this.current || { id: uid(), t0: seg.t0, status: 'speaking', text: '', preview: '' };
    if (!this.current) this.entries.push(entry);
    this.current = null;
    entry.t1 = seg.t1;
    if (!this.canTranscribe) {
      entry.status = 'skipped';
      this.h.onUpdate();
      return;
    }
    entry.samples = seg.samples;
    entry.status = 'pending';
    this.queue.push(entry);
    this.h.onUpdate();
    this._pump();
  }

  _onInterrupted(why) {
    if (this.state !== 'recording' && this.state !== 'paused') return;
    if (why === 'ended') {
      this.h.onNotice('麦克风被系统中断，已自动保存');
      this.h.onForceStop();
    } else if (this.state === 'recording') {
      this.pause();
      this.h.onNotice('麦克风被其他应用占用，已暂停');
    }
  }

  _onVisibility() {
    if (document.visibilityState === 'hidden') {
      // iOS 在后台会掐掉网页的麦克风，主动暂停比悄悄丢音频好
      if (isIOS && this.state === 'recording') {
        this.pause();
        this.autoPaused = true;
      }
    } else {
      this._acquireWake();
      if (this.rec && this.rec.trackEnded && (this.state === 'recording' || this.state === 'paused')) {
        this.h.onNotice('录音已被系统中断，已自动保存');
        this.h.onForceStop();
      } else if (this.autoPaused && this.state === 'paused') {
        this.autoPaused = false;
        this.h.onNotice('切到后台时已暂停，点 ▶ 继续录音');
      }
    }
  }

  // ---------- 转写队列 ----------

  _opts(extra) {
    return Object.assign({ language: this.s.language, vocab: this.s.vocab }, extra);
  }

  _pump() {
    while (this.active < MAX_PARALLEL && this.queue.length) this._run(this.queue.shift());
    if (!this.active && !this.queue.length) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      waiters.forEach((fn) => fn());
    }
  }

  async _run(entry) {
    this.active++;
    const ac = new AbortController();
    this.aborts.add(ac);
    try {
      const wav = encodeWav(entry.samples, RATE);
      entry.text = await transcribeWithRetry(wav, this.cfg, this._opts({ signal: ac.signal }));
      entry.status = 'done';
      entry.samples = null;
      this._persistSoon();
    } catch (e) {
      if (e && e.name === 'AbortError') {
        entry.status = 'skipped';
      } else {
        entry.status = 'error';
        this.lastError = (e && e.message) || '转写失败';
      }
    } finally {
      this.aborts.delete(ac);
      this.active--;
      this.h.onUpdate();
      this._pump();
    }
  }

  retryFailed() {
    for (const e of this.entries) {
      if (e.status === 'error' && e.samples) {
        e.status = 'pending';
        this.queue.push(e);
      }
    }
    this.lastError = '';
    this.h.onUpdate();
    this._pump();
  }

  _drain() {
    if (!this.active && !this.queue.length) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  // 说话过程中每隔一小会儿把「这一句到目前为止」送去识别，显示成灰色预览
  _tickInterim() {
    if (!this.s.interim || !this.canTranscribe || this.state !== 'recording') return;
    const cur = this.current;
    if (!cur || this.interimBusy || this.active >= MAX_PARALLEL) return;
    if (Date.now() < this.interimBlockedUntil) return;
    const snap = this.rec.snapshot();
    if (!snap || snap.length < RATE * 1.2) return;
    if (snap.length - cur.interimLen < RATE * 1.5) return;
    cur.interimLen = snap.length;
    this.interimBusy = true;
    const ac = new AbortController();
    this.aborts.add(ac);
    transcribe(encodeWav(snap, RATE), this.cfg, this._opts({ signal: ac.signal }))
      .then((text) => {
        if (text && (cur.status === 'speaking' || cur.status === 'pending')) {
          cur.preview = text;
          this.h.onUpdate();
        }
      })
      .catch((e) => {
        // 被限流时先停掉预览，把额度留给正式转写
        if (e && e.status === 429) this.interimBlockedUntil = Date.now() + 30000;
        else if (e && e.name !== 'AbortError') this.interimBlockedUntil = Date.now() + 5000;
      })
      .finally(() => {
        this.aborts.delete(ac);
        this.interimBusy = false;
      });
  }

  // ---------- 存盘 ----------

  _persistSoon() {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this._persist().catch(() => {}), 800);
  }

  async _persist() {
    const text = this.text;
    if (this.discarded || (!text && !this.noteSaved)) return;
    this.note.text = text;
    this.note.duration = this.elapsed;
    this.note.updatedAt = Date.now();
    await db.putNote(this.note);
    this.noteSaved = true;
  }

  // ---------- 控制 ----------

  pause() {
    if (this.state !== 'recording') return;
    this.rec.pause();
    this._setState('paused');
  }

  async resume() {
    if (this.state !== 'paused') return;
    this.autoPaused = false;
    await this.rec.resume();
    this._setState('recording');
    this._acquireWake();
  }

  _teardown() {
    clearInterval(this.interimTimer);
    clearTimeout(this.persistTimer);
    document.removeEventListener('visibilitychange', this._onVisibility);
    this._releaseWake();
  }

  stop() {
    if (!this.stopPromise) this.stopPromise = this._stop();
    return this.stopPromise;
  }

  // 结束录音：保存音频 → 等剩余句子转写完 → 保存笔记。没录到内容时返回 null
  async _stop() {
    this._setState('stopping');
    this._teardown();
    const { blob, duration } = await this.rec.stop();
    this.note.duration = duration;
    if (blob && blob.size > 0 && duration >= 1) {
      try {
        await db.putAudio(this.note.id, blob);
        this.note.hasAudio = true;
        this.note.audioType = blob.type;
        this.note.audioSize = blob.size;
      } catch (e) {
        this.h.onNotice('录音文件保存失败，可能是存储空间不足');
      }
    }
    await this._drain();
    this.note.text = this.text;
    this.note.updatedAt = Date.now();
    const keep = this.note.hasAudio || !!this.note.text;
    if (keep) await db.putNote(this.note);
    else if (this.noteSaved) await db.deleteNote(this.note.id);
    this._setState('stopped');
    return keep ? this.note : null;
  }

  async discard() {
    this.discarded = true;
    this._teardown();
    this.queue = [];
    this.aborts.forEach((ac) => ac.abort());
    this._setState('stopped');
    try {
      if (this.rec) await this.rec.stop();
    } catch (e) {
      /* 忽略 */
    }
    try {
      await db.deleteNote(this.note.id);
    } catch (e) {
      /* 忽略 */
    }
  }

  // ---------- 屏幕常亮 ----------

  async _acquireWake() {
    if (!('wakeLock' in navigator) || this.state === 'stopped' || this.state === 'stopping') return;
    if (this.wake && !this.wake.released) return;
    try {
      this.wake = await navigator.wakeLock.request('screen');
    } catch (e) {
      /* 低电量模式等情况下会被拒绝 */
    }
  }

  _releaseWake() {
    if (this.wake) {
      this.wake.release().catch(() => {});
      this.wake = null;
    }
  }
}
