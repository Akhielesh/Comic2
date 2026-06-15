import { describe, it, expect } from 'vitest';
import { capToolOutput, CHAT_TOOL_OUTPUT_MAX, MCP_TOOL_OUTPUT_MAX } from './capToolOutput.js';

describe('capToolOutput', () => {
  it('returns short content unchanged (byte-for-byte)', () => {
    const s = 'a tiny tool result with ```json\n{"ok":true}\n```';
    expect(capToolOutput(s, { max: 1000 })).toBe(s);
  });

  it('returns content exactly at the cap unchanged', () => {
    const s = 'x'.repeat(100);
    expect(capToolOutput(s, { max: 100 })).toBe(s);
  });

  it('handles empty / non-string input safely', () => {
    expect(capToolOutput('', { max: 100 })).toBe('');
    // Defensive: a non-string slipping through must not throw.
    expect(capToolOutput(undefined as unknown as string, { max: 100 })).toBe(undefined as unknown as string);
  });

  it('truncates oversized content but preserves BOTH the head and the tail', () => {
    const head = 'HEAD_MARKER_' + 'a'.repeat(5000);
    const middle = 'm'.repeat(50_000);
    const tail = 'b'.repeat(5000) + '_TAIL_MARKER';
    const out = capToolOutput(head + middle + tail, { max: 10_000, toolName: 'read_url' });
    expect(out.length).toBeLessThan(head.length + middle.length + tail.length);
    // Head survives (the answer usually leads here)...
    expect(out).toContain('HEAD_MARKER_');
    // ...and so does the tail (totals / closing rows / error trailers).
    expect(out).toContain('_TAIL_MARKER');
    // ...but the middle is gone.
    expect(out).not.toContain(middle);
  });

  it('inserts a marker naming the tool and the elided count', () => {
    const out = capToolOutput('z'.repeat(40_000), { max: 10_000, toolName: 'mcp_demo_search' });
    expect(out).toContain('mcp_demo_search');
    expect(out).toContain('truncated');
    expect(out).toMatch(/elided/);
  });

  it('keeps more of the head than the tail (70/30 split)', () => {
    const out = capToolOutput('q'.repeat(40_000), { max: 10_000 });
    const [headPart, tailPart] = out.split(/…\[[^\]]*\]…/s);
    // 70% of 10k head vs 30% tail (the marker sits between them).
    expect(headPart.length).toBeGreaterThan(tailPart.length);
  });

  it('defaults to the built-in cap when none is given', () => {
    const out = capToolOutput('y'.repeat(CHAT_TOOL_OUTPUT_MAX + 5000));
    expect(out.length).toBeLessThanOrEqual(CHAT_TOOL_OUTPUT_MAX + 400); // + marker
    expect(out).toContain('truncated');
  });

  it('caps MCP output tighter than built-in tools', () => {
    expect(MCP_TOOL_OUTPUT_MAX).toBeLessThan(CHAT_TOOL_OUTPUT_MAX);
  });
});
