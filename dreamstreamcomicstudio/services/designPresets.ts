// Client mirror of the server's design-system presets (id + name only) for the design-system picker.
// Source of truth: server/src/ai/studio/designSystem.ts (DESIGN_PRESETS). Keep ids in sync — the
// designPresets.sync test asserts this list matches the server's.

export interface DesignPresetMeta { id: string; name: string; }

export const DESIGN_PRESETS: DesignPresetMeta[] = [
  { id: 'comic', name: 'DreamStream Comic' },
  { id: 'warm-editorial', name: 'Warm Editorial' },
  { id: 'minimal-product', name: 'Minimal Product' },
  { id: 'premium-saas', name: 'Premium SaaS' },
  { id: 'playful', name: 'Playful Consumer' },
  { id: 'neobrutalist', name: 'Neobrutalist' },
  { id: 'glass-aurora', name: 'Glass / Aurora' },
  { id: 'dark-terminal', name: 'Dark Terminal' },
  { id: 'ios-native', name: 'iOS Native' },
  { id: 'material', name: 'Material 3' },
  { id: 'data-dashboard', name: 'Data Dashboard' },
  { id: 'luxury-editorial', name: 'Luxury Editorial' },
  { id: 'swiss', name: 'Swiss / International' },
  { id: 'bento', name: 'Bento Grid' },
  { id: 'synthwave', name: 'Synthwave / Retro 80s' },
  { id: 'corporate-trust', name: 'Corporate Trust' },
  { id: 'ecommerce', name: 'E-commerce / Storefront' },
  { id: 'workspace', name: 'Calm Workspace' },
  { id: 'pastel-soft', name: 'Soft Pastel' },
  { id: 'gradient-mesh', name: 'Gradient Mesh' },
  { id: 'claymorphism', name: 'Claymorphism' },
  { id: 'a11y-first', name: 'Accessibility-First' },
  { id: 'magazine', name: 'Magazine / Print' },
  { id: 'developer-docs', name: 'Developer Docs' },
  { id: 'monospace', name: 'Monospace Minimal' },
  { id: 'kids-bright', name: 'Kids / Education' },
];
