// Granular pitch shifter (AudioWorklet): two read heads sweep a circular delay buffer at a
// speed set by the pitch ratio and are cross-faded with a raised-cosine window, so the pitch
// changes while the duration — and therefore lip sync — stays the same (§12.3).
/* global sampleRate, registerProcessor, AudioWorkletProcessor */
class PitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "ratio", defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.size = Math.round(sampleRate * 0.1); // 100 ms grain window
    this.buf = new Float32Array(this.size * 2);
    this.write = 0;
    this.phase = 0; // 0..1 position of head A inside the window
  }

  process(inputs, outputs, params) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;
    const ratio = params.ratio[0];
    const n = this.buf.length;
    const size = this.size;
    const step = (1 - ratio) / size; // delay change per sample
    for (let i = 0; i < output.length; i++) {
      this.buf[this.write] = input ? input[i] : 0;
      this.phase += step;
      if (this.phase >= 1) this.phase -= 1;
      if (this.phase < 0) this.phase += 1;
      const pb = (this.phase + 0.5) % 1;
      const read = (p) => {
        const delay = p * size;
        let pos = this.write - delay;
        if (pos < 0) pos += n;
        const i0 = Math.floor(pos);
        const frac = pos - i0;
        const a = this.buf[i0 % n];
        const b = this.buf[(i0 + 1) % n];
        return a + (b - a) * frac;
      };
      const wa = 0.5 - 0.5 * Math.cos(2 * Math.PI * this.phase);
      const wb = 0.5 - 0.5 * Math.cos(2 * Math.PI * pb);
      output[i] = read(this.phase) * wa + read(pb) * wb;
      this.write = (this.write + 1) % n;
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(output);
    return true;
  }
}

registerProcessor("dubroom-pitch-shifter", PitchShifter);
