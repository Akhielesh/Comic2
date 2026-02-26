export type CoverTemplateDefinition = {
  id: string;
  label: string;
  description: string;
  compositionRules: string;
  focalStrategy: string;
  safeZoneNotes: string;
  toneTags: string[];
};

export const COVER_TEMPLATE_DEFINITIONS: CoverTemplateDefinition[] = [
  {
    id: 'hero-splash',
    label: 'Hero Splash',
    description: 'Single dominant subject with strong silhouette and high readability from thumbnail size.',
    compositionRules: 'Center-weighted or thirds-based hero composition with strong foreground/background depth.',
    focalStrategy: 'One clear focal subject, secondary elements framing the hero.',
    safeZoneNotes: 'Keep top 18% and bottom 12% visually clean for title, issue badge, and credits overlays.',
    toneTags: ['bold', 'iconic', 'high-contrast']
  },
  {
    id: 'duel-standoff',
    label: 'Dual-Character Standoff',
    description: 'Two opposing forces with directional tension and clear conflict silhouette.',
    compositionRules: 'Split composition with converging perspective lines; maintain breathing room for masthead.',
    focalStrategy: 'Two focal anchors balanced by environmental framing.',
    safeZoneNotes: 'Reserve top band for masthead and avoid key faces near corners for crop safety.',
    toneTags: ['tense', 'cinematic', 'confrontational']
  },
  {
    id: 'mystic-frame',
    label: 'Mystic Title Frame',
    description: 'Ornamental frame with atmospheric center scene and symbolic edge motifs.',
    compositionRules: 'Decorative border encloses central narrative iconography; avoid clutter in frame corners.',
    focalStrategy: 'Central emblematic subject supported by symbolic motifs.',
    safeZoneNotes: 'Frame margin should preserve 10% inside padding for logo and subtitle overlays.',
    toneTags: ['mythic', 'ornate', 'atmospheric']
  },
  {
    id: 'minimal-icon',
    label: 'Minimal Icon + Background',
    description: 'Large negative space and one iconic symbol/character for strong cover identity.',
    compositionRules: 'Use geometric balance and negative space; avoid multi-subject clutter.',
    focalStrategy: 'Single icon-level focal object with strong contrast against background.',
    safeZoneNotes: 'Keep center focal subject away from exact top-center so title overlays remain legible.',
    toneTags: ['minimal', 'graphic', 'modern']
  },
  {
    id: 'collage-triptych',
    label: 'Collage / Triptych',
    description: 'Three narrative slices unified by one palette and directional flow.',
    compositionRules: 'Three compositional zones with visual hierarchy and consistent perspective language.',
    focalStrategy: 'Primary central beat, with supporting side beats and no duplicated focal competition.',
    safeZoneNotes: 'Maintain clean text-safe region at top and avoid tiny unreadable micro-details.',
    toneTags: ['epic', 'story-rich', 'layered']
  }
];
