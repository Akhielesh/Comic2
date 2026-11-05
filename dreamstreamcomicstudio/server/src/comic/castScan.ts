// Uncast-being scan (contract §12.8, director.md §3.5; fixes "animals not cast → drift").
//
// A free, deterministic safety net behind the writer and director rules: recurring animals,
// pets, sea creatures, creatures, robots, toys (including LEGO-style brick figures), vehicles
// and key props that the plan draws in ≥ 2 panels (or in 1 panel when the user named them)
// but that have no cast entry become TEXT-LOCKED cast (tier extra, no sheet, no spend), so
// every panel and the cover describe the same ducklings instead of re-imagining them.
//
// False positives are kept down by requiring a noun PHRASE ("a frog", "three ducklings",
// "the red kite", a plural) and by skipping compounds ("bear hug", "fish market", "car park").
// The user can remove any of them for free.

import { isPageStale, newId, type CastKind, type ComicDoc, type Page } from '../../../shared/comic/doc.js';
import type { DocOp } from '../../../shared/comic/ops.js';

export interface UncastBeing {
  /** The noun as written ("duckling"). */
  noun: string;
  /** Proposed cast name ("Ducklings"). */
  name: string;
  kind: CastKind;
  /** 2–12 for a group drawn as one identity class. */
  count?: number;
  /** Panels it appears in. */
  panels: number;
  /** Where it first appears ("p1 panel 2"). */
  firstMention: string;
}

// ── Lexicon (~190 nouns) ─────────────────────────────────────────────────────

interface Entry {
  /** Singular, lowercase; may be two words ("teddy bear"). */
  word: string;
  kind: CastKind;
  /** Irregular plural. */
  plural?: string;
  /** Cast name override (avoids trademarks: "lego figure" → "Brick Figure"). */
  name?: string;
  /** look.species override. */
  species?: string;
}

const words = (kind: CastKind, list: string): Entry[] =>
  list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw) => {
      const [word, plural] = raw.split('/');
      return { word, kind, ...(plural ? { plural } : {}) };
    });

const LEXICON: Entry[] = [
  // Land animals and birds
  ...words(
    'animal',
    'dog,puppy,cat,kitten,bird,duck,duckling,goose/geese,gosling,swan,cygnet,chicken,chick,hen,rooster,cow,calf/calves,horse,pony,foal,donkey,pig,piglet,sheep/sheep,lamb,goat,rabbit,bunny,hare,mouse/mice,rat,hamster,guinea pig,squirrel,chipmunk,hedgehog,fox,wolf/wolves,bear,bear cub,deer/deer,fawn,moose/moose,elephant,giraffe,zebra,lion,lioness,tiger,leopard,cheetah,monkey,gorilla,chimpanzee,panda,koala,kangaroo,camel,hippo,rhino,crocodile,alligator,snake,lizard,gecko,turtle,tortoise,frog,toad,tadpole,owl,parrot,penguin,eagle,hawk,crow,pigeon,sparrow,robin,flamingo,peacock,ostrich,butterfly,caterpillar,bee,bumblebee,ladybug,ladybird,ant,spider,snail,dragonfly,firefly/fireflies,beetle,worm,bat,raccoon,otter,beaver,badger,skunk,buffalo/buffalo,yak,llama,alpaca,sloth,lemur,meerkat,mongoose,peahen,kitty/kitties,doggy/doggies,pup,cub'
  ),
  // Sea creatures
  ...words(
    'animal',
    'fish/fish,goldfish/goldfish,shark,whale,dolphin,octopus/octopuses,squid/squid,jellyfish/jellyfish,crab,lobster,shrimp/shrimp,starfish/starfish,seahorse,seal,sea lion,walrus/walruses,sea turtle,stingray,clownfish/clownfish,pufferfish/pufferfish,eel,orca,narwhal,manatee,sea otter,hermit crab,sea urchin'
  ),
  // Creatures
  ...words(
    'creature',
    'dragon,baby dragon,unicorn,dinosaur,t-rex/t-rexes,monster,ghost,fairy/fairies,troll,goblin,ogre,giant,mermaid,merman/mermen,phoenix/phoenixes,griffin,yeti,alien,zombie,vampire,werewolf/werewolves,gnome,pixie,sprite,kraken,sea serpent,dragonling,slime,genie,imp,golem,sphinx/sphinxes'
  ),
  // Robots
  ...words('robot', 'robot,droid,android,mech,cyborg,robo-dog,robot dog,robot cat,drone'),
  // Toys (LEGO-style figures named generically)
  ...words('toy', 'teddy bear,teddy/teddies,doll,rag doll,action figure,toy soldier,toy robot,rubber duck,plush,plushie,stuffed animal,puppet,marionette,wind-up toy,toy dinosaur,toy car,toy train,toy plane,nutcracker'),
  { word: 'lego figure', kind: 'toy', name: 'Brick Figure', species: 'brick-built toy minifigure' },
  { word: 'lego man', kind: 'toy', plural: 'lego men', name: 'Brick Figure', species: 'brick-built toy minifigure' },
  { word: 'minifigure', kind: 'toy', name: 'Minifigure', species: 'brick-built toy minifigure' },
  { word: 'minifig', kind: 'toy', name: 'Minifigure', species: 'brick-built toy minifigure' },
  { word: 'brick figure', kind: 'toy', name: 'Brick Figure', species: 'brick-built toy minifigure' },
  { word: 'block figure', kind: 'toy', name: 'Block Figure', species: 'block-built toy figure' },
  // Vehicles
  ...words(
    'vehicle',
    'car,truck,bus/buses,train,tractor,bike,bicycle,scooter,motorbike,motorcycle,boat,ship,sailboat,submarine,rocket,spaceship,spacecraft/spacecraft,airplane,plane,helicopter,hot air balloon,fire truck,fire engine,police car,ambulance,taxi/taxis,auto-rickshaw,rickshaw,van,jeep,race car,tank,canoe,kayak,raft,sled,wagon,cart,digger,excavator,bulldozer,steam engine,locomotive,tram,ufo/ufos,flying saucer,hovercraft/hovercraft,go-kart,monster truck'
  ),
  // Key props
  ...words(
    'object',
    'kite,beach ball,balloon,umbrella,lantern,magic wand,wand,sword,shield,crown,treasure chest,map,compass/compasses,backpack,seashell,magic shell,trophy/trophies,golden key,amulet,necklace,basket,bucket,sandcastle,snowman/snowmen,scarecrow,potion,orb,crystal,gem,drum,guitar,flute,telescope,magic lamp,music box/music boxes,paper boat,toy box/toy boxes,skateboard,surfboard,time machine'
  )
];

const pluralOf = (e: Entry): string => {
  if (e.plural) return e.plural;
  const w = e.word;
  if (/[^aeiou]y$/.test(w)) return `${w.slice(0, -1)}ies`;
  if (/(s|sh|ch|x|z)$/.test(w)) return `${w}es`;
  return `${w}s`;
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[ -]/g, '[ -]?');

// Longest words first so "teddy bear" wins over "bear", "sea turtle" over "turtle".
const ENTRIES = [...LEXICON].sort((a, b) => b.word.length - a.word.length);

/** One compiled matcher per entry, built once (a 40-page plan scans ~240 panels; compiling per call blocked the event loop for >1 s). */
const formsOf = (e: Entry): string[] => [pluralOf(e), e.word].filter((v, i, a) => a.indexOf(v) === i);
const squashForm = (s: string) => s.toLowerCase().replace(/[ -]/g, '');
const MATCHERS = new Map<Entry, { all: RegExp; first: RegExp; keys: string[] }>(
  ENTRIES.map((e) => {
    const body = `(^|[^\\p{L}])(${formsOf(e).map(esc).join('|')})(?=$|[^\\p{L}])`;
    // Cheap substring keys: the regex only runs when one of them occurs in the text.
    return [e, { all: new RegExp(body, 'giu'), first: new RegExp(body, 'iu'), keys: formsOf(e).map((f) => squashForm(f).slice(0, 4)) }];
  })
);

/** A noun phrase: determiner, number, possessive or adjective-ish word right before the noun, or a plural. */
const DETERMINER =
  "(?:a|an|the|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\\d{1,2}|few|several|some|many|his|her|their|its|our|my|your|this|that|these|those|little|tiny|small|big|giant|baby|old|young|cute|fluffy|friendly|brave|shy|playful|grumpy|happy|sleepy|red|blue|green|yellow|white|black|brown|grey|gray|pink|orange|purple|golden|silver|wooden|magic|mother|father|pet|toy|robot|[\\p{L}]+'s)";
const COMPOUND_STOP =
  /^(?:hug|hugs|market|stall|shop|tape|food|bowl|bed|park|parking|station|stop|ride|rides|seat|track|lane|crossing|sauce|print|prints|costume|costumes|mask|masks|shaped|shape|pattern|patterns|logo|sticker|stickers|poster|posters|keychain|cartoon|cartoons|show|movie|game|games|t-shirt|shirt|pajamas|onesie|slippers|hat|wallpaper|pen|pencil|nugget|nuggets|fingers|sticks|chase)\b/i;

interface Hit { entry: Entry; count?: number; groupWord: boolean }

const NUMBER_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, couple: 2, pair: 2, few: 3, several: 4, some: 3, dozen: 12 };

/** Nouns whose plural doubles as a verb ("Maya ducks", "she bears it"): they need a real noun phrase. */
const VERBISH = new Set(['duck', 'bear', 'seal', 'bat', 'crow', 'ship', 'train', 'tank', 'drone', 'plane', 'cart', 'rocket', 'map', 'drum', 'dog', 'wolf', 'fox', 'worm', 'bug', 'ant', 'pup', 'cub', 'hare', 'kite', 'ram', 'rat', 'pig', 'cat', 'hawk', 'robin', 'crab', 'shrimp', 'fish', 'whale', 'monster', 'giant', 'plush', 'tram', 'raft', 'sled', 'wagon', 'cub', 'orb', 'gem', 'wand', 'crown', 'shield', 'sword', 'balloon', 'lantern']);

/** Words that end a noun phrase (an adjective run never crosses them). */
const FUNCTION_WORDS = 'and|or|but|with|to|of|in|on|at|by|for|from|under|over|while|as|then|is|are|was|were|be|been|into|onto|near|behind|beside|past|through|across|it|he|she|they|we|you|i|who|that|which|when|where';
const PHRASE_BEFORE = new RegExp(`(?:^|[^\\p{L}])${DETERMINER}\\s+(?:(?!(?:${FUNCTION_WORDS})\\b)[\\p{L}-]+\\s+){0,2}$`, 'iu');

const countBefore = (before: string): number | undefined => {
  const m = /(?:\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple|pair|few|several|some|dozen)|\b(\d{1,2}))\b(?:\s+of)?(?:\s+[\p{L}-]+){0,2}\s*$/iu.exec(before);
  if (!m) return undefined;
  const n = m[2] ? Number(m[2]) : NUMBER_WORDS[m[1].toLowerCase()];
  return n >= 2 && n <= 12 ? n : undefined;
};

const squash = (s: string) => s.toLowerCase().replace(/[ -]/g, '');

/** Every lexicon noun phrase in `text` (each entry once, longest match wins on overlaps). */
export function scanText(text: string): Hit[] {
  const t = ` ${String(text || '').replace(/\s+/g, ' ')} `;
  const taken: Array<[number, number]> = [];
  const hits: Hit[] = [];
  const flat = squashForm(t);
  for (const entry of ENTRIES) {
    const matcher = MATCHERS.get(entry)!;
    if (!matcher.keys.some((k) => flat.includes(k))) continue;
    const re = matcher.all;
    re.lastIndex = 0;
    let found: Hit | undefined;
    for (let m = re.exec(t); m; m = re.exec(t)) {
      const start = m.index + m[1].length;
      const end = start + m[2].length;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      if (COMPOUND_STOP.test(t.slice(end).trimStart())) continue;
      const before = t.slice(0, start);
      const isPlural = squash(m[2]) !== squash(entry.word) && squash(m[2]) === squash(pluralOf(entry));
      const phrase = PHRASE_BEFORE.test(before);
      const nameLike = /^\p{Lu}/u.test(m[2]) && !/[.!?]\s*$/.test(before);
      if (!phrase && !nameLike && !(isPlural && !VERBISH.has(entry.word))) continue;
      taken.push([start, end]);
      const count = countBefore(before);
      if (!found) found = { entry, groupWord: isPlural, ...(count ? { count } : {}) };
      else {
        if (count && (!found.count || count > found.count)) found.count = count;
        if (isPlural) found.groupWord = true;
      }
    }
    if (found) hits.push(found);
  }
  return hits;
}

// ── Cast coverage ────────────────────────────────────────────────────────────

const castText = (doc: ComicDoc): string =>
  doc.cast
    .map((c) => [c.name, c.look?.species, c.look?.summary, c.look?.props].filter(Boolean).join(' '))
    .join(' \n ')
    .toLowerCase();

const covered = (entry: Entry, haystack: string): boolean => {
  const forms = [entry.word, pluralOf(entry), ...(entry.name ? [entry.name.toLowerCase()] : [])];
  return forms.some((f) => {
    const stem = f.toLowerCase();
    const re = stem.length <= 3 ? new RegExp(`(^|[^\\p{L}])${esc(stem)}s?(?=$|[^\\p{L}])`, 'iu') : new RegExp(`(^|[^\\p{L}])${esc(stem)}`, 'iu');
    return re.test(haystack);
  });
};

const titleCase = (s: string) => s.replace(/(^|[\s-])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());

const STOP_WORDS = new RegExp(`^(?:${FUNCTION_WORDS}|a|an|the|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|few|several|some|many|his|her|their|its|our|my|your|this|those|these|\\d+)$`, 'i');

/** The adjectives the plan used for this noun ("small green" in "a small green frog"), ≤ 3 words. */
const adjectivesFor = (text: string, entry: Entry): string => {
  const m = MATCHERS.get(entry)!.first.exec(` ${String(text || '').replace(/\s+/g, ' ')} `);
  if (!m) return '';
  const before = ` ${String(text || '').replace(/\s+/g, ' ')} `.slice(0, m.index + m[1].length).split(/[;,.!?:()]/).pop() || '';
  const out: string[] = [];
  for (const w of before.trim().split(/\s+/).reverse()) {
    if (!w || STOP_WORDS.test(w) || !/^[\p{L}-]+$/u.test(w) || /^\p{Lu}/u.test(w) || out.length >= 3) break;
    out.unshift(w.toLowerCase());
  }
  return out.join(' ');
};

const NUMBER_NAMES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/** A drawable, text-locked look line: "Three identical fluffy yellow ducklings (duckling)". */
const lockedSummary = (doc: ComicDoc, entry: Entry, count?: number): string => {
  const adjectives =
    sortedPages(doc)
      .flatMap((p) => p.panels.map((panel) => adjectivesFor(panel.action, entry)))
      .find(Boolean) || '';
  const noun = count && count > 1 ? pluralOf(entry) : entry.word;
  const head = count && count > 1 ? `${NUMBER_NAMES[count] || count} identical` : /^[aeiou]/i.test(adjectives || noun) ? 'An' : 'A';
  const line = `${head} ${adjectives ? `${adjectives} ` : ''}${entry.species && !entry.name ? entry.species : noun}`.replace(/\s+/g, ' ').trim();
  return `${line[0].toUpperCase()}${line.slice(1)}, drawn the same in every panel.`;
};

const userTexts = (doc: ComicDoc): string =>
  [
    doc.brief.premise,
    doc.brief.logline,
    doc.brief.setting,
    ...doc.brief.notes,
    ...doc.conversation.filter((m) => m.role === 'user').slice(-6).map((m) => m.text)
  ]
    .filter(Boolean)
    .join(' \n ');

const sortedPages = (doc: ComicDoc): Page[] => [...doc.pages].sort((a, b) => a.n - b.n);

/** Recurring non-human beings/props drawn in the plan but missing from the cast (free, deterministic). */
export function findUncastBeings(doc: ComicDoc): UncastBeing[] {
  if (!doc?.pages?.length) return [];
  const haystack = castText(doc);
  const named = scanText(userTexts(doc));
  const namedWords = new Set(named.map((h) => h.entry.word));
  const stats = new Map<string, { entry: Entry; panels: number; count?: number; group: boolean; first: string }>();
  for (const page of sortedPages(doc)) {
    for (const panel of page.panels) {
      if (!panel.action) continue;
      for (const hit of scanText(panel.action)) {
        const s = stats.get(hit.entry.word) || { entry: hit.entry, panels: 0, group: false, first: `p${page.n} panel ${panel.n}` };
        s.panels += 1;
        if (hit.count && (!s.count || hit.count > s.count)) s.count = hit.count;
        if (hit.groupWord) s.group = true;
        stats.set(hit.entry.word, s);
      }
    }
  }
  for (const h of named) {
    const s = stats.get(h.entry.word);
    if (!s) continue;
    if (h.count && (!s.count || h.count > s.count)) s.count = h.count;
    if (h.groupWord) s.group = true;
  }
  const out: UncastBeing[] = [];
  for (const s of stats.values()) {
    const byUser = namedWords.has(s.entry.word);
    if (s.panels < 2 && !(byUser && s.panels >= 1)) continue;
    if (covered(s.entry, haystack)) continue;
    // A sub-word already counted ("bear" inside an uncast "teddy bear") never doubles up.
    if (out.some((o) => o.noun.includes(s.entry.word) || s.entry.word.includes(o.noun))) continue;
    const count = s.count ?? (s.group ? 3 : undefined);
    const base = s.entry.name || (count && count > 1 ? pluralOf(s.entry) : s.entry.word);
    out.push({
      noun: s.entry.word,
      name: titleCase(base),
      kind: s.entry.kind,
      ...(count && count > 1 ? { count } : {}),
      panels: s.panels,
      firstMention: s.first
    });
  }
  // Most visible first; ties keep lexicon order.
  return out.sort((a, b) => b.panels - a.panels).slice(0, 8);
}

/** Character ops (text-locked cast) + panel castIds for undrawn/stale pages where each being appears. */
export function castOpsForUncast(doc: ComicDoc, beings: ReturnType<typeof findUncastBeings>): DocOp[] {
  if (!beings?.length) return [];
  const ops: DocOp[] = [];
  const named = new Set(scanText(userTexts(doc)).map((h) => h.entry.word));
  const totalPanels = doc.pages.reduce((n, p) => n + p.panels.length, 0) || 1;
  const panelAdds = new Map<string, { pageId: string; panelId: string; castIds: string[] }>();
  const existingNames = new Set(doc.cast.map((c) => c.name.trim().toLowerCase()));
  // Scan each panel once (not once per being).
  const panelWords = new Map<string, Set<string>>();
  const wordsIn = (action: string): Set<string> => {
    let set = panelWords.get(action);
    if (!set) {
      set = new Set(scanText(action).map((h) => h.entry.word));
      panelWords.set(action, set);
    }
    return set;
  };
  for (const being of beings) {
    const entry = ENTRIES.find((e) => e.word === being.noun);
    if (!entry || existingNames.has(being.name.toLowerCase())) continue;
    existingNames.add(being.name.toLowerCase());
    const id = newId('c');
    const species = entry.species || entry.word;
    const summary = lockedSummary(doc, entry, being.count);
    // Promoted to a companion (sheet) only when the user named it AND it carries the story.
    const tier = named.has(entry.word) && being.panels / totalPanels >= 0.5 ? 'support' : 'extra';
    ops.push({
      op: 'character',
      id,
      patch: {
        name: being.name,
        tier,
        kind: being.kind,
        ...(being.count && being.count > 1 ? { count: being.count } : {}),
        look: { summary, species },
        role: `${being.kind === 'object' ? 'Key prop' : 'Recurring companion'} (added so it stays consistent)`
      }
    });
    // Only pages that are not drawn-and-current get the castIds (never stale paid art).
    for (const page of doc.pages) {
      const current = page.render.status === 'ready' && !isPageStale(doc, page);
      if (current) continue;
      for (const panel of page.panels) {
        if (!wordsIn(panel.action || '').has(entry.word)) continue;
        const key = `${page.id}/${panel.id}`;
        const prev = panelAdds.get(key) || { pageId: page.id, panelId: panel.id, castIds: [...panel.castIds] };
        if (!prev.castIds.includes(id)) prev.castIds.push(id);
        panelAdds.set(key, prev);
      }
    }
  }
  for (const add of panelAdds.values()) ops.push({ op: 'panel', pageId: add.pageId, id: add.panelId, patch: { castIds: add.castIds } });
  return ops;
}

/** "Ducklings ×3, Frog and Bunny" for tool results and replies. */
export const describeUncast = (beings: UncastBeing[]): string => {
  const names = beings.map((b) => `${b.name}${b.count && b.count > 1 ? ` ×${b.count}` : ''}`);
  return names.length <= 1 ? names[0] || '' : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
};

export const LEXICON_SIZE = LEXICON.length;
