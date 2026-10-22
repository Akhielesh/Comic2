// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The headline privacy statements a parent reads before trusting a baby
 * monitor must say what really happens (as the FAQ does): the picture and
 * sound pass through our server not only when a network blocks the direct
 * connection, but also for a moment while a connection starts and when the
 * camera is full — and that path is not end-to-end encrypted.
 */
const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const statements = {
  'camera setup (MonitorCamera)': source('../views/MonitorCamera.tsx'),
  'guide, monitor step (Guide)': source('../components/Guide.tsx'),
  'how it works (MonitorHome)': source('../views/MonitorHome.tsx'),
};

describe('privacy copy: the in-app statements match the FAQ', () => {
  for (const [where, text] of Object.entries(statements)) {
    it(`${where}: names every time the server carries the picture, and that it isn't end-to-end encrypted then`, () => {
      // The old wording: "only when a network blocks that", inside "encrypted (…)".
      expect(text).not.toMatch(/only when a network blocks/);
      expect(text).not.toMatch(/encrypted \(through our server/);
      expect(text).toMatch(/end-to-end encrypted, wherever the network allows/);
      expect(text).toMatch(/For a moment while a connection starts, when a network blocks direct video, or when the camera is full/);
      expect(text).toMatch(/in memory only, never stored, not end-to-end encrypted/);
    });
  }
});
