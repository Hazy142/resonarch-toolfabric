import {readFile} from "node:fs/promises";

export type PromptClassification =
  | "canonical_instruction_candidate"
  | "runtime_prompt_candidate"
  | "reference_or_derivative";

export interface PromptDiscoveryItem {
  discovery_query: string;
  repository: string;
  path: string;
  url: string;
  classification: PromptClassification;
  excerpt: string;
}

export interface PromptDiscoverySnapshot {
  schema: "resonarch.toolfabric.agent-prompt-discovery/v1";
  generated_at: string;
  scope: string;
  queries: string[];
  unique_result_urls: number;
  classification_counts: Record<PromptClassification, number>;
  caveat: string;
  phase?: string;
  claim_boundary?: string;
  items: PromptDiscoveryItem[];
}

export interface PromptInventory {
  baseline: PromptDiscoverySnapshot;
  live: PromptDiscoverySnapshot;
  external_live_items: PromptDiscoveryItem[];
  self_referential_items: PromptDiscoveryItem[];
}

const SELF_REPOSITORY = "Hazy142/resonarch-toolfabric";
const CLASSES: PromptClassification[] = [
  "canonical_instruction_candidate",
  "runtime_prompt_candidate",
  "reference_or_derivative",
];

function countClasses(items: PromptDiscoveryItem[]): Record<PromptClassification, number> {
  const counts: Record<PromptClassification, number> = {
    canonical_instruction_candidate: 0,
    runtime_prompt_candidate: 0,
    reference_or_derivative: 0,
  };
  for (const item of items) counts[item.classification] += 1;
  return counts;
}

function validateSnapshot(snapshot: PromptDiscoverySnapshot, label: string): void {
  if (snapshot.schema !== "resonarch.toolfabric.agent-prompt-discovery/v1") {
    throw new Error(`PROMPT_INVENTORY_SCHEMA:${label}`);
  }
  if (snapshot.items.length !== snapshot.unique_result_urls) {
    throw new Error(`PROMPT_INVENTORY_COUNT:${label}`);
  }
  for (const [index, item] of snapshot.items.entries()) {
    if (!CLASSES.includes(item.classification)) {
      throw new Error(`PROMPT_INVENTORY_CLASSIFICATION:${label}:${index}:${String(item.classification)}`);
    }
  }
  const urls = new Set(snapshot.items.map(item => item.url));
  if (urls.size !== snapshot.items.length) {
    throw new Error(`PROMPT_INVENTORY_DUPLICATE_URL:${label}`);
  }
  const counted = countClasses(snapshot.items);
  for (const classification of CLASSES) {
    if (counted[classification] !== snapshot.classification_counts[classification]) {
      throw new Error(`PROMPT_INVENTORY_CLASS_COUNT:${label}:${classification}`);
    }
  }
}

export function assertPromptInventoryLineage(
  baseline: PromptDiscoverySnapshot,
  live: PromptDiscoverySnapshot,
): void {
  validateSnapshot(baseline, "baseline");
  validateSnapshot(live, "live");

  const external = live.items.filter(item => item.repository !== SELF_REPOSITORY);
  if (external.length !== baseline.unique_result_urls) {
    throw new Error("PROMPT_INVENTORY_BASELINE_DRIFT:count");
  }

  const baselineUrls = new Set(baseline.items.map(item => item.url));
  const externalUrls = new Set(external.map(item => item.url));
  if (baselineUrls.size !== externalUrls.size || [...baselineUrls].some(url => !externalUrls.has(url))) {
    throw new Error("PROMPT_INVENTORY_BASELINE_DRIFT:urls");
  }

  const baselineByUrl = new Map(baseline.items.map(item => [item.url, item]));
  for (const item of external) {
    const baselineItem = baselineByUrl.get(item.url);
    if (!baselineItem || baselineItem.classification !== item.classification) {
      throw new Error(`PROMPT_INVENTORY_BASELINE_DRIFT:classification:${item.url}`);
    }
  }

  const baselineCounts = countClasses(baseline.items);
  const externalCounts = countClasses(external);
  for (const classification of CLASSES) {
    if (baselineCounts[classification] !== externalCounts[classification]) {
      throw new Error(`PROMPT_INVENTORY_BASELINE_DRIFT:${classification}`);
    }
  }
}

export async function loadPromptInventory(
  baselinePath = "docs/sources/agent-prompt-discovery-historical.json",
  livePath = "docs/sources/agent-prompt-discovery-2026-10-05.json",
): Promise<PromptInventory> {
  const [baseline, live] = await Promise.all([
    readFile(baselinePath, "utf8").then(text => JSON.parse(text) as PromptDiscoverySnapshot),
    readFile(livePath, "utf8").then(text => JSON.parse(text) as PromptDiscoverySnapshot),
  ]);
  assertPromptInventoryLineage(baseline, live);
  return {
    baseline,
    live,
    external_live_items: live.items.filter(item => item.repository !== SELF_REPOSITORY),
    self_referential_items: live.items.filter(item => item.repository === SELF_REPOSITORY),
  };
}
