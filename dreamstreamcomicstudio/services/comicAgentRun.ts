import {
  AppStep,
  ComicAgentCard,
  ComicAgentCardKind,
  ComicAgentCardStatus,
  ComicAgentEvent,
  ComicAgentRun,
  ComicState
} from "../types";

export const AGENT_EVENT_LIMIT = 80;

export const AGENT_CARD_ORDER: ComicAgentCardKind[] = [
  "prompt",
  "style",
  "cast",
  "cover",
  "layout",
  "build",
  "export"
];

const CARD_COPY: Record<ComicAgentCardKind, { title: string; summary: string }> = {
  prompt: {
    title: "Prompt",
    summary: "Waiting for the story, script, notes, or rough creative idea."
  },
  style: {
    title: "Style",
    summary: "Choosing the visual language and a reusable style anchor."
  },
  cast: {
    title: "Cast",
    summary: "Extracting the characters, locations, objects, and continuity rules."
  },
  cover: {
    title: "Cover",
    summary: "Designing a cover direction grounded in the story."
  },
  layout: {
    title: "Layout",
    summary: "Choosing pages, panel density, text treatment, and output targets."
  },
  build: {
    title: "Build",
    summary: "Rendering pages and saving completed panels as they finish."
  },
  export: {
    title: "Export",
    summary: "Preparing the comic, book, and HTML outputs."
  }
};

const makeId = (prefix: string) => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
};

const makeCard = (kind: ComicAgentCardKind, now = Date.now()): ComicAgentCard => ({
  kind,
  title: CARD_COPY[kind].title,
  status: kind === "prompt" ? "active" : "pending",
  summary: CARD_COPY[kind].summary,
  updatedAt: now
});

export const makeDefaultComicAgentRun = (now = Date.now()): ComicAgentRun => ({
  id: makeId("agent_run"),
  status: "idle",
  activeCard: "prompt",
  cards: AGENT_CARD_ORDER.map((kind) => makeCard(kind, now)),
  events: [],
  createdAt: now,
  updatedAt: now
});

export const normalizeComicAgentRun = (run?: ComicAgentRun | null): ComicAgentRun => {
  const now = Date.now();
  const base = run || makeDefaultComicAgentRun(now);
  const cardsByKind = new Map((base.cards || []).map((card) => [card.kind, card]));
  const cards = AGENT_CARD_ORDER.map((kind) => ({
    ...makeCard(kind, now),
    ...(cardsByKind.get(kind) || {}),
    kind,
    title: cardsByKind.get(kind)?.title || CARD_COPY[kind].title,
    summary: cardsByKind.get(kind)?.summary || CARD_COPY[kind].summary,
    updatedAt: cardsByKind.get(kind)?.updatedAt || base.updatedAt || now
  }));
  const activeCard = AGENT_CARD_ORDER.includes(base.activeCard) ? base.activeCard : "prompt";

  return {
    ...base,
    id: base.id || makeId("agent_run"),
    status: base.status || "idle",
    activeCard,
    cards,
    events: (base.events || []).slice(-AGENT_EVENT_LIMIT),
    createdAt: base.createdAt || now,
    updatedAt: base.updatedAt || now
  };
};

const cardIndex = (kind: ComicAgentCardKind) => AGENT_CARD_ORDER.indexOf(kind);

const kindForStep = (step: number): ComicAgentCardKind => {
  switch (step) {
    case AppStep.SCRIPT_INPUT:
      return "prompt";
    case AppStep.STYLE_SELECTION:
      return "style";
    case AppStep.REFERENCE_BUILDER:
      return "cast";
    case AppStep.COVER:
      return "cover";
    case AppStep.LAYOUT_SELECTION:
      return "layout";
    case AppStep.FULL_GENERATION:
      return "build";
    case AppStep.REVIEW_EXPORT:
      return "export";
    default:
      return "prompt";
  }
};

const buildStatusFromState = (state: ComicState): ComicAgentCardStatus | undefined => {
  const description = state.generationStatus?.currentStepDescription || "";
  if (/^failed/i.test(description)) return "failed";
  if (/^stopped/i.test(description)) return "blocked";
  if (state.panels?.some((panel) => panel.imageUrl)) return "done";
  if (state.generationStatus?.isActive) return "active";
  return undefined;
};

const deriveCardStatus = (
  state: ComicState,
  kind: ComicAgentCardKind,
  activeKind: ComicAgentCardKind
): ComicAgentCardStatus => {
  if (kind === "prompt" && (state.scenes?.length || 0) > 0) return "done";
  if (kind === "style" && (state.selectedStyleId || state.stylePrompt) && cardIndex(activeKind) > cardIndex("style")) return "done";
  if (kind === "cast" && cardIndex(activeKind) > cardIndex("cast")) return "done";
  if (kind === "cover" && (state.coverImageId || state.coverImageUrl || cardIndex(activeKind) > cardIndex("cover"))) return "done";
  if (kind === "layout" && cardIndex(activeKind) > cardIndex("layout")) return "done";
  if (kind === "build") {
    const buildStatus = buildStatusFromState(state);
    if (buildStatus) return buildStatus;
  }
  if (kind === "export" && state.publishedAt) return "done";

  const currentIndex = cardIndex(kind);
  const activeIndex = cardIndex(activeKind);
  if (currentIndex < activeIndex) return "done";
  if (currentIndex === activeIndex) return "active";
  return "pending";
};

const deriveCardSummary = (state: ComicState, kind: ComicAgentCardKind, fallback: string) => {
  switch (kind) {
    case "prompt":
      return (state.scenes?.length || 0) > 0
        ? `${state.scenes.length} scene${state.scenes.length === 1 ? "" : "s"} analyzed from the story input.`
        : fallback;
    case "style":
      return state.styleCategory || state.selectedStyleId
        ? `Style direction locked${state.styleCategory ? `: ${state.styleCategory}` : ""}.`
        : fallback;
    case "cast": {
      const count = (state.characters?.length || 0) + (state.items?.length || 0) + (state.locations?.length || 0);
      return count > 0 ? `${count} world reference${count === 1 ? "" : "s"} tracked for continuity.` : fallback;
    }
    case "cover":
      return state.coverImageId || state.coverImageUrl ? "Cover image is ready." : fallback;
    case "layout":
      return state.pageCount
        ? `${state.pageCount} page${state.pageCount === 1 ? "" : "s"} planned with ${state.layoutType.replace(/_/g, " ")} layout.`
        : fallback;
    case "build": {
      const rendered = state.panels?.filter((panel) => panel.imageUrl).length || 0;
      const total = state.generationStatus?.totalPanels || state.panels?.length || 0;
      return total > 0 ? `${rendered} of ${total} panel${total === 1 ? "" : "s"} rendered.` : fallback;
    }
    case "export":
      if (state.publishedAt) return "Project has been published.";
      if (state.exportedOutputs) {
        const prepared = ["comic", "book", "html"].filter((target) => state.exportedOutputs?.[target as "comic" | "book" | "html"]).length;
        if (prepared > 0) return `${prepared} output${prepared === 1 ? "" : "s"} prepared from review.`;
      }
      return fallback;
    default:
      return fallback;
  }
};

export const syncAgentRunWithState = (state: ComicState): ComicAgentRun => {
  const now = Date.now();
  const run = normalizeComicAgentRun(state.agentRun);
  const activeCard = kindForStep(state.step);
  const cards = run.cards.map((card) => {
    const status = deriveCardStatus(state, card.kind, activeCard);
    const progress = card.kind === "build"
      ? Math.round(Math.min(Math.max(state.generationStatus?.progress || (status === "done" ? 100 : 0), 0), 100))
      : status === "done"
        ? 100
        : card.kind === activeCard
          ? card.progress
          : undefined;
    return {
      ...card,
      status,
      summary: deriveCardSummary(state, card.kind, card.summary || CARD_COPY[card.kind].summary),
      progress,
      updatedAt: status !== card.status || progress !== card.progress ? now : card.updatedAt
    };
  });
  const buildStatus = cards.find((card) => card.kind === "build")?.status;
  const status = buildStatus === "failed"
    ? "failed"
    : buildStatus === "blocked"
      ? "stopped"
      : state.step === AppStep.REVIEW_EXPORT && buildStatus === "done"
        ? "done"
        : state.step === AppStep.SCRIPT_INPUT && !(state.scenes?.length || 0)
          ? "idle"
          : "active";

  return {
    ...run,
    activeCard,
    cards,
    status,
    updatedAt: now,
    completedAt: status === "done" ? run.completedAt || now : run.completedAt
  };
};

export const patchAgentCard = (
  run: ComicAgentRun | undefined,
  kind: ComicAgentCardKind,
  patch: Partial<Omit<ComicAgentCard, "kind" | "title">>
): ComicAgentRun => {
  const now = Date.now();
  const normalized = normalizeComicAgentRun(run);
  return {
    ...normalized,
    cards: normalized.cards.map((card) => (
      card.kind === kind
        ? {
            ...card,
            ...patch,
            kind,
            title: card.title || CARD_COPY[kind].title,
            updatedAt: patch.updatedAt || now
          }
        : card
    )),
    activeCard: patch.status === "active" ? kind : normalized.activeCard,
    updatedAt: now
  };
};

export const appendAgentEvent = (
  run: ComicAgentRun | undefined,
  event: Omit<ComicAgentEvent, "id" | "timestamp"> & { id?: string; timestamp?: number }
): ComicAgentRun => {
  const normalized = normalizeComicAgentRun(run);
  const timestamp = event.timestamp || Date.now();
  const nextEvent: ComicAgentEvent = {
    id: event.id || makeId("agent_event"),
    kind: event.kind,
    status: event.status,
    message: event.message,
    timestamp
  };
  return {
    ...normalized,
    events: [...normalized.events, nextEvent].slice(-AGENT_EVENT_LIMIT),
    updatedAt: timestamp
  };
};

export const transitionAgentRun = (
  state: ComicState,
  updates: Array<{
    kind: ComicAgentCardKind;
    status: ComicAgentCardStatus;
    summary?: string;
    detail?: string;
    progress?: number;
  }>,
  event?: Omit<ComicAgentEvent, "id" | "timestamp">
): ComicAgentRun => {
  let next = normalizeComicAgentRun(state.agentRun);
  updates.forEach((update) => {
    next = patchAgentCard(next, update.kind, update);
  });
  const active = updates.find((update) => update.status === "active");
  if (active) {
    next = {
      ...next,
      activeCard: active.kind,
      status: "active"
    };
  }
  if (event) {
    next = appendAgentEvent(next, event);
  }
  return next;
};
