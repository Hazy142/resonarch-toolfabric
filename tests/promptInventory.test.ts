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
