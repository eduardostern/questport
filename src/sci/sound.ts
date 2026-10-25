// SCI0 sound resources (SCI_VERSION_0_LATE layout, as used by SQ3 0.000.685): decoding + offline PCM rendering.
//
// Behaviour ported from ScummVM's engines/sci/sound (midiparser_sci.cpp, resource_audio.cpp, music.cpp,
// soundcmd.cpp, drivers/pcjr.cpp, drivers/adlib.cpp).
//
// Resource layout (SCI0 late):
//   byte 0         : 0 = MIDI only, 2 = a digital sample follows the MIDI stream
//   bytes 1..32    : 16 x { voices, deviceMask }   (mask 0x04 = AdLib, 0x10 = PCjr/Tandy, 0x20 = PC speaker)
//   bytes 0x21..   : one MIDI-like stream, all channels mixed: <delta> <event> ...
//                    delta = ticks at 60 Hz (0xF8 = wait 240 ticks, no event), 0xFC = end of track.
//   [optional]     : after the 0xFC terminator(s): 44-byte sample header (rate @14, size @32), then 8-bit unsigned PCM.
// Channel 15 is the control channel:
//   0xCF nn   (program change ch15): set signal nn; nn = 0x7F marks the loop point (not passed to scripts in SCI0 late)
//   0xBF 0x60 nn : cue -> dataInc += nn (scripts see signal = dataInc + 127)
//   0xBF 0x52 nn : hold marker (SCI0 kDoSound has no setHold, so it never matches)
//   0xBF 0x4C nn : reset-on-pause flag

export type SciSoundDevice = 'adlib' | 'pcjr' | 'speaker';

export interface SciSoundCue {
  time: number; // seconds from start of the (first) pass
  tick: number; // 60 Hz ticks
  /** What the kernel writes into the sound object's `signal` selector for this event (if nothing else is pending). */
  value: number;
  /** 'signal' = 0xCF nn on channel 15 (value = nn). 'cue' = 0xBF 0x60 inc (value = running dataInc + 127, first pass). */
  kind: 'signal' | 'cue';
  /** For kind 'cue': the dataInc increment carried by the event (dataInc accumulates across loops). */
  inc?: number;
}

export interface SciSoundRender {
  pcm: Float32Array; // mono
  sampleRate: number;
  duration: number; // seconds (one pass; == end-of-track tick / 60)
  /** Where playback restarts when the song loops (seconds). 0 if there's no loop marker (whole song repeats). */
  loopStart: number;
  /** Signal/cue events in playback order during one pass. On loop iterations, cues with time >= loopStart repeat. */
  cues: SciSoundCue[];
  /** True when the PCM is the embedded digital sample rather than synthesized MIDI. */
  digital: boolean;
  /** Device actually emulated. */
  device: SciSoundDevice;
  /** Number of note-on events routed to the device (0 => silent for this device). */
  notes: number;
}

export interface SciSoundOptions {
  device?: SciSoundDevice; // default 'adlib'
  sampleRate?: number; // default 22050
  /** AdLib instrument bank: the raw patch.003 resource (2690 or 1344 bytes). Required for good AdLib sound;
   *  without it, a generic built-in organ-like patch is used. */
  adlibPatch?: Uint8Array;
  /**
   * Digital samples embedded in the resource:
   *  'auto'   (default) play the sample only if the MIDI part is empty (ScummVM with prefer_digitalsfx off;
   *           this is what makes the "Where am I?" voice in the SQ3 intro, sound 100, play),
   *  'prefer' play the sample whenever one exists (ScummVM prefer_digitalsfx on),
   *  'never'  always synthesize MIDI.
   */
  digital?: 'auto' | 'prefer' | 'never';
}

const DEVICE_MASK: Record<SciSoundDevice, number> = { adlib: 0x04, pcjr: 0x10, speaker: 0x20 };
const TICKS_PER_SECOND = 60;

// ---------------------------------------------------------------------------------------------------------------
// Parsing

export interface Sci0Event {
  tick: number;
  status: number; // 0x80..0xEF channel message; 0xF0 sysex (skipped)
  p1: number;
  p2: number;
}

export interface Sci0Sound {
  hasDigitalFlag: boolean;
  channels: { voices: number; mask: number }[]; // 16 entries from the header
  header: Uint8Array; // the 0x21-byte header
  events: Sci0Event[];
  endTick: number;
  midiEmpty: boolean; // MIDI stream is empty (first event is end-of-track)
  sample?: { rate: number; data: Uint8Array }; // 8-bit unsigned PCM
}

const N_PARAMS = [2, 2, 2, 2, 1, 1, 2, 0]; // per status high nibble 8..F

export function parseSci0Sound(data: Uint8Array): Sci0Sound {
  const HDR = 0x21;
  const header = data.subarray(0, Math.min(HDR, data.length));
  const channels: { voices: number; mask: number }[] = [];
  for (let i = 0; i < 16; i++) channels.push({ voices: data[1 + i * 2] ?? 0, mask: data[2 + i * 2] ?? 0 });
  const hasDigitalFlag = data[0] === 2;

  let midi = data.subarray(Math.min(HDR, data.length));
  let sample: Sci0Sound['sample'];
  if (hasDigitalFlag) {
    // find 0xFC (channel terminator); skip following 0xFCs; anything after is the sample
    let i = 0;
    while (i < midi.length && midi[i] !== 0xfc) i++;
    let j = i;
    while (j < midi.length && midi[j] === 0xfc) j++;
    if (j < midi.length && midi.length - j >= 44) {
      const s = midi.subarray(j);
      const rate = s[14] | (s[15] << 8);
      const size = s[32] | (s[33] << 8);
      sample = { rate: rate || 11000, data: s.subarray(44, Math.min(s.length, 44 + size)) };
      midi = midi.subarray(0, i + 1);
    }
  }
  const midiEmpty = midi.length < 2 || midi[1] === 0xfc;

  // Parse the stream (like MidiParser_SCI::midiFilterChannels, without filtering).
  const events: Sci0Event[] = [];
  let pos = 0;
  let tick = 0;
  let command = 0;
  const rd = () => (pos < midi.length ? midi[pos++] : -1);
  for (;;) {
    const d = rd();
    if (d < 0 || d === 0xfc) break; // 0xFC can appear in delta position
    if (d === 0xf8) {
      tick += 240;
      continue;
    }
    tick += d;
    let b = rd();
    if (b < 0) break;
    if (b === 0xfc) break; // end of track
    if (b === 0xf0) {
      // sysex: skip to F7
      while (b >= 0 && b !== 0xf7) b = rd();
      if (b < 0) break;
      continue;
    }
    let p1: number;
    if (b & 0x80) {
      command = b;
      p1 = -2; // need read
    } else {
      p1 = b; // running status
    }
    if (command < 0x80) break; // data without status: corrupt
    const np = N_PARAMS[(command >> 4) - 8];
    if (np > 0 && p1 === -2) p1 = rd();
    if (np === 0) p1 = 0;
    let p2 = 0;
    if (np > 1) p2 = rd();
    if (p1 < 0 || p2 < 0) break;
    events.push({ tick, status: command, p1, p2 });
  }
  return { hasDigitalFlag, channels, header, events, endTick: tick, midiEmpty, sample };
}

// ---------------------------------------------------------------------------------------------------------------
// Synth interface

interface Synth {
  send(status: number, p1: number, p2: number): void;
  /** Called once per 60 Hz tick after the tick's events. */
  tick(): void;
  /** Render samples [from, to) into out (adding). */
  render(out: Float32Array, from: number, to: number): void;
}

// ---------------------------------------------------------------------------------------------------------------
// PCjr / Tandy (SN76489, 3 square voices) and PC speaker — port of drivers/pcjr.cpp (SCI0 channel model)

class PcjrChannel {
  part = 0xff;
  note = 0xff;
  ctrlVolume = 96;
  velocity = 0;
  envVolume = 0;
  envAttn = 0;
  envState = 0;
  envCount = 0;
  envCount2 = 0;
  pitchBendV = 0;
  freqCount = 0;
  smpAmplitude = 0;
  curSample = 0;

  constructor(private drv: PcjrSynth) {
    this.reset();
  }

  reset(): void {
    this.part = this.note = 0xff;
    this.velocity = 0;
    this.envVolume = this.envAttn = 0;
    this.envState = this.envCount = 0;
    this.freqCount = 0;
    this.smpAmplitude = 0;
    this.curSample = 0;
    this.pitchBendV = 0;
    this.ctrlVolume = 96;
    this.updateChannelVolume();
  }

  isPlaying(): boolean {
    return this.note !== 0xff;
  }

  chanOff(): void {
    this.note = 0xff;
    this.envState = 0;
    this.envAttn = 0;
    this.envVolume = 0;
    this.envCount = 0;
  }

  pitchBend(pb: number): void {
    this.pitchBendV = Math.trunc((pb < 0x2000 ? -(0x2000 - pb) : pb - 0x2000) / 171);
  }

  updateChannelVolume(): void {
    const tbl = this.drv.volTable;
    if (this.drv.speaker) {
      this.smpAmplitude = tbl[15 - this.drv.masterVolume];
      return;
    }
    const veloAttn = 3 - (this.velocity >> 5);
    const volAttn = 15 - (this.ctrlVolume >> 3);
    let attn = volAttn + veloAttn + this.envVolume;
    if (attn >= 15) {
      attn = 15;
      if (this.envState >= 2) this.chanOff();
    } else if (attn < 0) attn = 0;
    attn = Math.min(15, Math.max(volAttn, attn + (15 - this.drv.masterVolume)));
    this.smpAmplitude = tbl[attn];
  }

  processEnvelope(): void {
    if (this.drv.speaker) return;
    switch (this.envState) {
      case 1:
        this.envAT();
        break;
      case 2:
        this.envST();
        break;
      case 3:
        this.envRL();
        break;
    }
  }

  noteOn(note: number, velocity: number): void {
    this.note = note;
    if (this.drv.speaker) return;
    this.velocity = velocity;
    this.envState = 1;
    this.envCount = 0;
    this.envAT();
  }

  noteOff(): void {
    if (this.drv.speaker) {
      this.chanOff();
      return;
    }
    this.envState = 3;
    this.envCount = 0;
    this.envRL();
  }

  private envAT(): void {
    const envTable = [0, -2, -3, -2, -1, 0, 127];
    const c = this.envCount++;
    if (envTable[c] === 127) {
      this.envState++;
      this.envCount = 0;
      this.envCount2 = 20;
      this.envST();
    } else {
      this.envVolume = this.envAttn = 0; // (sic, see pcjr.cpp)
      this.updateChannelVolume();
    }
  }

  private envST(): void {
    if (!this.envCount2 || --this.envCount2) return;
    this.envVolume = ++this.envAttn;
    this.envCount2 = 20;
    this.updateChannelVolume();
  }

  private envRL(): void {
    const envTable = [1, 1, 1, 2, 2, 3, 3, 4, 4, 6, 6, 7, 8, 9, 10, 11, 12, 127];
    const c = Math.min(this.envCount++, envTable.length - 1);
    this.envVolume = envTable[c] === 127 ? 15 : this.envAttn + envTable[c];
    this.updateChannelVolume();
  }

  private getFrequency(): number {
    if (this.note === 0xff) return 0;
    const BASE_NOTE = 129;
    const BASE_OCT = 10;
    const hd = (this.note - BASE_NOTE) * 4 + this.pitchBendV;
    const octDiff = Math.floor((hd + BASE_OCT * 48) / 48) - BASE_OCT;
    const idx = (((hd + 48 * 100) % 48) + 48) % 48;
    return Math.trunc(this.drv.freqTable[idx] / Math.pow(2, -octDiff));
  }

  recalcSample(): void {
    const rate = this.drv.rate;
    const freq = this.getFrequency();
    if (freq === 0) {
      this.curSample = 0;
      return;
    }
    this.freqCount += freq;
    while (this.freqCount >= rate << 1) this.freqCount -= rate << 1;
    const a = this.smpAmplitude;
    if (this.freqCount - freq < 0) {
      // unclean rising edge
      this.curSample = ~a + Math.trunc(((a << 1) * this.freqCount) / freq);
    } else if (this.freqCount >= rate && this.freqCount - freq < rate) {
      // unclean falling edge
      this.curSample = a - Math.trunc(((a << 1) * (this.freqCount - rate)) / freq);
    } else {
      this.curSample = this.freqCount < rate ? a : ~a;
    }
  }
}

class PcjrSynth implements Synth {
  readonly volTable: number[] = [];
  readonly freqTable: number[] = [];
  readonly masterVolume = 15;
  readonly channels: PcjrChannel[] = [];

  constructor(readonly rate: number, readonly speaker: boolean, header: Uint8Array) {
    const n = speaker ? 1 : 3;
    for (let i = 0; i < 15; i++) this.volTable[i] = Math.trunc((32767 & ~n) / n / Math.pow(10, i / 10));
    this.volTable[15] = 0;
    for (let i = 0; i < 48; i++) this.freqTable[i] = Math.trunc(Math.pow(2, (288 + i) / 48) * 440);
    for (let i = 0; i < n; i++) this.channels.push(new PcjrChannel(this));
    // initTrack (SCI0 late): first n channels whose mask has the device bit get a hardware voice each
    const flag = speaker ? 0x20 : 0x10;
    for (let i = 0, assigned = 0; i < 16 && assigned < n; i++) {
      const f = header[2 + i * 2] ?? 0;
      if (f & flag) this.channels[assigned++].part = i;
    }
  }

  send(status: number, p1: number, p2: number): void {
    const part = status & 0x0f;
    switch (status & 0xf0) {
      case 0x80:
        this.noteOff(part, p1);
        break;
      case 0x90:
        if (!p2) this.noteOff(part, p1);
        else this.noteOn(part, p1, p2);
        break;
      case 0xb0:
        if (p1 === 7) {
          for (const c of this.channels) if (c.part === part) c.ctrlVolume = p2;
        } else if (p1 === 0x7b || p1 === 0x78) {
          for (const c of this.channels) if (c.part === part) c.chanOff();
        }
        break;
      case 0xe0:
        for (const c of this.channels) if (c.part === part) c.pitchBend((p1 & 0x7f) | ((p2 & 0x7f) << 7));
        break;
    }
  }

  private noteOn(part: number, note: number, velocity: number): void {
    if (this.speaker) {
      const c = this.channels[0];
      if (c.part !== part) return;
      c.chanOff();
      if (note >= 24 && note <= 119) c.noteOn(note, velocity);
      return;
    }
    if (note === 0 || note === 1) return;
    let res = -1;
    for (let i = 0; i < this.channels.length; i++) if (this.channels[i].part === part) res = i;
    if (res >= 0) this.channels[res].noteOn(note, velocity);
  }

  private noteOff(part: number, note: number): void {
    for (const c of this.channels) if (c.part === part && c.note === note) c.noteOff();
  }

  tick(): void {
    for (const c of this.channels) if (c.isPlaying()) c.processEnvelope();
  }

  render(out: Float32Array, from: number, to: number): void {
    for (let i = from; i < to; i++) {
      let smp = 0;
      for (const c of this.channels) {
        if (!c.isPlaying()) continue;
        c.recalcSample();
        smp += c.curSample;
      }
      out[i] += (this.speaker ? 0.5 : 1) * smp / 32768;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// AdLib: port of drivers/adlib.cpp (SCI0 voice allocation / velocity / pitch) driving a small OPL2 FM model.

interface AdlibOperator {
  am: boolean;
  vib: boolean;
  egt: boolean; // sustaining envelope
  ksr: boolean;
  mult: number;
  ksl: number;
  tl: number;
  ar: number;
  dr: number;
  sl: number;
  rr: number;
  ws: number;
}

interface AdlibPatch {
  op: [AdlibOperator, AdlibOperator];
  feedback: number;
  algorithm: number; // 1 = additive
}

function parseAdlibBank(data: Uint8Array | undefined): AdlibPatch[] {
  const patches: AdlibPatch[] = [];
  const load = (off: number) => {
    const ins = (i: number) => data![off + i] ?? 0;
    const op = (base: number): AdlibOperator => ({
      ksl: ins(base + 0) & 3,
      mult: ins(base + 1) & 0xf,
      ar: ins(base + 3) & 0xf,
      sl: ins(base + 4) & 0xf,
      egt: !!ins(base + 5),
      dr: ins(base + 6) & 0xf,
      rr: ins(base + 7) & 0xf,
      tl: ins(base + 8) & 0x3f,
      am: !!ins(base + 9),
      vib: !!ins(base + 10),
      ksr: !!ins(base + 11),
      ws: 0,
    });
    const o0 = op(0);
    const o1 = op(13);
    o0.ws = ins(26) & 3;
    o1.ws = ins(27) & 3;
    patches.push({ op: [o0, o1], feedback: ins(2) & 7, algorithm: ins(12) ? 0 : 1 });
  };
  if (data && (data.length === 1344 || data.length === 2690 || data.length >= 5382)) {
    for (let i = 0; i < 48; i++) load(28 * i);
    if (data.length === 2690) for (let i = 48; i < 96; i++) load(2 + 28 * i);
  }
  if (patches.length === 0) {
    // Fallback generic patch (soft FM organ/piano) when no bank is supplied.
    const mk = (tl: number, ar: number, dr: number, sl: number, rr: number, mult: number): AdlibOperator => ({
      am: false,
      vib: false,
      egt: true,
      ksr: false,
      mult,
      ksl: 0,
      tl,
      ar,
      dr,
      sl,
      rr,
      ws: 0,
    });
    for (let i = 0; i < 96; i++) patches.push({ op: [mk(28, 15, 4, 4, 6, 1), mk(0, 15, 3, 3, 6, 1)], feedback: 3, algorithm: 0 });
  }
  while (patches.length < 96) patches.push(patches[0]);
  return patches;
}

const ADLIB_FREQ = [
  0x157, 0x15c, 0x161, 0x166, 0x16b, 0x171, 0x176, 0x17b, 0x181, 0x186, 0x18c, 0x192, 0x198, 0x19e, 0x1a4, 0x1aa, 0x1b0,
  0x1b6, 0x1bd, 0x1c3, 0x1ca, 0x1d0, 0x1d7, 0x1de, 0x1e5, 0x1ec, 0x1f3, 0x1fa, 0x202, 0x209, 0x211, 0x218, 0x220, 0x228,
  0x230, 0x238, 0x241, 0x249, 0x252, 0x25a, 0x263, 0x26c, 0x275, 0x27e, 0x287, 0x290, 0x29a, 0x2a4,
];

// --- OPL2 model ---
const OPL_RATE = 49716; // 3.579545 MHz / 72
const MULT = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];
const KSL_ROM = [0, 32, 40, 45, 48, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64];
const KSL_SHIFT = [8, 1, 2, 0];
const OUT_UNITS = 4084; // OPL operator output full scale
const ENV_MAX = 511;

const enum Eg {
  Off = 0,
  Attack,
  Decay,
  Sustain,
  Release,
}

class OplOperator {
  // registers
  am = false;
  vib = false;
  egt = false;
  ksr = false;
  mult = 0;
  ksl = 0;
  tl = 63;
  ar = 0;
  dr = 0;
  sl = 0;
  rr = 0;
  ws = 0;
  // state
  phase = 0;
  env = ENV_MAX;
  stage = Eg.Off;
  out = 0; // last output, OPL units
  prevOut = 0;

  keyOn(): void {
    if (this.stage === Eg.Off || this.stage === Eg.Release) {
      this.phase = 0;
      this.stage = Eg.Attack;
    }
  }

  keyOff(): void {
    if (this.stage !== Eg.Off) this.stage = Eg.Release;
  }
}

class OplChannel {
  fnum = 0;
  block = 0;
  key = false;
  feedback = 0;
  alg = 0;
  readonly op = [new OplOperator(), new OplOperator()];
}

class Opl2 {
  readonly ch: OplChannel[] = [];
  private amPhase = 0;
  private vibPhase = 0;
  private attackK: Float64Array; // per effective rate: per-sample multiplier for attack
  private decayStep: Float64Array; // per effective rate: env units per sample

  constructor(private rate: number) {
    for (let i = 0; i < 9; i++) this.ch.push(new OplChannel());
    this.attackK = new Float64Array(64);
    this.decayStep = new Float64Array(64);
    for (let eff = 0; eff < 64; eff++) {
      if (eff < 4) {
        this.attackK[eff] = 1;
        this.decayStep[eff] = 0;
        continue;
      }
      const scale = Math.pow(2, -(eff - 4) / 4);
      const ta = (2826.24 * scale) / 1000; // seconds for full attack
      const td = (39280.64 * scale) / 1000; // seconds for 0 -> 96 dB
      this.attackK[eff] = eff >= 60 ? 0 : Math.exp(-Math.log(512) / Math.max(1, ta * rate));
      this.decayStep[eff] = 512 / Math.max(1e-6, td * rate);
    }
  }

  private effRate(r: number, op: OplOperator, c: OplChannel): number {
    if (r === 0) return 0;
    const kcode = (c.block << 1) | ((c.fnum >> 9) & 1);
    const rof = op.ksr ? kcode : kcode >> 2;
    return Math.min(63, r * 4 + rof);
  }

  private stepEnv(op: OplOperator, c: OplChannel): void {
    switch (op.stage) {
      case Eg.Attack: {
        const eff = this.effRate(op.ar, op, c);
        if (eff >= 60) op.env = 0;
        else if (eff >= 4) op.env = op.env * this.attackK[eff] - 0.02;
        if (op.env <= 0) {
          op.env = 0;
          op.stage = Eg.Decay;
        }
        break;
      }
      case Eg.Decay: {
        const slv = op.sl === 15 ? 31 * 16 : op.sl * 16;
        op.env += this.decayStep[this.effRate(op.dr, op, c)];
        if (op.env >= slv) {
          op.env = slv;
          op.stage = Eg.Sustain;
        }
        break;
      }
      case Eg.Sustain:
        if (!op.egt) op.env += this.decayStep[this.effRate(op.rr, op, c)];
        break;
      case Eg.Release:
        op.env += this.decayStep[this.effRate(op.rr, op, c)];
        break;
    }
    if (op.env >= ENV_MAX) {
      op.env = ENV_MAX;
      if (op.stage === Eg.Release || op.stage === Eg.Sustain) op.stage = Eg.Off;
    }
  }

  private wave(ws: number, ph: number): number {
    const f = ph - Math.floor(ph);
    const s = Math.sin(f * 2 * Math.PI);
    switch (ws) {
      case 1:
        return s > 0 ? s : 0;
      case 2:
        return Math.abs(s);
      case 3:
        return f % 0.5 < 0.25 ? Math.abs(s) : 0;
      default:
        return s;
    }
  }

  /** Returns operator output in OPL units given phase modulation in cycles. */
  private opOut(op: OplOperator, c: OplChannel, freq: number, mod: number, am: number, vib: number): number {
    this.stepEnv(op, c);
    let f = freq * MULT[op.mult];
    if (op.vib) f *= vib;
    op.phase += f / this.rate;
    if (op.phase > 1e6) op.phase -= Math.floor(op.phase);
    if (op.stage === Eg.Off) return 0;
    let ksl = (KSL_ROM[c.fnum >> 6] << 2) - ((8 - c.block) << 5);
    if (ksl < 0) ksl = 0;
    const att = op.env + op.tl * 4 + (ksl >> KSL_SHIFT[op.ksl]) + (op.am ? am : 0);
    if (att >= ENV_MAX) return 0;
    return this.wave(op.ws, op.phase + mod) * Math.pow(2, -att / 32) * OUT_UNITS;
  }

  /** Generates one sample (sum of channel outputs, OPL units). */
  sample(): number {
    // LFOs (depth bits in 0xBD are 0: AM 1 dB, vibrato 7 cents)
    this.amPhase += 3.7 / this.rate;
    this.vibPhase += 6.07 / this.rate;
    if (this.amPhase >= 1) this.amPhase -= 1;
    if (this.vibPhase >= 1) this.vibPhase -= 1;
    const tri = (p: number) => (p < 0.5 ? p * 2 : 2 - p * 2);
    const am = tri(this.amPhase) * (1 / 0.1875);
    const vib = Math.pow(2, ((tri(this.vibPhase) * 2 - 1) * 7) / 1200);
    let sum = 0;
    for (const c of this.ch) {
      const [m, k] = c.op;
      if (m.stage === Eg.Off && k.stage === Eg.Off) continue;
      const freq = (c.fnum * OPL_RATE) / Math.pow(2, 20 - c.block);
      const fb = c.feedback ? (m.prevOut + m.out) / Math.pow(2, 9 - c.feedback) / 1024 : 0;
      const mo = this.opOut(m, c, freq, fb, am, vib);
      m.prevOut = m.out;
      m.out = mo;
      if (c.alg) {
        sum += mo + this.opOut(k, c, freq, 0, am, vib);
      } else {
        sum += this.opOut(k, c, freq, mo / 1024, am, vib);
      }
    }
    return sum;
  }
}

const VOICE_COUNT = 9;

class AdlibSynth implements Synth {
  private opl: Opl2;
  private patches: AdlibPatch[];
  private masterVolume = 15;
  private chan = Array.from({ length: 16 }, () => ({
    patch: 13,
    volume: 63,
    pan: 64,
    holdPedal: 0,
    pitchWheel: 8192,
    lastVoice: 0,
    enableVelocity: false,
    voices: 0,
    mappedVoices: 0,
  }));
  private voice = Array.from({ length: VOICE_COUNT }, () => ({
    channel: -1,
    mappedChannel: -1,
    note: -1,
    patch: 13,
    velocity: 0,
    isSustained: false,
    age: 0,
  }));

  constructor(private rate: number, header: Uint8Array, bank?: Uint8Array) {
    this.opl = new Opl2(rate);
    this.patches = parseAdlibBank(bank);
    // initTrack (SCI0 late)
    for (let i = 0; i < VOICE_COUNT; i++) this.setPatch(i, 13);
    for (let i = 0; i < 16; i++) {
      const num = (header[1 + i * 2] ?? 0) & 0x7f;
      const flags = header[2 + i * 2] ?? 0;
      if (flags & 0x04 && num) this.assignVoices(i, num);
    }
  }

  send(status: number, p1: number, p2: number): void {
    const channel = status & 0x0f;
    const c = this.chan[channel];
    switch (status & 0xf0) {
      case 0x80:
        this.noteOff(channel, p1);
        break;
      case 0x90:
        this.noteOn(channel, p1, p2);
        break;
      case 0xb0:
        switch (p1) {
          case 0x07:
            c.volume = p2 >> 1;
            this.renewNotes(channel, true);
            break;
          case 0x0a:
            c.pan = p2;
            this.renewNotes(channel, true);
            break;
          case 0x40:
            c.holdPedal = p2;
            if (p2 === 0) for (let i = 0; i < VOICE_COUNT; i++) if (this.voice[i].channel === channel && this.voice[i].isSustained) this.voiceOff(i);
            break;
          case 0x4b:
            this.voiceMapping(channel, p2);
            break;
          case 0x4e:
            c.enableVelocity = !!p2;
            break;
          case 0x7b:
            for (let i = 0; i < VOICE_COUNT; i++) if (this.voice[i].channel === channel && this.voice[i].note !== -1) this.voiceOff(i);
            break;
        }
        break;
      case 0xc0:
        c.patch = p1;
        break;
      case 0xe0:
        c.pitchWheel = (p1 & 0x7f) | ((p2 & 0x7f) << 7);
        this.renewNotes(channel, true);
        break;
    }
  }

  tick(): void {
    for (const v of this.voice) if (v.note !== -1) v.age++;
  }

  render(out: Float32Array, from: number, to: number): void {
    const gain = 1 / (OUT_UNITS * 4);
    for (let i = from; i < to; i++) out[i] += this.opl.sample() * gain;
  }

  // --- driver logic (adlib.cpp) ---
  private voiceMapping(channel: number, voices: number): void {
    let cur = 0;
    for (let i = 0; i < VOICE_COUNT; i++) if (this.voice[i].mappedChannel === channel) cur++;
    if (cur < voices) this.assignVoices(channel, voices - cur);
    else if (cur > voices) this.releaseVoices(channel, cur - voices);
  }

  private assignVoices(channel: number, voices: number): void {
    for (let i = 0; i < VOICE_COUNT; i++) {
      if (this.voice[i].mappedChannel === -1) {
        if (this.voice[i].note !== -1) this.voiceOff(i);
        this.voice[i].mappedChannel = channel;
        this.chan[channel].mappedVoices++;
        if (--voices === 0) return;
      }
    }
  }

  private releaseVoices(channel: number, voices: number): void {
    for (let i = 0; i < VOICE_COUNT; i++) {
      if (this.voice[i].mappedChannel === channel && this.voice[i].note === -1) {
        this.voice[i].mappedChannel = -1;
        this.chan[channel].mappedVoices--;
        if (--voices === 0) return;
      }
    }
    for (let i = 0; i < VOICE_COUNT; i++) {
      if (this.voice[i].mappedChannel === channel) {
        this.voiceOff(i);
        this.voice[i].mappedChannel = -1;
        this.chan[channel].mappedVoices--;
        if (--voices === 0) return;
      }
    }
  }

  private renewNotes(channel: number, key: boolean): void {
    for (let i = 0; i < VOICE_COUNT; i++) {
      if ((channel === -1 || this.voice[i].channel === channel) && this.voice[i].note !== -1) this.setNote(i, this.voice[i].note, key);
    }
  }

  private noteOn(channel: number, note: number, velocity: number): void {
    if (velocity === 0) return this.noteOff(channel, note);
    velocity >>= 1;
    if (note < 12 || note > 107) return;
    for (let i = 0; i < VOICE_COUNT; i++) {
      if (this.voice[i].channel === channel && this.voice[i].note === note) {
        this.voiceOff(i);
        this.voiceOn(i, note, velocity);
        return;
      }
    }
    const v = this.findVoice(channel);
    if (v === -1) return;
    this.voiceOn(v, note, velocity);
  }

  private findVoice(channel: number): number {
    let voice = -1;
    let oldestVoice = -1;
    let oldestAge = 0;
    for (let i = 0; i < VOICE_COUNT; i++) {
      const v = (this.chan[channel].lastVoice + i + 1) % VOICE_COUNT;
      if (this.voice[v].mappedChannel === channel) {
        if (this.voice[v].note === -1) {
          voice = v;
          this.voice[voice].channel = channel;
          break;
        }
        if (this.voice[v].age >= oldestAge) {
          oldestAge = this.voice[v].age;
          oldestVoice = v;
        }
      }
    }
    if (voice === -1) {
      if (!oldestAge) return -1;
      this.voiceOff(oldestVoice);
      voice = oldestVoice;
      this.voice[voice].channel = channel;
    }
    this.chan[channel].lastVoice = voice;
    return voice;
  }

  private noteOff(channel: number, note: number): void {
    for (let i = 0; i < VOICE_COUNT; i++) {
      if (this.voice[i].channel === channel && this.voice[i].note === note) {
        if (this.chan[channel].holdPedal) this.voice[i].isSustained = true;
        else this.voiceOff(i);
        return;
      }
    }
  }

  private voiceOn(voice: number, note: number, velocity: number): void {
    const v = this.voice[voice];
    const patch = this.chan[v.channel].patch;
    v.age = 0;
    this.chan[v.channel].voices++;
    if (patch !== v.patch) this.setPatch(voice, patch);
    v.velocity = velocity;
    this.setNote(voice, note, true);
  }

  private voiceOff(voice: number): void {
    const v = this.voice[voice];
    v.isSustained = false;
    this.setNote(voice, v.note, false);
    v.note = -1;
    v.age = 0;
    if (v.channel >= 0) this.chan[v.channel].voices--;
  }

  private setNote(voice: number, note: number, key: boolean): void {
    const v = this.voice[voice];
    v.note = note;
    let index = note << 2;
    let pw = this.chan[v.channel]?.pitchWheel ?? 0x2000;
    let sign: number;
    if (pw === 0x2000) {
      pw = 0;
      sign = 0;
    } else if (pw > 0x2000) {
      pw -= 0x2000;
      sign = 1;
    } else {
      pw = 0x2000 - pw;
      sign = -1;
    }
    pw = Math.trunc(pw / 171);
    index += sign === 1 ? pw : -pw;
    if (index > 0x1fc) index = 0x1fc;
    if (index < 0) index = 0;
    const freq = ADLIB_FREQ[index % 48];
    let oct = Math.trunc(index / 48);
    if (oct > 0) oct--;
    if (oct > 7) oct = 7;
    const c = this.opl.ch[voice];
    c.fnum = freq;
    c.block = oct;
    if (key && !c.key) {
      c.op[0].keyOn();
      c.op[1].keyOn();
    } else if (!key && c.key) {
      c.op[0].keyOff();
      c.op[1].keyOff();
    }
    c.key = key;
    this.setVelocity(voice);
  }

  private setVelocity(voice: number): void {
    const v = this.voice[voice];
    const p = this.patches[v.patch];
    const c = this.opl.ch[voice];
    c.op[1].tl = 63 - this.calcVelocity(voice, 1);
    if (p.algorithm === 1) c.op[0].tl = 63 - this.calcVelocity(voice, 0);
  }

  private calcVelocity(voice: number, op: number): number {
    const v = this.voice[voice];
    let velocity = this.masterVolume;
    if (velocity > 0) velocity += 3;
    if (velocity > 15) velocity = 15;
    const ins = v.channel >= 0 && this.chan[v.channel].enableVelocity ? v.velocity : 63 - this.patches[v.patch].op[op].tl;
    return Math.trunc((velocity * ins) / 15);
  }

  private setPatch(voice: number, patch: number): void {
    if (patch < 0 || patch >= this.patches.length) patch = 0;
    this.voice[voice].patch = patch;
    const p = this.patches[patch];
    const c = this.opl.ch[voice];
    for (let i = 0; i < 2; i++) {
      const src = p.op[i];
      const dst = c.op[i];
      dst.am = src.am;
      dst.vib = src.vib;
      dst.egt = src.egt;
      dst.ksr = src.ksr;
      dst.mult = src.mult;
      dst.ksl = src.ksl;
      dst.tl = src.tl;
      dst.ar = src.ar;
      dst.dr = src.dr;
      dst.sl = src.sl;
      dst.rr = src.rr;
      dst.ws = src.ws;
    }
    c.feedback = p.feedback;
    c.alg = p.algorithm;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering

function renderSample(s: { rate: number; data: Uint8Array }, sampleRate: number): Float32Array {
  const n = Math.max(0, Math.floor((s.data.length * sampleRate) / s.rate));
  const out = new Float32Array(n);
  const step = s.rate / sampleRate;
  for (let i = 0; i < n; i++) {
    const p = i * step;
    const k = Math.floor(p);
    const f = p - k;
    const a = s.data[k] ?? 128;
    const b = s.data[k + 1] ?? a;
    out[i] = ((a + (b - a) * f) - 128) / 128;
  }
  return out;
}

/** Renders an SCI0 sound resource for the given device (default AdLib). */
export function renderSci0Sound(data: Uint8Array, opts: SciSoundOptions = {}): SciSoundRender {
  const sampleRate = opts.sampleRate ?? 22050;
  const device = opts.device ?? 'adlib';
  const snd = parseSci0Sound(data);

  const digitalMode = opts.digital ?? 'auto';
  if (snd.sample && digitalMode !== 'never' && (digitalMode === 'prefer' || snd.midiEmpty)) {
    const pcm = renderSample(snd.sample, sampleRate);
    return { pcm, sampleRate, duration: pcm.length / sampleRate, loopStart: 0, cues: [], digital: true, device, notes: 0 };
  }

  const mask = DEVICE_MASK[device];
  // channel filter mask (SoundResource::getChannelFilterMask): ch15 always; ch9 only if flagged (no rhythm devices here)
  let chMask = 0x8000;
  for (let i = 0; i < 15; i++) if (snd.channels[i].mask & mask) chMask |= 1 << i;

  const synth: Synth =
    device === 'adlib' ? new AdlibSynth(sampleRate, snd.header, opts.adlibPatch) : new PcjrSynth(sampleRate, device === 'speaker', snd.header);

  const endTick = snd.endTick;
  const totalSamples = Math.round((endTick * sampleRate) / TICKS_PER_SECOND);
  const pcm = new Float32Array(totalSamples);
  const cues: SciSoundCue[] = [];
  let loopTick = 0;
  let dataInc = 0;
  let notes = 0;
  const sampleAt = (t: number) => Math.min(totalSamples, Math.round((t * sampleRate) / TICKS_PER_SECOND));

  let ei = 0;
  const ev = snd.events;
  for (let t = 0; t < endTick || (t === endTick && ei < ev.length); t++) {
    while (ei < ev.length && ev[ei].tick === t) {
      const e = ev[ei++];
      const ch = e.status & 0x0f;
      const cmd = e.status & 0xf0;
      if (!((1 << ch) & chMask)) continue;
      if (ch === 15 && cmd === 0xc0) {
        if (e.p1 === 0x7f) {
          loopTick = t; // loop marker; not passed to scripts in SCI0 late
        } else {
          cues.push({ time: t / TICKS_PER_SECOND, tick: t, value: e.p1, kind: 'signal' });
        }
        continue;
      }
      if (ch === 15 && cmd === 0xb0) {
        if (e.p1 === 0x60) {
          dataInc += e.p2;
          cues.push({ time: t / TICKS_PER_SECOND, tick: t, value: dataInc + 127, kind: 'cue', inc: e.p2 });
          continue;
        }
        // 0x50 reverb, 0x52 hold, 0x4C reset-on-pause, 0x4B voices, misc: parser-level only
        if (![0x01, 0x04, 0x07, 0x0a, 0x0b, 0x40, 0x79, 0x7b].includes(e.p1)) continue;
      }
      if (cmd === 0x90 && e.p2) notes++;
      synth.send(e.status, e.p1, e.p2);
    }
    synth.tick();
    if (t < endTick) synth.render(pcm, sampleAt(t), sampleAt(t + 1));
  }

  // soft limit
  for (let i = 0; i < pcm.length; i++) {
    const x = pcm[i];
    pcm[i] = x > 1 || x < -1 ? Math.tanh(x) : x;
  }
  // tiny fade-out to avoid a click at the end for one-shot sounds
  const fade = Math.min(pcm.length, Math.round(sampleRate * 0.004));
  for (let i = 0; i < fade; i++) pcm[pcm.length - 1 - i] *= i / fade;

  return {
    pcm,
    sampleRate,
    duration: endTick / TICKS_PER_SECOND,
    loopStart: loopTick / TICKS_PER_SECOND,
    cues,
    digital: false,
    device,
    notes,
  };
}

/** Encodes mono float PCM as a 16-bit WAV file (handy for debugging). */
export function encodeWav(pcm: Float32Array, sampleRate: number): Uint8Array {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 32767, true);
  return new Uint8Array(buf);
}
