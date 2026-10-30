// PG-13 pre-filter lexicon (safety.md §3.1). Owner: P1-SAFETY.
//
// INTENTIONALLY NON-EXHAUSTIVE. This is the free first layer: it settles the common cases
// at $0 (kids, animals, toys, action, horror) and hands anything context-dependent to the
// platform-paid classifier. English obscenities, sexual terms and slurs come from the
// `obscenity` dataset (MIT, zero deps) and are only CATEGORISED here; this file adds what
// that dataset lacks: rating-shaping words (gore, weapons, substances, moderate language),
// minor terms for the co-occurrence rule, real-world-harm instruction patterns, a minimal
// romanized/native Hindi and Telugu abuse list, trademarked names (steered to an homage,
// never blocked) and a horror/action allow-list that never escalates.
//
// Tiers:
//   block      high confidence, any rating (assessed X). A strike unless the category is self_harm.
//   ambiguous  context-dependent: the classifier decides (when it runs). `clearAt` = the lowest
//              rating at which the word alone is fine (e.g. "gun" is clear at PG-13).
// Never put user-facing copy here, and never log what matched.

import type { ContentRating, SafetyCategory } from '../../../../shared/comic/safety.js';

export type LexTier = 'block' | 'ambiguous';

export interface LexEntry {
  /** Matched against the normalized text (lowercase, leet folded, diacritics stripped). */
  re: RegExp;
  category: SafetyCategory;
  tier: LexTier;
  /** Ambiguous only: at this rating or above, the word alone is clear. Absent ⇒ never clear by itself. */
  clearAt?: ContentRating;
  /** Counts as a sexual term for the minor co-occurrence rule (block). */
  sexualSignal?: boolean;
  /** Counts as a nudity term for the minor co-occurrence rule (ambiguous). */
  nuditySignal?: boolean;
}

/** One `obscenity` dataset word → how DreamStream treats it. `null` = a common homonym we ignore
 *  (rooster, the bird, a name, a cat…): the classifier and the publish check cover real abuse. */
export interface ObscenityRule {
  category: SafetyCategory;
  tier: LexTier;
  clearAt?: ContentRating;
  sexualSignal?: boolean;
}

const sexualBlock: ObscenityRule = { category: 'sexual', tier: 'block', sexualSignal: true };
const sexualAmbiguous: ObscenityRule = { category: 'sexual', tier: 'ambiguous', sexualSignal: true };
const nudityAmbiguous: ObscenityRule = { category: 'nudity', tier: 'ambiguous', sexualSignal: true };
const slurBlock: ObscenityRule = { category: 'hate', tier: 'block' };
const slurAmbiguous: ObscenityRule = { category: 'hate', tier: 'ambiguous' };
const strongLanguage: ObscenityRule = { category: 'language', tier: 'ambiguous' };
const moderateLanguage: ObscenityRule = { category: 'language', tier: 'ambiguous', clearAt: 'PG-13' };
const mildLanguage: ObscenityRule = { category: 'language', tier: 'ambiguous', clearAt: 'PG' };

/** Keys are the dataset's `originalWord` metadata (obscenity 0.4.6, English preset). */
export const OBSCENITY_RULES: Readonly<Record<string, ObscenityRule | null>> = {
  abo: slurAmbiguous,
  abeed: slurBlock,
  africoon: slurBlock,
  anal: sexualBlock,
  anus: nudityAmbiguous,
  arabush: slurBlock,
  arse: moderateLanguage,
  ass: moderateLanguage,
  bastard: moderateLanguage,
  bestiality: sexualBlock,
  bitch: moderateLanguage,
  blowjob: sexualBlock,
  bollocks: moderateLanguage,
  boob: null,
  boonga: slurBlock,
  buttplug: sexualBlock,
  chingchong: slurBlock,
  chink: slurAmbiguous,
  cock: null,
  cuck: strongLanguage,
  cum: sexualAmbiguous,
  cunt: strongLanguage,
  deepthroat: sexualBlock,
  dick: null,
  dildo: sexualBlock,
  doggystyle: sexualBlock,
  'double penetration': sexualBlock,
  dyke: slurAmbiguous,
  ejaculate: sexualBlock,
  fag: slurAmbiguous,
  felch: sexualBlock,
  fellatio: sexualBlock,
  'finger bang': sexualBlock,
  fisting: sexualBlock,
  fuck: strongLanguage,
  gangbang: sexualBlock,
  handjob: sexualBlock,
  hentai: sexualBlock,
  hooker: sexualAmbiguous,
  incest: sexualBlock,
  'jerk off': sexualBlock,
  jizz: sexualBlock,
  kike: slurBlock,
  lubejob: sexualBlock,
  masturbate: sexualBlock,
  negro: slurAmbiguous,
  nigger: slurBlock,
  orgasm: sexualBlock,
  orgy: sexualBlock,
  penis: nudityAmbiguous,
  piss: moderateLanguage,
  porn: sexualBlock,
  prick: null,
  pussy: null,
  rape: sexualBlock,
  retard: slurAmbiguous,
  scat: null,
  semen: sexualAmbiguous,
  sex: sexualAmbiguous,
  shit: moderateLanguage,
  slut: strongLanguage,
  spastic: slurAmbiguous,
  tit: null,
  tranny: slurAmbiguous,
  turd: mildLanguage,
  twat: strongLanguage,
  vagina: nudityAmbiguous,
  wank: strongLanguage,
  whore: strongLanguage
};

const words = (list: string[]) => new RegExp(`\\b(?:${list.join('|')})\\b`, 'g');
/** Native-script terms: JS \b is ASCII-only, so these match as substrings (they are distinctive). */
const native = (list: string[]) => new RegExp(`(?:${list.map((w) => w.normalize('NFKC')).join('|')})`, 'gu');

/** Rating-shaping and extra sexual/abuse terms not in the obscenity dataset. */
export const LEXICON: readonly LexEntry[] = [
  // ── Sexual (beyond the dataset) ──
  { re: words(['erotica?', 'onlyfans', 'strip ?tease', 'sexting', 'sex ?tape', 'nudes']), category: 'sexual', tier: 'block', sexualSignal: true },
  // Ambiguous sexual words are WEAK signals: near a minor or a public figure they go to the
  // classifier (never a strike by themselves). "Make out" only in its kissing sense ("the kids
  // could barely make out the castle" is innocent); "xxx" is also how people sign off with kisses.
  { re: words(['sexy', 'seductive(?:ly)?', 'seduc(?:e|es|ed|ing)', 'lingerie', 'nsfw', 'stripper', 'aroused', 'horny', 'kinky', 'make ?out with', 'makes ?out with', 'making ?out', 'made ?out with', 'lap ?dance', 'brothel', 'xxx']), category: 'sexual', tier: 'ambiguous', sexualSignal: true },
  { re: words(['naked', 'nude', 'nudity', 'topless', 'undress(?:es|ed|ing)?', 'unclothed', 'skinny ?dipping']), category: 'nudity', tier: 'ambiguous', nuditySignal: true },

  // ── Graphic gore: never clear by itself (the classifier decides adapt vs X) ──
  {
    re: words([
      'gore', 'gory', 'guts', 'entrails', 'intestines', 'innards', 'viscera', 'disembowel\\w*', 'dismember\\w*', 'decapitat\\w*',
      'behead\\w*', 'mutilat\\w*', 'flay(?:s|ed|ing)?', 'skinned alive', 'severed (?:head|heads|limb|limbs|arm|arms|leg|legs)',
      'blood ?bath', 'blood-soaked', 'splatter\\w*', 'torture(?:s|d)?', 'torturing', 'eviscerat\\w*', 'brains? splatter\\w*', 'gouge\\w* (?:out )?(?:his|her|their|the) eyes?'
    ]),
    category: 'graphic_gore',
    tier: 'ambiguous'
  },

  // ── Violence and weapons (rating-shaping) ──
  { re: words(['kill', 'kills', 'killed', 'killing', 'killer', 'slay', 'slays', 'slain']), category: 'violence', tier: 'ambiguous', clearAt: 'PG' },
  { re: words(['murder\\w*', 'stab', 'stabs', 'stabbed', 'stabbing', 'strangl\\w*', 'corpses?', 'dead bod(?:y|ies)', 'massacre\\w*']), category: 'violence', tier: 'ambiguous', clearAt: 'PG-13' },
  { re: words(['blood', 'bloody', 'bloodied', 'bleed', 'bleeds', 'bleeding', 'wounds', 'wounded']), category: 'violence', tier: 'ambiguous', clearAt: 'PG-13' },
  { re: words(['guns?', 'pistols?', 'rifles?', 'shotguns?', 'firearms?', 'revolvers?', 'machine ?guns?', 'shoot', 'shoots', 'shooting', 'shot dead', 'gunned down']), category: 'weapons', tier: 'ambiguous', clearAt: 'PG-13' },
  { re: words(['knife', 'knives', 'bombs?', 'grenades?', 'explosives?']), category: 'weapons', tier: 'ambiguous', clearAt: 'PG' },

  // ── Self-harm (never clear by itself; instructions are blocked below) ──
  {
    re: words(['suicide', 'suicidal', 'kill (?:myself|yourself|himself|herself|themselves)', 'self[- ]?harm\\w*', 'cut(?:ting)? (?:myself|yourself|himself|herself|themselves)', 'overdos\\w*', 'hang (?:myself|yourself|himself|herself|themselves)']),
    category: 'self_harm',
    tier: 'ambiguous'
  },

  // ── Substances (rating-shaping) ──
  { re: words(['cocaine', 'heroin', 'meth', 'methamphetamine', 'crack pipe', 'lsd', 'mdma', 'marijuana', 'ganja', 'charas', 'opium', 'drugs?', 'stoned']), category: 'substances', tier: 'ambiguous', clearAt: 'PG-13' },
  { re: words(['drunk', 'beer', 'beers', 'wine', 'vodka', 'whiske?y', 'rum', 'tequila', 'alcohol', 'liquor', 'daru', 'sharab', 'cigarettes?', 'cigars?', 'smoking', 'vap(?:e|es|ing)']), category: 'substances', tier: 'ambiguous', clearAt: 'PG-13' },

  // ── Language (beyond the dataset) ──
  { re: words(['damn', 'damned', 'dammit', 'goddamn', 'hell', 'crap', 'crappy', 'bloody hell']), category: 'language', tier: 'ambiguous', clearAt: 'PG' },
  { re: words(['motherf\\w*', 'wtf', 'stfu']), category: 'language', tier: 'ambiguous' },

  // ── Hate symbols (context: a WW2 story is fine; the classifier decides) ──
  { re: words(['swastikas?', 'kkk', 'white power', 'sieg heil', 'heil hitler', 'ethnic cleansing']), category: 'hate', tier: 'ambiguous' },

  // ── Romanized Hindi / Telugu abuse (minimal; the classifier covers the rest) ──
  { re: words(['madarchod', 'maderchod', 'behe?nchod', 'bhe?nchod', 'bhosdi\\w*', 'chutiy[ae]', 'chutia', 'gaa?ndu', 'lund', 'dengu', 'dengey', 'puku', 'modda']), category: 'language', tier: 'ambiguous' },
  { re: words(['randi', 'lanja']), category: 'language', tier: 'ambiguous', sexualSignal: true },
  { re: words(['harami', 'kamina', 'kameena']), category: 'language', tier: 'ambiguous', clearAt: 'PG-13' },
  // Native script (Devanagari / Telugu).
  { re: native(['मादरचोद', 'बहनचोद', 'भेनचोद', 'चूतिया', 'भोसड़ी', 'లంజ', 'దెంగు', 'పూకు', 'మొడ్డ']), category: 'language', tier: 'ambiguous' },
  { re: native(['रंडी']), category: 'language', tier: 'ambiguous', sexualSignal: true }
];

/**
 * Real-world harm instructions (block, `dangerous`): an instruction verb near a making verb near
 * a weapon/drug/poison. "the hero builds a bomb shelter" never matches (no instruction words).
 */
export const DANGEROUS_INSTRUCTIONS: readonly RegExp[] = [
  // Story props are excluded: bomb shelters/squads, poison apples and potions (fantasy), "a crack
  // in the wall", "method" (meth is matched as a whole word only).
  /\b(?:how (?:do (?:i|you) |to )|recipe (?:for|to)|steps? (?:to|for)|step[- ]by[- ]step|instructions? (?:for|to|on)|guide (?:to|for)|tutorial|teach me (?:how )?to|ways? to)\b.{0,60}?\b(?:make|making|build|building|cook|cooking|synthesi[sz]e|assemble|brew|mix|3d[- ]print|manufacture)\b.{0,40}?\b(?:pipe ?bombs?|bombs?(?![- ](?:shelters?|squads?|disposal|drills?|threats?|scares?|proof|sniff\w*))|explosives?|ied|napalm|thermite|molotov\w*|meth|methamphetamine|crystal meth|crack cocaine|crack rocks?|poisons?(?![- ](?:apples?|potions?|ivy|darts?|mushrooms?|frogs?|berr(?:y|ies)|oak|gas cloud))|nerve (?:agent|gas)|ricin|sarin|anthrax|ghost guns?|silencers?|suppressors?|untraceable guns?|grenades?|landmines?)\b/,
  /\b(?:how (?:do (?:i|you) |to )|best way to|easiest way to|ways? to)\b.{0,30}?\b(?:poison (?:someone|a person|my|him|her|them)|make (?:someone|a person) overdose|untraceable poison)\b/
];

/** Supportive framing around a self-harm instruction match ("how to help a friend who…", "ways to
 *  prevent suicide"): the classifier decides instead of a block. */
export const SELF_HARM_SUPPORT = /\b(?:prevent\w*|stop(?:ping)?|help(?:ing)?|support\w*|talk(?:ing)? (?:to|with|about)|cope|coping|awareness|recover\w*|survive|surviving|hotline|helpline|counsel\w*|therap\w*)\b/;

/** Instructions for self-harm (block, `self_harm`, no strike: answered with care). */
export const SELF_HARM_INSTRUCTIONS: readonly RegExp[] = [
  /\b(?:how (?:do (?:i|you) |to )|best way to|easiest way to|painless way to|ways? to|methods? (?:of|to|for)|tips (?:for|to|on))\b.{0,30}?\b(?:kill (?:myself|yourself|oneself)|commit suicide|suicide|end (?:my|your) life|self[- ]?harm|cut (?:myself|yourself)|overdose|hang (?:myself|yourself))\b/
];

/** First-person crisis wording (the reply adds a caring line). */
export const FIRST_PERSON_CRISIS = /\b(?:kill(?:ing)? myself|end(?:ing)? my life|i (?:want|wanna|am going|'m going|plan) to die|hurt(?:ing)? myself|cut(?:ting)? myself)\b/;

/** Words for minors (co-occurrence with a sexual term ⇒ zero-tolerance block). */
export const MINOR_TERMS: RegExp = new RegExp(
  `\\b(?:${[
    'child', 'children', 'childs?', 'kids?', 'kiddies', 'minors?', 'underage', 'under-age', 'toddlers?', 'bab(?:y|ies)', 'infants?',
    'pre-?teens?', 'tweens?', 'teens?', 'teenage(?:rs?)?', 'schoolgirls?', 'schoolboys?', 'school ?girls?', 'school ?boys?', 'loli', 'lolita',
    'shota', 'young (?:girls?|boys?)', 'little (?:girls?|boys?)', 'girl child', 'boy child', 'juveniles?', 'kindergarten\\w*', 'grade ?schoolers?',
    'pre-?schoolers?', 'jailbait'
  ].join('|')})\\b`,
  'g'
);
/** "12 year old", "a 9-year-old", "aged 15" (matched on the un-folded text; < 18 counts as a minor). */
export const MINOR_AGE = /\b(\d{1,2})\s*-?\s*(?:years?|yrs?)[-\s]?olds?\b|\b(\d{1,2})\s*(?:y\/o|yo)\b|\baged\s+(\d{1,2})\b/g;
/** Native-script minor words (Hindi / Telugu). */
export const MINOR_NATIVE: RegExp = native(['बच्चे', 'बच्चा', 'बच्ची', 'बच्चों', 'नाबालिग', 'పిల్లలు', 'పిల్లల', 'బాలిక', 'బాలుడు', 'మైనర్']);

/** Public figures (respectful portrayals are fine; with any sexual term ⇒ severe block). */
export const REAL_PEOPLE: RegExp = words([
  'narendra modi', 'modi', 'rahul gandhi', 'sonia gandhi', 'amit shah', 'yogi adityanath', 'arvind kejriwal', 'mamata banerjee',
  'donald trump', 'trump', 'joe biden', 'biden', 'kamala harris', 'barack obama', 'obama', 'vladimir putin', 'putin', 'xi jinping',
  'elon musk', 'taylor swift', 'shah rukh khan', 'srk', 'salman khan', 'aamir khan', 'amitabh bachchan', 'deepika padukone',
  'alia bhatt', 'priyanka chopra', 'virat kohli', 'sachin tendulkar', 'ms dhoni', 'prabhas', 'allu arjun', 'chiranjeevi',
  'mahesh babu', 'jr ntr', 'ram charan', 'pawan kalyan', 'rajinikanth', 'king charles', 'pope francis', 'pope leo'
]);

/** Trademarked names → canonical name + a hint for an original homage (a steer, never a block). */
export interface IpName {
  re: RegExp;
  name: string;
  homage: string;
}
const ip = (patterns: string[], name: string, homage: string): IpName => ({ re: words(patterns), name, homage });
export const IP_NAMES: readonly IpName[] = [
  ip(['crayon shin-?chan', 'shin-?chan', 'shin chan', 'shinchan'], 'Shin-chan', 'a cheeky five-year-old with the same chaos energy'),
  ip(['doraemon', 'doremon', 'nobita'], 'Doraemon', 'a gadget-pocket robot pal from the future'),
  ip(['chh?ota bh?eem', 'chhota bheem'], 'Chhota Bheem', 'a laddoo-powered village hero'),
  ip(['motu patlu'], 'Motu Patlu', 'two mismatched best friends who bumble into adventures'),
  ip(['lego'], 'LEGO', 'snap-together brick figures with their own look'),
  ip(['baa?hubali'], 'Baahubali', 'an epic warrior-prince with legendary strength'),
  ip(['spider-?man', 'spiderman', 'spidey'], 'Spider-Man', 'a web-slinging teen hero with an original suit'),
  ip(['batman'], 'Batman', 'a caped night detective with gadgets'),
  ip(['superman'], 'Superman', 'a flying hero with a new emblem'),
  ip(['iron ?man'], 'Iron Man', 'an inventor in a home-built power suit'),
  ip(['hulk'], 'Hulk', 'a gentle giant who grows huge when upset'),
  ip(['captain america'], 'Captain America', 'a shield-carrying hero with an original emblem'),
  ip(['avengers'], 'Avengers', 'an original hero team'),
  ip(['marvel'], 'Marvel', 'original heroes with their own powers'),
  ip(['dc comics', 'justice league'], 'DC Comics', 'original heroes with their own powers'),
  ip(['disney', 'pixar'], 'Disney', 'an original storybook look'),
  ip(['mickey(?: mouse)?', 'minnie(?: mouse)?', 'donald duck', 'goofy'], 'Mickey Mouse', 'a cheerful cartoon mouse of your own design'),
  ip(['elsa', 'frozen'], 'Frozen', 'an ice-magic princess with an original design'),
  ip(['pok[eé]mon', 'pikachu', 'charizard'], 'Pokémon', 'original pocket creatures'),
  ip(['naruto'], 'Naruto', 'a determined young ninja of your own design'),
  ip(['goku', 'dragon ?ball'], 'Dragon Ball', 'a spiky-haired martial-arts hero'),
  ip(['one piece', 'luffy'], 'One Piece', 'a rubbery pirate captain of your own design'),
  ip(['harry potter', 'hogwarts', 'hermione'], 'Harry Potter', 'a young wizard at an original magic school'),
  ip(['peppa pig'], 'Peppa Pig', 'a cheerful little piglet family'),
  ip(['paw patrol'], 'Paw Patrol', 'a team of rescue pups'),
  ip(['bluey'], 'Bluey', 'a playful puppy family'),
  ip(['sponge ?bob'], 'SpongeBob', 'a bubbly undersea character'),
  ip(['super mario', 'mario bros', 'luigi'], 'Super Mario', 'a jumping plumber-style hero of your own'),
  ip(['sonic the hedgehog'], 'Sonic', 'a super-fast critter of your own design'),
  ip(['minecraft'], 'Minecraft', 'a blocky build-anything world'),
  ip(['barbie'], 'Barbie', 'a stylish doll character of your own design'),
  ip(['hello kitty'], 'Hello Kitty', 'a cute kitten mascot of your own'),
  ip(['transformers', 'optimus prime', 'bumblebee'], 'Transformers', 'car-to-robot heroes of your own design'),
  ip(['star wars', 'darth vader', 'jedi', 'lightsabers?'], 'Star Wars', 'space knights with glowing blades of your own design'),
  ip(['totoro', 'ghibli'], 'Studio Ghibli', 'a gentle forest spirit with an original look'),
  ip(['tom and jerry'], 'Tom and Jerry', 'a cat-and-mouse chase duo of your own'),
  ip(['scooby-?doo'], 'Scooby-Doo', 'a mystery-solving dog and friends'),
  ip(['ben ?10'], 'Ben 10', 'a kid with an alien-transforming watch of your own design')
];

/**
 * Horror/action vocabulary and idioms that NEVER escalate (removed before matching).
 * Monsters, zombies, ghosts, battles, explosions and villains are welcome at every rating;
 * the generation rules shape how they are drawn.
 */
export const ALLOW_PHRASES: readonly RegExp[] = [
  words([
    'killer whales?', 'killer bees?', 'killer app', 'killer smile', 'killing time', 'kill time', 'kill the lights', 'kill the engine', 'lady ?killer',
    'blood moon', 'blood orange', 'blood types?', 'blood banks?', 'blood tests?', 'blood pressure', 'blood donors?', 'bloodhounds?', 'blood brothers?',
    'shiitake', 'cum laude', 'flame ?retardants?', 'retardants?', 'scunthorpe', 'naked eye', 'naked mole[- ]rats?', 'chink in (?:the|his|her|its) armou?r',
    'water ?guns?', 'nerf ?guns?', 'squirt ?guns?', 'bubble ?guns?', 'glue ?guns?', 'toy ?guns?', 'ray ?guns?', 'laser ?guns?', 'freeze ?rays?',
    'photo ?shoot', 'shoot(?:ing)? (?:for )?the stars', 'shooting stars?', 'shoot(?:s|ing)? hoops', 'bamboo shoots?',
    'shoot(?:s|ing)? (?:the|a) (?:ball|basket|goal|hoop|puck|arrow at the target)', 'shoots and scores', 'bath ?bombs?', 'photo ?bomb\\w*', 'glitter ?bombs?', 'water ?balloons?',
    'butter ?knife', 'butter ?knives', 'pocket ?knife', 'hell ?bent', 'what the heck', 'root ?beer', 'ginger ?beer', 'wine ?gums?', 'gripe ?water',
    'dead tired', 'drop dead gorgeous', 'pokemon go'
  ])
];
