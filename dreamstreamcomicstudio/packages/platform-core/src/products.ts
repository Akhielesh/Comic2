/**
 * Products (plan §5.4): one manifest per studio and per outside app. The platform is a CAPABILITY of a product, not
 * a product of its own, so no access table changes when a studio gets it. A manifest names the studio it belongs to,
 * the capabilities, tools, flows and templates it may use, its approval policy, its skin, and whether its users see
 * governed (usage, never dollars) wording.
 *
 * Every DreamStream studio must have one: the app's `tests/config/platformProducts.test.ts` fails when a studio id
 * has no manifest, or a manifest names a studio the app does not have.
 */
import { CAPABILITY_IDS, isCapabilityId } from './capabilities.js';
import type { CapabilityId } from './capabilities.js';
import { isHostPolicy } from './gates/gates.js';
import type { HostPolicy } from './gates/gates.js';
import { FLOW_IDS, isFlowId } from './flows/types.js';
import type { FlowId } from './flows/types.js';
import { getPlatformTool, isPlatformToolName } from './tools/registry.js';
import { FORBIDDEN_NAME } from './tools/types.js';
import type { PlatformToolName } from './tools/types.js';

export const PLATFORM_APPS = ['dreamstream', 'atlas'] as const;
export type PlatformApp = (typeof PLATFORM_APPS)[number];

/** UI skins (brand data in `src/brand`): `comic-fun` is planned. */
export const SKIN_IDS = ['dreamstream', 'atlas', 'comic-fun'] as const;
export type SkinId = (typeof SKIN_IDS)[number];

export interface ProductManifest {
  /** The product's platform id (`comic`, `chat`, `stream`, `atlas`). */
  readonly id: string;
  /** The host's studio id this product serves (`comic_studio`); `null` for an app with no studios. */
  readonly studio: string | null;
  readonly app: PlatformApp;
  readonly skin: SkinId;
  readonly capabilities: readonly CapabilityId[];
  readonly tools: readonly PlatformToolName[];
  readonly flows: readonly FlowId[];
  /** Email template ids this product offers (`event_recap`). */
  readonly templates: readonly string[];
  /** The default approval policy for this product's users (a user's own choice may replace it, never its floors). */
  readonly policy: HostPolicy;
  /** Its users' usage wording is governed: shares of usage, never dollars. */
  readonly governedWording: boolean;
}

export interface ProductManifestInput {
  id: string;
  studio: string | null;
  app: PlatformApp;
  skin: SkinId;
  capabilities: readonly CapabilityId[];
  tools: readonly PlatformToolName[];
  flows: readonly FlowId[];
  templates?: readonly string[];
  policy: HostPolicy;
  governedWording: boolean;
}

export class ProductDefinitionError extends Error {
  constructor(product: string, message: string) {
    super(`product ${product}: ${message}`);
    this.name = 'ProductDefinitionError';
  }
}

const PRODUCT_ID = /^[a-z][a-z0-9_]{1,31}$/;
const STUDIO_ID = /^[a-z][a-z0-9_]{1,63}$/;
const TEMPLATE_ID = /^[a-z][a-z0-9_]{1,63}$/;

const uniqueList = <T extends string>(product: string, what: string, list: readonly T[], ok: (v: string) => boolean): readonly T[] => {
  if (!Array.isArray(list)) throw new ProductDefinitionError(product, `${what} must be a list`);
  const seen: string[] = [];
  for (const v of list) {
    if (typeof v !== 'string' || !ok(v)) throw new ProductDefinitionError(product, `${what} has an unknown entry "${String(v)}"`);
    if (FORBIDDEN_NAME.test(v)) throw new ProductDefinitionError(product, `${what} entry "${v}" is named like it sends`);
    if (seen.indexOf(v) !== -1) throw new ProductDefinitionError(product, `${what} lists "${v}" twice`);
    seen.push(v);
  }
  return Object.freeze(list.slice());
};

/**
 * Validate a manifest and return it frozen. Throws `ProductDefinitionError` when: an id is malformed or named like it
 * sends; a DreamStream product names no studio; a capability, tool or flow is unknown or listed twice; a tool needs
 * a capability the product does not list; the policy is not the app's own kind.
 */
export const defineProduct = (input: ProductManifestInput): ProductManifest => {
  const id = input && typeof input.id === 'string' ? input.id : '(unnamed)';
  const fail = (message: string): never => {
    throw new ProductDefinitionError(id, message);
  };
  if (!PRODUCT_ID.test(id) || FORBIDDEN_NAME.test(id)) fail('id must be a short snake_case id');
  if ((PLATFORM_APPS as readonly string[]).indexOf(input.app) === -1) fail(`app must be one of ${PLATFORM_APPS.join(', ')}`);
  if (input.studio !== null && (typeof input.studio !== 'string' || !STUDIO_ID.test(input.studio))) fail('studio must be a studio id or null');
  if (input.app === 'dreamstream' && input.studio === null) fail('a DreamStream product belongs to a studio');
  if ((SKIN_IDS as readonly string[]).indexOf(input.skin) === -1) fail(`skin must be one of ${SKIN_IDS.join(', ')}`);
  if (!isHostPolicy(input.policy) || input.policy.app !== input.app) fail(`policy must be a ${input.app} policy`);
  if (typeof input.governedWording !== 'boolean') fail('governedWording must be true or false');
  const capabilities = uniqueList(id, 'capabilities', input.capabilities, isCapabilityId);
  const tools = uniqueList(id, 'tools', input.tools, isPlatformToolName);
  const flows = uniqueList(id, 'flows', input.flows, isFlowId);
  const templates = uniqueList(id, 'templates', input.templates || [], (v) => TEMPLATE_ID.test(v));
  for (const name of tools) {
    const tool = getPlatformTool(name);
    if (tool && tool.capability !== undefined && capabilities.indexOf(tool.capability) === -1) fail(`tool ${name} needs capability ${tool.capability}`);
  }
  return Object.freeze({
    id,
    studio: input.studio,
    app: input.app,
    skin: input.skin,
    capabilities,
    tools,
    flows,
    templates,
    policy: Object.freeze({ ...input.policy }) as HostPolicy,
    governedWording: input.governedWording,
  });
};

// ── The manifests (plan §5.4) ───────────────────────────────────────────────────────────────────────────────────

export const COMIC_PRODUCT = defineProduct({
  id: 'comic',
  studio: 'comic_studio',
  app: 'dreamstream',
  skin: 'atlas',
  capabilities: ['richdoc.export', 'deck.export', 'email.render', 'print.book', 'print.preflight', 'asset.normalize', 'image.psd', 'layout.idml', 'comic.cbz', 'comic.epub', 'comic.strip'],
  tools: ['deck_create', 'email_draft', 'print_book', 'psd_export'],
  flows: ['comic_pitch_deck', 'comic_print_book'],
  policy: { app: 'dreamstream', confirm: 'big', bigSpendUsd: 0.5 },
  governedWording: true,
});

export const CHAT_PRODUCT = defineProduct({
  id: 'chat',
  studio: 'chat_studio',
  app: 'dreamstream',
  skin: 'dreamstream',
  capabilities: ['richdoc.export', 'deck.export', 'email.render', 'doc.extract', 'pdf.inspect', 'pdf.fill', 'pdf.redact', 'pdf.organize'],
  tools: ['email_draft', 'deck_create', 'pdf_inspect', 'pdf_fill', 'pdf_redact', 'pdf_organize'],
  flows: ['meeting_followup_pack', 'reply_with_proposal_pdf'],
  policy: { app: 'dreamstream', confirm: 'always' },
  governedWording: true,
});

export const STREAM_PRODUCT = defineProduct({
  id: 'stream',
  studio: 'stream_studio',
  app: 'dreamstream',
  skin: 'dreamstream',
  capabilities: ['richdoc.export', 'deck.export', 'email.render'],
  tools: [],
  flows: [],
  templates: ['event_recap', 'sponsor_thanks'],
  policy: { app: 'dreamstream', confirm: 'always' },
  governedWording: true,
});

export const ATLAS_PRODUCT = defineProduct({
  id: 'atlas',
  studio: null,
  app: 'atlas',
  skin: 'atlas',
  capabilities: ['email.render', 'doc.extract', 'doc.convert', 'doc.thumbnail', 'pdf.inspect'],
  tools: ['email_draft'],
  flows: ['reply_with_context'],
  policy: { app: 'atlas', approval: 'before_write' },
  governedWording: false,
});

export const PRODUCTS: readonly ProductManifest[] = Object.freeze([COMIC_PRODUCT, CHAT_PRODUCT, STREAM_PRODUCT, ATLAS_PRODUCT]);

export const getProduct = (id: string): ProductManifest | undefined => {
  for (const p of PRODUCTS) if (p.id === id) return p;
  return undefined;
};

/** The manifest of a host studio (`comic_studio` → comic), or `undefined`. */
export const productForStudio = (studio: string): ProductManifest | undefined => {
  for (const p of PRODUCTS) if (p.studio !== null && p.studio === studio) return p;
  return undefined;
};

export const productsForApp = (app: PlatformApp): readonly ProductManifest[] => PRODUCTS.filter((p) => p.app === app);

/** Every studio a DreamStream manifest serves. */
export const DREAMSTREAM_PLATFORM_STUDIOS: readonly string[] = Object.freeze(productsForApp('dreamstream').map((p) => p.studio as string));

/** Rules across manifests; returns the problems (empty when sound). */
export const productRegistryProblems = (products: readonly ProductManifest[] = PRODUCTS): string[] => {
  const problems: string[] = [];
  const ids: string[] = [];
  const studios: string[] = [];
  for (const p of products) {
    if (ids.indexOf(p.id) !== -1) problems.push(`${p.id}: duplicate product id`);
    ids.push(p.id);
    if (p.studio !== null) {
      if (studios.indexOf(`${p.app}:${p.studio}`) !== -1) problems.push(`${p.id}: studio ${p.studio} has two manifests`);
      studios.push(`${p.app}:${p.studio}`);
    }
  }
  return problems;
};

/** Every id a manifest may reference (for docs and the onboarding checklist). */
export const MANIFEST_VOCABULARY = { capabilities: CAPABILITY_IDS, flows: FLOW_IDS } as const;
