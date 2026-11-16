import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setComposerDraftAccount, useComposerDraft } from './composerDrafts';

beforeEach(() => { setComposerDraftAccount(null); sessionStorage.clear(); setComposerDraftAccount('alice'); });
const scope = (conversationId: string, accountId = 'alice') => ({ accountId, conversationId, surface: 'director' });

describe('durable composer drafts', () => {
  it('survives unmount/reload storage and switches projects synchronously without overwriting either', () => {
    const hook = renderHook(({ id }) => useComposerDraft(scope(id)), { initialProps: { id: 'one' } });
    act(() => hook.result.current.setText('First comic draft'));
    expect(Object.values(sessionStorage).join(' ')).toContain('First comic draft');
    hook.rerender({ id: 'two' });
    expect(hook.result.current.text).toBe('');
    act(() => hook.result.current.setText('Second comic draft'));
    hook.rerender({ id: 'one' });
    expect(hook.result.current.text).toBe('First comic draft');
    hook.unmount();
    const next = renderHook(() => useComposerDraft(scope('two')));
    expect(next.result.current.text).toBe('Second comic draft');
  });
  it('shares the Director draft between the dock and ask sheet', () => {
    const dock = renderHook(() => useComposerDraft(scope('shared')));
    const sheet = renderHook(() => useComposerDraft(scope('shared')));
    act(() => sheet.result.current.setText('Keep this after closing the sheet'));
    expect(dock.result.current.text).toBe('Keep this after closing the sheet');
  });
  it('only commits the submitted revision, even when the person edits away and back', () => {
    const { result } = renderHook(() => useComposerDraft(scope('race')));
    act(() => result.current.setText('Send this'));
    const sent = result.current.capture();
    act(() => { result.current.setText('New note'); result.current.setText('Send this'); result.current.clearIfCurrent(sent); });
    expect(result.current.text).toBe('Send this');
    act(() => result.current.clearIfCurrent(result.current.capture()));
    expect(result.current.text).toBe('');
  });
  it('keeps a different project draft when an earlier send finishes', () => {
    const { result, rerender } = renderHook(({ id }) => useComposerDraft(scope(id)), { initialProps: { id: 'old' } });
    act(() => result.current.setText('Old request'));
    const old = result.current;
    const sent = old.capture();
    rerender({ id: 'new' });
    act(() => result.current.setText('New project'));
    act(() => old.clearIfCurrent(sent));
    expect(result.current.text).toBe('New project');
    rerender({ id: 'old' }); expect(result.current.text).toBe('');
  });
  it('purges another identity and blocks an old async writer after account change', () => {
    const { result } = renderHook(() => useComposerDraft(scope('private')));
    act(() => result.current.setText('Private words'));
    const old = result.current;
    act(() => { setComposerDraftAccount('bob'); old.setText('Late old request'); });
    expect(result.current.text).toBe('');
    expect(Object.values(sessionStorage).join(' ')).not.toMatch(/Private words|Late old request/);
  });
  it('keeps working when browser storage is blocked', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    const { result } = renderHook(() => useComposerDraft(scope('blocked')));
    act(() => result.current.setText('Still editable'));
    expect(result.current.text).toBe('Still editable');
    spy.mockRestore();
  });
});
