import { describe, it, expect } from 'vitest';
import { parseTreasuryXml } from './marketWidgets.js';
import { clampMonitorInterval } from './registry.js';

// A trimmed sample of the Treasury daily par-yield OData XML (two trading days).
const SAMPLE_XML = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <content type="application/xml">
      <m:properties xmlns:m="m" xmlns:d="d">
        <d:NEW_DATE m:type="Edm.DateTime">2026-06-08T00:00:00</d:NEW_DATE>
        <d:BC_1MONTH m:type="Edm.Double">4.33</d:BC_1MONTH>
        <d:BC_2YEAR m:type="Edm.Double">3.86</d:BC_2YEAR>
        <d:BC_10YEAR m:type="Edm.Double">4.18</d:BC_10YEAR>
        <d:BC_30YEAR m:type="Edm.Double">4.60</d:BC_30YEAR>
      </m:properties>
    </content>
  </entry>
  <entry>
    <content type="application/xml">
      <m:properties xmlns:m="m" xmlns:d="d">
        <d:NEW_DATE m:type="Edm.DateTime">2026-06-09T00:00:00</d:NEW_DATE>
        <d:BC_1MONTH m:type="Edm.Double">4.32</d:BC_1MONTH>
        <d:BC_2YEAR m:type="Edm.Double">3.84</d:BC_2YEAR>
        <d:BC_10YEAR m:type="Edm.Double">4.19</d:BC_10YEAR>
        <d:BC_30YEAR m:type="Edm.Double">4.61</d:BC_30YEAR>
      </m:properties>
    </content>
  </entry>
</feed>`;

describe('parseTreasuryXml', () => {
  it('extracts dated yield rows sorted ascending', () => {
    const rows = parseTreasuryXml(SAMPLE_XML);
    expect(rows).toHaveLength(2);
    expect(rows[0].date).toBe('2026-06-08');
    expect(rows[1].date).toBe('2026-06-09');
    expect(rows[1].yields.BC_10YEAR).toBe(4.19);
    expect(rows[1].yields.BC_2YEAR).toBe(3.84);
  });

  it('returns an empty list for malformed/empty feeds instead of throwing', () => {
    expect(parseTreasuryXml('')).toEqual([]);
    expect(parseTreasuryXml('<feed><entry>no properties</entry></feed>')).toEqual([]);
  });
});

describe('clampMonitorInterval', () => {
  it('defaults to 5 minutes and clamps to the 30s–1h band', () => {
    expect(clampMonitorInterval(undefined)).toBe(300);
    expect(clampMonitorInterval('soon')).toBe(300);
    expect(clampMonitorInterval(5)).toBe(30);
    expect(clampMonitorInterval(60)).toBe(60);
    expect(clampMonitorInterval(86400)).toBe(3600);
  });
});
