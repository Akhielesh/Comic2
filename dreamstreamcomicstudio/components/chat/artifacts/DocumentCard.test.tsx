// W1.9: "Word (.docx)" on a chat document. Shown only where the platform rollout admits the person
// (platformDocsVisible(useIsAdmin()): the VITE_PLATFORM_DOCS build var and the stage); it builds the file with
// exportMarkdownDocx and saves it with downloadPlatformFile, and a failure shows friendlyExportError.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const exporter = vi.hoisted(() => ({ exportMarkdownDocx: vi.fn(), downloadPlatformFile: vi.fn() }));
vi.mock('../../../services/platformExport', () => exporter);
const admin = vi.hoisted(() => ({ value: true }));
vi.mock('../../../hooks/useIsAdmin', () => ({ useIsAdmin: () => admin.value }));

import { DocumentCard } from './DocumentCard';
import { ExportError } from '../../comicstudio/export/errors';

const doc = { title: 'Launch checklist', content: '## Before Friday\n\n- Print the RSVP list\n- Test the projector' };
const file = { blob: new Blob(['x']), fileName: 'Launch checklist.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 1 };
const word = () => screen.queryByRole('button', { name: /word \(\.docx\)/i });

beforeEach(() => {
  admin.value = true;
  exporter.exportMarkdownDocx.mockReset().mockResolvedValue(file);
  exporter.downloadPlatformFile.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe('DocumentCard: Word (.docx)', () => {
  it('is hidden with VITE_PLATFORM_DOCS unset or off, admins included', () => {
    for (const value of ['', 'off']) {
      vi.stubEnv('VITE_PLATFORM_DOCS', value);
      const { unmount } = render(<DocumentCard data={doc} />);
      expect(word()).toBeNull();
      unmount();
    }
  });

  it('is hidden for a non-admin at stage admins', () => {
    vi.stubEnv('VITE_PLATFORM_DOCS', 'on');
    admin.value = false;
    render(<DocumentCard data={doc} />);
    expect(word()).toBeNull();
  });

  it('for an admin with the kill switch on: exportMarkdownDocx, then downloadPlatformFile', async () => {
    vi.stubEnv('VITE_PLATFORM_DOCS', 'on');
    render(<DocumentCard data={doc} />);
    await act(async () => {
      fireEvent.click(word()!);
    });
    expect(exporter.exportMarkdownDocx).toHaveBeenCalledWith(doc.content, { fileName: doc.title });
    expect(exporter.downloadPlatformFile).toHaveBeenCalledWith(file);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the friendly export error on failure', async () => {
    vi.stubEnv('VITE_PLATFORM_DOCS', 'on');
    exporter.exportMarkdownDocx.mockRejectedValueOnce(new ExportError("Word files can't hold this picture format."));
    render(<DocumentCard data={doc} />);
    await act(async () => {
      fireEvent.click(word()!);
    });
    expect(screen.getByRole('alert').textContent).toBe("Word files can't hold this picture format.");
    expect(exporter.downloadPlatformFile).not.toHaveBeenCalled();
  });
});
