// Builds an encrypted AI art pack for publishing: only someone with the same original game files can
// decrypt it (see src/ai-pack.ts). Output: packs/<id>/... (keep it out of git; deployed with the site).
// Usage: tsx tools/ai-pack.ts <game dir>   e.g. public/games/sq3
// Env: EXCLUDE_VIEWS="601,602" leaves those views out of the pack.
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadGameDir } from './png';
import { packKey, encryptBytes } from '../src/ai-pack';

const gameDir = process.argv[2];
const aiDir = `${gameDir}/ai`;
const pk = await packKey(loadGameDir(gameDir));
if (!pk) throw new Error('Unrecognized game files');
const outDir = `packs/${pk.id}`;
rmSync(outDir, { recursive: true, force: true });

const exclude = new Set((process.env.EXCLUDE_VIEWS ?? '').split(',').filter(Boolean));
const index = JSON.parse(readFileSync(`${aiDir}/index.json`, 'utf8'));
for (const v of exclude) delete index.views?.[v];

let count = 0;
let bytes = 0;
const put = async (path: string, data: Uint8Array) => {
  const out = await encryptBytes(pk.key, data);
  mkdirSync(dirname(`${outDir}/${path}`), { recursive: true });
  writeFileSync(`${outDir}/${path}.bin`, out);
  count++;
  bytes += out.length;
};

await put('index.json', new TextEncoder().encode(JSON.stringify(index)));
for (const file of Object.values(index.pics ?? {}) as string[]) await put(file, readFileSync(`${aiDir}/${file}`));
for (const file of Object.values(index.views ?? {}) as string[]) {
  const raw = readFileSync(`${aiDir}/${file}`);
  await put(file, raw);
  for (const s of JSON.parse(raw.toString()).sheets) await put(s.file, readFileSync(`${aiDir}/${s.file}`));
}
console.log(`pack ${pk.id}: ${count} files, ${(bytes / 1048576).toFixed(1)} MB`);
