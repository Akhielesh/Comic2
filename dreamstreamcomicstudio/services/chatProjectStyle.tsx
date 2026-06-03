// Curated, minimalist icon + color sets for chat projects (shadcn / 21st.dev vibe:
// simple line icons + a small, tasteful swatch palette).

import {
  Folder, Briefcase, Code2, BookOpen, Lightbulb, FlaskConical, Rocket, Palette,
  Bug, GraduationCap, Heart, Star, Globe, MessageSquare, type LucideIcon
} from 'lucide-react';

export const PROJECT_ICONS: { name: string; Icon: LucideIcon }[] = [
  { name: 'folder', Icon: Folder },
  { name: 'briefcase', Icon: Briefcase },
  { name: 'code', Icon: Code2 },
  { name: 'book', Icon: BookOpen },
  { name: 'idea', Icon: Lightbulb },
  { name: 'lab', Icon: FlaskConical },
  { name: 'rocket', Icon: Rocket },
  { name: 'palette', Icon: Palette },
  { name: 'bug', Icon: Bug },
  { name: 'grad', Icon: GraduationCap },
  { name: 'heart', Icon: Heart },
  { name: 'star', Icon: Star },
  { name: 'globe', Icon: Globe },
  { name: 'chat', Icon: MessageSquare }
];

export const iconByName = (name: string): LucideIcon =>
  PROJECT_ICONS.find((i) => i.name === name)?.Icon || Folder;

export interface ProjectColor {
  key: string;
  /** Solid swatch (the picker dot + icon tint background). */
  dot: string;
  /** Soft tinted surface + border for the project header. */
  soft: string;
}

export const PROJECT_COLORS: ProjectColor[] = [
  { key: 'slate', dot: 'bg-slate-400', soft: 'bg-slate-100 border-slate-300' },
  { key: 'red', dot: 'bg-red-400', soft: 'bg-red-50 border-red-300' },
  { key: 'amber', dot: 'bg-amber-400', soft: 'bg-amber-50 border-amber-300' },
  { key: 'green', dot: 'bg-emerald-400', soft: 'bg-emerald-50 border-emerald-300' },
  { key: 'blue', dot: 'bg-blue-400', soft: 'bg-blue-50 border-blue-300' },
  { key: 'violet', dot: 'bg-violet-400', soft: 'bg-violet-50 border-violet-300' },
  { key: 'pink', dot: 'bg-pink-400', soft: 'bg-pink-50 border-pink-300' },
  { key: 'teal', dot: 'bg-teal-400', soft: 'bg-teal-50 border-teal-300' }
];

export const colorByKey = (key: string): ProjectColor =>
  PROJECT_COLORS.find((c) => c.key === key) || PROJECT_COLORS[4];

export const DEFAULT_PROJECT_ICON = 'folder';
export const DEFAULT_PROJECT_COLOR = 'blue';
