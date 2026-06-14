// Relevant external links per model — where it's sourced/hosted/documented.
//
// Gives the public catalog the "click through to the real model page" feel of HuggingFace /
// OpenRouter. Source links are exact (we know the source's URL scheme); the Hugging Face link
// uses a SEARCH url rather than a guessed repo path, because publisher prefixes and casing
// differ across sources (e.g. "meta-llama/llama-3.3-70b-instruct" vs the HF repo
// "meta-llama/Llama-3.3-70B-Instruct") — a search never dead-links.

import type { CatalogModel, ModelSource } from './modelCatalog';

export type ModelLinkKind = 'source' | 'host' | 'docs';

export interface ModelLink {
  label: string;
  url: string;
  kind: ModelLinkKind;
}

const stripFree = (id: string): string => id.replace(/:free$/i, '');

const modelNameTail = (id: string): string => {
  const clean = stripFree(id);
  const i = clean.lastIndexOf('/');
  return i >= 0 ? clean.slice(i + 1) : clean;
};

/** External links for a model, ordered source → host → docs. */
export const modelLinks = (model: CatalogModel): ModelLink[] => {
  const links: ModelLink[] = [];
  const id = stripFree(model.id);
  const name = modelNameTail(id);

  if (model.source === 'openrouter') {
    links.push({ label: 'OpenRouter', url: `https://openrouter.ai/${id}`, kind: 'source' });
  } else if (model.source === 'nvidia') {
    links.push({ label: 'NVIDIA Build', url: `https://build.nvidia.com/${id}`, kind: 'source' });
  }

  // The underlying model home — search avoids dead links from prefix/casing drift.
  if (name) {
    links.push({ label: 'Hugging Face', url: `https://huggingface.co/models?search=${encodeURIComponent(name)}`, kind: 'host' });
  }

  return links;
};

/** Short, honest descriptor of where a source actually hosts/serves models. */
export const SOURCE_HOSTING_NOTE: Record<ModelSource, string> = {
  openrouter: 'Unified gateway — routes your request to an upstream host; pay-per-token, some free variants.',
  nvidia: 'NVIDIA DGX Cloud (NIM) — credit-based free tier, then billed to your nvapi- key.',
  openai: 'OpenAI’s own API — billed directly to your OpenAI key.',
  anthropic: 'Anthropic’s native Messages API — billed directly to your Anthropic key.',
  gemini: 'Google AI Studio (Gemini) — free tier available, then billed to your Google key.',
  deepseek: 'DeepSeek’s API — very low cost, billed directly to your DeepSeek key.',
  zai: 'Z.AI (GLM) — billed directly to your Z.AI key.',
  minimax: 'MiniMax — billed directly to your MiniMax key.',
  tencent: 'Tencent Hunyuan — billed directly to your Tencent key.',
  xai: 'xAI (Grok) — billed directly to your xAI key.'
};
