import crypto from 'node:crypto';
import { getSupabaseAdmin } from '../services/supabase.js';

type ParsedModel = {
  provider: 'gemini' | 'pixazo';
  model: string;
  inputPer1kUsd: number;
  outputPer1kUsd: number;
  imagePerOutputUsd: number;
  sourceUrl: string;
  confidence: number;
};

type SnapshotStatus = 'ACTIVE' | 'REVIEW_REQUIRED';

type PricingAlert = {
  provider: 'gemini' | 'pixazo';
  model: string;
  reasons: string[];
};

type EvaluatedModel = ParsedModel & {
  status: SnapshotStatus;
  reviewReasons: string[];
};

const GEMINI_SOURCE = process.env.GEMINI_PRICING_SOURCE_URL || 'https://ai.google.dev/gemini-api/docs/pricing';
const PIXAZO_SOURCE = process.env.PIXAZO_PRICING_SOURCE_URL || 'https://www.pixazo.ai/';

const ACTIVE_THRESHOLD = 0.8;
const MAJOR_DELTA_THRESHOLD = Number(process.env.PRICING_MAJOR_DELTA_THRESHOLD || '0.35');
const REQUEST_TIMEOUT_MS = 20_000;

const hashModels = (models: ParsedModel[]) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(models.map((model) => ({
      provider: model.provider,
      model: model.model,
      inputPer1kUsd: model.inputPer1kUsd,
      outputPer1kUsd: model.outputPer1kUsd,
      imagePerOutputUsd: model.imagePerOutputUsd
    }))))
    .digest('hex');

const normalizeMoney = (value: number, perMillion = false) => {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (perMillion) {
    return Number((value / 1000).toFixed(6));
  }
  return Number(value.toFixed(6));
};

const isSchemaValid = (model: ParsedModel) =>
  Number.isFinite(model.inputPer1kUsd) &&
  Number.isFinite(model.outputPer1kUsd) &&
  Number.isFinite(model.imagePerOutputUsd) &&
  model.inputPer1kUsd >= 0 &&
  model.outputPer1kUsd >= 0 &&
  model.imagePerOutputUsd >= 0;

const relativeDelta = (nextValue: number, previousValue: number) => {
  const baseline = Math.max(0.000001, Math.abs(previousValue));
  return Math.abs(nextValue - previousValue) / baseline;
};

const loadLatestActiveMap = async () => {
  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('model_pricing_snapshots')
      .select('provider, model_id, input_per_1k, output_per_1k, image_per_output, effective_from')
      .eq('status', 'ACTIVE')
      .order('effective_from', { ascending: false });

    if (error || !Array.isArray(data) || data.length === 0) {
      return new Map<string, ParsedModel>();
    }

    const map = new Map<string, ParsedModel>();
    for (const row of data) {
      const provider = String((row as Record<string, unknown>).provider || 'gemini') as 'gemini' | 'pixazo';
      const model = String((row as Record<string, unknown>).model_id || 'unknown');
      const key = `${provider}:${model}`;
      if (map.has(key)) continue;
      map.set(key, {
        provider,
        model,
        inputPer1kUsd: normalizeMoney(Number((row as Record<string, unknown>).input_per_1k || 0)),
        outputPer1kUsd: normalizeMoney(Number((row as Record<string, unknown>).output_per_1k || 0)),
        imagePerOutputUsd: normalizeMoney(Number((row as Record<string, unknown>).image_per_output || 0)),
        sourceUrl: 'historical_snapshot',
        confidence: 1
      });
    }

    return map;
  } catch {
    return new Map<string, ParsedModel>();
  }
};

const parseGeminiPricing = (text: string): ParsedModel[] => {
  const rows: ParsedModel[] = [];

  const extractSectionPrices = (sectionId: string, maxSpan = 2400) => {
    const start = text.indexOf(`id=\"${sectionId}\"`);
    if (start < 0) return [] as number[];
    const section = text.slice(start, start + maxSpan);
    const matches = Array.from(section.matchAll(/\$\s*([0-9]+(?:\.[0-9]+)?)/g));
    return matches.map((match) => Number(match[1])).filter((value) => Number.isFinite(value));
  };

  const flashPrices = extractSectionPrices('gemini-2.5-flash');
  if (flashPrices.length >= 2) {
    rows.push({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      inputPer1kUsd: normalizeMoney(flashPrices[0], true),
      outputPer1kUsd: normalizeMoney(flashPrices[1], true),
      imagePerOutputUsd: 0,
      sourceUrl: GEMINI_SOURCE,
      confidence: 0.93
    });
  }

  const flashLitePrices = extractSectionPrices('gemini-2.5-flash-lite');
  if (flashLitePrices.length >= 2) {
    rows.push({
      provider: 'gemini',
      model: 'gemini-2.5-flash-lite',
      inputPer1kUsd: normalizeMoney(flashLitePrices[0], true),
      outputPer1kUsd: normalizeMoney(flashLitePrices[1], true),
      imagePerOutputUsd: 0,
      sourceUrl: GEMINI_SOURCE,
      confidence: 0.93
    });
  }

  const flashImagePrices = extractSectionPrices('gemini-2.5-flash-image');
  const explicitImagePrice = text.match(/\$\s*([0-9]+(?:\.[0-9]+)?)\s*per\s*image/i);
  const imagePrice = explicitImagePrice
    ? Number(explicitImagePrice[1])
    : flashImagePrices.find((value) => value > 0 && value < 1) || 0.134;

  if (imagePrice > 0) {
    rows.push({
      provider: 'gemini',
      model: 'gemini-2.5-flash-image',
      inputPer1kUsd: 0,
      outputPer1kUsd: 0,
      imagePerOutputUsd: normalizeMoney(imagePrice, false),
      sourceUrl: GEMINI_SOURCE,
      confidence: explicitImagePrice ? 0.9 : 0.84
    });
  }

  return rows;
};

const parsePixazoPricing = (text: string): ParsedModel[] => {
  const rows: ParsedModel[] = [];
  const hasFlux = /flux/i.test(text);

  const usdPerImageRegex = /(\$\s*[0-9]+(?:\.[0-9]+)?)\s*(?:per|\/)?\s*(?:image|generation)/i;
  const match = usdPerImageRegex.exec(text);

  if (hasFlux && match) {
    const value = Number(match[1].replace(/[^0-9.]/g, ''));
    rows.push({
      provider: 'pixazo',
      model: 'pixazo/flux-1-schnell',
      inputPer1kUsd: 0,
      outputPer1kUsd: 0,
      imagePerOutputUsd: normalizeMoney(value, false),
      sourceUrl: PIXAZO_SOURCE,
      confidence: 0.65
    });
  } else {
    rows.push({
      provider: 'pixazo',
      model: 'pixazo/flux-1-schnell',
      inputPer1kUsd: 0,
      outputPer1kUsd: 0,
      imagePerOutputUsd: 0,
      sourceUrl: PIXAZO_SOURCE,
      confidence: 0.85
    });
  }

  return rows;
};

const fetchText = async (url: string): Promise<string> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'dreamstream-pricing-sync/1.0'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }

    return response.text();
  } finally {
    clearTimeout(timer);
  }
};

const writeSnapshots = async (models: EvaluatedModel[], alerts: PricingAlert[], dryRun: boolean) => {
  if (dryRun) return;

  const admin = getSupabaseAdmin();
  const fetchedAt = new Date().toISOString();

  const rows = models.map((model) => ({
    provider: model.provider,
    model_id: model.model,
    input_per_1k: model.inputPer1kUsd,
    output_per_1k: model.outputPer1kUsd,
    image_per_output: model.imagePerOutputUsd,
    currency: 'USD',
    source_url: model.sourceUrl,
    status: model.status,
    parser_confidence: model.confidence,
    fetched_at: fetchedAt,
    effective_from: fetchedAt,
    raw_payload: {
      source: model.sourceUrl,
      syncedAt: fetchedAt,
      reviewReasons: model.reviewReasons
    }
  }));

  await admin.from('model_pricing_snapshots').insert(rows);

  const grouped = new Map<string, ParsedModel[]>();
  models.forEach((model) => {
    if (!grouped.has(model.provider)) grouped.set(model.provider, []);
    grouped.get(model.provider)!.push(model);
  });

  for (const [provider, providerModels] of grouped.entries()) {
    const confidence = providerModels.reduce((sum, model) => sum + model.confidence, 0) / providerModels.length;
    const hash = hashModels(providerModels);
    const providerAlerts = alerts.filter((alert) => alert.provider === provider);
    const status: SnapshotStatus = providerAlerts.length > 0 ? 'REVIEW_REQUIRED' : 'ACTIVE';
    const sourceUrl = provider === 'gemini' ? GEMINI_SOURCE : PIXAZO_SOURCE;
    const lastError = providerAlerts.length > 0
      ? providerAlerts.map((alert) => `${alert.model}: ${alert.reasons.join(', ')}`).slice(0, 6).join(' | ')
      : null;

    await admin
      .from('model_pricing_sources')
      .upsert({
        provider,
        source_url: sourceUrl,
        parser_name: 'dailyPricingSync.ts',
        last_checked_at: fetchedAt,
        last_status: status,
        last_error: lastError,
        last_confidence: confidence,
        last_hash: hash,
        updated_at: fetchedAt
      }, { onConflict: 'provider' });
  }

  const status: SnapshotStatus = alerts.length > 0 ? 'REVIEW_REQUIRED' : 'ACTIVE';
  const summary = alerts.length > 0
    ? `Pricing sync requires review for ${alerts.length} model(s).`
    : `Pricing sync applied successfully for ${models.length} model(s).`;

  try {
    await admin
      .from('pricing_changelog_entries')
      .insert({
        source: 'daily_pricing_sync',
        status,
        summary,
        details: {
          modelCount: models.length,
          reviewRequiredCount: alerts.length,
          alerts,
          syncedAt: fetchedAt
        }
      });
  } catch {
    // If changelog table is unavailable, keep sync non-blocking.
  }
};

export const runDailyPricingSync = async (options?: { dryRun?: boolean; failOnLowConfidence?: boolean }) => {
  const dryRun = options?.dryRun === true;
  const failOnLowConfidence = options?.failOnLowConfidence === true;

  const [geminiText, pixazoText] = await Promise.all([
    fetchText(GEMINI_SOURCE),
    fetchText(PIXAZO_SOURCE)
  ]);

  const geminiModels = parseGeminiPricing(geminiText);
  const pixazoModels = parsePixazoPricing(pixazoText);
  const models = [...geminiModels, ...pixazoModels];

  if (models.length === 0) {
    throw new Error('Pricing parser returned no models.');
  }

  const latestActive = await loadLatestActiveMap();
  const alerts: PricingAlert[] = [];

  const evaluatedModels: EvaluatedModel[] = models.map((model) => {
    const reasons: string[] = [];

    if (!isSchemaValid(model)) {
      reasons.push('schema_invalid');
    }
    if (model.confidence < ACTIVE_THRESHOLD) {
      reasons.push('low_confidence');
    }

    const previous = latestActive.get(`${model.provider}:${model.model}`);
    if (previous) {
      const deltas = [
        relativeDelta(model.inputPer1kUsd, previous.inputPer1kUsd),
        relativeDelta(model.outputPer1kUsd, previous.outputPer1kUsd),
        relativeDelta(model.imagePerOutputUsd, previous.imagePerOutputUsd)
      ];
      if (deltas.some((delta) => delta > MAJOR_DELTA_THRESHOLD)) {
        reasons.push('major_delta');
      }
    }

    if (reasons.length > 0) {
      alerts.push({
        provider: model.provider,
        model: model.model,
        reasons
      });
    }

    return {
      ...model,
      status: reasons.length > 0 ? 'REVIEW_REQUIRED' : 'ACTIVE',
      reviewReasons: reasons
    };
  });

  const averageConfidence = evaluatedModels.reduce((sum, model) => sum + model.confidence, 0) / evaluatedModels.length;

  if (failOnLowConfidence && averageConfidence < ACTIVE_THRESHOLD) {
    throw new Error(`Pricing sync confidence too low (${averageConfidence.toFixed(2)}). Manual review required.`);
  }

  if (failOnLowConfidence && alerts.length > 0) {
    const reasons = alerts.map((alert) => `${alert.model}:${alert.reasons.join(',')}`).slice(0, 8).join(' | ');
    throw new Error(`Pricing sync requires review (${alerts.length} models). ${reasons}`);
  }

  await writeSnapshots(evaluatedModels, alerts, dryRun);

  return {
    modelCount: evaluatedModels.length,
    averageConfidence,
    reviewRequiredCount: alerts.length,
    alerts,
    dryRun,
    syncedAt: new Date().toISOString(),
    models: evaluatedModels
  };
};

const parseArgs = () => {
  const args = new Set(process.argv.slice(2));
  return {
    dryRun: args.has('--dry-run') || args.has('--check'),
    failOnLowConfidence: args.has('--check') || args.has('--fail-on-low-confidence')
  };
};

const isDirectRun = Boolean(process.argv[1] && process.argv[1].includes('dailyPricingSync'));

if (isDirectRun) {
  const args = parseArgs();
  runDailyPricingSync(args)
    .then((result) => {
      console.log(JSON.stringify({
        ok: true,
        modelCount: result.modelCount,
        averageConfidence: Number(result.averageConfidence.toFixed(3)),
        reviewRequiredCount: result.reviewRequiredCount,
        syncedAt: result.syncedAt,
        dryRun: result.dryRun
      }));
    })
    .catch((error) => {
      console.error(JSON.stringify({ ok: false, error: (error as Error).message }));
      process.exitCode = 1;
    });
}
