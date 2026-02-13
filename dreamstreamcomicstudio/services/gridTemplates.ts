/**
 * Grid template definitions for comic page layouts.
 *
 * Each template defines a fixed number of panel slots with positions in
 * percentage coordinates (0-100) so they scale to any page resolution.
 * Templates are tagged with compatible aspect ratios and descriptive tags.
 */
import type { AspectRatio } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A rectangular region on the page expressed in percentages. */
export type PanelSlot = {
    id: string;
    /** X offset from left edge as % of page width (0-100) */
    x: number;
    /** Y offset from top edge as % of page height (0-100) */
    y: number;
    /** Width as % of page width */
    width: number;
    /** Height as % of page height */
    height: number;
    /** Effective aspect ratio for generating the panel image */
    effectiveRatio: AspectRatio;
    /** Optional label shown in the editor */
    label?: string;
};

export type GridTemplateId = string;

export type GridTemplate = {
    id: GridTemplateId;
    variant?: string;
    title: string;
    description: string;
    panelCount: number;
    panelSlots: PanelSlot[];
    compatibleRatios: AspectRatio[];
    tags: string[];
};

// ---------------------------------------------------------------------------
// Internal helper — gutter between panels (%)
// ---------------------------------------------------------------------------
const G = 1.5; // gutter percentage

// ---------------------------------------------------------------------------
// Portrait templates  (3:4, 2:3, 9:16)
// ---------------------------------------------------------------------------

const portraitRatios: AspectRatio[] = ['3:4', '2:3', '9:16'];

const PORTRAIT_3_STACK: GridTemplate = {
    id: 'portrait-3-stack',
    title: '3-Panel Stack',
    description: 'Three evenly stacked panels — clean vertical flow.',
    panelCount: 3,
    panelSlots: [
        { id: 'p1', x: 0, y: 0, width: 100, height: 32, effectiveRatio: '3:2', label: 'Top' },
        { id: 'p2', x: 0, y: 34, width: 100, height: 32, effectiveRatio: '3:2', label: 'Middle' },
        { id: 'p3', x: 0, y: 68, width: 100, height: 32, effectiveRatio: '3:2', label: 'Bottom' },
    ],
    compatibleRatios: portraitRatios,
    tags: ['simple', 'narrative', 'vertical'],
};

const PORTRAIT_HERO_2_INSETS: GridTemplate = {
    id: 'portrait-hero-2-insets',
    title: 'Hero + 2 Insets',
    description: 'Large hero panel on top with two smaller detail panels below.',
    panelCount: 3,
    panelSlots: [
        { id: 'hero', x: 0, y: 0, width: 100, height: 60, effectiveRatio: '3:2', label: 'Hero' },
        { id: 'inset1', x: 0, y: 62, width: 48.5, height: 38, effectiveRatio: '1:1', label: 'Detail Left' },
        { id: 'inset2', x: 51.5, y: 62, width: 48.5, height: 38, effectiveRatio: '1:1', label: 'Detail Right' },
    ],
    compatibleRatios: portraitRatios,
    tags: ['dramatic', 'hero', 'action'],
};

const PORTRAIT_4_GRID: GridTemplate = {
    id: 'portrait-4-grid',
    title: '4-Panel Grid',
    description: 'Classic 2×2 grid — works for dialogue and pacing.',
    panelCount: 4,
    panelSlots: [
        { id: 'tl', x: 0, y: 0, width: 48.5, height: 48.5, effectiveRatio: '1:1', label: 'Top-Left' },
        { id: 'tr', x: 51.5, y: 0, width: 48.5, height: 48.5, effectiveRatio: '1:1', label: 'Top-Right' },
        { id: 'bl', x: 0, y: 51.5, width: 48.5, height: 48.5, effectiveRatio: '1:1', label: 'Bottom-Left' },
        { id: 'br', x: 51.5, y: 51.5, width: 48.5, height: 48.5, effectiveRatio: '1:1', label: 'Bottom-Right' },
    ],
    compatibleRatios: portraitRatios,
    tags: ['dialogue', 'conversation', 'pacing'],
};

const PORTRAIT_L_HERO: GridTemplate = {
    id: 'portrait-l-hero',
    title: 'L-Shaped Hero',
    description: 'Large L-shaped hero with two stacked side panels.',
    panelCount: 3,
    panelSlots: [
        { id: 'hero', x: 0, y: 0, width: 60, height: 100, effectiveRatio: '9:16', label: 'Hero' },
        { id: 'side-top', x: 62, y: 0, width: 38, height: 48.5, effectiveRatio: '3:4', label: 'Side Top' },
        { id: 'side-bot', x: 62, y: 51.5, width: 38, height: 48.5, effectiveRatio: '3:4', label: 'Side Bottom' },
    ],
    compatibleRatios: portraitRatios,
    tags: ['dramatic', 'hero', 'asymmetric'],
};

const PORTRAIT_MANGA_5: GridTemplate = {
    id: 'portrait-manga-5',
    title: 'Manga Dynamic',
    description: 'Manga-style 5-panel layout with varied sizes for energy and flow.',
    panelCount: 5,
    panelSlots: [
        { id: 'top-wide', x: 0, y: 0, width: 100, height: 25, effectiveRatio: '16:9', label: 'Establishing' },
        { id: 'mid-left', x: 0, y: 27, width: 55, height: 35, effectiveRatio: '3:4', label: 'Action' },
        { id: 'mid-right', x: 57, y: 27, width: 43, height: 35, effectiveRatio: '3:4', label: 'Reaction' },
        { id: 'bot-left', x: 0, y: 64, width: 43, height: 36, effectiveRatio: '1:1', label: 'Detail' },
        { id: 'bot-right', x: 45, y: 64, width: 55, height: 36, effectiveRatio: '3:2', label: 'Close-up' },
    ],
    compatibleRatios: portraitRatios,
    tags: ['manga', 'action', 'dynamic', 'varied'],
};

const PORTRAIT_DIAGONAL_CASCADE: GridTemplate = {
    id: 'portrait-diagonal-cascade',
    title: 'Diagonal Cascade',
    description: 'Staggered diagonal panels for energetic action sequences.',
    panelCount: 4,
    panelSlots: [
        { id: 'p1', x: 0, y: 0, width: 55, height: 30, effectiveRatio: '16:9', label: 'Panel 1' },
        { id: 'p2', x: 30, y: 25, width: 70, height: 25, effectiveRatio: '16:9', label: 'Panel 2' },
        { id: 'p3', x: 0, y: 50, width: 65, height: 25, effectiveRatio: '16:9', label: 'Panel 3' },
        { id: 'p4', x: 20, y: 75, width: 80, height: 25, effectiveRatio: '16:9', label: 'Panel 4' },
    ],
    compatibleRatios: portraitRatios,
    tags: ['action', 'dynamic', 'diagonal', 'energetic'],
};

const PORTRAIT_TALL_HERO_STRIP: GridTemplate = {
    id: 'portrait-tall-hero-strip',
    title: 'Tall Hero + Strip',
    description: 'Tall hero panel with a horizontal strip of 3 panels below.',
    panelCount: 4,
    panelSlots: [
        { id: 'hero', x: 0, y: 0, width: 100, height: 65, effectiveRatio: '3:4', label: 'Hero' },
        { id: 's1', x: 0, y: 67, width: 32, height: 33, effectiveRatio: '1:1', label: 'Strip 1' },
        { id: 's2', x: 34, y: 67, width: 32, height: 33, effectiveRatio: '1:1', label: 'Strip 2' },
        { id: 's3', x: 68, y: 67, width: 32, height: 33, effectiveRatio: '1:1', label: 'Strip 3' },
    ],
    compatibleRatios: portraitRatios,
    tags: ['hero', 'establishing', 'strip'],
};

// ---------------------------------------------------------------------------
// Landscape templates  (16:9, 4:3, 21:9)
// ---------------------------------------------------------------------------

const landscapeRatios: AspectRatio[] = ['16:9', '4:3', '21:9', '3:2'];

const LANDSCAPE_DUAL_WIDE: GridTemplate = {
    id: 'landscape-dual-wide',
    title: 'Dual Widescreen',
    description: 'Two cinematic widescreen panels — epic scope.',
    panelCount: 2,
    panelSlots: [
        { id: 'top', x: 0, y: 0, width: 100, height: 48, effectiveRatio: '16:9', label: 'Top' },
        { id: 'bot', x: 0, y: 52, width: 100, height: 48, effectiveRatio: '16:9', label: 'Bottom' },
    ],
    compatibleRatios: landscapeRatios,
    tags: ['cinematic', 'epic', 'widescreen'],
};

const LANDSCAPE_FILMSTRIP: GridTemplate = {
    id: 'landscape-filmstrip',
    title: 'Horizontal Filmstrip',
    description: 'Four panels in a horizontal strip — like film frames.',
    panelCount: 4,
    panelSlots: [
        { id: 'f1', x: 0, y: 10, width: 23.5, height: 80, effectiveRatio: '3:4', label: 'Frame 1' },
        { id: 'f2', x: 25.5, y: 10, width: 23.5, height: 80, effectiveRatio: '3:4', label: 'Frame 2' },
        { id: 'f3', x: 51, y: 10, width: 23.5, height: 80, effectiveRatio: '3:4', label: 'Frame 3' },
        { id: 'f4', x: 76.5, y: 10, width: 23.5, height: 80, effectiveRatio: '3:4', label: 'Frame 4' },
    ],
    compatibleRatios: landscapeRatios,
    tags: ['sequential', 'filmstrip', 'pacing'],
};

const LANDSCAPE_PANORAMIC_HERO_2: GridTemplate = {
    id: 'landscape-panoramic-hero-2',
    title: 'Panoramic Hero + 2',
    description: 'Wide panoramic establishing shot with two detail panels below.',
    panelCount: 3,
    panelSlots: [
        { id: 'panoramic', x: 0, y: 0, width: 100, height: 55, effectiveRatio: '21:9', label: 'Panoramic' },
        { id: 'detail-l', x: 0, y: 57, width: 48.5, height: 43, effectiveRatio: '16:9', label: 'Detail Left' },
        { id: 'detail-r', x: 51.5, y: 57, width: 48.5, height: 43, effectiveRatio: '16:9', label: 'Detail Right' },
    ],
    compatibleRatios: landscapeRatios,
    tags: ['panoramic', 'establishing', 'epic'],
};

const LANDSCAPE_TRIPLE_HORIZONTAL: GridTemplate = {
    id: 'landscape-triple-horizontal',
    title: 'Triple Horizontal',
    description: 'Three horizontal bands — clean narrative pacing.',
    panelCount: 3,
    panelSlots: [
        { id: 'top', x: 0, y: 0, width: 100, height: 31, effectiveRatio: '16:9', label: 'Top' },
        { id: 'mid', x: 0, y: 34, width: 100, height: 32, effectiveRatio: '16:9', label: 'Middle' },
        { id: 'bot', x: 0, y: 68, width: 100, height: 32, effectiveRatio: '16:9', label: 'Bottom' },
    ],
    compatibleRatios: landscapeRatios,
    tags: ['simple', 'narrative', 'horizontal'],
};

const LANDSCAPE_STORYBOARD_6: GridTemplate = {
    id: 'landscape-storyboard-6',
    title: 'Storyboard 6-Shot',
    description: 'Six-panel storyboard grid for tight sequential storytelling.',
    panelCount: 6,
    panelSlots: [
        { id: 's1', x: 0, y: 0, width: 32, height: 48, effectiveRatio: '16:9', label: 'Shot 1' },
        { id: 's2', x: 34, y: 0, width: 32, height: 48, effectiveRatio: '16:9', label: 'Shot 2' },
        { id: 's3', x: 68, y: 0, width: 32, height: 48, effectiveRatio: '16:9', label: 'Shot 3' },
        { id: 's4', x: 0, y: 52, width: 32, height: 48, effectiveRatio: '16:9', label: 'Shot 4' },
        { id: 's5', x: 34, y: 52, width: 32, height: 48, effectiveRatio: '16:9', label: 'Shot 5' },
        { id: 's6', x: 68, y: 52, width: 32, height: 48, effectiveRatio: '16:9', label: 'Shot 6' },
    ],
    compatibleRatios: landscapeRatios,
    tags: ['storyboard', 'sequential', 'detailed'],
};

const LANDSCAPE_HERO_SIDE: GridTemplate = {
    id: 'landscape-hero-side',
    title: 'Hero + Side Stack',
    description: 'Big hero panel on the left with vertical stack on the right.',
    panelCount: 3,
    panelSlots: [
        { id: 'hero', x: 0, y: 0, width: 60, height: 100, effectiveRatio: '3:4', label: 'Hero' },
        { id: 'side-top', x: 62, y: 0, width: 38, height: 48, effectiveRatio: '16:9', label: 'Side Top' },
        { id: 'side-bot', x: 62, y: 52, width: 38, height: 48, effectiveRatio: '16:9', label: 'Side Bottom' },
    ],
    compatibleRatios: landscapeRatios,
    tags: ['hero', 'dramatic', 'asymmetric'],
};

// ---------------------------------------------------------------------------
// Square templates  (1:1)
// ---------------------------------------------------------------------------

const squareRatios: AspectRatio[] = ['1:1', '4:5', '5:4'];

const SQUARE_2X2: GridTemplate = {
    id: 'square-2x2',
    title: '2×2 Grid',
    description: 'Four equal square panels — balanced and symmetrical.',
    panelCount: 4,
    panelSlots: [
        { id: 'tl', x: 0, y: 0, width: 48.5, height: 48.5, effectiveRatio: '1:1', label: 'Top-Left' },
        { id: 'tr', x: 51.5, y: 0, width: 48.5, height: 48.5, effectiveRatio: '1:1', label: 'Top-Right' },
        { id: 'bl', x: 0, y: 51.5, width: 48.5, height: 48.5, effectiveRatio: '1:1', label: 'Bottom-Left' },
        { id: 'br', x: 51.5, y: 51.5, width: 48.5, height: 48.5, effectiveRatio: '1:1', label: 'Bottom-Right' },
    ],
    compatibleRatios: squareRatios,
    tags: ['simple', 'balanced', 'conversation'],
};

const SQUARE_3X3: GridTemplate = {
    id: 'square-3x3',
    title: '3×3 Grid',
    description: 'Nine compact panels — high-density storytelling.',
    panelCount: 9,
    panelSlots: Array.from({ length: 9 }, (_, i) => {
        const row = Math.floor(i / 3);
        const col = i % 3;
        return {
            id: `p${i + 1}`,
            x: col * 34,
            y: row * 34,
            width: 32,
            height: 32,
            effectiveRatio: '1:1' as AspectRatio,
            label: `Panel ${i + 1}`,
        };
    }),
    compatibleRatios: squareRatios,
    tags: ['dense', 'montage', 'action'],
};

const SQUARE_SINGLE_SPLASH: GridTemplate = {
    id: 'square-single-splash',
    title: 'Single Splash',
    description: 'One big dramatic splash page — maximum impact.',
    panelCount: 1,
    panelSlots: [
        { id: 'splash', x: 0, y: 0, width: 100, height: 100, effectiveRatio: '1:1', label: 'Splash' },
    ],
    compatibleRatios: squareRatios,
    tags: ['splash', 'dramatic', 'impact'],
};

const SQUARE_ASYMMETRIC_QUAD: GridTemplate = {
    id: 'square-asymmetric-quad',
    title: 'Asymmetric Quad',
    description: 'Big hero panel with three smaller panels — visual emphasis.',
    panelCount: 4,
    panelSlots: [
        { id: 'hero', x: 0, y: 0, width: 65, height: 65, effectiveRatio: '1:1', label: 'Hero' },
        { id: 'side', x: 67, y: 0, width: 33, height: 65, effectiveRatio: '3:4', label: 'Side' },
        { id: 'bot-left', x: 0, y: 67, width: 48.5, height: 33, effectiveRatio: '3:2', label: 'Bottom-Left' },
        { id: 'bot-right', x: 51.5, y: 67, width: 48.5, height: 33, effectiveRatio: '3:2', label: 'Bottom-Right' },
    ],
    compatibleRatios: squareRatios,
    tags: ['hero', 'emphasis', 'asymmetric'],
};

const SQUARE_CONVERSATION: GridTemplate = {
    id: 'square-conversation',
    title: 'Conversation Grid',
    description: 'Balanced panels for dialogue-heavy scenes.',
    panelCount: 4,
    panelSlots: [
        { id: 'tl', x: 0, y: 0, width: 48.5, height: 48.5, effectiveRatio: '1:1', label: 'Speaker A' },
        { id: 'tr', x: 51.5, y: 0, width: 48.5, height: 48.5, effectiveRatio: '1:1', label: 'Speaker B' },
        { id: 'bl', x: 0, y: 51.5, width: 48.5, height: 48.5, effectiveRatio: '1:1', label: 'Speaker A' },
        { id: 'br', x: 51.5, y: 51.5, width: 48.5, height: 48.5, effectiveRatio: '1:1', label: 'Speaker B' },
    ],
    compatibleRatios: squareRatios,
    tags: ['dialogue', 'conversation', 'balanced'],
};

// ---------------------------------------------------------------------------
// Universal templates  (work with all aspect ratios)
// ---------------------------------------------------------------------------

const allRatios: AspectRatio[] = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

const CLASSIC_GRID: GridTemplate = {
    id: 'grid',
    title: 'Classic Grid',
    description: 'Traditional Western comic book layout. Great for dynamic action.',
    panelCount: 4,
    panelSlots: [
        { id: 'top-wide', x: 0, y: 0, width: 100, height: 30, effectiveRatio: '16:9', label: 'Establishing' },
        { id: 'mid-left', x: 0, y: 32, width: 48.5, height: 33, effectiveRatio: '3:2', label: 'Mid-Left' },
        { id: 'mid-right', x: 51.5, y: 32, width: 48.5, height: 33, effectiveRatio: '3:2', label: 'Mid-Right' },
        { id: 'bot-wide', x: 0, y: 68, width: 100, height: 32, effectiveRatio: '16:9', label: 'Bottom' },
    ],
    compatibleRatios: allRatios,
    tags: ['classic', 'western', 'versatile'],
};

const WEBTOON_SCROLL: GridTemplate = {
    id: 'webtoon',
    title: 'Webtoon Scroll',
    description: 'Vertical scrolling format optimized for mobile.',
    panelCount: 3,
    panelSlots: [
        { id: 'p1', x: 0, y: 0, width: 100, height: 30, effectiveRatio: '16:9', label: 'Panel 1' },
        { id: 'p2', x: 10, y: 35, width: 80, height: 28, effectiveRatio: '3:2', label: 'Panel 2' },
        { id: 'p3', x: 0, y: 68, width: 100, height: 32, effectiveRatio: '16:9', label: 'Panel 3' },
    ],
    compatibleRatios: allRatios,
    tags: ['webtoon', 'mobile', 'scroll'],
};

const STRIP_4: GridTemplate = {
    id: 'strip',
    title: '4-Panel Strip',
    description: 'Classic newspaper or "yonkoma" style. Simple and effective.',
    panelCount: 4,
    panelSlots: [
        { id: 'p1', x: 0, y: 0, width: 100, height: 23, effectiveRatio: '16:9', label: 'Panel 1' },
        { id: 'p2', x: 0, y: 26, width: 100, height: 23, effectiveRatio: '16:9', label: 'Panel 2' },
        { id: 'p3', x: 0, y: 52, width: 100, height: 23, effectiveRatio: '16:9', label: 'Panel 3' },
        { id: 'p4', x: 0, y: 78, width: 100, height: 22, effectiveRatio: '16:9', label: 'Panel 4' },
    ],
    compatibleRatios: allRatios,
    tags: ['strip', 'yonkoma', 'simple'],
};

const MANGA_ACTION: GridTemplate = {
    id: 'manga',
    title: 'Manga Action',
    description: 'Dynamic angles and high impact panels.',
    panelCount: 4,
    panelSlots: [
        { id: 'top', x: 0, y: 0, width: 65, height: 45, effectiveRatio: '3:2', label: 'Establishing' },
        { id: 'side', x: 67, y: 0, width: 33, height: 35, effectiveRatio: '1:1', label: 'Reaction' },
        { id: 'mid', x: 35, y: 40, width: 65, height: 30, effectiveRatio: '16:9', label: 'Impact' },
        { id: 'bot', x: 0, y: 55, width: 40, height: 45, effectiveRatio: '3:4', label: 'Close-up' },
    ],
    compatibleRatios: allRatios,
    tags: ['manga', 'action', 'dynamic'],
};

const CINEMATIC_WIDE: GridTemplate = {
    id: 'cinematic',
    title: 'Cinematic Wide',
    description: 'Widescreen aspect ratios for an epic movie feel.',
    panelCount: 2,
    panelSlots: [
        { id: 'top', x: 0, y: 5, width: 100, height: 42, effectiveRatio: '21:9', label: 'Top Wide' },
        { id: 'bot', x: 0, y: 53, width: 100, height: 42, effectiveRatio: '21:9', label: 'Bottom Wide' },
    ],
    compatibleRatios: allRatios,
    tags: ['cinematic', 'epic', 'widescreen'],
};

const GRAPHIC_NOVEL: GridTemplate = {
    id: 'graphic_novel',
    title: 'Graphic Novel',
    description: 'Sophisticated, varying panel sizes for complex narratives.',
    panelCount: 4,
    panelSlots: [
        { id: 'main', x: 0, y: 0, width: 65, height: 65, effectiveRatio: '1:1', label: 'Main' },
        { id: 'side', x: 67, y: 0, width: 33, height: 100, effectiveRatio: '3:4', label: 'Side' },
        { id: 'bot-left', x: 0, y: 67, width: 32, height: 33, effectiveRatio: '1:1', label: 'Bottom-Left' },
        { id: 'bot-mid', x: 34, y: 67, width: 32, height: 33, effectiveRatio: '1:1', label: 'Bottom-Mid' },
    ],
    compatibleRatios: allRatios,
    tags: ['graphic_novel', 'sophisticated', 'narrative'],
};

const SPLASH_INSETS: GridTemplate = {
    id: 'splash_insets',
    title: 'Splash + Insets',
    description: 'Big hero panel with small inset details below.',
    panelCount: 4,
    panelSlots: [
        { id: 'splash', x: 0, y: 0, width: 100, height: 65, effectiveRatio: '3:2', label: 'Splash' },
        { id: 'i1', x: 0, y: 67, width: 32, height: 33, effectiveRatio: '1:1', label: 'Inset 1' },
        { id: 'i2', x: 34, y: 67, width: 32, height: 33, effectiveRatio: '1:1', label: 'Inset 2' },
        { id: 'i3', x: 68, y: 67, width: 32, height: 33, effectiveRatio: '1:1', label: 'Inset 3' },
    ],
    compatibleRatios: allRatios,
    tags: ['splash', 'hero', 'details'],
};

const GOLDEN_RATIO: GridTemplate = {
    id: 'golden_ratio',
    title: 'Golden Ratio',
    description: 'Elegant asymmetry and visual rhythm.',
    panelCount: 4,
    panelSlots: [
        { id: 'large', x: 0, y: 0, width: 62, height: 62, effectiveRatio: '1:1', label: 'Primary' },
        { id: 'top-right', x: 64, y: 0, width: 36, height: 30, effectiveRatio: '3:2', label: 'Secondary' },
        { id: 'mid-right', x: 64, y: 32, width: 36, height: 30, effectiveRatio: '3:2', label: 'Tertiary' },
        { id: 'bottom', x: 0, y: 64, width: 100, height: 36, effectiveRatio: '16:9', label: 'Footer' },
    ],
    compatibleRatios: allRatios,
    tags: ['golden_ratio', 'elegant', 'asymmetric'],
};

const DIAGONAL_ACTION: GridTemplate = {
    id: 'diagonal_action',
    title: 'Diagonal Action',
    description: 'Energetic framing for action beats.',
    panelCount: 4,
    panelSlots: [
        { id: 'top-wide', x: 0, y: 0, width: 100, height: 28, effectiveRatio: '16:9', label: 'Panel 1' },
        { id: 'mid-left', x: 0, y: 30, width: 48.5, height: 35, effectiveRatio: '3:2', label: 'Panel 2' },
        { id: 'mid-right', x: 51.5, y: 30, width: 48.5, height: 35, effectiveRatio: '3:2', label: 'Panel 3' },
        { id: 'bot-wide', x: 0, y: 68, width: 100, height: 32, effectiveRatio: '16:9', label: 'Panel 4' },
    ],
    compatibleRatios: allRatios,
    tags: ['action', 'energetic', 'dynamic'],
};

const STORYBOARD: GridTemplate = {
    id: 'storyboard',
    title: 'Cinematic Storyboard',
    description: 'Tight sequential shots for clarity.',
    panelCount: 6,
    panelSlots: [
        { id: 's1', x: 0, y: 0, width: 32, height: 48, effectiveRatio: '3:4', label: 'Shot 1' },
        { id: 's2', x: 34, y: 0, width: 32, height: 48, effectiveRatio: '3:4', label: 'Shot 2' },
        { id: 's3', x: 68, y: 0, width: 32, height: 48, effectiveRatio: '3:4', label: 'Shot 3' },
        { id: 's4', x: 0, y: 52, width: 32, height: 48, effectiveRatio: '3:4', label: 'Shot 4' },
        { id: 's5', x: 34, y: 52, width: 32, height: 48, effectiveRatio: '3:4', label: 'Shot 5' },
        { id: 's6', x: 68, y: 52, width: 32, height: 48, effectiveRatio: '3:4', label: 'Shot 6' },
    ],
    compatibleRatios: allRatios,
    tags: ['storyboard', 'sequential', 'detailed'],
};

const CONVERSATION_GRID: GridTemplate = {
    id: 'conversation_grid',
    title: 'Conversation Grid',
    description: 'Balanced panels for dialogue-heavy scenes.',
    panelCount: 4,
    panelSlots: [
        { id: 'tl', x: 0, y: 0, width: 48.5, height: 48.5, effectiveRatio: '3:2', label: 'Speaker A' },
        { id: 'tr', x: 51.5, y: 0, width: 48.5, height: 48.5, effectiveRatio: '3:2', label: 'Speaker B' },
        { id: 'bl', x: 0, y: 51.5, width: 48.5, height: 48.5, effectiveRatio: '3:2', label: 'Response A' },
        { id: 'br', x: 51.5, y: 51.5, width: 48.5, height: 48.5, effectiveRatio: '3:2', label: 'Response B' },
    ],
    compatibleRatios: allRatios,
    tags: ['conversation', 'dialogue', 'balanced'],
};

// ---------------------------------------------------------------------------
// Exported registry
// ---------------------------------------------------------------------------

export const GRID_TEMPLATES: GridTemplate[] = [
    // Universal
    CLASSIC_GRID,
    WEBTOON_SCROLL,
    STRIP_4,
    MANGA_ACTION,
    CINEMATIC_WIDE,
    GRAPHIC_NOVEL,
    SPLASH_INSETS,
    GOLDEN_RATIO,
    DIAGONAL_ACTION,
    STORYBOARD,
    CONVERSATION_GRID,
    // Portrait-specific
    PORTRAIT_3_STACK,
    PORTRAIT_HERO_2_INSETS,
    PORTRAIT_4_GRID,
    PORTRAIT_L_HERO,
    PORTRAIT_MANGA_5,
    PORTRAIT_DIAGONAL_CASCADE,
    PORTRAIT_TALL_HERO_STRIP,
    // Landscape-specific
    LANDSCAPE_DUAL_WIDE,
    LANDSCAPE_FILMSTRIP,
    LANDSCAPE_PANORAMIC_HERO_2,
    LANDSCAPE_TRIPLE_HORIZONTAL,
    LANDSCAPE_STORYBOARD_6,
    LANDSCAPE_HERO_SIDE,
    // Square-specific
    SQUARE_2X2,
    SQUARE_3X3,
    SQUARE_SINGLE_SPLASH,
    SQUARE_ASYMMETRIC_QUAD,
    SQUARE_CONVERSATION,
];

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/** Get templates compatible with a given aspect ratio. */
export function getTemplatesForRatio(ratio: AspectRatio): GridTemplate[] {
    return GRID_TEMPLATES.filter(t => t.compatibleRatios.includes(ratio));
}

/** Get a template by ID. Falls back to classic grid. */
export function getTemplateById(id: string): GridTemplate {
    return GRID_TEMPLATES.find(t => t.id === id) ?? CLASSIC_GRID;
}

/** Get templates matching any of the given tags. */
export function getTemplatesByTags(tags: string[]): GridTemplate[] {
    const tagSet = new Set(tags.map(t => t.toLowerCase()));
    return GRID_TEMPLATES.filter(t => t.tags.some(tag => tagSet.has(tag)));
}
