// 录音核心：采集麦克风 → 降采样到 16kHz → 按停顿自动断句（VAD）
// 同时用 MediaRecorder 保存整段压缩录音，供回放和导出。

export const RATE = 16000;
const FRAME = 480; // 30ms @ 16kHz
const FRAME_MS = 30;
const PRE_FRAMES = 10; // 语音开始前保留 300ms，避免吃掉第一个字
const START_FRAMES = 3; // 连续 90ms 有声才算开始说话
const MIN_VOICED_MS = 240; // 短于此的声音（咳嗽、敲击）直接丢弃
const SOFT_MAX_S = 12; // 说了很久时，遇到短暂换气就切一段
const SOFT_PAUSE_MS = 240;
const HARD_MAX_S = 25; // 无论如何不超过 25 秒一段
const ABS_THRESHOLD = { high: 0.004, medium: 0.008, low: 0.016 };

// 流式降采样：对每个输出采样点取对应输入窗口的平均值
class Downsampler {
  constructor(inRate, outRate) {
    this.ratio = inRate / outRate;
    this.pos = 0;
    this.acc = 0;
    this.n = 0;
  }

  process(input) {
    const out = new Float32Array(Math.ceil(input.length / this.ratio) + 2);
    let o = 0;
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i];
      this.n++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        out[o++] = this.acc / this.n;
        this.acc = 0;
        this.n = 0;
        this.pos -= this.ratio;
      }
    }
    return out.subarray(0, o);
  }
}

function concat(frames, count) {
  const n = count == null ? frames.length : count;
  const out = new Float32Array(n * FRAME);
  for (let i = 0; i < n; i++) out.set(frames[i], i * FRAME);
  return out;
}

export function encodeWav(samples, rate = RATE) {
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
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // 单声道
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

export class Recorder {
  constructor(opts) {
    this.o = Object.assign(
      {
        endSilenceMs: 800,
        sensitivity: 'medium',
        onSpeechStart() {},
        onSegment() {},
        onSpeechDiscard() {},
        onLevel() {},
        onInterrupted() {},
      },
      opts
    );
    this.paused = false;
    this.stopped = false;
    this.samplesSeen = 0;
    this.frame = new Float32Array(FRAME);
    this.frameFill = 0;
    this.noise = 0.004;
    this.inSpeech = false;
    this.pre = [];
    this.seg = null;
    this.run = 0;
    this.voiced = 0;
    this.silence = 0;
    this.segStart = 0;
    this.chunks = [];
  }

  get elapsed() {
    return this.samplesSeen / RATE;
  }

  get trackEnded() {
    const t = this.stream && this.stream.getAudioTracks()[0];
    return !t || t.readyState === 'ended';
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    });
    try {
      await this._setup();
    } catch (e) {
      this._cleanup();
      throw e;
    }
  }

  async _setup() {
    // iOS 上必须在拿到麦克风之后再创建 AudioContext，否则采样率可能对不上
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch (e) {
        /* 下面会在用户点击时再试 */
      }
    }
    if (this.ctx.state !== 'running') {
      const kick = () => {
        if (this.ctx && this.ctx.state !== 'running' && this.ctx.state !== 'closed') this.ctx.resume().catch(() => {});
      };
      document.addEventListener('touchend', kick, { once: true });
      document.addEventListener('click', kick, { once: true });
    }

    this.down = new Downsampler(this.ctx.sampleRate, Math.min(RATE, this.ctx.sampleRate));
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0; // 只采集，不外放
    this.sink.connect(this.ctx.destination);

    if (this.ctx.audioWorklet && window.AudioWorkletNode) {
      try {
        await this.ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url).href);
        const node = new AudioWorkletNode(this.ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1 });
        node.port.onmessage = (e) => this._onPcm(e.data);
        this.node = node;
      } catch (e) {
        this.node = null;
      }
    }
    if (!this.node) {
      const sp = this.ctx.createScriptProcessor(4096, 1, 1);
      sp.onaudioprocess = (e) => this._onPcm(new Float32Array(e.inputBuffer.getChannelData(0)));
      this.node = sp;
    }
    this.source.connect(this.node);
    this.node.connect(this.sink);

    const track = this.stream.getAudioTracks()[0];
    if (track) {
      track.addEventListener('ended', () => !this.stopped && this.o.onInterrupted('ended'));
      track.addEventListener('mute', () => !this.stopped && !this.paused && this.o.onInterrupted('muted'));
    }

    if (window.MediaRecorder) {
      // 优先 AAC（m4a），各家手机、电脑和转写服务都认；不行再退到 webm
      const types = ['audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'];
      const type = types.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
      try {
        this.mr = new MediaRecorder(this.stream, type ? { mimeType: type, audioBitsPerSecond: 64000 } : undefined);
      } catch (e) {
        try {
          this.mr = new MediaRecorder(this.stream);
        } catch (e2) {
          this.mr = null;
        }
      }
      if (this.mr) {
        this.mr.ondataavailable = (e) => {
          if (e.data && e.data.size) this.chunks.push(e.data);
        };
        this.mr.start(1000);
      }
    }
  }

  _onPcm(buf) {
    if (this.paused || this.stopped) return;
    const ds = this.down.process(buf);
    let off = 0;
    while (off < ds.length) {
      const take = Math.min(ds.length - off, FRAME - this.frameFill);
      this.frame.set(ds.subarray(off, off + take), this.frameFill);
      this.frameFill += take;
      off += take;
      if (this.frameFill === FRAME) {
        const f = this.frame;
        this.frame = new Float32Array(FRAME);
        this.frameFill = 0;
        this._onFrame(f);
      }
    }
  }

  _onFrame(frame) {
    this.samplesSeen += FRAME;
    let sum = 0;
    for (let i = 0; i < FRAME; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / FRAME);
    this.o.onLevel(rms);

    const base = Math.max(ABS_THRESHOLD[this.o.sensitivity] || ABS_THRESHOLD.medium, this.noise * 2.5);

    if (!this.inSpeech) {
      // 跟踪环境底噪：下降快，上升慢
      this.noise = rms < this.noise ? this.noise * 0.7 + rms * 0.3 : this.noise * 0.995 + rms * 0.005;
      this.pre.push(frame);
      if (this.pre.length > PRE_FRAMES) this.pre.shift();
      this.run = rms > base ? this.run + 1 : 0;
      if (this.run >= START_FRAMES) {
        this.inSpeech = true;
        this.seg = this.pre;
        this.pre = [];
        this.segStart = (this.samplesSeen - this.seg.length * FRAME) / RATE;
        this.voiced = this.run;
        this.silence = 0;
        this.run = 0;
        this.o.onSpeechStart(this.segStart);
      }
      return;
    }

    this.seg.push(frame);
    // 说话过程中用更低的门槛，避免句尾轻声被截断
    if (rms > base * 0.6) {
      this.voiced++;
      this.silence = 0;
    } else {
      this.silence++;
    }
    const len = (this.seg.length * FRAME) / RATE;
    const silMs = this.silence * FRAME_MS;
    if (silMs >= this.o.endSilenceMs || (len >= SOFT_MAX_S && silMs >= SOFT_PAUSE_MS) || len >= HARD_MAX_S) {
      this._finalize();
    }
  }

  _finalize() {
    const frames = this.seg;
    const voicedMs = this.voiced * FRAME_MS;
    const trailing = this.silence;
    this.inSpeech = false;
    this.seg = null;
    this.run = 0;
    this.voiced = 0;
    this.silence = 0;
    if (!frames || voicedMs < MIN_VOICED_MS) {
      this.o.onSpeechDiscard();
      return;
    }
    const keep = frames.length - Math.max(0, trailing - 7); // 句尾留约 200ms 静音
    const samples = concat(frames, keep);
    this.o.onSegment({ samples, t0: this.segStart, t1: this.segStart + samples.length / RATE });
  }

  // 正在说的这一句到目前为止的音频（用于实时预览）
  snapshot() {
    if (!this.inSpeech || !this.seg) return null;
    return concat(this.seg);
  }

  pause() {
    if (this.paused || this.stopped) return;
    if (this.inSpeech) this._finalize();
    this.paused = true;
    this.pre = [];
    this.run = 0;
    try {
      if (this.mr && this.mr.state === 'recording') this.mr.pause();
    } catch (e) {
      /* 忽略 */
    }
  }

  async resume() {
    if (!this.paused || this.stopped) return;
    if (this.ctx && this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch (e) {
        /* 忽略 */
      }
    }
    try {
      if (this.mr && this.mr.state === 'paused') this.mr.resume();
    } catch (e) {
      /* 忽略 */
    }
    this.paused = false;
  }

  async stop() {
    if (this.stopped) return { blob: null, duration: this.elapsed };
    if (this.inSpeech) this._finalize();
    this.stopped = true;
    if (this.mr && this.mr.state !== 'inactive') {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        this.mr.onstop = () => {
          clearTimeout(timer);
          resolve();
        };
        try {
          this.mr.stop();
        } catch (e) {
          clearTimeout(timer);
          resolve();
        }
      });
    }
    let blob = null;
    if (this.chunks.length) {
      const type = (this.mr && this.mr.mimeType) || this.chunks[0].type || 'audio/mp4';
      blob = new Blob(this.chunks, { type });
    }
    this.chunks = [];
    this._cleanup();
    return { blob, duration: this.elapsed };
  }

  _cleanup() {
    this.stopped = true;
    try {
      if (this.node) {
        if (this.node.port) this.node.port.onmessage = null;
        this.node.disconnect();
      }
      if (this.source) this.source.disconnect();
      if (this.sink) this.sink.disconnect();
    } catch (e) {
      /* 忽略 */
    }
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close().catch(() => {});
  }
}
