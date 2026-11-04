import React from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PrivacyPolicy } from './PrivacyPolicy';

const USER_DATA_POLICY = 'https://developers.google.com/terms/api-services-user-data-policy';

const googleSection = (): HTMLElement => {
  const { container } = render(<PrivacyPolicy onBack={vi.fn()} />);
  const section = container.querySelector<HTMLElement>('#google-user-data');
  if (!section) throw new Error('missing #google-user-data section');
  return section;
};

const textOf = (el: Element): string => (el.textContent || '').replace(/\s+/g, ' ').trim();

describe('privacy policy: Google user data (OAuth verification)', () => {
  afterEach(() => {
    window.location.hash = '';
    vi.restoreAllMocks();
  });

  it('has a stable #google-user-data anchor with a labelled heading', () => {
    const section = googleSection();
    expect(section.tagName).toBe('SECTION');
    expect(within(section).getByRole('heading', { level: 2, name: /Google User Data/i })).toBeInTheDocument();
    expect(section).toHaveAttribute('aria-labelledby', 'google-user-data-title');
  });

  it('carries both Limited Use statements verbatim, linked to the User Data Policy', () => {
    const section = googleSection();
    const text = textOf(section);
    expect(text).toContain(
      "DreamStream Studio's use and transfer of information received from Google APIs to any other app will adhere to the Google API Services User Data Policy, including the Limited Use requirements."
    );
    expect(text).toContain(
      'The use of information received from Google Workspace APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements.'
    );
    const policyLinks = within(section).getAllByRole('link', { name: 'Google API Services User Data Policy' });
    expect(policyLinks).toHaveLength(2);
    for (const a of policyLinks) expect(a).toHaveAttribute('href', USER_DATA_POLICY);
  });

  it('lists every OAuth scope the connectors request (server/src/connectors/connectors/*.ts)', () => {
    const text = textOf(googleSection());
    for (const scope of [
      'userinfo.email',
      'userinfo.profile',
      'gmail.readonly',
      'drive.readonly',
      'drive.file',
      'calendar.events',
      'spreadsheets.readonly',
      'youtube.readonly'
    ]) {
      expect(text).toContain(scope);
    }
  });

  it('names who receives the data and rules out sale and advertising', () => {
    const text = textOf(googleSection());
    expect(text).toMatch(/We do not sell Google user data/);
    expect(text).toMatch(/advertising platforms, data brokers or information resellers/);
    for (const provider of ['Cloudflare', 'Supabase', 'OpenRouter', 'Anthropic', 'OpenAI', 'Google (Gemini)']) {
      expect(text).toContain(provider);
    }
    expect(text).toMatch(/to generate the response you asked for/);
    expect(text).toMatch(/explicit prior consent/);
  });

  it('names follow-up suggestions as a purpose, since FollowUpChips sends the last turns after every answer', () => {
    const section = googleSection();
    // components/chat/FollowUpChips.tsx posts the last 6 turns (answers included) to /chat/followups,
    // which runs them through the chat's provider (server/src/routes/chat.ts).
    expect(textOf(section)).toMatch(/to suggest follow-up questions \(shown under the answer as "You might ask"\)/);
    const providers = within(section).getByText(/and the AI providers described under AI processing/);
    expect(textOf(providers)).toMatch(/generate the response you asked for, suggest follow-up questions, and write and index your memory notes/);
  });

  it('names the services the model\'s tools contact, since tool requests can carry connected-account details', () => {
    const section = googleSection();
    const text = textOf(section);
    // web_search/read_url are always offered (toolCatalog.ts CORE_ALWAYS_TOOLS), Context7/DeepWiki
    // and user MCP servers join when tools are in use (server/src/routes/chat.ts).
    for (const recipient of ['Tavily', 'Brave Search', 'SearXNG', 'Bing', 'Wikipedia', 'Context7', 'DeepWiki', 'MCP servers you add']) {
      expect(text).toContain(recipient);
    }
    const shareList = within(section).getByText(/to the services the AI model uses while answering you/);
    expect(shareList.tagName).toBe('LI');
    // read_url falls back to the Jina Reader proxy (server/src/ai/tools/readArticle.ts readViaJina).
    expect(text).toContain('through the Jina Reader service');
    expect(textOf(shareList)).toContain('the page-reading service it uses');
  });

  it('describes memory as it works: automatic, saved to the account, Gemini-indexed, deleted by email', () => {
    const text = textOf(googleSection());
    expect(text).toMatch(/keeps memory notes automatically/);
    expect(text).toMatch(/sent to Google's Gemini API to make it searchable/);
    expect(text).toMatch(/memory cannot yet be turned off in the app/);
    expect(text).toMatch(/does not delete the copy saved to your account/);
    // Settings → Memory only edits the synced list (services/chatStorage.ts), not user_memories.
    expect(text).not.toMatch(/turn off memory in Chat Studio/i);
    expect(text).not.toMatch(/memory notes under Settings → Memory\./);
  });

  it('says memory goes with every later chat, not only matching ones', () => {
    const text = textOf(googleSection());
    // The whole Settings → Memory list rides on every request (AIChatPlatform composeSystemPrompt), and
    // buildUserMemoryBlock adds the nearest or most recent saved notes with no relevance cutoff.
    expect(text).toMatch(/included in every request Chat Studio sends to the AI model in your later chats, not only the ones they relate to/);
    expect(text).toMatch(/the full list shown in Settings → Memory in Chat Studio, plus up to eight of the notes saved to your account/);
    expect(text).not.toMatch(/notes that match a later message/);
  });

  it('carries the YouTube API Services notice and links the Google Privacy Policy', () => {
    const section = googleSection();
    expect(textOf(section)).toContain('DreamStream uses YouTube API Services.');
    expect(within(section).getByRole('link', { name: 'Google Privacy Policy' })).toHaveAttribute(
      'href',
      'https://policies.google.com/privacy'
    );
  });

  it('explains revocation, in-app disconnect and the privacy contact', () => {
    const section = googleSection();
    expect(within(section).getByRole('link', { name: /myaccount\.google\.com\/connections/ })).toHaveAttribute(
      'href',
      'https://myaccount.google.com/connections'
    );
    expect(textOf(section)).toMatch(/Settings → Connectors and choose Disconnect/);
    for (const a of within(section).getAllByRole('link', { name: 'privacy@dreamstreamstudio.ai' })) {
      expect(a).toHaveAttribute('href', 'mailto:privacy@dreamstreamstudio.ai');
    }
  });

  it('shows the updated date and an email contact instead of only the in-app flow', () => {
    render(<PrivacyPolicy onBack={vi.fn()} />);
    expect(screen.getByText('November 4, 2026')).toHaveAttribute('dateTime', '2026-11-04');
    const contact = screen.getByRole('heading', { name: /12\. Contact/ }).closest('section') as HTMLElement;
    expect(within(contact).getByRole('link', { name: 'privacy@dreamstreamstudio.ai' })).toBeInTheDocument();
    // Account Settings still shows an address on a domain we don't own; don't send requesters there.
    expect(textOf(contact)).not.toMatch(/Account Settings/);
  });

  it('scrolls to the #google-user-data fragment once the lazily-loaded view mounts', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    window.location.hash = '#google-user-data';
    render(<PrivacyPolicy onBack={vi.fn()} />);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toHaveProperty('id', 'google-user-data');
  });

  it('survives a malformed #fragment instead of throwing into the error boundary', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    window.location.hash = '#%E0%A4';
    expect(() => render(<PrivacyPolicy onBack={vi.fn()} />)).not.toThrow();
    expect(screen.getByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeInTheDocument();
    expect(scroll).not.toHaveBeenCalled();
  });

  it('uses theme tokens only, so it reads in light and dark', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'PrivacyPolicy.tsx'), 'utf8');
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/\b(?:bg|text|border)-(?:white|black|slate-\d+|gray-\d+)\b/);
  });
});
