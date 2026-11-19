// 在音频线程里采集麦克风原始 PCM，攒够一小块再发给主线程
class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 2048;
    this.buf = new Float32Array(this.size);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      let off = 0;
      while (off < ch.length) {
        const take = Math.min(ch.length - off, this.size - this.n);
        this.buf.set(ch.subarray(off, off + take), this.n);
        this.n += take;
        off += take;
        if (this.n === this.size) {
          const out = this.buf;
          this.buf = new Float32Array(this.size);
          this.n = 0;
          this.port.postMessage(out, [out.buffer]);
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PCMCapture);
