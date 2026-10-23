import { describe, expect, it } from 'vitest';
import type { ExportSlot } from './sequence';
import { MIN_ZIP_EDGE, PNG_BYTES_PER_PIXEL, ZIP_BUDGET, planZipMemory, zipMemoryBudget, zipReducedNotice, zipTooBigMessage } from './zipMemory';

const MB = 1024 * 1024;

/** `n` portrait pages of w × h (plus an optional plate). */
const book = (n: number, w = 1365, h = 2048, plates = 0): ExportSlot[] => [
  ...Array.from({ length: n }, (_, i): ExportSlot => ({
    key: `pg_${i + 1}`,
    kind: 'page',
    label: `Page ${i + 1}`,
    fileBase: `${i}-page`,
    asset: { path: `u/p${i}.png`, source: 'generated', at: 0, w, h },
    url: `https://cdn.test/p${i}.png`,
    aspect: w / h
  })),
  ...Array.from({ length: plates }, (_, i): ExportSlot => ({ key: `plate${i}`, kind: 'title', label: 'Title page', fileBase: `p${i}-title`, plate: 'title', aspect: 2 / 3 }))
];

describe('zipMemoryBudget', () => {
  it('scales with the device memory, within a floor and a ceiling', () => {
    expect(zipMemoryBudget({ deviceMemoryGb: 4 })).toBeGreaterThan(300 * MB);
    expect(zipMemoryBudget({ deviceMemoryGb: 4 })).toBeLessThan(340 * MB);
    expect(zipMemoryBudget({ deviceMemoryGb: 0.5 })).toBe(ZIP_BUDGET.min);
    expect(zipMemoryBudget({ deviceMemoryGb: 64 })).toBe(ZIP_BUDGET.max);
  });

  it('unknown memory: phones and tablets get the cautious budget, computers the larger one', () => {
    expect(zipMemoryBudget({ coarse: true })).toBe(ZIP_BUDGET.phone);
    expect(zipMemoryBudget({})).toBe(ZIP_BUDGET.computer);
  });
});

describe('planZipMemory', () => {
  const phone = zipMemoryBudget({ coarse: true });
  const laptop = zipMemoryBudget({ deviceMemoryGb: 8 });

  it('a book that fits is exported at full size (30 pages, one language, on a phone)', () => {
    const plan = planZipMemory(book(30), 1, { budget: phone });
    expect(plan.fits).toBe(true);
    expect(plan.maxEdge).toBeUndefined();
    expect(plan.fullEdge).toBe(2048);
    expect(plan.bytes).toBe(plan.fullBytes);
    expect(plan.fullBytes).toBeCloseTo(30 * 1365 * 2048 * PNG_BYTES_PER_PIXEL, -4);
  });

  it('every language multiplies the estimate: 30 pages × 6 languages is over 1 GB at full size', () => {
    const one = planZipMemory(book(30), 1, { budget: laptop });
    const six = planZipMemory(book(30), 6, { budget: laptop });
    expect(six.fullBytes).toBeCloseTo(one.fullBytes * 6, -2);
    expect(six.fullBytes).toBeGreaterThan(1000 * MB);
    // A laptop draws it smaller (and says so) …
    expect(six.fits).toBe(true);
    expect(six.maxEdge).toBeGreaterThanOrEqual(MIN_ZIP_EDGE);
    expect(six.maxEdge).toBeLessThan(2048);
    expect(six.maxEdge! % 16).toBe(0);
    expect(six.bytes).toBeLessThanOrEqual(six.budget);
    // … a phone refuses before any work and asks for one language at a time (which fits in full).
    const onPhone = planZipMemory(book(30), 6, { budget: phone });
    expect(onPhone.fits).toBe(false);
    expect(zipTooBigMessage(onPhone, { languages: 6, pages: 30 })).toMatch(/Download one language at a time instead\./);
  });

  it('picks the largest cap that fits (one step bigger would not)', () => {
    const slots = book(24);
    const plan = planZipMemory(slots, 3, { budget: laptop / 2 });
    expect(plan.fits).toBe(true);
    expect(plan.bytes).toBeLessThanOrEqual(plan.budget);
    // The estimate at cap + 64 px is over budget: the cap is not needlessly small.
    const edge = plan.maxEdge! + 64;
    const at = 24 * 3 * edge * edge * (1365 / 2048) * PNG_BYTES_PER_PIXEL;
    expect(at).toBeGreaterThan(plan.budget);
  });

  it('refuses honestly when even the smallest readable size is too big', () => {
    const plan = planZipMemory(book(200), 8, { budget: 96 * MB });
    expect(plan.fits).toBe(false);
    expect(plan.maxEdge).toBe(MIN_ZIP_EDGE);
    expect(zipTooBigMessage(plan, { languages: 8, pages: 200 })).toMatch(/too big to zip in all 8 languages at once on this device .*Download one language at a time/);
    expect(zipTooBigMessage(plan, { languages: 1, pages: 200 })).toMatch(/Download the PDF instead/);
  });

  it('a caller’s long edge is what gets estimated (upscaling counts too)', () => {
    const plan = planZipMemory(book(4, 1000, 1500), 1, { longEdge: 3000, budget: 400 * MB });
    expect(plan.fullEdge).toBe(3000);
  });

  it('art with no recorded size is assumed to be full 2K, never zero', () => {
    const slots = book(2).map((s) => ({ ...s, asset: { ...s.asset!, w: undefined, h: undefined } }));
    expect(planZipMemory(slots, 1, { budget: 400 * MB }).fullEdge).toBe(2048);
  });

  it('plates count far less than painted pages', () => {
    const withPlates = planZipMemory(book(1, 1365, 2048, 3), 1, { budget: 400 * MB, plateWidth: 1365 });
    const pageOnly = planZipMemory(book(1), 1, { budget: 400 * MB });
    // Each plate costs less than a third of a painted page of the same size.
    expect((withPlates.fullBytes - pageOnly.fullBytes) / 3).toBeLessThan(pageOnly.fullBytes * 0.33);
  });
});

describe('zipReducedNotice', () => {
  it('says how big the images are and how to get full size', () => {
    const plan = planZipMemory(book(30), 6, { budget: zipMemoryBudget({ deviceMemoryGb: 8 }) });
    expect(zipReducedNotice(plan, { languages: 6, oneLanguageFits: true })).toBe(
      `To fit in this device’s memory, the images were saved at up to ${plan.maxEdge!.toLocaleString('en-US')} px (full size is 2,048 px). Download one language at a time for full-size pages.`
    );
    expect(zipReducedNotice(plan, { languages: 1 })).not.toMatch(/one language/);
    expect(zipReducedNotice(planZipMemory(book(2), 1, { budget: 400 * MB }), { languages: 1 })).toBeUndefined();
  });
});
