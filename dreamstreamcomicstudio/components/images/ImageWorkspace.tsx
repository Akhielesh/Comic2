import { API_KEYS_CHANGED } from '../../services/apiKeys';
import type { ApiError } from '../../services/apiClient';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '../ds/Dialog';
import { isFreeOnly } from '../../services/freeOnlyMode';
import { NATIVE_REFERENCE_MODEL, STANDALONE_MODEL, WORKSPACE_QUALITIES, type WorkspaceQuality } from '../../shared/standaloneImage';
import { openApiKeysLink } from '../account/accountNav';
import { readAttachmentBatch } from '../../services/attachmentBatch';
import { MAX_INLINE_ATTACHMENT_CHARS } from '../../shared/attachmentLimits';
import { userFacingErrorMessage } from '../../services/apiErrors';
import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, Image as ImageIcon, Paperclip, RefreshCw, X } from 'lucide-react';
import { Button } from '../ds/Button';
import { Field } from '../ds/Field';
import { Textarea } from '../ds/Input';
import { Select } from '../ds/Select';
import { IMAGE_PROMPT_LIMIT, IMAGE_RATIOS, MAX_IMAGE_REFS, REF_MIME_TYPES, type SavedStandaloneImage, type StandaloneRoute, type ImageFormatChoice, suggestedImageRatio } from '../../shared/standaloneImage';
import { downloadStandalone, loadImageHistory, loadStandaloneRoute, loadReference, reopenStandalone, renderStandalone, reuseStandalone } from '../../services/standaloneImages';
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
  const [quality, setQuality] = useState<WorkspaceQuality>(() => {
    try { const q = JSON.parse(sessionStorage.getItem(draftKey) || '{}').quality; return WORKSPACE_QUALITIES.includes(q) ? q : 'native'; } catch { return 'native'; }
  });
  const [elapsed, setElapsed] = useState(0);
  const [routeVersion, setRouteVersion] = useState(0);
  const [route, setRoute] = useState<StandaloneRoute | null>(null);
  const [routeError, setRouteError] = useState('');
  const [paidRequired, setPaidRequired] = useState(false);
  const [checkHistory, setCheckHistory] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const pending = useRef<AbortController | undefined>(undefined);
  const preflight = useRef<AbortController | undefined>(undefined);
  const consent = useRef(false);
  const routeLabel = route ? `${route.provider === 'openrouter' ? 'OpenRouter' : 'Gemini'} · ${route.payer === 'personal' ? 'your key' : 'account allowance'}` : '';
  function showRouteIssue(issue: ApiError) {
    const code = issue?.code;
    if (!code || !['IMAGE_KEY_MISSING', 'IMAGE_KEY_INVALID', 'IMAGE_KEY_EXHAUSTED', 'IMAGE_MODEL_ACCESS_DENIED', 'IMAGE_ROUTE_UNAVAILABLE', 'IMAGE_ROUTE_CHANGED', 'NO_FREE_MODEL_AVAILABLE'].includes(code)) return false;
    setRoute(null);
    setRouteError('');
    setSetupHint('');
    setPaidRequired(code === 'NO_FREE_MODEL_AVAILABLE');
    if (code === 'NO_FREE_MODEL_AVAILABLE') {
      const detail = issue.details as Partial<StandaloneRoute> | undefined;
      if (detail?.provider === 'openrouter' && (detail.payer === 'personal' || detail.payer === 'platform') && detail.model) setRoute(detail as StandaloneRoute);
    } else if (code === 'IMAGE_ROUTE_UNAVAILABLE' || code === 'IMAGE_ROUTE_CHANGED') {
      const message = code === 'IMAGE_ROUTE_CHANGED' ? 'The available image provider or funding source changed. Check the provider again before generating.'
        : 'The image provider is temporarily unavailable. Check again in a moment.';
      setRouteError(userFacingErrorMessage(issue, message));
    } else {
      const fallback = code === 'IMAGE_KEY_EXHAUSTED' ? 'Review your OpenRouter spending limit and available credits in Settings.'
        : code === 'IMAGE_KEY_INVALID' ? 'Validate or replace the rejected image key in Settings.'
        : code === 'IMAGE_MODEL_ACCESS_DENIED' ? 'Check the model permissions for your image key in Settings.'
        : 'Connect a Gemini or OpenRouter key in Settings. Your prompt and references stay here.';
      setSetupHint(code === 'IMAGE_KEY_MISSING' ? fallback : userFacingErrorMessage(issue, fallback));
    }
    return true;
  }
  useEffect(() => {
    const refresh = () => setRouteVersion(v => v + 1);
    for (const event of [API_KEYS_CHANGED, 'dreamstream:settings-changed', 'dreamstream:freeOnly:changed', 'focus']) window.addEventListener(event, refresh);
    return () => { for (const event of [API_KEYS_CHANGED, 'dreamstream:settings-changed', 'dreamstream:freeOnly:changed', 'focus']) window.removeEventListener(event, refresh); };
  }, []);
  useEffect(() => {
    if (pending.current) return;
    const controller = new AbortController();
    preflight.current = controller;
    setRoute(null);
    setRouteError('');
    setSetupHint('');
    setPaidRequired(false);
    void loadStandaloneRoute(userId, quality, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setRoute(value);
      setSetupHint('');
    }).catch((error: ApiError) => {
      if (controller.signal.aborted) return;
      if (!showRouteIssue(error)) setRouteError(userFacingErrorMessage(error, 'The provider will be checked again when you generate.'));
    });
    return () => controller.abort();
  }, [userId, quality, routeVersion]);
  useEffect(() => () => pending.current?.abort(), []);
  const [naturalSize, setNaturalSize] = useState<{ url: string; width: number; height: number } | null>(null);
  const [actualPixels, setActualPixels] = useState(false);
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
  useEffect(() => {
    if (!working) return;
    const start = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [working]);
  const fileInput = useRef<HTMLInputElement>(null);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const submitLock = useRef(false);
  const retryId = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    try { sessionStorage.setItem(draftKey, JSON.stringify({ ...draft, quality })); } catch { /* storage disabled */ }
  }, [draft, draftKey, quality]);

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
    if (reading || working) return;
    setReading(true);
    try {
      const { added, notice } = await readAttachmentBatch(files, refs.length, refs.reduce((n, ref) => n + ref.data.length, 0), loadReference, ref => ref.data);
      if (!mounted.current) return;
      setError(notice);
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
    const allowPaidImage = consent.current;
    consent.current = false;
    if (paidRequired && !allowPaidImage) return;
    const paidOpenRouterAllowed = allowPaidImage || !isFreeOnly();
    preflight.current?.abort();
    submitLock.current = true;
    const controller = new AbortController();
    pending.current = controller;
    const timeout = window.setTimeout(() => controller.abort('timeout'), 220_000);
    setRetrying(false); setCheckHistory(false);
    setElapsed(0); setWorking(true); setError(''); setSetupHint('');
    try {
      retryId.current ??= crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');
      const initialPin = allowPaidImage && route?.provider === 'openrouter' ? route : undefined;
      const run = (expectedRoute?: StandaloneRoute) => renderStandalone(userId, draft.prompt, draft.ratio, refs.map(ref => ref.data), retryId.current!, quality, {
        signal: controller.signal, allowPaidImage, ...(expectedRoute ? {expectedRoute} : {})
      });
      let image: SavedStandaloneImage;
      try { image = await run(initialPin); }
      catch (failure) {
        const refusal = failure as ApiError;
        if (refusal.status === 409 && refusal.code === 'IMAGE_ROUTE_RESELECT') {
          const alternate = refusal.details as Partial<StandaloneRoute> | undefined;
          const model = quality === 'native' ? STANDALONE_MODEL : NATIVE_REFERENCE_MODEL;
          if (alternate?.provider !== 'openrouter' || alternate.model !== 'google/' + model ||
              (alternate.payer !== 'personal' && alternate.payer !== 'platform') ||
              (route && route.payer !== alternate.payer) || initialPin) throw failure;
          const nextRoute: StandaloneRoute = { provider:'openrouter', model:alternate.model, payer:alternate.payer };
          setRoute(nextRoute);
          if (!paidOpenRouterAllowed) { setPaidRequired(true); return; }
          // Only a confirmed, unpaid rejection reaches this path. Pin provider AND payer, retain
          // the original request ID/consent, and let any second failure reach the creator.
          image = await run(nextRoute);
        } else if (refusal.status === 429 && refusal.code === 'GENERATION_BUSY') {
          setRetrying(true);
          await new Promise<void>((resolve, reject) => {
            const stopped = () => { window.clearTimeout(timer); reject(new DOMException('Stopped', 'AbortError')); };
            const timer = window.setTimeout(() => { controller.signal.removeEventListener('abort', stopped); resolve(); }, Math.min(30, Math.max(1, refusal.retryAfterSeconds || 10)) * 1000);
            if (controller.signal.aborted) stopped(); else controller.signal.addEventListener('abort', stopped, { once: true });
          });
          setRetrying(false);
          image = await run(initialPin);
        } else throw failure;
      }
      if (mounted.current) {
        setSelected(image);
        setPreviewFailed(false);
        setImages(current => [image, ...current.filter(item => item.imageId !== image.imageId)]);
        retryId.current = undefined;
      }
    } catch (e) {
      if (mounted.current) {
        if (controller.signal.aborted || ['IMAGE_RESULT_UNCONFIRMED','MODEL_TIMEOUT'].includes((e as ApiError).code || '')) {
          setCheckHistory(true);
          setError('The provider has not confirmed a finished image. Check your saved images before retrying this request.'); return;
        }
        if (showRouteIssue(e as ApiError)) return;
        const message = userFacingErrorMessage(e, 'Image generation paused. Try again in a moment.');
        if (/NO_FREE_MODEL_AVAILABLE|free.only|free model/i.test(message) || (e as { code?: string })?.code === 'NO_FREE_MODEL_AVAILABLE') {
          setPaidRequired(true);
        } else if ((e as ApiError)?.code === 'IMAGE_KEY_MISSING' || /api key|key missing|key (?:was )?rejected|invalid key/i.test(message)) {
          setSetupHint('Check your active Gemini or OpenRouter key in Settings, then return here with this draft.');
        } else if ((e as { status?: number } | null)?.status === 402 || /insufficient (?:funds|credits)|out of credits|allowance.*(?:used|exhausted)|billing.*enabled/i.test(message)) {
          setSetupHint(`Check your remaining allowance or ${route?.provider === 'openrouter' ? 'OpenRouter' : route?.provider === 'gemini' ? 'Gemini' : 'provider'} billing account. Your prompt and references are saved here.`);
        } else setError(message);
      }
    }
    finally { window.clearTimeout(timeout); pending.current = undefined; submitLock.current = false; if (mounted.current) { setWorking(false); setRetrying(false); } }
  };

  const reuseImage = async () => {
    if (!selected || reading || working || refs.length >= MAX_IMAGE_REFS) return;
    setReading(true); setError('');
    try {
      const ref = await reuseStandalone(selected);
      if (mounted.current) {
        if (refs.reduce((n, item) => n + item.data.length, ref.data.length) > MAX_INLINE_ATTACHMENT_CHARS) {
          setError('This image exceeds the remaining attachment space. Remove a reference and try again.'); return;
        }
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
            <Button type="submit" onClick={() => { consent.current = paidRequired; }} disabled={reading} loading={working} aria-keyshortcuts="Control+Enter Meta+Enter">{working ? 'Generating image…' : paidRequired ? 'Generate this paid image' : 'Generate image'}</Button>
            <Button type="button" variant="outline" disabled={working || reading || refs.length >= MAX_IMAGE_REFS}
              onClick={() => fileInput.current?.click()}><Paperclip aria-hidden />Add references</Button>
          </div>
          <div className="image-reference-input">
            <input ref={fileInput} type="file" multiple hidden aria-label="Reference image files" accept={REF_MIME_TYPES.join(',')}
              onChange={e => { const files = Array.from(e.target.files || []); e.target.value = ''; void attach(files); }} />
            <small>Up to {MAX_IMAGE_REFS} images · JPG, PNG or WebP · 2 MB each, 6 MB total</small>
            {quality === 'native' && refs.length > 3 && <small>Flash receives numbered reference sheets. Choose individual references in Image format to send every photo at its own resolution.</small>}
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
            <Field label="Rendering" description={quality === 'native' ? 'Flash uses its native output size.' : 'Nano Banana 2.1 accepts each photo individually. Larger outputs use more provider credit and can take longer.'}>
              <Select value={quality} disabled={working} options={[
                { value: 'native', label: 'Flash · native size' },
                { value: '1K', label: 'Individual references · 1K' },
                { value: '2K', label: 'Individual references · 2K' },
                { value: '4K', label: 'Individual references · 4K' }
              ]} onChange={e => { setQuality(e.target.value as WorkspaceQuality); retryId.current = undefined; }} />
            </Field>
          </details>
          <p className="image-usage">{quality === 'native' ? 'Gemini 2.5 Flash Image' : `Nano Banana 2.1 · ${quality}`} · Uses your image allowance or active Gemini or OpenRouter key.</p>
          {routeLabel && <p className="image-usage">Selected route · {routeLabel}</p>}
          {routeError && !setupHint && <div><p className="image-usage" role="status">{routeError}</p>
            <Button type="button" size="sm" variant="ghost" disabled={working} onClick={() => setRouteVersion(v => v + 1)}>Check provider again</Button></div>}
          {paidRequired && <p className="image-usage">Your free-only setting blocks this OpenRouter image model. “Generate this paid image” permits this one render{route?.payer === 'personal' ? ' on your OpenRouter key' : ''}. Your free-only setting stays on.</p>}
          {setupHint && <p role="status" className="image-usage">{setupHint} <a href={API_KEYS_HREF} onClick={openApiKeysLink}>Open API keys and usage</a></p>}
          {error && <p role="alert" className="image-workspace-error">{error}</p>}
          {checkHistory && <Button type="button" variant="outline" onClick={() => { setPage({offset:0, version:page.version + 1}); document.getElementById('image-history-title')?.focus(); }}>Check saved images</Button>}
        </form>
        <section className="image-result" aria-label="Image preview">
          {working && <div className="image-progress"><span role="status">{retrying ? 'All image slots are busy. Your request will retry once.' : elapsed >= 30 ? `Waiting for ${route?.provider === 'openrouter' ? 'OpenRouter' : route?.provider === 'gemini' ? 'Gemini' : 'the image provider'}. Keep this workspace open.` : `Generating your image${route ? ' via ' + (route.provider === 'openrouter' ? 'OpenRouter' : 'Gemini') : ''}…`}</span> <span aria-hidden="true">{elapsed}s</span></div>}
          {selected && !previewFailed ? <img className="image-output" src={selected.imageUrl} alt="Your generated image" onLoad={e => { const img = e.currentTarget; if (img.naturalWidth) setNaturalSize({ url: selected.imageUrl, width: img.naturalWidth, height: img.naturalHeight }); }} onError={() => setPreviewFailed(true)} /> :
            previewFailed || working || historyBusy ? (
              <div className="image-placeholder" role="status"><ImageIcon aria-hidden size={36} />
                <span>{previewFailed ? 'The preview link has expired or could not load.' : working ? 'Your finished artwork will appear here.' : 'Loading saved images…'}</span>
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
          {selected && !previewFailed && <p className="image-usage">{naturalSize?.url === selected.imageUrl ? `${naturalSize.width} × ${naturalSize.height} px` : selected.width && selected.height ? `${selected.width} × ${selected.height} px` : ''}
            {typeof selected.apiMs === 'number' && ` · Generated in ${(selected.apiMs / 1000).toFixed(1)}s`}
            {typeof selected.saveMs === 'number' && ` · Saved in ${(selected.saveMs / 1000).toFixed(1)}s`}
            {selected.provider && ` · ${selected.provider === 'openrouter' ? 'OpenRouter' : 'Gemini'}`}{selected.byok === true && ' · Your API key'}</p>}
          {selected && <div className="image-output-actions">
            {!previewFailed && <Dialog onOpenChange={open => { if (!open) setActualPixels(false); }}>
              <DialogTrigger asChild><Button type="button" variant="outline">View full size</Button></DialogTrigger>
              <DialogContent size="lg" className="image-original-dialog">
                <DialogTitle>Your generated image</DialogTitle>
                <DialogDescription>View the saved artwork at its original resolution.</DialogDescription>
                <Button type="button" size="sm" variant="outline" aria-pressed={actualPixels} onClick={() => setActualPixels(!actualPixels)}>{actualPixels ? 'Fit image' : 'Actual pixels'}</Button>
                <div className="image-original-scroll"><img src={selected.imageUrl} alt="Full-resolution generated artwork" className={actualPixels ? 'actual' : ''} /></div>
              </DialogContent>
            </Dialog>}
            <Button type="button" variant="outline" disabled={reading || working || refs.length >= MAX_IMAGE_REFS} onClick={reuseImage}>
              <Paperclip aria-hidden />Use as reference</Button>
            <Button type="button" variant="outline" loading={downloading} onClick={download}>
            <Download aria-hidden />Download image</Button></div>}
        </section>
      </div>
      <section className="image-history" aria-labelledby="image-history-title">
        <div className="image-history-heading"><h2 tabIndex={-1} id="image-history-title">Your images</h2>
          <Button type="button" size="sm" variant="ghost" disabled={historyBusy} onClick={refresh}><RefreshCw aria-hidden />Refresh</Button></div>
        <p role="status" className="image-history-status">{historyError || (historyBusy ? 'Loading saved images…' : !images.length ? 'Your generated images will appear here.' : '')}</p>
        {images.length > 0 && <ul>{images.map((image, index) => <li key={image.imageId}>
          <button type="button" aria-label={`View image ${images.length - index}, ${new Date(image.createdAt).toLocaleDateString()}`}
            aria-pressed={selected?.imageId === image.imageId} onClick={() => { setSelected(image); setPreviewFailed(false); }}>
            <img src={image.imageUrl} loading="lazy" decoding="async" fetchPriority="low" alt="" /></button>
        </li>)}</ul>}
        {hasMore && <Button type="button" variant="outline" disabled={historyBusy} onClick={() => setPage(current => ({ offset: images.length, version: current.version + 1 }))}>Load more</Button>}
      </section>
    </main>
  );
}
