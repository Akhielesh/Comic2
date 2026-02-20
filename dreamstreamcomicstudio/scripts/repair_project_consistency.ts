import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { ComicState } from "../types";
import { applyStyleLockResolution } from "../services/styleLock";
import { buildContinuityFromWorld, resolvePanelContinuity } from "../services/continuity";
import { hasMultiFrameLanguage } from "../services/panelDescription";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config();

type RiskTag =
  | "STYLE_LOCK_MISSING"
  | "WORLD_CONTAMINATED"
  | "ZERO_PANEL_REFS"
  | "MULTI_FRAME_DESCRIPTIONS";

type ProjectRow = {
  id: string;
  name: string;
  state: ComicState;
};

type ContaminationReport = {
  characters: string[];
  items: string[];
  locations: string[];
};

const isApply = process.argv.includes("--apply") && !process.argv.includes("--dry-run");

const normalizeForMatch = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const normalizeEntityName = (value: string) =>
  value
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const containsName = (source: string, name: string) => {
  const haystack = normalizeForMatch(source);
  const target = normalizeForMatch(name);
  if (!haystack || !target) return false;
  const pattern = new RegExp(`(^|\\s)${escapeRegex(target)}($|\\s)`);
  return pattern.test(haystack);
};

const detectWorldContamination = (state: ComicState): ContaminationReport => {
  const sceneText = (state.scenes || [])
    .map((scene) => [scene.synopsis || "", scene.setting || "", ...(scene.characters || [])].join(" "))
    .join("\n");

  const canonicalCharacters = new Set(
    (state.scenes || [])
      .flatMap((scene) => scene.characters || [])
      .map((name) => normalizeEntityName(name))
      .filter(Boolean)
  );

  const characters = (state.characters || [])
    .map((entry) => entry.name)
    .filter((name) => !!name && !canonicalCharacters.has(normalizeEntityName(name)) && !containsName(sceneText, name));

  const items = (state.items || [])
    .map((entry) => entry.name)
    .filter((name) => !!name && !containsName(sceneText, name));

  const locations = (state.locations || [])
    .map((entry) => entry.name)
    .filter((name) => !!name && !containsName(sceneText, name));

  return {
    characters: Array.from(new Set(characters)),
    items: Array.from(new Set(items)),
    locations: Array.from(new Set(locations))
  };
};

const parseState = (row: { state: unknown }): ComicState | null => {
  if (!row || typeof row.state !== "object" || row.state === null) return null;
  return row.state as ComicState;
};

const main = async () => {
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error("Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false }
  });

  const report = {
    generatedAt: new Date().toISOString(),
    mode: isApply ? "apply" : "dry-run",
    totals: {
      scanned: 0,
      repaired: 0,
      unchanged: 0,
      failed: 0
    },
    projects: [] as Array<{
      id: string;
      name: string;
      changed: boolean;
      applied: boolean;
      riskTags: RiskTag[];
      contamination: ContaminationReport;
      panelStats: {
        totalPanels: number;
        zeroRefPanels: number;
        multiFramePanels: number;
      };
      styleLock: {
        resolved: boolean;
        source: string;
      };
      errors?: string[];
    }>
  };

  const pageSize = 200;
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("projects")
      .select("id,name,state")
      .range(from, from + pageSize - 1);

    if (error) throw error;
    if (!data || data.length === 0) break;

    for (const rawRow of data) {
      const row = rawRow as ProjectRow & { state: unknown };
      report.totals.scanned += 1;

      try {
        const parsed = parseState(row);
        if (!parsed) {
          report.totals.failed += 1;
          report.projects.push({
            id: row.id,
            name: row.name || "Unnamed",
            changed: false,
            applied: false,
            riskTags: ["STYLE_LOCK_MISSING"],
            contamination: { characters: [], items: [], locations: [] },
            panelStats: { totalPanels: 0, zeroRefPanels: 0, multiFramePanels: 0 },
            styleLock: { resolved: false, source: "invalid_state" },
            errors: ["State payload is missing or invalid."]
          });
          continue;
        }

        const styleResult = applyStyleLockResolution(parsed);
        let nextState = styleResult.state;

        const nextContinuity = buildContinuityFromWorld(
          nextState.scenes || [],
          nextState.characters || [],
          nextState.items || [],
          nextState.locations || [],
          nextState.continuity
        );
        nextState = { ...nextState, continuity: nextContinuity };

        const stateForPanels = { ...nextState, continuity: nextContinuity } as ComicState;
        let zeroRefPanels = 0;
        let multiFramePanels = 0;
        const nextPanels = (nextState.panels || []).map((panel) => {
          const continuity = resolvePanelContinuity(stateForPanels, panel);
          if ((continuity.requiredEntityIds?.length || 0) > 0 && (continuity.referenceImageIds?.length || 0) === 0) {
            zeroRefPanels += 1;
          }
          if (hasMultiFrameLanguage(panel.description || panel.prompt || "")) {
            multiFramePanels += 1;
          }
          return {
            ...panel,
            continuity
          };
        });
        nextState = { ...nextState, panels: nextPanels };

        const contamination = detectWorldContamination(nextState);
        const riskTags: RiskTag[] = [];
        if (!styleResult.resolution.resolved) riskTags.push("STYLE_LOCK_MISSING");
        if (contamination.characters.length || contamination.items.length || contamination.locations.length) {
          riskTags.push("WORLD_CONTAMINATED");
        }
        if (zeroRefPanels > 0) riskTags.push("ZERO_PANEL_REFS");
        if (multiFramePanels > 0) riskTags.push("MULTI_FRAME_DESCRIPTIONS");

        const before = JSON.stringify(parsed);
        const after = JSON.stringify(nextState);
        const changed = before !== after;

        if (changed && isApply) {
          const { error: updateError } = await supabase
            .from("projects")
            .update({ state: nextState })
            .eq("id", row.id);
          if (updateError) throw updateError;
        }

        if (changed) {
          report.totals.repaired += 1;
        } else {
          report.totals.unchanged += 1;
        }

        report.projects.push({
          id: row.id,
          name: row.name || "Unnamed",
          changed,
          applied: isApply && changed,
          riskTags,
          contamination,
          panelStats: {
            totalPanels: nextPanels.length,
            zeroRefPanels,
            multiFramePanels
          },
          styleLock: {
            resolved: styleResult.resolution.resolved,
            source: styleResult.resolution.source
          }
        });
      } catch (error) {
        report.totals.failed += 1;
        report.projects.push({
          id: row.id,
          name: row.name || "Unnamed",
          changed: false,
          applied: false,
          riskTags: [],
          contamination: { characters: [], items: [], locations: [] },
          panelStats: { totalPanels: 0, zeroRefPanels: 0, multiFramePanels: 0 },
          styleLock: { resolved: false, source: "error" },
          errors: [error instanceof Error ? error.message : String(error)]
        });
      }
    }

    from += data.length;
  }

  const reportPath = `/tmp/consistency_repair_report_${Date.now()}.json`;
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

  console.info(
    JSON.stringify(
      {
        mode: report.mode,
        scanned: report.totals.scanned,
        repaired: report.totals.repaired,
        unchanged: report.totals.unchanged,
        failed: report.totals.failed,
        reportPath
      },
      null,
      2
    )
  );
};

main().catch((error) => {
  console.error("[repair_project_consistency] failed", error);
  process.exitCode = 1;
});
