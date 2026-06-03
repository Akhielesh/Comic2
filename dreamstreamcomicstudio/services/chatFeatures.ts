// Maps a catalog model to the per-conversation features the chat UI exposes.
//
// "Model-specific features" in the chat platform (reasoning level, web access,
// file attachments, structured output) are driven off the shared capability index
// so the controls only appear when the chosen model actually supports them.

import type { CatalogModel } from './modelCatalog';
import { getCapabilities } from './modelCapabilities';
import type { ChatReasoningLevel } from '../apiTypes';

export interface ChatModelFeatures {
  /** Step-by-step reasoning effort control (OpenRouter reasoning models). */
  reasoning: boolean;
  /** Live web search augmentation (OpenRouter `web` plugin — any model). */
  webSearch: boolean;
  /** Accepts image attachments as input (vision). */
  vision: boolean;
  /** Reliable structured / JSON output. */
  structured: boolean;
  /** Long context window (>= 200K tokens). */
  longContext: boolean;
  contextLength: number;
}

export const REASONING_LEVELS: { value: ChatReasoningLevel; label: string }[] = [
  { value: 'none', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
];

export const deriveModelFeatures = (model: CatalogModel | null): ChatModelFeatures => {
  if (!model) {
    // With no model resolved yet, web search is still offered (server defaults to a
    // free OpenRouter model that supports the web plugin).
    return {
      reasoning: false,
      webSearch: true,
      vision: false,
      structured: false,
      longContext: false,
      contextLength: 0
    };
  }
  const caps = getCapabilities(model);
  return {
    reasoning: caps.reasoning,
    // Web plugin is OpenRouter-only; NVIDIA models can't ground on the web here.
    webSearch: model.source === 'openrouter',
    vision: caps.imageInput,
    structured: caps.structuredJson,
    longContext: caps.longContext,
    contextLength: caps.contextLength
  };
};

/** Short, human descriptors of each chat capability (for tooltips / the features panel). */
export const FEATURE_BLURBS: Record<keyof Omit<ChatModelFeatures, 'contextLength'>, string> = {
  reasoning: 'Spends extra steps "thinking" before answering — better for hard problems.',
  webSearch: 'Searches the live web and grounds the answer in current results, with citations.',
  vision: 'Understands images you attach — describe, analyze, or extract from them.',
  structured: 'Reliably returns tables and structured data for clean rendering.',
  longContext: 'Holds very large conversations and documents in context.'
};
