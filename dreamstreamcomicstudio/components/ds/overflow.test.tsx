/**
 * Long words stay inside their boxes (SPEC-overflow §3.1, §3.3, §3.4; docs/design/design-system.md "Long words"): the
 * three recipes, the text recipes that carry the long-word rule, the Badge / Button label spans (and every
 * `buttonClasses()` element that uses them), and ErrorState's description element.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Check, X } from 'lucide-react';
import { CLIP_TEXT, SECTION_BODY, SECTION_DESCRIPTION, TWO_LINE_TEXT, WRAP_TEXT } from './recipes';
import { INLINE_TITLE, STATE_DESCRIPTION, STATE_TITLE } from './stateParts';
import { FIELD_DESCRIPTION } from './Field';
import { CARD_DESCRIPTION, CARD_TITLE } from './Card';
import { Badge } from './Badge';
import { Button, BUTTON_BASE, labelChildren } from './Button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from './AlertDialog';
import { ComicCard } from './ComicCard';
import { ErrorState } from './ErrorState';
import { MessageText } from './MessageText';

const ID60 = 'google/gemini-3-pro-image-preview-experimental-20261101-a1b2c3';
const tokens = (s: string) => s.split(/\s+/).filter(Boolean);
const hasAll = (recipe: string, part: string) => tokens(part).every((t) => tokens(recipe).includes(t));

afterEach(() => vi.restoreAllMocks());

describe('the long-word recipes', () => {
  it('WRAP_TEXT, CLIP_TEXT and TWO_LINE_TEXT are exactly the documented classes', () => {
    expect(WRAP_TEXT).toBe('min-w-0 [overflow-wrap:anywhere]');
    expect(CLIP_TEXT).toBe('min-w-0 truncate');
    expect(TWO_LINE_TEXT).toBe('min-w-0 [overflow-wrap:anywhere] line-clamp-2');
  });

  it.each([
    ['STATE_TITLE', STATE_TITLE],
    ['STATE_DESCRIPTION', STATE_DESCRIPTION],
    ['INLINE_TITLE', INLINE_TITLE],
    ['FIELD_DESCRIPTION', FIELD_DESCRIPTION],
    ['SECTION_DESCRIPTION', SECTION_DESCRIPTION],
    ['CARD_TITLE', CARD_TITLE],
    ['CARD_DESCRIPTION', CARD_DESCRIPTION]
  ])('%s carries the long-word rule (both WRAP_TEXT tokens)', (_name, recipe) => {
    expect(hasAll(recipe, WRAP_TEXT), recipe).toBe(true);
  });

  it('SECTION_BODY does not: a container rule would lower the min-content of every row inside it', () => {
    expect(tokens(SECTION_BODY)).not.toContain('[overflow-wrap:anywhere]');
  });
});

describe('Badge: the label inside its edge', () => {
  const stubWidths = (scroll: number, client: number) => {
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(scroll);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(client);
  };

  it('a long name sits in one CLIP_TEXT span and has no title while it is not known to be cut', () => {
    render(<Badge>{ID60}</Badge>);
    const badge = document.querySelector('[data-slot="badge"]')!;
    const label = badge.querySelector(':scope > span.min-w-0.truncate');
    expect(label?.textContent).toBe(ID60);
    expect(badge.hasAttribute('title')).toBe(false);
  });

  it('pointerenter sets the title only when the label is cut, and clears it when it is not', () => {
    render(<Badge>{ID60}</Badge>);
    const badge = document.querySelector<HTMLElement>('[data-slot="badge"]')!;
    stubWidths(300, 100);
    fireEvent.pointerEnter(badge);
    expect(badge.getAttribute('title')).toBe(ID60);
    stubWidths(100, 100);
    fireEvent.pointerEnter(badge);
    expect(badge.hasAttribute('title')).toBe(false);
  });

  it("a caller's own title is never replaced, and its own pointerenter still runs", () => {
    const onPointerEnter = vi.fn();
    render(
      <Badge title="Model in use" onPointerEnter={onPointerEnter}>
        {ID60}
      </Badge>
    );
    const badge = document.querySelector<HTMLElement>('[data-slot="badge"]')!;
    stubWidths(300, 100);
    fireEvent.pointerEnter(badge);
    expect(badge.getAttribute('title')).toBe('Model in use');
    expect(onPointerEnter).toHaveBeenCalledTimes(1);
  });

  it('an icon stays a direct child (its [&>svg] sizing still applies); the words get the span', () => {
    render(
      <Badge>
        <Check aria-hidden="true" /> Done
      </Badge>
    );
    const badge = document.querySelector('[data-slot="badge"]')!;
    expect(badge.querySelector(':scope > svg')).not.toBeNull();
    expect(badge.querySelector(':scope > [data-slot="badge-label"]')?.textContent).toBe(' Done');
  });
});

describe('Button: the label inside its edge', () => {
  it('`{n} pages` is ONE label span, and the full text stays the accessible name', () => {
    render(<Button>{3} pages</Button>);
    const button = screen.getByRole('button', { name: '3 pages' });
    const labels = button.querySelectorAll('[data-slot="button-label"]');
    expect(labels).toHaveLength(1);
    expect(labels[0].textContent).toBe('3 pages');
    expect(tokens(labels[0].className)).toEqual(expect.arrayContaining(tokens(CLIP_TEXT)));
  });

  it('BUTTON_BASE caps the button at its row (max-w-full) and keeps verbs unsquashed (shrink-0)', () => {
    expect(tokens(BUTTON_BASE)).toEqual(expect.arrayContaining(['max-w-full', 'shrink-0', 'whitespace-nowrap']));
  });

  it('an icon-only button gets no label span; an icon beside words stays a direct child', () => {
    render(
      <>
        <Button size="icon" aria-label="Close">
          <X />
        </Button>
        <Button>
          <Check /> Save
        </Button>
      </>
    );
    expect(screen.getByRole('button', { name: 'Close' }).querySelector('[data-slot="button-label"]')).toBeNull();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save.querySelector(':scope > svg')).not.toBeNull();
    expect(save.querySelector(':scope > [data-slot="button-label"]')?.textContent).toBe(' Save');
  });

  it('labelChildren leaves element-only and empty children as they are', () => {
    const icon = <X />;
    expect(labelChildren(icon)).toBe(icon);
    expect(labelChildren(null)).toBeNull();
    expect(labelChildren('  ')).toBe('  ');
  });

  it("AlertDialogAction and AlertDialogCancel put their words in the same label span", () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Delete page 2?</AlertDialogTitle>
          <AlertDialogDescription>It goes to the bin.</AlertDialogDescription>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction variant="destructive">Delete page</AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog>
    );
    for (const name of ['Keep it', 'Delete page']) {
      expect(screen.getByRole('button', { name }).querySelector('[data-slot="button-label"]')?.textContent).toBe(name);
    }
  });

  it("ComicCard's link action label sits in the label span too", () => {
    render(<ComicCard title="The heist" href="/c/heist" read={{ href: '/read/heist', label: 'Read from page one' }} />);
    const link = document.querySelector('a[data-card-action="read"]')!;
    expect(link.querySelector('[data-slot="button-label"]')?.textContent).toBe('Read from page one');
  });
});

describe('ErrorState: the description element', () => {
  it('a string description renders in a <p>', () => {
    render(<ErrorState title="Couldn't save" description="Try again in a moment." />);
    expect(screen.getByText('Try again in a moment.').tagName).toBe('P');
  });

  it('a node description (a MessageText) renders in a <div>, so no block lands inside a <p>', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const variant of ['panel', 'inline'] as const) {
      const { unmount } = render(<ErrorState variant={variant} title="Couldn't save" description={<MessageText>{`Details: ${ID60}`}</MessageText>} />);
      const message = document.querySelector('[data-slot="message"]')!;
      expect(message.parentElement?.tagName, variant).toBe('DIV');
      expect(tokens(message.parentElement!.className)).toEqual(expect.arrayContaining(tokens(STATE_DESCRIPTION)));
      unmount();
    }
    expect(errors).not.toHaveBeenCalled();
  });
});
