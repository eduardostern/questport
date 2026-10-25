// Renders every SQ3 sound resource with the SCI0 sound module, prints timing/cue info, writes some WAVs.
// Usage: npx tsx tools/sci-sound-test.ts <outdir> [device=adlib|pcjr|speaker] [sound numbers to dump...]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SciResources } from '../src/sci/resource';
import { encodeWav, parseSci0Sound, renderSci0Sound, type SciSoundDevice } from '../src/sci/sound';
import { loadGameDir } from './png';

const outDir = process.argv[2] ?? 'out-sound';
const device = (process.argv[3] ?? 'adlib') as SciSoundDevice;
const extra = process.argv.slice(4).map(Number);
mkdirSync(outDir, { recursive: true });

const res = new SciResources(loadGameDir('public/games/sq3'));
const adlibPatch = res.get(9 /* Patch */, 3) ?? undefined;

const results: { n: number; duration: number; audible: boolean }[] = [];
let failures = 0;
for (const n of res.list(4)) {
  const data = res.get(4, n);
  if (!data) continue;
  try {
    const t0 = performance.now();
    const r = renderSci0Sound(data, { device, adlibPatch });
    const ms = performance.now() - t0;
    const info = parseSci0Sound(data);
    let peak = 0;
    for (const x of r.pcm) peak = Math.max(peak, Math.abs(x));
    const cues = r.cues.map((c) => `${c.time.toFixed(2)}s:${c.kind === 'cue' ? `cue+${c.inc}=>` : ''}${c.value}`).join(' ');
    console.log(
      `sound ${String(n).padStart(3)}  dur ${r.duration.toFixed(2).padStart(7)}s  loop@${r.loopStart.toFixed(2).padStart(6)}s  ` +
        `${r.digital ? 'DIGITAL ' : `notes ${String(r.notes).padStart(4)}`}  peak ${peak.toFixed(2)}  ` +
        `${info.sample ? `[sample ${info.sample.data.length}B@${info.sample.rate}${info.midiEmpty ? ', midi empty' : ''}] ` : ''}` +
        `(${ms.toFixed(0)}ms)  cues: ${cues || '-'}`,
    );
    results.push({ n, duration: r.duration, audible: peak > 0.01 });
  } catch (e) {
    failures++;
    console.log(`sound ${n}: ERROR ${(e as Error).stack}`);
  }
}

// dump the longest few (title theme etc.) plus requested ones
const longest = results.filter((r) => r.audible).sort((a, b) => b.duration - a.duration).slice(0, 4).map((r) => r.n);
const dump = [...new Set([1, ...longest, 100, ...extra])];
for (const n of dump) {
  const data = res.get(4, n);
  if (!data) continue;
  const r = renderSci0Sound(data, { device, adlibPatch });
  const file = join(outDir, `sound${n}-${device}.wav`);
  writeFileSync(file, encodeWav(r.pcm, r.sampleRate));
  console.log(`wrote ${file} (${r.duration.toFixed(1)}s)`);
}
console.log(`${results.length} rendered, ${failures} failures`);
if (failures) process.exit(1);
