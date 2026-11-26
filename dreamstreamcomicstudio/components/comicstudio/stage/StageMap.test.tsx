// The stage map (SH-C2): five ink-only rows (done, now, next or later), what is left in each, one target that only
// navigates; from the stage strip as a popover (a bottom sheet on phones) and from the side panel's "This comic" marks.
// Keyboard: arrows, Home and End between the targets, Enter to go, Escape back to the button. Synthetic docs only.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createEmptyDoc, type AssetRef, type ComicDoc, type Page, type RenderState } from '../../../shared/comic/doc';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import { stageFacts } from '../../../shared/comic/stage';
import { FormFactorProvider, formFactorFor } from '../mobile/useFormFactor';
import { ComicSection } from '../panel/ComicSection';
import { StageMap } from './StageMap';
import { StageStrip } from './StageStrip';

const NOW = 1_800_000_000_000;
const picture = (): AssetRef => ({ path: 'u/p/pages/a.webp', source: 'generated', at: NOW });
const render_ = (status: RenderState['status'], asset?: AssetRef): RenderState => ({ status, history: [], ...(asset ? { asset } : {}) });
const page = (n: number, r: RenderState): Page => ({
  id: `pg_${n}`,
  n,
  summary: '',
  layout: '',
  panels: [{ id: `pg_${n}_p1`, n: 1, size: 'medium', shot: 'medium', action: 'A beat', castIds: [], lines: [] }],
  render: r,
  balloons: []
});
/** Story and look set, 12 pages planned and approved, 6 drawn. */
const drawing = (): ComicDoc => {
  const doc = createEmptyDoc('c1', 'The Night Ferry', NOW);
  doc.brief.premise = 'A ferry that only runs after midnight.';
  doc.style = { ...doc.style, status: 'drafted', name: 'Ink wash', spec: 'Soft ink washes.' };
  doc.pages = Array.from({ length: 12 }, (_, i) => page(i + 1, i < 6 ? render_('ready', picture()) : render_('none')));
  doc.planStatus = 'approved';
  return doc;
};

const DESK = formFactorFor({ w: 1280, h: 800 });
const PHONE = formFactorFor({ w: 360, h: 740, coarse: true });
const map = () => screen.getByRole('list', { name: 'Stage map' });
const targets = () => within(map()).getAllByRole('button');

afterEach(cleanup);

describe('StageMap', () => {
  it('shows each stage done, now, next or later with what is left, and marks the current one as the step', () => {
    render(<StageMap facts={stageFacts(drawing())} onGo={vi.fn()} />);
    const rows = within(map()).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-stage-map-state'))).toEqual(['done', 'done', 'done', 'current', 'next']);
    expect(rows.filter((r) => r.getAttribute('aria-current') === 'step')).toEqual([rows[3]]);
    expect(rows[3]).toHaveTextContent('Draw · Now6 pages to drawDraw the rest');
    expect(rows[0]).toHaveTextContent('Story · DoneNothing leftOpen Story');
    // Each target says which stage it belongs to and where it goes.
    expect(targets()[3]).toHaveAccessibleName('Draw the rest');
    expect(targets()[3]).toHaveAccessibleDescription('Draw, now. 6 pages to draw. Opens the Pages tab.');
    expect(targets()[2]).toHaveAccessibleDescription('Plan, done. Nothing left. Opens the Pages tab.');
  });

  it('keyboard: native buttons in order; arrows, Home and End move between targets; Enter goes there', () => {
    const onGo = vi.fn();
    render(<StageMap facts={stageFacts(drawing())} onGo={onGo} />);
    const [story, style, , draw, publish] = targets();
    for (const b of targets()) {
      expect(b.tagName).toBe('BUTTON');
      expect(b).toHaveAttribute('type', 'button');
      expect(b.className).toContain('focus-visible:outline');
    }
    story.focus();
    fireEvent.keyDown(story, { key: 'ArrowDown' });
    expect(style).toHaveFocus();
    fireEvent.keyDown(style, { key: 'End' });
    expect(publish).toHaveFocus();
    fireEvent.keyDown(publish, { key: 'ArrowDown' });
    expect(publish).toHaveFocus();
    fireEvent.keyDown(publish, { key: 'ArrowUp' });
    expect(draw).toHaveFocus();
    fireEvent.keyDown(draw, { key: 'Home' });
    expect(story).toHaveFocus();
    fireEvent.click(draw);
    expect(onGo).toHaveBeenCalledWith('pages');
    fireEvent.click(story);
    expect(onGo).toHaveBeenLastCalledWith('story');
  });

  it('stays ink: no hue, wash, spark, accent fill or price', () => {
    const { container } = render(<StageMap facts={stageFacts(drawing())} onGo={vi.fn()} />);
    const classes = Array.from(container.querySelectorAll('[class]'), (el) => el.getAttribute('class')).join(' ');
    expect(classes).not.toMatch(/hue|wash|spark|accent|success|warning|danger/);
    expect(container.textContent).not.toMatch(/\$|%/);
  });
});

describe('the stage map from the strip', () => {
  const mount = (ff = DESK, onGo = vi.fn()) => {
    render(
      <FormFactorProvider value={ff}>
        <StageStrip doc={drawing()} onGo={onGo} />
      </FormFactorProvider>
    );
    return onGo;
  };

  it('opens as a popover with focus on the current stage; Escape closes it and returns focus to its button', async () => {
    mount();
    const toggle = within(screen.getByRole('navigation', { name: 'Comic stages' })).getByRole('button', { name: 'Stage map' });
    expect(toggle).toHaveAttribute('aria-haspopup', 'dialog');
    toggle.focus();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const sheet = screen.getByRole('dialog', { name: 'Stage map' });
    await waitFor(() => expect(within(sheet).getByRole('button', { name: 'Draw the rest' })).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Stage map' })).toBeNull();
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('a target closes the map and goes there; nothing spends', () => {
    const onGo = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Stage map' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Stage map' })).getByRole('button', { name: 'Open Style' }));
    expect(onGo).toHaveBeenCalledWith('style');
    expect(screen.queryByRole('dialog', { name: 'Stage map' })).toBeNull();
  });

  it('on a phone it is a bottom sheet with its title, and its button is a 44 px target in the strip’s one row', () => {
    mount(PHONE);
    const nav = screen.getByRole('navigation', { name: 'Comic stages' });
    expect(nav).toHaveAttribute('data-stage-strip', 'compact');
    const toggle = within(nav).getByRole('button', { name: 'Stage map' });
    expect(toggle.className).toContain('coarse:h-11');
    expect(toggle.className).toContain('coarse:min-w-11');
    fireEvent.click(toggle);
    const sheet = screen.getByRole('dialog', { name: 'Stage map' });
    expect(within(sheet).getByText('Stage map')).toBeInTheDocument();
    expect(within(sheet).getAllByRole('listitem')).toHaveLength(5);
  });
});

describe('the stage map from the side panel', () => {
  it('the five marks beside “This comic” open the map in place; its targets only navigate', () => {
    const doc = drawing();
    const onGo = vi.fn();
    render(<ComicSection doc={doc} caps={DEFAULT_CAPS} tab="pages" facts={stageFacts(doc)} onSelect={vi.fn()} onConversation={vi.fn()} onGo={onGo} />);
    const section = screen.getByRole('group', { name: 'This comic' });
    const toggle = within(section).getByRole('button', { name: 'Stage map' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(section).queryByRole('list', { name: 'Stage map' })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const inline = within(section).getByRole('list', { name: 'Stage map' });
    expect(toggle).toHaveAttribute('aria-controls', inline.parentElement!.id);
    fireEvent.click(within(inline).getByRole('button', { name: 'Open Read' }));
    expect(onGo).toHaveBeenCalledWith('read');
    fireEvent.click(toggle);
    expect(within(section).queryByRole('list', { name: 'Stage map' })).toBeNull();
  });
});
