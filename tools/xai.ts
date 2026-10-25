// Minimal client for xAI's image editing API (Grok Imagine). Reads XAI_API_KEY from .env.local.
import { readFileSync } from 'node:fs';

function apiKey(): string {
  if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY;
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && line.slice(0, i).trim() === 'XAI_API_KEY') return line.slice(i + 1).trim();
  }
  throw new Error('XAI_API_KEY missing (put it in .env.local)');
}

/** Sends a PNG and a prompt to the image editor; returns the resulting image bytes. */
export async function editImage(png: Buffer, prompt: string, resolution = process.env.RES): Promise<Buffer> {
  const key = apiKey();
  for (let attempt = 1; ; attempt++) {
    const r = await fetch('https://api.x.ai/v1/images/edits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.MODEL ?? 'grok-imagine-image-2.0',
        prompt,
        image: { url: `data:image/png;base64,${png.toString('base64')}`, type: 'image_url' },
        ...(resolution ? { resolution } : {}),
      }),
    });
    const text = await r.text();
    if (!r.ok) {
      if (attempt < 4 && (r.status === 429 || r.status >= 500)) {
        await new Promise((ok) => setTimeout(ok, 5000 * attempt));
        continue;
      }
      throw new Error(`HTTP ${r.status} ${text.slice(0, 300)}`);
    }
    const j = JSON.parse(text);
    const item = j.data?.[0] ?? j;
    if (item.b64_json) return Buffer.from(item.b64_json, 'base64');
    if (item.url) return Buffer.from(await (await fetch(item.url)).arrayBuffer());
    throw new Error(`unexpected response ${text.slice(0, 300)}`);
  }
}
