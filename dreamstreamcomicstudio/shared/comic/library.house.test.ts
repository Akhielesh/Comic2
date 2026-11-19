// House comics calls are admin spend (spec DC-H1): their comic_image_calls kinds carry the 'house_' prefix, and
// isAdminSpendCallKind keeps them out of users' model statistics and the public showcase like library and lab calls.
import { describe, expect, it } from 'vitest';
import { HOUSE_CALL_KIND_PREFIX, LAB_CALL_KIND_PREFIX, LIBRARY_CALL_KIND, isAdminSpendCallKind } from './library';
import { houseCallKind } from './house';

describe('house call kinds are admin spend', () => {
  it('the prefix is house_', () => {
    expect(HOUSE_CALL_KIND_PREFIX).toBe('house_');
  });

  it('house kinds are admin spend; plain user kinds are not', () => {
    expect(isAdminSpendCallKind('house_page')).toBe(true);
    expect(isAdminSpendCallKind('page')).toBe(false);
    for (const k of ['house_sheet', 'house_cover', 'house_panel', 'house_place', 'house_edit']) expect(isAdminSpendCallKind(k), k).toBe(true);
    for (const k of ['housepage', 'houses', 'my_house_page', 'House_page', '', 'sheet']) expect(isAdminSpendCallKind(k), k).toBe(false);
    expect(isAdminSpendCallKind(null)).toBe(false);
    expect(isAdminSpendCallKind(undefined)).toBe(false);
  });

  it('library and lab kinds are unchanged (regression)', () => {
    expect(isAdminSpendCallKind(LIBRARY_CALL_KIND)).toBe(true);
    expect(isAdminSpendCallKind(`${LAB_CALL_KIND_PREFIX}page`)).toBe(true);
  });

  it('houseCallKind builds the recorded kind from the job kind', () => {
    for (const k of ['page', 'sheet', 'cover', 'panel', 'style_option']) {
      expect(houseCallKind(k)).toBe(`house_${k}`);
      expect(isAdminSpendCallKind(houseCallKind(k))).toBe(true);
    }
  });
});
