import { describe, it, expect } from 'vitest';
import { buildContextBlock } from './chat.js';

describe('buildContextBlock', () => {
  it('returns an empty string when there is no context object', () => {
    expect(buildContextBlock(undefined)).toBe('');
  });

  it('still anchors the date when given an empty context object', () => {
    // The route only forwards a context when it has fields, but an empty object
    // should at least anchor "now" to server time rather than going blind.
    expect(buildContextBlock({})).toContain('Current date & time');
  });

  it('anchors the current date from the provided ISO time', () => {
    const block = buildContextBlock({ now: '2026-06-03T12:00:00.000Z' });
    expect(block).toContain('Current date & time');
    expect(block).toContain('03 Jun 2026');
  });

  it('includes timezone, locale and unit guidance', () => {
    const block = buildContextBlock({
      timezone: 'America/New_York',
      locale: 'en-US',
      units: 'imperial'
    });
    expect(block).toContain('America/New_York');
    expect(block).toContain('en-US');
    expect(block).toContain('imperial');
    expect(block).toContain('°F');
  });

  it('renders an approximate location with coarse coordinates', () => {
    const block = buildContextBlock({
      location: { city: 'Fairfax', region: 'VA', country: 'US', lat: 38.8462, lng: -77.3064 }
    });
    expect(block).toContain('Fairfax, VA, US');
    expect(block).toContain('38.85');
    expect(block).toContain('-77.31');
  });

  it('falls back to server time when "now" is invalid', () => {
    const block = buildContextBlock({ now: 'not-a-date', timezone: 'UTC' });
    expect(block).toContain('Current date & time');
    expect(block).toContain('UTC');
  });
});
