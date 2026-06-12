export type CoverTemplateDefinition = {
  id: string;
  label: string;
  description: string;
  compositionRules: string;
  focalStrategy: string;
  safeZoneNotes: string;
  /** Masthead/title treatment direction — covers render their own trade dress now. */
  typography: string;
  toneTags: string[];
};

export const COVER_TEMPLATE_DEFINITIONS: CoverTemplateDefinition[] = [
  {
    id: 'hero-splash',
    label: 'Hero Splash',
    description: 'Single dominant subject with strong silhouette and high readability from thumbnail size.',
    compositionRules: 'Center-weighted or thirds-based hero composition with strong foreground/background depth.',
    focalStrategy: 'One clear focal subject, secondary elements framing the hero.',
    safeZoneNotes: 'Keep top 18% visually calm so the masthead dominates it; keep bottom corners clean.',
    typography: 'Huge blockbuster masthead across the top — thick, beveled display letters with a hard drop shadow, slightly overlapped by the hero\'s head for depth.',
    toneTags: ['bold', 'iconic', 'high-contrast']
  },
  {
    id: 'cinematic-montage',
    label: 'Cinematic Montage',
    description: 'Movie-poster style cast montage: lead in front, supporting cast and world layered behind.',
    compositionRules: 'Layered depth montage — foreground lead at waist-up, mid-ground allies/rivals at smaller scale, cityscape or key setting filling the background; one unified color grade.',
    focalStrategy: 'The lead\'s face is the anchor; every other element recedes in scale and contrast.',
    safeZoneNotes: 'Keep one upper corner calmer for the masthead; avoid faces at the extreme edges.',
    typography: 'Distressed, oversized title letters dominating the upper third — gritty texture inside the letterforms, with a short tagline line in small caps above or below.',
    toneTags: ['epic', 'cinematic', 'ensemble']
  },
  {
    id: 'duel-standoff',
    label: 'Dual-Character Standoff',
    description: 'Two opposing forces with directional tension and clear conflict silhouette.',
    compositionRules: 'Split composition with converging perspective lines; maintain breathing room for masthead.',
    focalStrategy: 'Two focal anchors balanced by environmental framing.',
    safeZoneNotes: 'Reserve top band for masthead and avoid key faces near corners for crop safety.',
    typography: 'Masthead split across the top band between the two figures; angular, high-tension letterforms; tagline wedged along the dividing line.',
    toneTags: ['tense', 'cinematic', 'confrontational']
  },
  {
    id: 'painted-epic',
    label: 'Painted Epic Saga',
    description: 'Ornate painted-poster cover: regal figures, golden light, monumental scale.',
    compositionRules: 'Low-angle monumental composition; painted rendering with rich texture; grand architecture or battlefield sweeping behind the figures.',
    focalStrategy: 'One regal central figure (or pair), framed by armies/structures at miniature scale.',
    safeZoneNotes: 'Keep the sky/upper area open for an engraved masthead.',
    typography: 'Engraved metallic masthead — gold or carved-stone letterforms with serifs and ornamental flourishes, plus a small "Legend begins" style banner line.',
    toneTags: ['mythic', 'regal', 'painterly']
  },
  {
    id: 'mystic-frame',
    label: 'Mystic Title Frame',
    description: 'Ornamental frame with atmospheric center scene and symbolic edge motifs.',
    compositionRules: 'Decorative border encloses central narrative iconography; avoid clutter in frame corners.',
    focalStrategy: 'Central emblematic subject supported by symbolic motifs.',
    safeZoneNotes: 'Frame margin should preserve 10% inside padding for the integrated logotype.',
    typography: 'Title worked INTO the ornamental frame at the top — arcane, illuminated-manuscript letterforms that share the frame\'s motifs.',
    toneTags: ['mythic', 'ornate', 'atmospheric']
  },
  {
    id: 'minimal-icon',
    label: 'Minimal Icon + Background',
    description: 'Large negative space and one iconic symbol/character for strong cover identity.',
    compositionRules: 'Use geometric balance and negative space; avoid multi-subject clutter.',
    focalStrategy: 'Single icon-level focal object with strong contrast against background.',
    safeZoneNotes: 'Keep center focal subject away from exact top-center so the logotype stays legible.',
    typography: 'Small, precise, modernist title — clean geometric sans-serif set in the negative space, lots of air around it; no drop shadows.',
    toneTags: ['minimal', 'graphic', 'modern']
  },
  {
    id: 'retro-pulp',
    label: 'Retro Pulp Issue',
    description: 'Vintage newsstand comic: halftone dots, loud colors, classic corner box and issue badge.',
    compositionRules: 'Slightly off-kilter action vignette with halftone shading, bold outlines, aged paper tint.',
    focalStrategy: 'One melodramatic action beat staged like a 1960s cover.',
    safeZoneNotes: 'Top quarter belongs to the masthead band; leave the top-left corner for a small badge.',
    typography: 'Classic newsstand masthead band across the very top — chunky retro letterforms on a solid color band, a starburst "#1" badge, and a melodramatic hook line in a small caption box.',
    toneTags: ['retro', 'pulp', 'playful']
  },
  {
    id: 'collage-triptych',
    label: 'Collage / Triptych',
    description: 'Three narrative slices unified by one palette and directional flow.',
    compositionRules: 'Three compositional zones with visual hierarchy and consistent perspective language.',
    focalStrategy: 'Primary central beat, with supporting side beats and no duplicated focal competition.',
    safeZoneNotes: 'Maintain clean text-safe region at top and avoid tiny unreadable micro-details.',
    typography: 'Tall condensed masthead running across all three slices to bind them; tagline tucked under the masthead rule line.',
    toneTags: ['epic', 'story-rich', 'layered']
  }
];
