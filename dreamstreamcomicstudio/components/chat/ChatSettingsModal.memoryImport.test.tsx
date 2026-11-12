// @vitest-environment jsdom
// MEM-IMPORT-1: the memory import sends only the user's own words. A file or paste in which none can
// be found (e.g. a Google Takeout activity file whose entries are the assistant's answers) makes no
// request, and a calm inline notice says so: role="status", the info tone recipe, never red.
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { importChatMemory } = vi.hoisted(() => ({ importChatMemory: vi.fn() }));
vi.mock('../../services/chatApi', () => ({ importChatMemory }));
// The other tabs are never shown here; stub them so the test loads only the Memory tab.
vi.mock('./SystemDashboard', () => ({ SystemDashboard: () => null }));
vi.mock('./ComponentGallery', () => ({ ComponentGallery: () => null }));
vi.mock('./RecipeStudio', () => ({ RecipeStudio: () => null }));
vi.mock('./ToolsDashboard', () => ({ ToolsDashboard: () => null }));
vi.mock('../connectors/ConnectorsPage', () => ({ ConnectorsPage: () => null }));

import { ChatSettingsModal } from './ChatSettingsModal';
import { TONE_TEXT } from './studioDesign';

const FILE_NOTICE = "We couldn't find your own words in that file, so nothing was sent.";
const TEXT_NOTICE = "We couldn't find your own words in that text, so nothing was sent.";

/** The review's probe: Takeout-shaped activity entries whose titles hold none of the user's words. */
const TAKEOUT_UNRECOGNISED = JSON.stringify([
  {
    header: 'Gemini Apps',
    title: 'Used Gemini Apps',
    time: '2026-05-01T12:00:00.000Z',
    products: ['Gemini Apps'],
    safeHtmlItem: [{ html: '<p>ASSISTANT ANSWER: try a lentil curry</p>' }]
  },
  { header: 'Gemini Apps', title: 'what should I cook', safeHtmlItem: [{ html: 'ASSISTANT ANSWER: pasta' }] }
]);

/** A prompt/answer layout with no role marker: the answer sits under a generic `text` key. */
const PROMPT_RESPONSE = JSON.stringify([{ prompt: 'I am vegan', response: { text: 'ASSISTANT ANSWER: try tofu' } }]);

const CHATGPT_EXPORT = JSON.stringify([
  {
    title: 'Dinner ideas',
    mapping: {
      a: { message: { author: { role: 'user' }, content: { content_type: 'text', parts: ['I am vegetarian'] } } },
      b: { message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['ASSISTANT: try a dal'] } } }
    }
  }
]);

const renderMemoryTab = () =>
  render(
    <ChatSettingsModal userId="u-test" initialTab="memory" onMemoryChange={() => {}} onAgentsChange={() => {}} onClose={() => {}} />
  );

/** Upload a file through the hidden input (Blob.text is not in jsdom, so the file carries its own). */
const upload = async (content: string, name = 'MyActivity.json') => {
  const file = new File([content], name, { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(content) });
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
  });
};

const importButton = () => screen.getByRole('button', { name: 'Import' });

describe('ChatSettingsModal memory import: only the user’s own words are sent', () => {
  beforeEach(() => {
    importChatMemory.mockReset();
    importChatMemory.mockResolvedValue({ memory: '- Vegetarian' });
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('a Takeout-shaped file with none of the user’s words makes no request and shows the calm notice', async () => {
    renderMemoryTab();
    // The live region is in the page, empty, before anything is said into it.
    expect(screen.getByRole('status').textContent).toBe('');
    await upload(TAKEOUT_UNRECOGNISED);
    expect((screen.getByPlaceholderText(/memories or instructions here/) as HTMLTextAreaElement).value).toBe(TAKEOUT_UNRECOGNISED);
    await act(async () => {
      fireEvent.click(importButton());
    });

    expect(importChatMemory).not.toHaveBeenCalled();
    const notice = screen.getByRole('status');
    expect(notice.textContent).toBe(FILE_NOTICE);
    // The info tone on its icon, ink words, and no red anywhere in it.
    expect(notice.querySelector('svg')?.getAttribute('class')).toContain(TONE_TEXT.info);
    expect(notice.outerHTML).not.toMatch(/red-\d/);
    // No preview and no error alongside it.
    expect(screen.queryByText(/Preview ·/)).toBeNull();
  });

  it('pasted JSON with none of the user’s words names the text, makes no request, and clears when edited', async () => {
    renderMemoryTab();
    const box = screen.getByPlaceholderText(/memories or instructions here/);
    fireEvent.change(box, { target: { value: JSON.stringify({ id: 'abc', create_time: 123 }) } });
    await act(async () => {
      fireEvent.click(importButton());
    });
    expect(importChatMemory).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe(TEXT_NOTICE);

    fireEvent.change(box, { target: { value: 'I am vegetarian' } });
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('a prompt/answer file whose answer sits under a generic text key makes no request and shows the notice', async () => {
    renderMemoryTab();
    await upload(PROMPT_RESPONSE, 'export.json');
    await act(async () => {
      fireEvent.click(importButton());
    });
    expect(importChatMemory).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe(FILE_NOTICE);
  });

  it('a repeat Import of the same file says the notice again (its words are re-inserted into the live region)', async () => {
    renderMemoryTab();
    await upload(TAKEOUT_UNRECOGNISED);
    await act(async () => {
      fireEvent.click(importButton());
    });
    const region = screen.getByRole('status');
    const firstWords = region.querySelector('span');
    expect(firstWords?.textContent).toBe(FILE_NOTICE);

    await act(async () => {
      fireEvent.click(importButton());
    });
    expect(importChatMemory).not.toHaveBeenCalled();
    // The same always-mounted region, fresh words inside it.
    expect(screen.getByRole('status')).toBe(region);
    const secondWords = region.querySelector('span');
    expect(secondWords?.textContent).toBe(FILE_NOTICE);
    expect(secondWords).not.toBe(firstWords);
  });

  it('a ChatGPT export still sends only the user’s turns, with no notice', async () => {
    renderMemoryTab();
    await upload(CHATGPT_EXPORT, 'conversations.json');
    await act(async () => {
      fireEvent.click(importButton());
    });

    expect(importChatMemory).toHaveBeenCalledTimes(1);
    const [source, content] = importChatMemory.mock.calls[0];
    expect(source).toBe('chatgpt');
    expect(content).toBe('I am vegetarian');
    expect(screen.queryByText(FILE_NOTICE)).toBeNull();
    expect(await screen.findByText(/Preview ·/)).toBeTruthy();
  });

  it('plain text is sent as written', async () => {
    renderMemoryTab();
    fireEvent.change(screen.getByPlaceholderText(/memories or instructions here/), {
      target: { value: '  - Prefers metric units\n- Works in Lisbon  ' }
    });
    await act(async () => {
      fireEvent.click(importButton());
    });
    expect(importChatMemory).toHaveBeenCalledTimes(1);
    expect(importChatMemory.mock.calls[0][1]).toBe('- Prefers metric units\n- Works in Lisbon');
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('a new file replaces the notice: the next upload with the user’s words imports', async () => {
    renderMemoryTab();
    await upload(TAKEOUT_UNRECOGNISED);
    await act(async () => {
      fireEvent.click(importButton());
    });
    expect(screen.getByRole('status').textContent).toBe(FILE_NOTICE);

    await upload(CHATGPT_EXPORT, 'conversations.json');
    expect(screen.getByRole('status').textContent).toBe('');
    await act(async () => {
      fireEvent.click(importButton());
    });
    expect(importChatMemory).toHaveBeenCalledTimes(1);
    expect(importChatMemory.mock.calls[0][1]).toBe('I am vegetarian');
  });
});
