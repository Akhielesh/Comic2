import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config();

type ArtifactRow = {
  project_id?: string;
  created_at?: string;
  data?: Record<string, unknown>;
};

const parseDays = () => {
  const arg = process.argv.find((entry) => entry.startsWith("--days="));
  const value = Number(arg?.split("=")[1] || 7);
  if (!Number.isFinite(value) || value <= 0) return 7;
  return Math.floor(value);
};

const toNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const toBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return undefined;
};

const main = async () => {
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error("Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }

  const days = parseDays();
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false }
  });

  const { data, error } = await supabase
    .from("artifacts")
    .select("project_id,created_at,data")
    .gte("created_at", sinceIso);

  if (error) throw error;

  const rows = (data || []) as ArtifactRow[];
  const panelArtifacts = rows.filter((row) => {
    const artifact = row.data || {};
    const stage = String(artifact.stage || "").toLowerCase();
    const type = String(artifact.type || "").toLowerCase();
    return type === "image" && (stage === "panel" || stage === "panel_regen");
  });

  let referenceCountTotal = 0;
  let referenceCountSamples = 0;
  let strictPanelCount = 0;
  let zeroRefStrictPanels = 0;
  let multiFrameDetected = 0;
  let styleLockAttemptCount = 0;
  let styleLockUnresolvedCount = 0;

  const runModels = new Map<string, Set<string>>();

  for (const row of panelArtifacts) {
    const artifact = row.data || {};
    const meta = (artifact.meta as Record<string, unknown>) || {};

    const runId = typeof meta.runId === "string" ? meta.runId : undefined;
    const model = typeof artifact.model === "string" ? artifact.model : undefined;
    if (runId) {
      if (!runModels.has(runId)) runModels.set(runId, new Set<string>());
      if (model) runModels.get(runId)!.add(model);
    }

    const referenceCount = toNumber(artifact.referenceCount)
      ?? toNumber(meta.referenceCount)
      ?? toNumber(meta.panel_ref_count);
    if (typeof referenceCount === "number") {
      referenceCountTotal += referenceCount;
      referenceCountSamples += 1;
    }

    const requiredReferences = toBoolean(meta.requiredReferences) === true;
    if (requiredReferences) {
      strictPanelCount += 1;
      const zeroRef =
        toBoolean(meta.zero_ref_panel) === true ||
        (typeof referenceCount === "number" && referenceCount === 0);
      if (zeroRef) {
        zeroRefStrictPanels += 1;
      }
    }

    if (toBoolean(meta.multi_frame_description_detected) === true) {
      multiFrameDetected += 1;
    }

    const styleLockResolved = toBoolean(meta.style_lock_resolved);
    if (typeof styleLockResolved === "boolean") {
      styleLockAttemptCount += 1;
      if (!styleLockResolved) {
        styleLockUnresolvedCount += 1;
      }
    }
  }

  const mixedRuns = Array.from(runModels.values()).filter((models) => models.size > 1).length;
  const totalRuns = runModels.size;

  const zeroRefStrictRate = strictPanelCount > 0 ? zeroRefStrictPanels / strictPanelCount : 0;
  const mixedModelRunRate = totalRuns > 0 ? mixedRuns / totalRuns : 0;
  const multiFrameRate = panelArtifacts.length > 0 ? multiFrameDetected / panelArtifacts.length : 0;
  const avgPanelRefCount = referenceCountSamples > 0 ? referenceCountTotal / referenceCountSamples : 0;

  const thresholds = {
    zero_ref_strict_panels_max_rate: 0.01,
    mixed_model_runs_max_rate: 0.02,
    multi_frame_descriptions_max_rate: 0.01,
    unresolved_style_lock_attempts_max: 0
  };

  const alerts = {
    zero_ref_strict_panels_breach: zeroRefStrictRate > thresholds.zero_ref_strict_panels_max_rate,
    mixed_model_runs_breach: mixedModelRunRate > thresholds.mixed_model_runs_max_rate,
    multi_frame_descriptions_breach: multiFrameRate > thresholds.multi_frame_descriptions_max_rate,
    unresolved_style_lock_attempts_breach: styleLockUnresolvedCount > thresholds.unresolved_style_lock_attempts_max
  };

  const output = {
    generatedAt: new Date().toISOString(),
    window: {
      days,
      since: sinceIso
    },
    totals: {
      panelArtifacts: panelArtifacts.length,
      strictPanels: strictPanelCount,
      runCount: totalRuns
    },
    metrics: {
      panel_ref_count: Number(avgPanelRefCount.toFixed(3)),
      zero_ref_panel: {
        count: zeroRefStrictPanels,
        rate: Number(zeroRefStrictRate.toFixed(6))
      },
      mixed_model_in_run: {
        count: mixedRuns,
        rate: Number(mixedModelRunRate.toFixed(6))
      },
      multi_frame_description_detected: {
        count: multiFrameDetected,
        rate: Number(multiFrameRate.toFixed(6))
      },
      style_lock_resolved: {
        attempts: styleLockAttemptCount,
        unresolvedAttempts: styleLockUnresolvedCount
      }
    },
    thresholds,
    alerts
  };

  console.info(JSON.stringify(output, null, 2));
};

main().catch((error) => {
  console.error("[consistency_metrics] failed", error);
  process.exitCode = 1;
});
