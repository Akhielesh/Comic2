import { userFacingErrorMessage } from '../../services/apiErrors';
import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, Image as ImageIcon, Paperclip, RefreshCw, X } from 'lucide-react';
import { Button } from '../ds/Button';
import { Field } from '../ds/Field';
import { Textarea } from '../ds/Input';
import { Select } from '../ds/Select';
import { IMAGE_PROMPT_LIMIT, IMAGE_RATIOS, MAX_IMAGE_REFS, REF_MIME_TYPES, type SavedStandaloneImage, type ImageFormatChoice, suggestedImageRatio } from '../../shared/standaloneImage';
import { downloadStandalone, loadImageHistory, loadReference, reopenStandalone, renderStandalone, reuseStandalone } from '../../services/standaloneImages';
import { API_KEYS_HREF } from '../usage/links';
import './imageWorkspace.css';

export interface ImageWorkspaceProps { userId: string; onBack: () => void }
type Reference = Awaited<ReturnType<typeof loadReference>>;
const ratioLabels = ['Square · 1:1', 'Landscape · 4:3', 'Portrait · 3:4', 'Wide · 16:9', 'Tall · 9:16'];
const ratios = [{ value: 'auto', label: 'Automatic' }, ...IMAGE_RATIOS.map((value, i) => ({ value, label: ratioLabels[i] }))];
const paperBoatArt = '/assets/comic-sample/indie-risograph-thumb.webp';
const paperBoatPrompt = 'Draw the canal from the paper boat’s point of view as it passes beneath the stone bridge. Keep the coral and teal risograph inks and the texture of the paper.';

function readDraft(key: string): { prompt: string; ratio: ImageFormatChoice } {
  try {
    const draft = JSON.parse(sessionStorage.getItem(key) || '{}');
    return { prompt: typeof draft.prompt === 'string' ? draft.prompt.slice(0, IMAGE_PROMPT_LIMIT) : '',
      ratio: IMAGE_RATIOS.includes(draft.ratio) ? draft.ratio : 'auto' };
  } catch { return { prompt: '', ratio: 'auto' }; }
}

/** Remount on an account switch so the previous account’s files, signed links and pending results never appear. */
export const ImageWorkspace = (props: ImageWorkspaceProps) => <Workspace key={props.userId} {...props} />;

function Workspace({ userId, onBack }: ImageWorkspaceProps) {
  const draftKey = 'dreamstream.image-draft.' + userId;
  const [draft, setDraft] = useState(() => readDraft(draftKey));
  const [refs, setRefs] = useState<Reference[]>([]);
  const [reading, setReading] = useState(false);
  const [working, setWorking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const [setupHint, setSetupHint] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [historyBusy, setHistoryBusy] = useState(true);
  const [images, setImages] = useState<SavedStandaloneImage[]>([]);
  const [selected, setSelected] = useState<SavedStandaloneImage | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState({ offset: 0, version: 0 });
  const fileInput = useRef<HTMLInputElement>(null);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const submitLock = useRef(false);
  const retryId = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    try { sessionStorage.setItem(draftKey, JSON.stringify(draft)); } catch { /* storage disabled */ }
  }, [draft, draftKey]);

  useEffect(() => {
    let active = true;
    setHistoryBusy(true);
    setHistoryError('');
    void loadImageHistory(page.offset).then(result => {
      if (!active) return;
      setImages(current => {
        const next = new Map((page.offset === 0 && page.version > 0 ? [] : current).map(img => [img.imageId, img]));
        for (const image of result.images) next.set(image.imageId, image);
        return [...next.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      });
      setSelected(current => result.images.find(img => img.imageId === current?.imageId) ?? current ?? result.images[0] ?? null);
      setHasMore(result.hasMore);
      setPreviewFailed(false);
    }).catch(e => { if (active) setHistoryError(userFacingErrorMessage(e, 'Could not load your images.')); })
      .finally(() => { if (active) setHistoryBusy(false); });
    return () => { active = false; };
  }, [page]);

  const attach = async (files: File[]) => {
    if (!files.length) return;
    setError('');
    if (refs.length + files.length > MAX_IMAGE_REFS) {
      setError('Choose up to three reference images.'); return;
    }
    setReading(true);
    try {
      const added = await Promise.all(files.map(loadReference));
      setRefs(current => [...current, ...added]);
      retryId.current = undefined;
    } catch (e) { setError(userFacingErrorMessage(e, 'Could not read that image.')); }
    finally { setReading(false); }
  };

  const usePaperBoat = async () => {
    if (reading || working || refs.length) return;
    setReading(true);
    setError('');
    try {
      const response = await fetch(paperBoatArt);
      if (!response.ok) throw new Error('The sample artwork could not load. Try again or add your own reference.');
      const blob = await response.blob();
      const reference = await loadReference(new File([blob], 'The Paper Boat.webp', { type: 'image/webp' }));
      if (!mounted.current) return;
      setRefs([reference]);
      setDraft(current => current.prompt.trim() ? current : { ...current, prompt: paperBoatPrompt });
      retryId.current = undefined;
      promptInput.current?.focus();
    } catch (e) {
      if (mounted.current) setError(userFacingErrorMessage(e, 'Could not attach the sample artwork.'));
    } finally {
      if (mounted.current) setReading(false);
    }
  };

  const generate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitLock.current || reading) return;
    if (!draft.prompt.trim()) { setError('Describe the image you want to make.'); promptInput.current?.focus(); return; }
    submitLock.current = true;
    setWorking(true); setError(''); setSetupHint('');
    try {
      retryId.current ??= crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');
      const image = await renderStandalone(userId, draft.prompt, draft.ratio, refs.map(ref => ref.data), retryId.current);
      if (mounted.current) {
        setSelected(image);
        setPreviewFailed(false);
        setImages(current => [image, ...current.filter(item => item.imageId !== image.imageId)]);
        retryId.current = undefined;
      }
    } catch (e) {
      if (mounted.current) {
        const message = userFacingErrorMessage(e, 'Image generation paused. Try again in a moment.');
        if (/api key|key missing|key (?:was )?rejected|invalid key/i.test(message)) {
          setSetupHint('Connect a Gemini key in Settings, then return here to generate your image.');
        } else if ((e as { status?: number } | null)?.status === 402 || /insufficient (?:funds|credits)|out of credits|allowance.*(?:used|exhausted)|billing.*enabled/i.test(message)) {
          setSetupHint('Check your remaining allowance or your Gemini billing account. You can return here with the same prompt and references.');
        } else setError(message);
      }
    }
    finally { submitLock.current = false; if (mounted.current) setWorking(false); }
  };

  const reuseImage = async () => {
    if (!selected || reading || working || refs.length >= MAX_IMAGE_REFS) return;
    setReading(true); setError('');
    try {
      const ref = await reuseStandalone(selected);
      if (mounted.current) {
        setRefs(current => [...current, ref]);
        retryId.current = undefined;
        promptInput.current?.focus();
        promptInput.current?.select();
      }
    } catch (e) { setError(userFacingErrorMessage(e, 'Could not attach this image.')); }
    finally { setReading(false); }
  };

  const download = async () => {
    if (!selected || downloading) return;
    setDownloading(true); setError('');
    try { await downloadStandalone(selected); }
    catch (e) { setError(userFacingErrorMessage(e, 'Download failed. Please try again.')); }
    finally { setDownloading(false); }
  };
  const refresh = () => {
    if (previewFailed && selected) {
      setError('');
      const imageId = selected.imageId;
      void reopenStandalone(selected).then(fresh => {
        if (!mounted.current) return;
        setImages(current => current.map(item => item.imageId === imageId ? fresh : item));
        setSelected(current => current?.imageId === imageId ? fresh : current);
        setPreviewFailed(false);
      }).catch(e => { if (mounted.current) setError(userFacingErrorMessage(e, 'Could not reopen this image.')); });
    } else {
      setPage(current => ({ offset: 0, version: current.version + 1 }));
    }
  };

  const inferredRatio = draft.ratio === 'auto' ? suggestedImageRatio(draft.prompt) : undefined;
  const formatSummary = draft.ratio === 'auto' ? `Automatic${inferredRatio ? ' · ' + inferredRatio : ''}` : draft.ratio;

  return (
    <main className="image-workspace">
      <header className="image-workspace-header">
        <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft aria-hidden /> Back</Button>
        <h1>Create an image</h1>
        <p>Tell the studio what you have in mind. It can choose the framing, lighting and style from your description.</p>
      </header>
      <div className="image-workspace-body">
        <form onSubmit={generate} aria-label="Image settings" aria-busy={working} className="image-workspace-form">
          <Field label="Describe your image" required>
            <Textarea ref={promptInput} rows={5} maxLength={IMAGE_PROMPT_LIMIT} value={draft.prompt} disabled={working}
              placeholder="A windswept lighthouse above a midnight sea, in ink and watercolor"
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (!e.repeat && !working && !reading) e.currentTarget.form?.requestSubmit();
                }
              }}
              onChange={e => { setDraft({ ...draft, prompt: e.target.value }); retryId.current = undefined; }} />
          </Field>
          <div className="image-compose-actions">
            <Button type="submit" disabled={reading} loading={working} aria-keyshortcuts="Control+Enter Meta+Enter">{working ? 'Generating image…' : 'Generate image'}</Button>
            <Button type="button" variant="outline" disabled={working || reading || refs.length >= MAX_IMAGE_REFS}
              onClick={() => fileInput.current?.click()}><Paperclip aria-hidden />Add references</Button>
          </div>
          <div className="image-reference-input">
            <input ref={fileInput} type="file" multiple hidden aria-label="Reference image files" accept={REF_MIME_TYPES.join(',')}
              onChange={e => { const files = Array.from(e.target.files || []); e.target.value = ''; void attach(files); }} />
            <small>Up to 3 images · JPG, PNG or WebP · 2 MB each</small>
            {refs.length > 0 && <ul className="image-reference-list">{refs.map((ref, i) => <li key={i}>
              <img alt="" src={ref.data} /><span>{ref.name}</span>
              <Button type="button" variant="ghost" size="icon" disabled={working} aria-label={'Remove ' + ref.name}
                onClick={() => { setRefs(refs.filter((_, index) => index !== i)); retryId.current = undefined; }}><X aria-hidden /></Button>
            </li>)}</ul>}
          </div>
          <details className="image-format-options">
            <summary>Image format <span>{formatSummary}</span></summary>
            <Field label="Aspect ratio" description="Automatic follows the brief. Choose a fixed format if you have a canvas size in mind.">
              <Select options={ratios} value={draft.ratio} disabled={working}
                onChange={e => { setDraft({ ...draft, ratio: e.target.value as ImageFormatChoice }); retryId.current = undefined; }} />
            </Field>
          </details>
          <p className="image-usage">Gemini 2.5 Flash Image · Uses your account’s image allowance or configured Gemini key.</p>
          {setupHint && <p role="status" className="image-usage">{setupHint} <a href={API_KEYS_HREF} target="_blank" rel="noreferrer">Open API keys and usage ↗</a></p>}
          {error && <p role="alert" className="image-workspace-error">{error}</p>}
        </form>
        <section className="image-result" aria-label="Image preview">
          {selected && !previewFailed ? <img className="image-output" src={selected.imageUrl} alt="Your generated image" onError={() => setPreviewFailed(true)} /> :
            previewFailed || working || historyBusy ? (
              <div className="image-placeholder" role="status"><ImageIcon aria-hidden size={36} />
                <span>{previewFailed ? 'The preview link has expired or could not load.' : working ? 'Generating your image…' : 'Loading saved images…'}</span>
                {previewFailed && <Button type="button" variant="outline" onClick={refresh}>Refresh preview</Button>}
              </div>
            ) : refs.length ? (
              <figure className="image-reference-sheet">
                <img src={refs[0].data} alt="First reference for your image" />
                <figcaption><strong>Reference</strong><span>{refs[0].name}</span></figcaption>
              </figure>
            ) : (
              <figure className="image-reference-sheet">
                <img src={paperBoatArt} width={480} height={240} alt="A girl and her dog watch a paper boat from a stone bridge, in coral and teal ink." />
                <figcaption><div><strong>The Paper Boat</strong><span>Studio reference · Risograph</span></div>
                  <Button type="button" variant="outline" disabled={reading} onClick={usePaperBoat}>Try this reference</Button>
                </figcaption>
              </figure>
            )}
          {selected && <div className="image-output-actions">
            <Button type="button" variant="outline" disabled={reading || working || refs.length >= MAX_IMAGE_REFS} onClick={reuseImage}>
              <Paperclip aria-hidden />Use as reference</Button>
            <Button type="button" variant="outline" loading={downloading} onClick={download}>
            <Download aria-hidden />Download image</Button></div>}
        </section>
      </div>
      <section className="image-history" aria-labelledby="image-history-title">
        <div className="image-history-heading"><h2 id="image-history-title">Your images</h2>
          <Button type="button" size="sm" variant="ghost" disabled={historyBusy} onClick={refresh}><RefreshCw aria-hidden />Refresh</Button></div>
        <p role="status" className="image-history-status">{historyError || (historyBusy ? 'Loading saved images…' : !images.length ? 'Your generated images will appear here.' : '')}</p>
        {images.length > 0 && <ul>{images.map((image, index) => <li key={image.imageId}>
          <button type="button" aria-label={`View image ${images.length - index}, ${new Date(image.createdAt).toLocaleDateString()}`}
            aria-pressed={selected?.imageId === image.imageId} onClick={() => { setSelected(image); setPreviewFailed(false); }}>
            <img src={image.imageUrl} loading="lazy" alt="" /></button>
        </li>)}</ul>}
        {hasMore && <Button type="button" variant="outline" disabled={historyBusy} onClick={() => setPage(current => ({ offset: images.length, version: current.version + 1 }))}>Load more</Button>}
      </section>
    </main>
  );
}
