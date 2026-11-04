// QA scene `ds-gallery` (DS-1a; master plan §1.1, QA scene contract L4): every components/ds primitive in
// every variant and state, so the app layout smoke (DS-1b) measures them at every viewport, in light and
// dark, with and without the Atlas skin. The harness (qa/app/index.tsx) discovers this file by glob and
// renders `Scene`; nothing here reaches the network.
//
// Light and dark: the first panel follows the page's theme (the harness `theme=` param); while the page is
// light a second panel repeats the gallery in dark (`.dark`, restating the page's skin attribute so the
// skin's dark block applies to it). Interactive pieces keep local state so keyboard and touch checks work.
import React, { useState } from 'react';
import { Bell, Bold, BookOpen, Image as ImageIcon, Inbox, Italic, Palette, Plus, Search, Settings, Sparkles, Trash2, Underline } from 'lucide-react';
import {
  Badge,
  BADGE_VARIANTS,
  Button,
  BUTTON_SIZES,
  BUTTON_VARIANTS,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  Chip,
  EmptyState,
  ErrorBoundary,
  ErrorState,
  Field,
  IconButton,
  Input,
  LoadingState,
  MetricCard,
  PageHeader,
  Progress,
  SectionCard,
  Segmented,
  Select,
  Skeleton,
  Slider,
  STATUS_STATES,
  StatusChip,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  type CheckedState
} from '../../../components/ds';

const ROW = 'flex min-w-0 flex-wrap items-center gap-2';
const STACK = 'flex min-w-0 flex-col gap-4';
const NOTE = 'm-0 text-[length:var(--ds-text-sm)] text-[var(--ds-muted)]';

function Buttons() {
  return (
    <SectionCard title="Buttons" description="Every Atlas variant in every size, plus busy, disabled and icon-only." icon={<Sparkles />}>
      <div className={STACK}>
        {BUTTON_VARIANTS.map((variant) => (
          <div key={variant} className={ROW} data-qa-variant={variant}>
            {BUTTON_SIZES.map((size) =>
              size === 'icon' ? (
                <Button key={size} variant={variant} size="icon" aria-label={`${variant} add`}>
                  <Plus />
                </Button>
              ) : (
                <Button key={size} variant={variant} size={size}>
                  {variant} {size}
                </Button>
              )
            )}
            <Button variant={variant} disabled>
              Disabled
            </Button>
            <Button variant={variant} loading>
              Saving
            </Button>
          </div>
        ))}
        <div className={ROW}>
          <IconButton label="Search" size="sm">
            <Search />
          </IconButton>
          <IconButton label="Notifications">
            <Bell />
          </IconButton>
          <IconButton label="Settings" size="lg" variant="outline">
            <Settings />
          </IconButton>
          <IconButton label="Delete page" variant="destructive">
            <Trash2 />
          </IconButton>
          <Button variant="outline">
            <ImageIcon />
            With an icon
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}

function Fields() {
  const [title, setTitle] = useState('');
  return (
    <SectionCard title="Fields" description="Label, description and error wired to the control; required and disabled." icon={<BookOpen />}>
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <Field label="Comic title" description="Shown on the cover and in the gallery." required error={title.trim() ? undefined : 'Give the comic a title.'}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="The lake at night" />
        </Field>
        <Field label="Search" hideLabel>
          <Input type="search" placeholder="Search comics" />
        </Field>
        <Field label="What happens on this page" description="A sentence or two is enough.">
          <Textarea placeholder="Mara finds the map under the floorboards." />
        </Field>
        <Field label="Disabled field" disabled description="Locked while the page draws.">
          <Input defaultValue="Can’t change this now" />
        </Field>
        <Field label="Page size">
          <Select
            placeholder="Choose a size"
            options={[
              { value: 'a4', label: 'A4 (portrait)' },
              { value: 'letter', label: 'US Letter' },
              { value: 'square', label: 'Square', disabled: true }
            ]}
          />
        </Field>
        <Field label="Format" error="PNG is not available for this comic yet.">
          <Select
            size="sm"
            defaultValue="png"
            options={[
              { value: 'pdf', label: 'PDF' },
              { value: 'png', label: 'PNG' }
            ]}
          />
        </Field>
      </div>
    </SectionCard>
  );
}

type View = 'scroll' | 'page' | 'spread';
type Mode = 'easy' | 'pro';
type TextStyle = 'bold' | 'italic' | 'underline';

function Choices() {
  const [view, setView] = useState<View>('page');
  const [mode, setMode] = useState<Mode>('easy');
  const [align, setAlign] = useState<TextStyle>('bold');
  const [autosave, setAutosave] = useState(true);
  const [all, setAll] = useState<CheckedState>('indeterminate');
  const [gutter, setGutter] = useState(12);
  return (
    <SectionCard title="Choices" description="Segmented, tabs, switches, checkboxes, sliders and progress." icon={<Palette />}>
      <div className={STACK}>
        <div className={ROW}>
          <Segmented<View>
            label="Reading view"
            value={view}
            onChange={setView}
            options={[
              { value: 'scroll', label: 'Scroll' },
              { value: 'page', label: 'Page' },
              { value: 'spread', label: 'Spread' }
            ]}
          />
          <Segmented<Mode>
            label="Editor mode"
            size="sm"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'easy', label: 'Easy' },
              { value: 'pro', label: 'Pro' }
            ]}
          />
          <Segmented<TextStyle>
            label="Text style"
            value={align}
            onChange={setAlign}
            options={[
              { value: 'bold', label: <span className="sr-only">Bold</span>, icon: <Bold />, title: 'Bold' },
              { value: 'italic', label: <span className="sr-only">Italic</span>, icon: <Italic />, title: 'Italic' },
              { value: 'underline', label: <span className="sr-only">Underline</span>, icon: <Underline />, title: 'Underline' }
            ]}
          />
          <Segmented label="Disabled choice" disabled value="a" onChange={() => undefined} options={[{ value: 'a', label: 'On' }, { value: 'b', label: 'Off' }]} />
        </div>
        <Segmented<View>
          label="Panel layout"
          fullWidth
          value={view}
          onChange={setView}
          options={[
            { value: 'scroll', label: 'One column' },
            { value: 'page', label: 'Two columns' },
            { value: 'spread', label: 'Three columns', disabled: true }
          ]}
        />
        <Tabs defaultValue="pages">
          <TabsList label="Comic sections">
            <TabsTrigger value="pages">Pages</TabsTrigger>
            <TabsTrigger value="cast">Cast</TabsTrigger>
            <TabsTrigger value="notes" disabled>
              Notes
            </TabsTrigger>
            <TabsTrigger value="share">Share</TabsTrigger>
          </TabsList>
          <TabsContent value="pages">
            <p className={NOTE}>Twelve pages, four still drawing.</p>
          </TabsContent>
          <TabsContent value="cast">
            <p className={NOTE}>Mara, Ilya and the lake keeper.</p>
          </TabsContent>
          <TabsContent value="share">
            <p className={NOTE}>Private until you publish.</p>
          </TabsContent>
        </Tabs>
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <Field label="Autosave" description="Every change is kept as you go.">
            <Switch checked={autosave} onCheckedChange={setAutosave} />
          </Field>
          <Field label="Locked switch" disabled>
            <Switch defaultChecked />
          </Field>
          <div className={STACK}>
            <Checkbox label="Select all pages" checked={all} onCheckedChange={(on) => setAll(on)} />
            <Checkbox label="Show page numbers" description="In the reader and the PDF." defaultChecked />
            <Checkbox label="Disabled option" disabled />
            <Checkbox label="Accept the licence" aria-invalid="true" />
          </div>
          <div className={STACK}>
            <Field label="Panel gutter" description={`${gutter} px between panels.`}>
              <Slider min={0} max={48} step={2} value={gutter} onValueChange={setGutter} valueText={(v) => `${v} pixels`} />
            </Field>
            <Field label="Locked slider" disabled>
              <Slider defaultValue={30} />
            </Field>
          </div>
        </div>
        <div className={STACK}>
          <Progress label="Drawing pages" value={40} valueText="4 of 10 pages" />
          <Progress label="Done" value={100} tone="healthy" />
          <Progress label="Needs a look" value={70} tone="attention" size="sm" />
          <Progress label="Failed" value={20} tone="error" />
          <Progress label="Preparing" />
        </div>
      </div>
    </SectionCard>
  );
}

function Labels() {
  return (
    <SectionCard title="Labels" description="Chips name things; badges count or flag; status chips say a state in words." icon={<Bell />}>
      <div className={STACK}>
        <div className={ROW}>
          <Chip>Outline chip</Chip>
          <Chip variant="filled" icon={<BookOpen />}>
            The Lake Series
          </Chip>
          <Chip variant="dashed">No style yet</Chip>
          <Chip className="max-w-[10rem]">A very long chip label that truncates</Chip>
        </div>
        <div className={ROW}>
          {BADGE_VARIANTS.map((v) => (
            <Badge key={v} variant={v}>
              {v}
            </Badge>
          ))}
        </div>
        <div className={ROW}>
          {STATUS_STATES.map((s) => (
            <StatusChip key={s} state={s}>
              {{ healthy: 'Published', active: 'Drawing', waiting: 'Queued', attention: 'Check the lettering', error: 'Failed to draw' }[s]}
            </StatusChip>
          ))}
        </div>
      </div>
    </SectionCard>
  );
}

function Containers() {
  return (
    <SectionCard title="Containers" description="Cards, a plain section card and metrics." icon={<Inbox />} aside={<StatusChip state="healthy">Saved</StatusChip>}>
      <div className={STACK}>
        <Card>
          <CardHeader>
            <CardTitle>Cast</CardTitle>
            <CardDescription>Who appears in this comic, with their reference sheets.</CardDescription>
            <CardAction>
              <Button size="sm" variant="outline">
                Add
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <p className={NOTE}>Three characters, two locations.</p>
          </CardContent>
          <CardFooter>
            <Button size="sm" variant="ghost">
              Manage
            </Button>
          </CardFooter>
        </Card>
        <SectionCard title="Plain section" description="Without an icon the card keeps a simple title row." actions={<Button size="sm">Edit</Button>}>
          <p className={NOTE}>Section body.</p>
        </SectionCard>
        <div className="grid min-w-0 gap-3 sm:grid-cols-3">
          <MetricCard title="Pages drawn" value="12" meta="of 24 planned" icon={<ImageIcon />} />
          <MetricCard title="Readers" value="1,284" meta="since Monday" />
          <MetricCard title="Usage left" value="68 %" />
        </div>
      </div>
    </SectionCard>
  );
}

function Fragile({ broken }: { broken: boolean }) {
  if (broken) throw new Error('gallery: a deliberately broken panel');
  return <p className={NOTE}>This panel renders normally until you break it.</p>;
}

function States() {
  const [broken, setBroken] = useState(false);
  return (
    <SectionCard title="States" description="Empty, loading, failed, skeletons and the error boundary." icon={<Inbox />}>
      <div className={STACK}>
        <EmptyState title="No comics yet" description="Start one from a single sentence; the studio drafts the pages." icon={<BookOpen />} action={{ label: 'New comic', onClick: () => undefined }} secondaryAction={{ label: 'See examples', onClick: () => undefined }} />
        <EmptyState variant="inline" title="No pages match" description="Clear the filter to see every page." icon={<Search />} action={{ label: 'Clear filter', onClick: () => undefined }} />
        <EmptyState variant="bare" title="Nothing archived" description="Archived pages show up here." />
        <LoadingState title="Loading your comics…" description="This takes a moment on a slow connection." />
        <LoadingState variant="inline" title="Saving…" />
        <ErrorState title="Your comics didn’t load" description="Check your connection, then try again." onRetry={() => undefined} />
        <ErrorState variant="inline" title="Not saved" description="The last change is still on this device." onRetry={() => undefined} />
        <div className="flex min-w-0 items-center gap-3">
          <Skeleton shape="circle" className="size-10 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton shape="text" className="w-2/3" />
            <Skeleton shape="text" className="w-1/2" />
          </div>
          <Skeleton className="h-16 w-24 shrink-0" />
        </div>
        <ErrorBoundary resetKeys={[broken]} title="This panel stopped working" description="Try again to render it once more.">
          <div className={ROW}>
            <Fragile broken={broken} />
            <Button size="sm" variant="outline" onClick={() => setBroken(true)}>
              Break this panel
            </Button>
          </div>
        </ErrorBoundary>
        {broken ? (
          <Button size="sm" variant="ghost" onClick={() => setBroken(false)}>
            Mend it
          </Button>
        ) : null}
      </div>
    </SectionCard>
  );
}

function Gallery() {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Buttons />
      <Fields />
      <Choices />
      <Labels />
      <Containers />
      <States />
    </div>
  );
}

function ThemePanel({ dark, children }: { dark?: boolean; children: React.ReactNode }) {
  const skin = typeof document !== 'undefined' ? document.documentElement.getAttribute('data-ds-skin') : null;
  return (
    <section
      aria-label={dark ? 'Dark theme' : 'Page theme'}
      data-qa-theme={dark ? 'dark' : 'page'}
      className={dark ? 'dark min-w-0 rounded-[var(--ds-radius-panel)] bg-[var(--ds-canvas)] p-3 text-[var(--ds-ink)] sm:p-4' : 'min-w-0'}
      data-ds-skin={dark && skin ? skin : undefined}
    >
      {children}
    </section>
  );
}

function DsGallery() {
  const pageIsDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  return (
    <main className="min-h-[100dvh] min-w-0 bg-[var(--ds-canvas)] px-4 py-6 text-[var(--ds-ink)] sm:px-6">
      <div className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-8">
        <PageHeader eyebrow="Design system" title="DreamStream primitives" description="Atlas recipes on the --ds-* tokens. Every primitive, variant and state, in the page theme and in dark." />
        <ThemePanel>
          <Gallery />
        </ThemePanel>
        {pageIsDark ? null : (
          <ThemePanel dark>
            <Gallery />
          </ThemePanel>
        )}
      </div>
    </main>
  );
}

export default { id: 'ds-gallery', title: 'Design system primitives', Scene: DsGallery };
