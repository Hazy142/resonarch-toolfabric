import test from "node:test";
import assert from "node:assert/strict";
import {assertPromptInventoryLineage, loadPromptInventory} from "../src/sources/promptInventory.js";

test("page 10 freezes the pre-public discovery baseline at 106 external hits", async () => {
  const inventory = await loadPromptInventory();
  assert.equal(inventory.baseline.unique_result_urls, 106);
  assert.deepEqual(inventory.baseline.classification_counts, {
    canonical_instruction_candidate: 11,
    reference_or_derivative: 78,
    runtime_prompt_candidate: 17,
  });
  assert.equal(inventory.baseline.items.length, 106);
  assert.equal(inventory.baseline.items.some(item => item.repository === "Hazy142/resonarch-toolfabric"), false);
});

test("the later live rerun preserves the baseline and isolates ToolFabric self-reference", async () => {
  const inventory = await loadPromptInventory();
  assert.equal(inventory.live.unique_result_urls, 108);
  assert.equal(inventory.external_live_items.length, 106);
  assert.deepEqual(inventory.self_referential_items.map(item => item.path).sort(), ["AGENTS.md", "README.md"]);
  assert.doesNotThrow(() => assertPromptInventoryLineage(inventory.baseline, inventory.live));
});

test("prompt inventory lineage fails closed when an external hit is lost", async () => {
  const inventory = await loadPromptInventory();
  const firstExternal = inventory.live.items.findIndex(item => item.repository !== "Hazy142/resonarch-toolfabric");
  const removed = inventory.live.items[firstExternal]!;
  const mutated = {
    ...inventory.live,
    items: inventory.live.items.filter((_, index) => index !== firstExternal),
    unique_result_urls: inventory.live.unique_result_urls - 1,
    classification_counts: {
      ...inventory.live.classification_counts,
      [removed.classification]: inventory.live.classification_counts[removed.classification] - 1,
    },
  };
  assert.throws(() => assertPromptInventoryLineage(inventory.baseline, mutated), /PROMPT_INVENTORY_BASELINE_DRIFT/);
});

test("prompt inventory validation rejects an unknown runtime classification", async () => {
  const inventory = await loadPromptInventory();
  const mutated = structuredClone(inventory.live);
  (mutated.items[0] as {classification: string}).classification = "unknown_class";
  assert.throws(
    () => assertPromptInventoryLineage(inventory.baseline, mutated),
    /PROMPT_INVENTORY_CLASSIFICATION:live/,
  );
});

test("prompt inventory lineage rejects per-URL classification swaps", async () => {
  const inventory = await loadPromptInventory();
  const mutated = structuredClone(inventory.live);
  const first = mutated.items.find(item =>
    item.repository !== "Hazy142/resonarch-toolfabric" &&
    item.classification === "canonical_instruction_candidate"
  )!;
  const second = mutated.items.find(item =>
    item.repository !== "Hazy142/resonarch-toolfabric" &&
    item.classification === "reference_or_derivative"
  )!;
  [first.classification, second.classification] = [second.classification, first.classification];
  assert.throws(
    () => assertPromptInventoryLineage(inventory.baseline, mutated),
    /PROMPT_INVENTORY_BASELINE_DRIFT:classification/,
  );
});

test("historical baseline excerpts exactly match the revision-bound live records", async () => {
  const inventory = await loadPromptInventory();
  const liveByUrl = new Map(inventory.external_live_items.map(item => [item.url, item]));
  for (const baselineItem of inventory.baseline.items) {
    assert.equal(baselineItem.excerpt, liveByUrl.get(baselineItem.url)?.excerpt, baselineItem.url);
  }
});
