export type StylePreset = {
  id: string;
  label: string;
  prompt: string;
  description: string;
};

export const STYLE_PRESETS: StylePreset[] = [
  { id: 'ligne-claire', label: 'Ligne Claire (Clear Line)', prompt: 'ultra clean line art, flat color fills, crisp outlines, zero shading clutter', description: 'Clean lines, fast readability, intelligent world-building.' },
  { id: 'ink-wash', label: 'Ink Wash / Sumi-e Noir', prompt: 'flowing ink wash, controlled chaos, textured paper grain, dramatic contrast', description: 'Handmade, emotional, timeless even in sci-fi.' },
  { id: 'indian-miniature', label: 'Indian Miniature x Sci-Fi', prompt: 'flat perspective, rich ornamental detail, jewel tones, symbolic composition', description: 'Mythology fused with technology, rare and distinctive.' },
  { id: 'woodcut', label: 'Woodcut / Linocut', prompt: 'bold carved lines, high contrast, raw texture, printmaking style', description: 'Dystopian, revolutionary, propaganda power.' },
  { id: 'dieselpunk', label: 'Dieselpunk', prompt: '1920s-40s retro futurism, art deco machinery, soot and chrome', description: 'Alternate timelines and authoritarian futures.' },
  { id: 'brutalist', label: 'Brutalist Graphic Novel', prompt: 'harsh geometry, heavy negative space, limited palette, oppressive tone', description: 'Cold, controlled, and unsettling visuals.' },
  { id: 'surreal-dream', label: 'Surreal / Dream-Logic', prompt: 'impossible shapes, distorted anatomy, symbolic surrealism, dreamlike', description: 'Reality-breaking visuals for multiverse stories.' },
  { id: 'chalk-pastel', label: 'Chalk / Pastel Noir', prompt: 'soft pastel textures, dusty colors, moody haze, hand-drawn feel', description: 'Atmospheric, rare, memory-heavy tone.' },
  { id: 'retrofuturism', label: 'Retrofuturism 60s-70s', prompt: 'optimistic vintage future, retro sci-fi posters, bright palettes', description: 'Nostalgia for a future that never happened.' },
  { id: 'mythic-icon', label: 'Mythological Sci-Fi Iconography', prompt: 'deity-like poses, symbolic framing, epic scale, sacred geometry', description: 'Religious art from the future.' },
  { id: 'manga-bw', label: 'Manga (B&W)', prompt: 'manga style, black and white, high contrast, screentones, intricate line art', description: 'Classic manga readability with speed lines.' },
  { id: 'western-comic', label: 'Modern Western', prompt: 'modern western comic book style, vibrant colors, dynamic shading, sharp outlines', description: 'Bold, cinematic, mainstream energy.' },
  { id: 'noir', label: 'Noir / Sin City', prompt: 'film noir graphic novel style, extreme chiaroscuro, black white and one accent color', description: 'High-contrast mood, dramatic tension.' },
  { id: 'webtoon', label: 'Webtoon / Anime', prompt: 'webtoon digital art style, soft shading, anime aesthetics, bright cel shading', description: 'Clean, modern, mobile-friendly.' },
  { id: 'watercolor', label: 'Watercolor', prompt: 'watercolor graphic novel style, dreamy, soft edges, painterly texture', description: 'Gentle, emotional, storybook feel.' },
  { id: 'cyberpunk', label: 'Cyberpunk', prompt: 'cyberpunk neon aesthetic, digital painting, glowing lights, gritty futuristic', description: 'Neon, high-tech, and gritty.' }
];

export const RECOMMENDED_STYLE_IDS = [
  'ligne-claire',
  'ink-wash',
  'indian-miniature',
  'dieselpunk',
  'retrofuturism'
];
