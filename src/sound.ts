// AGI v2 sound: three square-wave voices plus a noise channel, written for the
// PCjr / Tandy SN76489 chip. We render the whole sound to PCM up front.

export const SAMPLE_RATE = 22050;
const CLOCK = 111860.8; // tone frequency = CLOCK / divisor
const TICK = 1 / 60; // note durations are in 1/60 s

interface Note {
  duration: number; // ticks
  divisor: number;
  attenuation: number; // 0 = loudest, 15 = silent
  noiseType: number; // for the noise channel
}

function readVoice(d: Uint8Array, off: number): Note[] {
  const notes: Note[] = [];
  for (let p = off; p + 4 < d.length; p += 5) {
    const duration = d[p] | (d[p + 1] << 8);
    if (duration === 0xffff) break;
    notes.push({
      duration,
      divisor: ((d[p + 2] & 0x3f) << 4) | (d[p + 3] & 0x0f),
      attenuation: d[p + 4] & 0x0f,
      noiseType: d[p + 3] & 0x07,
    });
  }
  return notes;
}

const volume = (att: number) => (att >= 15 ? 0 : Math.pow(10, (-2 * att) / 20));

/** Renders an AGI sound resource to mono PCM samples. */
export function renderSound(d: Uint8Array): Float32Array {
  const voices: Note[][] = [];
  for (let v = 0; v < 4; v++) voices.push(readVoice(d, d[v * 2] | (d[v * 2 + 1] << 8)));
  const ticks = Math.max(...voices.map((n) => n.reduce((a, b) => a + b.duration, 0)));
  const total = Math.ceil(ticks * TICK * SAMPLE_RATE);
  const out = new Float32Array(total);

  // Tone voices
  for (let v = 0; v < 3; v++) {
    let t = 0;
    let phase = 0;
    for (const n of voices[v]) {
      const len = Math.round(n.duration * TICK * SAMPLE_RATE);
      const amp = volume(n.attenuation) * 0.18;
      const freq = n.divisor ? CLOCK / n.divisor : 0;
      if (amp > 0 && freq > 20 && freq < SAMPLE_RATE / 2) {
        const step = freq / SAMPLE_RATE;
        for (let i = 0; i < len && t + i < total; i++) {
          phase = (phase + step) % 1;
          out[t + i] += phase < 0.5 ? amp : -amp;
        }
      }
      t += len;
    }
  }

  // Noise voice: 15-bit LFSR; low 2 bits pick the shift rate, bit 2 picks white vs periodic noise.
  {
    let t = 0;
    let lfsr = 0x4000;
    let acc = 0;
    let voice2t = 0;
    let v2i = 0;
    for (const n of voices[3]) {
      const len = Math.round(n.duration * TICK * SAMPLE_RATE);
      const amp = volume(n.attenuation) * 0.15;
      const rate = n.noiseType & 3;
      const white = (n.noiseType & 4) !== 0;
      for (let i = 0; i < len && t + i < total; i++) {
        let shiftFreq: number;
        if (rate < 3) shiftFreq = CLOCK / (16 << rate) * 2;
        else {
          // Uses voice 2's (third tone voice) current frequency.
          while (v2i < voices[2].length && voice2t + voices[2][v2i].duration * TICK * SAMPLE_RATE <= t + i) {
            voice2t += voices[2][v2i].duration * TICK * SAMPLE_RATE;
            v2i++;
          }
          const dv = voices[2][v2i]?.divisor || 1;
          shiftFreq = (CLOCK / dv) * 2;
        }
        acc += shiftFreq / SAMPLE_RATE;
        while (acc >= 1) {
          acc -= 1;
          const fb = white ? (lfsr ^ (lfsr >> 1)) & 1 : lfsr & 1;
          lfsr = (lfsr >> 1) | (fb << 14);
        }
        if (amp > 0) out[t + i] += lfsr & 1 ? amp : -amp;
      }
      t += len;
    }
  }
  return out;
}
