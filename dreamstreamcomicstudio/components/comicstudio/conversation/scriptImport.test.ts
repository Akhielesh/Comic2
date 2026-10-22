import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { fdxToText, importScriptFile, scriptKindOf, tidyScript, ScriptImportError } from './scriptImport';

const FDX = `<?xml version="1.0" encoding="UTF-8"?>
<FinalDraft DocumentType="Script" Template="No" Version="5">
  <Content>
    <Paragraph Type="Scene Heading"><Text>int. kitchen - night</Text></Paragraph>
    <Paragraph Type="Action"><Text>Three siblings sit around the table.</Text></Paragraph>
    <Paragraph Type="Character"><Text>Priya</Text></Paragraph>
    <Paragraph Type="Parenthetical"><Text>tired</Text></Paragraph>
    <Paragraph Type="Dialogue"><Text>We scan it. </Text><Text>Everyone gets a copy.</Text></Paragraph>
    <Paragraph Type="Transition"><Text>cut to:</Text></Paragraph>
  </Content>
  <TitlePage><Content><Paragraph><Text>MOTHER'S BOOK</Text></Paragraph></Content></TitlePage>
</FinalDraft>`;

describe('script import', () => {
  it('routes files to the right importer', () => {
    expect(scriptKindOf('Draft.DOCX')).toBe('docx');
    expect(scriptKindOf('script.pdf')).toBe('pdf');
    expect(scriptKindOf('pilot.fdx')).toBe('fdx');
    expect(scriptKindOf('pilot.fountain')).toBe('fountain');
    expect(scriptKindOf('notes', 'text/plain')).toBe('text');
    expect(scriptKindOf('photo.png', 'image/png')).toBeNull();
  });

  it('converts Final Draft XML to screenplay text and ignores the title page', () => {
    const text = fdxToText(FDX);
    expect(text).toBe('INT. KITCHEN - NIGHT\n\nThree siblings sit around the table.\n\nPRIYA\n(tired)\nWe scan it. Everyone gets a copy.\n\nCUT TO:');
    expect(text).not.toContain("MOTHER'S BOOK");
  });

  it('tidies extraction noise', () => {
    expect(tidyScript('a  \r\n\r\n\r\n\r\nb\t\tc')).toBe('a\n\nb c');
  });

  it('reads a real .docx (mammoth) end to end', async () => {
    // Minimal valid WordprocessingML package.
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>PAGE ONE</w:t></w:r></w:p><w:p><w:r><w:t>Maya runs through the market.</w:t></w:r></w:p></w:body></w:document>');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const file = new File([bytes as BlobPart], 'draft.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const out = await importScriptFile(file);
    expect(out).toMatchObject({ kind: 'docx', truncated: false });
    expect(out.text).toBe('PAGE ONE\n\nMaya runs through the market.');
  });

  it('rejects unsupported and oversized files with a friendly message', async () => {
    await expect(importScriptFile(new File(['x'], 'photo.png', { type: 'image/png' }))).rejects.toBeInstanceOf(ScriptImportError);
    const big = new File(['x'], 'huge.txt', { type: 'text/plain' });
    Object.defineProperty(big, 'size', { value: 16 * 1024 * 1024 });
    await expect(importScriptFile(big)).rejects.toThrow(/larger than 15 MB/);
  });
});

describe('PDF scripts (pdf.js)', () => {
  it('extracts selectable text from a real PDF', async () => {
    const { PDFDocument, StandardFonts } = await import('@cantoo/pdf-lib');
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([400, 400]);
    page.drawText('INT. MARKET - DAY', { x: 40, y: 340, size: 14, font });
    page.drawText('Maya sprints between the spice stalls.', { x: 40, y: 310, size: 12, font });
    const bytes = await pdf.save();
    const out = await importScriptFile(new File([bytes as BlobPart], 'script.pdf', { type: 'application/pdf' }));
    expect(out.kind).toBe('pdf');
    expect(out.text).toContain('INT. MARKET - DAY');
    expect(out.text).toContain('Maya sprints between the spice stalls.');
  }, 20_000);
});
