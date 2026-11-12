// QA scene `ds-overlays` (DS-1c; the scene contract is in qa/app/index.tsx): the design system's overlays on Radix —
// Dialog, AlertDialog, Menu, Popover, Tooltip — and the app's one toast slot (the Toast host and its card in every
// status), so the app layout smoke (DS-1b) measures their triggers at every viewport, light and dark, with and without
// the Atlas skin, and a person can open each one with a pointer, a finger or the keyboard. "Inside a sheet" opens a
// menu and a confirm from a phone BottomSheet, where they open on phones: each is the top layer there (drawn above the
// sheet; Esc, a row or an answer acts on it, never on the sheet). Every overlay starts closed
// (an open modal would hide the page from the smoke); the static toast cards show the card itself. Nothing here reaches
// the network or starts a timer until someone asks for a toast.
import React, { useState } from 'react';
import { Copy, FolderInput, Info, MoreHorizontal, PanelBottom, Pencil, Redo2, Share2, SlidersHorizontal, Trash2, Undo2 } from 'lucide-react';
import { Button } from '../../../components/ds/Button';
import { IconButton } from '../../../components/ds/IconButton';
import { Field } from '../../../components/ds/Field';
import { Input } from '../../../components/ds/Input';
import { Checkbox } from '../../../components/ds/Checkbox';
import { PageHeader } from '../../../components/ds/PageHeader';
import { SectionCard } from '../../../components/ds/SectionCard';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../../../components/ds/Dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '../../../components/ds/AlertDialog';
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger
} from '../../../components/ds/Menu';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '../../../components/ds/Popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../../components/ds/Tooltip';
import { toast, ToastCard, ToastHost, type ToastTone } from '../../../components/ds/Toast';
import { BottomSheet } from '../../../components/ds/sheet';

const ROW = 'flex min-w-0 flex-wrap items-center gap-2';
const STACK = 'flex min-w-0 flex-col gap-3';
const NOTE = 'm-0 text-[length:var(--ds-text-sm)] text-[var(--ds-muted)]';

function DialogDemo() {
  const [title, setTitle] = useState('Spice Market');
  const [saved, setSaved] = useState<string | null>(null);
  return (
    <SectionCard title="Dialog" description="Focus moves in and stays; Esc, the scrim or Close leave; focus returns to the button." icon={<Pencil />}>
      <div className={STACK} data-qa-overlay="dialog">
        <div className={ROW}>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">Comic details</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Comic details</DialogTitle>
                <DialogDescription>The title shows on the cover and in your library.</DialogDescription>
              </DialogHeader>
              <Field label="Title">
                <Input value={title} onChange={(e) => setTitle(e.target.value)} />
              </Field>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline">Cancel</Button>
                </DialogClose>
                <DialogClose asChild>
                  <Button onClick={() => setSaved(title)}>Save</Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
        <p className={NOTE} role="status">
          {saved ? `Saved “${saved}”.` : 'Nothing saved yet.'}
        </p>
      </div>
    </SectionCard>
  );
}

function AlertDialogDemo() {
  const [answer, setAnswer] = useState<string | null>(null);
  return (
    <SectionCard title="Alert dialog" description="The confirm step: Cancel has focus first; the destructive answer is the danger fill." icon={<Trash2 />}>
      <div className={STACK} data-qa-overlay="alert-dialog">
        <div className={ROW}>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline">Delete page 3</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete page 3?</AlertDialogTitle>
                <AlertDialogDescription>It stays in Assets › Deleted, so you can bring it back.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={() => setAnswer('Kept page 3.')}>Keep it</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => setAnswer('Page 3 deleted.')}>
                  Delete page
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        <p className={NOTE} role="status">
          {answer ?? 'No answer yet.'}
        </p>
      </div>
    </SectionCard>
  );
}

function MenuDemo() {
  const [grid, setGrid] = useState(true);
  const [view, setView] = useState('page');
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <SectionCard title="Menu" description="Arrow keys move, a letter jumps (typeahead), Enter chooses, Esc closes. Rows are 44 px on touch." icon={<MoreHorizontal />}>
      <div className={STACK} data-qa-overlay="menu">
        <div className={ROW}>
          <Menu>
            <MenuTrigger asChild>
              <IconButton label="Page actions" title={null} variant="outline">
                <MoreHorizontal />
              </IconButton>
            </MenuTrigger>
            <MenuContent align="start">
              <MenuLabel>Page 3</MenuLabel>
              <MenuItem onSelect={() => setPicked('Rename')}>
                <Pencil aria-hidden />
                Rename
                <MenuShortcut>F2</MenuShortcut>
              </MenuItem>
              <MenuItem onSelect={() => setPicked('Duplicate')}>
                <Copy aria-hidden />
                Duplicate
              </MenuItem>
              <MenuSub>
                <MenuSubTrigger>
                  <FolderInput aria-hidden />
                  Move to
                </MenuSubTrigger>
                <MenuSubContent>
                  <MenuItem onSelect={() => setPicked('Moved to chapter 1')}>Chapter 1</MenuItem>
                  <MenuItem onSelect={() => setPicked('Moved to chapter 2')}>Chapter 2</MenuItem>
                </MenuSubContent>
              </MenuSub>
              <MenuItem disabled>Translate (needs a connection)</MenuItem>
              <MenuSeparator />
              <MenuCheckboxItem checked={grid} onCheckedChange={setGrid}>
                Show the grid
              </MenuCheckboxItem>
              <MenuRadioGroup value={view} onValueChange={setView}>
                <MenuRadioItem value="page">One page</MenuRadioItem>
                <MenuRadioItem value="spread">Spread</MenuRadioItem>
              </MenuRadioGroup>
              <MenuSeparator />
              <MenuItem variant="destructive" onSelect={() => setPicked('Delete page')}>
                <Trash2 aria-hidden />
                Delete page
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
        <p className={NOTE} role="status">
          {picked ? `Chose “${picked}”.` : 'Nothing chosen yet.'} Grid {grid ? 'on' : 'off'}, {view === 'page' ? 'one page' : 'spread'}.
        </p>
      </div>
    </SectionCard>
  );
}

function PopoverDemo() {
  const [kids, setKids] = useState(false);
  const [finished, setFinished] = useState(true);
  return (
    <SectionCard title="Popover" description="A small panel that may hold controls; it opens on a press, never on hover." icon={<SlidersHorizontal />}>
      <div className={STACK} data-qa-overlay="popover">
        <div className={ROW}>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline">
                <SlidersHorizontal aria-hidden />
                Filters
              </Button>
            </PopoverTrigger>
            <PopoverContent aria-label="Filters" align="start">
              <div className={STACK}>
                <Checkbox label="Kids only" checked={kids} onCheckedChange={(v) => setKids(v === true)} />
                <Checkbox label="Finished comics" checked={finished} onCheckedChange={(v) => setFinished(v === true)} />
                <div className="flex justify-end">
                  <PopoverClose asChild>
                    <Button size="sm">Done</Button>
                  </PopoverClose>
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <p className={NOTE}>
          {[kids && 'Kids only', finished && 'Finished'].filter(Boolean).join(' · ') || 'No filters'}
        </p>
      </div>
    </SectionCard>
  );
}

function TooltipDemo() {
  const tools: Array<{ label: string; tip: string; icon: React.ReactNode }> = [
    { label: 'Undo', tip: 'Undo · Ctrl+Z', icon: <Undo2 /> },
    { label: 'Redo', tip: 'Redo · Ctrl+Shift+Z', icon: <Redo2 /> },
    { label: 'Share', tip: 'Share a read-only link', icon: <Share2 /> }
  ];
  return (
    <SectionCard title="Tooltip" description="Inverted ink after 300 ms of hover, at once on keyboard focus, on a long press on touch." icon={<Info />}>
      <div className={ROW} data-qa-overlay="tooltip">
        <TooltipProvider>
          {tools.map((t) => (
            <Tooltip key={t.label}>
              <TooltipTrigger asChild>
                <IconButton label={t.label} title={null} variant="outline">
                  {t.icon}
                </IconButton>
              </TooltipTrigger>
              <TooltipContent>{t.tip}</TooltipContent>
            </Tooltip>
          ))}
        </TooltipProvider>
      </div>
    </SectionCard>
  );
}

function SheetDemo() {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  return (
    <SectionCard
      title="Inside a sheet"
      description="On phones the overlays open from sheets. Each is the top layer there: Esc closes it, not the sheet; its rows and answers never close the sheet."
      icon={<PanelBottom />}
    >
      <div className={STACK} data-qa-overlay="sheet">
        <div className={ROW}>
          <Button variant="outline" onClick={() => setOpen(true)}>
            Open page 3’s sheet
          </Button>
        </div>
        <p className={NOTE} role="status">
          {done ?? 'Nothing done in the sheet yet.'}
        </p>
        <BottomSheet open={open} onClose={() => setOpen(false)} label="Page 3" title="Page 3">
          <div className={`${ROW} p-4`}>
            <Menu>
              <MenuTrigger asChild>
                <IconButton label="More for page 3" title={null} variant="outline">
                  <MoreHorizontal />
                </IconButton>
              </MenuTrigger>
              <MenuContent align="start">
                <MenuItem onSelect={() => setDone('Duplicated page 3 from its sheet.')}>
                  <Copy aria-hidden />
                  Duplicate
                </MenuItem>
                <MenuItem onSelect={() => setDone('Renamed page 3 from its sheet.')}>
                  <Pencil aria-hidden />
                  Rename
                </MenuItem>
              </MenuContent>
            </Menu>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline">Clear the lettering</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Clear page 3’s lettering?</AlertDialogTitle>
                  <AlertDialogDescription>The balloons go; the art stays. Undo brings them back.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep it</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={() => setDone('Cleared page 3’s lettering.')}>
                    Clear lettering
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </BottomSheet>
      </div>
    </SectionCard>
  );
}

const SAMPLES: Array<{ tone: ToastTone; title: string; message?: string; action?: string }> = [
  { tone: 'healthy', title: 'Saved to your library', message: 'Spice Market, 12 pages.' },
  { tone: 'active', title: 'Drawing page 4', message: 'It shows up here when it is done.' },
  { tone: 'waiting', title: 'Waiting for a connection', message: 'Your edits are kept on this device.' },
  { tone: 'attention', title: 'Two pages need lettering', message: 'Open them from Pages.' },
  { tone: 'error', title: 'That invite has expired', message: 'Ask for a new one from the person who sent it.' }
];

function ToastDemo() {
  return (
    <SectionCard title="Toast" description="One slot for the whole app, above the tab bar: a newer toast replaces the one on screen." icon={<Info />}>
      <div className={STACK} data-qa-overlay="toast">
        <div className={ROW}>
          <Button variant="outline" onClick={() => toast({ title: 'Copied the link', message: 'Anyone with it can read, not edit.' })}>
            Show a toast
          </Button>
          <Button variant="outline" onClick={() => toast({ title: 'Page 3 deleted', tone: 'active', action: { label: 'Undo', onClick: () => toast({ title: 'Page 3 is back' }) } })}>
            Show a toast with Undo
          </Button>
          <Button variant="outline" onClick={() => toast({ title: 'Your invite could not be used', message: 'It may have expired.', tone: 'attention', duration: 0 })}>
            Show one that stays
          </Button>
        </div>
        <div className={STACK} data-qa-toast-samples="">
          {SAMPLES.map((s) => (
            <ToastCard key={s.tone} tone={s.tone} title={s.title} message={s.message} />
          ))}
        </div>
      </div>
    </SectionCard>
  );
}

function DsOverlays() {
  return (
    // The page's one <main> (the scene contract, qa/app/index.tsx): QaAppSurface mounts a scene bare.
    <main data-qa-scene="ds-overlays" aria-label="Design system overlays" className="min-h-[100dvh] min-w-0 bg-[var(--ds-canvas)] px-4 py-6 text-[var(--ds-ink)] sm:px-6">
      <div className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-8">
        <PageHeader eyebrow="Design system" title="Overlays and toasts" description="Dialog, alert dialog, menu, popover and tooltip on Radix, and the one toast slot." />
        <div className="grid min-w-0 gap-6 lg:grid-cols-2">
          <DialogDemo />
          <AlertDialogDemo />
          <MenuDemo />
          <PopoverDemo />
          <TooltipDemo />
          <ToastDemo />
          <SheetDemo />
        </div>
      </div>
      <ToastHost />
    </main>
  );
}

export default { id: 'ds-overlays', title: 'Design system overlays', Scene: DsOverlays };
