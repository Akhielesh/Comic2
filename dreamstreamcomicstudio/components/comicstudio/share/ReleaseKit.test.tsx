import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicationOwnerView } from '../../../shared/comic/publication';
import { parseShareParams } from '../../../shared/comic/publication';
import { COMICS_ORIGIN } from '../../../services/productHost';
import { ReleaseKit } from './ReleaseKit';
import { releasePost, releasePostText, xWeight, X_POST_LIMIT, type ReleaseChannel } from './releasePosts';

const slug = 'Ab3dEf6hIj9kLm2nP';
const signed = 'https://storage.example/storage/v1/object/sign/comic-private/private.webp?token=private-fixture';
const view: PublicationOwnerView = {
  status: 'live', visibility: 'unlisted', slug, publishedRev: 8, docRev: 9, behind: false, publishedAt: 100,
  languages: ['en'], defaultLang: 'en', allowDownload: true, allowEmbed: true, showCreator: false,
  url: signed, ogImageUrl: signed, rating: 'PG',
  card: { title: 'Paper Town', description: 'A mapmaker follows a missing street.', pageCount: 8, coverUrl: signed },
  readiness: { ok: true, drawnPages: 8, plannedPages: 8, missing: [], stalePages: [], safety: { status: 'cleared', blockedPages: [], reasons: [] }, languages: [] }
};
const channels: ReleaseChannel[] = ['email','whatsapp','x','facebook','telegram','linkedin'];
const open = () => fireEvent.click(screen.getByText('Plan a release post'));
const switchChannel = (value: ReleaseChannel) => fireEvent.change(screen.getByLabelText('Where will you share it?'), { target: { value } });
const setText = (value: string) => fireEvent.change(screen.getByLabelText('Post text'), { target: { value } });
afterEach(() => vi.unstubAllGlobals());

describe('release materials', () => {
  it('gives each channel distinct writing, proven publication facts and the matching reader link', () => {
    const bodies = new Set<string>();
    for (const channel of channels) {
      const post = releasePost(view, channel, 'read')!;
      bodies.add(post.body);
      const text = releasePostText(post);
      expect(text).toContain('Paper Town');
      expect(text).toContain('Rated PG');
      expect(text).not.toContain('storage.example');
      const link = new URL(post.footer.split('\n').at(-1)!);
      expect(link.origin + link.pathname).toEqual(COMICS_ORIGIN + '/c/' + slug);
      expect(parseShareParams(link.search)).toEqual({ via: channel });
      expect(releasePost(view, channel, 'feedback')!.body).not.toEqual(post.body);
    }
    expect(bodies.size).toBe(channels.length);
    expect(releasePost(view, 'email', 'read')!.subject).toContain('Paper Town');
    expect(releasePost(view, 'linkedin', 'read')!.body).toContain('I’ve published');
    expect(releasePost(view, 'whatsapp', 'feedback')!.body).toContain('Message me');
  });

  it('bounds long Unicode X copy at full grapheme boundaries with the rating and tagged URL intact', () => {
    const name = '👩🏽‍🎨';
    const long = { ...view, card: { title: name.repeat(90), description: '界'.repeat(200) + ' ' + signed } };
    for (const goal of ['read','feedback'] as const) {
      const post = releasePost(long, 'x', goal)!;
      const text = releasePostText(post);
      expect(xWeight(text)).toBeLessThanOrEqual(X_POST_LIMIT);
      expect(post.body.split('\n')[0].replaceAll(name,'')).toBe('…');
      expect(text).toMatch(/Rated PG\nhttps:\/\/[^\s]+\?via=x$/);
      expect(text).not.toContain('private-fixture');
    }
    const withLink = { ...view, card: { title: 'Book', description: 'Read this ' + signed } };
    expect(releasePostText(releasePost(withLink, 'whatsapp', 'read')!)).not.toContain('storage.example');
    expect(releasePost({ ...view, slug: '../bad' }, 'email', 'read')).toBeNull();
    expect(releasePost({ ...view, visibility: 'private' }, 'email', 'read')).toBeNull();
  });

  it('keeps edited subject, body and goals separate by channel while the same edition stays open', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText }, userAgent: 'test' });
    const { rerender } = render(<ReleaseKit view={view} ownerId="owner-a" projectId="book-a" />);
    open();
    fireEvent.change(screen.getByLabelText('Email subject'), { target:{ value:'A note for Sam' } });
    fireEvent.change(screen.getByLabelText('Email body'), { target:{ value:'I thought you would like page four.' } });
    fireEvent.click(screen.getByRole('button', {name:'Copy subject'}));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('A note for Sam'));
    switchChannel('whatsapp');
    setText('Read this on your break.');
    fireEvent.change(screen.getByLabelText('Goal'), { target:{ value:'feedback' } });
    expect((screen.getByLabelText('Post text') as HTMLTextAreaElement).value).toContain('Message me');
    setText('How was the ending?');
    fireEvent.change(screen.getByLabelText('Goal'), { target:{ value:'read' } });
    expect(screen.getByLabelText('Post text')).toHaveValue('Read this on your break.');
    switchChannel('email');
    rerender(<ReleaseKit view={{ ...view, docRev: 10, behind: true }} ownerId="owner-a" projectId="book-a" />);
    expect(screen.getByLabelText('Email subject')).toHaveValue('A note for Sam');
    expect(screen.getByLabelText('Email body')).toHaveValue('I thought you would like page four.');
    fireEvent.click(screen.getByRole('button',{ name:'Copy email body' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(`I thought you would like page four.\n\nRated PG\n${COMICS_ORIGIN}/c/${slug}?via=email`));
  });

  it.each([
    ['member','another-member','book-a',view],
    ['project','owner-a','book-b',view],
    ['slug','owner-a','book-a',{ ...view, slug:'Ac3dEf6hIj9kLm2nP' }],
    ['revision','owner-a','book-a',{ ...view,publishedRev:9 }],
    ['edition','owner-a','book-a',{ ...view, defaultLang:'hi',languages:['en','hi'] }],
    ['published time','owner-a','book-a',{ ...view,publishedAt:101 }]
  ] as const)('clears temporary copy synchronously for a different %s', (_reason, owner, project, current) => {
    const { rerender } = render(<ReleaseKit view={view} ownerId="owner-a" projectId="book-a" />);
    open();
    fireEvent.change(screen.getByLabelText('Email body'), { target:{ value:'Unsent private editorial note' } });
    rerender(<ReleaseKit view={{ ...current,languages:[...current.languages] }} ownerId={owner} projectId={project} />);
    open();
    expect(screen.getByLabelText('Email body')).not.toHaveValue('Unsent private editorial note');
    expect(screen.getByText(/\?via=email/)).toHaveTextContent(`/c/${current.slug}?via=email`);
  });

  it('blocks copying an oversize X edit or signed storage URL and preserves edits for correction', () => {
    render(<ReleaseKit view={view} ownerId="owner-a" projectId="book-a" />);
    open(); switchChannel('x'); setText('界'.repeat(300));
    expect(screen.getByRole('button',{name:'Copy post'})).toBeDisabled();
    expect(screen.getByLabelText('Post text')).toHaveValue('界'.repeat(300));
    setText(signed);
    expect(screen.getByRole('alert')).toHaveTextContent('Remove the private file link');
    expect(screen.getByRole('button',{name:'Copy post'})).toBeDisabled();
    setText('Read the comic.');
    expect(screen.getByRole('button',{name:'Copy post'})).toBeEnabled();
  });
});
