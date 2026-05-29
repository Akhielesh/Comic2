#!/usr/bin/env node
// OpenRouter smoke test — verifies the new API source end to end without the
// server, auth, or a build step.
//
//   node scripts/openrouter-smoketest.mjs            # text round-trip
//   node scripts/openrouter-smoketest.mjs --models   # also list a few models
//   node scripts/openrouter-smoketest.mjs --image    # also try an image
//
// Reads OPENROUTER_API_KEY from the environment, or from a .env file in the
// project root / server/ directory if present. Optional overrides:
//   OPENROUTER_BASE_URL, OPENROUTER_TEXT_MODEL, OPENROUTER_IMAGE_MODEL.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

// Minimal .env loader (no dependency): fill any keys not already in process.env.
const loadEnvFile = (path) => {
  try {
    const text = readFileSync(path, 'utf8');
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    /* file not present — ignore */
  }
};

loadEnvFile(resolve(projectRoot, '.env'));
loadEnvFile(resolve(projectRoot, 'server/.env'));

const BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const API_KEY = process.env.OPENROUTER_API_KEY;
const TEXT_MODEL = process.env.OPENROUTER_TEXT_MODEL || 'google/gemini-2.0-flash-exp:free';
const IMAGE_MODEL = process.env.OPENROUTER_IMAGE_MODEL || 'google/gemini-2.5-flash-image';

const args = new Set(process.argv.slice(2));
const wantModels = args.has('--models');
const wantImage = args.has('--image');

const headers = {
  'Content-Type': 'application/json',
  'HTTP-Referer': process.env.OPENROUTER_APP_URL || 'https://dreamstream.studio',
  'X-Title': process.env.OPENROUTER_APP_TITLE || 'DreamStream Comic Studio',
  Authorization: `Bearer ${API_KEY}`
};

const fail = (msg) => {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
};

if (!API_KEY) {
  fail('OPENROUTER_API_KEY is not set. Export it or add it to .env, then re-run.');
}

const post = async (path, body) => {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status} ${res.statusText}\n${text.slice(0, 600)}`);
  return JSON.parse(text);
};

const main = async () => {
  console.log(`OpenRouter smoke test`);
  console.log(`  base:  ${BASE_URL}`);
  console.log(`  text:  ${TEXT_MODEL}`);
  if (wantImage) console.log(`  image: ${IMAGE_MODEL}`);
  console.log('');

  // 1) Text round-trip.
  console.log('→ text generation …');
  const t0 = Date.now();
  const textRes = await post('/chat/completions', {
    model: TEXT_MODEL,
    messages: [{ role: 'user', content: 'Reply with exactly: OPENROUTER OK' }],
    usage: { include: true }
  });
  const reply = textRes?.choices?.[0]?.message?.content || '';
  console.log(`  ✅ ${Date.now() - t0}ms — model=${textRes?.model} reply=${JSON.stringify(String(reply).slice(0, 60))}`);
  if (textRes?.usage) {
    console.log(`     usage: prompt=${textRes.usage.prompt_tokens} completion=${textRes.usage.completion_tokens} cost=$${textRes.usage.cost ?? 'n/a'}`);
  }

  // 2) Optional: list a few models.
  if (wantModels) {
    console.log('\n→ listing models …');
    const res = await fetch(`${BASE_URL}/models`, { headers });
    if (!res.ok) throw new Error(`/models → ${res.status} ${res.statusText}`);
    const data = await res.json();
    const rows = Array.isArray(data?.data) ? data.data : [];
    const free = rows.filter((m) => String(m.id).endsWith(':free')).slice(0, 5);
    console.log(`  ✅ ${rows.length} models. Sample free text models:`);
    for (const m of free) console.log(`     • ${m.id}`);
  }

  // 3) Optional: image generation.
  if (wantImage) {
    console.log('\n→ image generation …');
    const i0 = Date.now();
    const imgRes = await post('/chat/completions', {
      model: IMAGE_MODEL,
      messages: [{ role: 'user', content: 'A single red apple on a white background, comic book ink style.' }],
      modalities: ['image', 'text'],
      usage: { include: true }
    });
    const message = imgRes?.choices?.[0]?.message;
    const url = message?.images?.[0]?.image_url?.url || message?.images?.[0]?.url || '';
    if (!url) throw new Error(`No image returned. Confirm "${IMAGE_MODEL}" supports image output.`);
    console.log(`  ✅ ${Date.now() - i0}ms — got image (${url.slice(0, 32)}… ${Math.round(url.length / 1024)}KB)`);
  }

  console.log('\n✅ OpenRouter is reachable and generating. The new API source works.');
};

main().catch((err) => fail(err?.message || String(err)));
