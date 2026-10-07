import test from "node:test";
import assert from "node:assert/strict";
import {readdir, readFile} from "node:fs/promises";
import {join} from "node:path";
import {assertAdapterResultStates, REQUIRED_RESULT_STATES} from "../conformance/provider.js";

if (false) {
  // @ts-expect-error arbitrary strings are not valid canonical ResultStatus values
  assertAdapterResultStates(["bogus"]);
}

test("adapter conformance rejects missing 'uncertain'", () =>
  assert.throws(
    () => assertAdapterResultStates(REQUIRED_RESULT_STATES.filter(state => state !== "uncertain")),
    /ADAPTER_STATE_LOSS:uncertain/,
  ));

test("adapter conformance accepts all canonical result states", () =>
  assert.doesNotThrow(() => assertAdapterResultStates(REQUIRED_RESULT_STATES)),
);

test("all conformance vectors use the canonical vector schema and unique IDs", async () => {
  const root = "conformance/vectors";
  const files = (await readdir(root))
    .filter(name => name.endsWith(".json") && name !== "result-states.json")
    .sort();
  assert.ok(files.length > 0);

  const ids = new Set<string>();
  for (const file of files) {
    const vector = JSON.parse(await readFile(join(root, file), "utf8"));
    assert.equal(vector.schema, "resonarch.toolfabric.conformance-vector/v1", `${file}: schema`);
    assert.equal(typeof vector.id, "string", `${file}: id`);
    assert.ok(vector.id.length > 0, `${file}: non-empty id`);
    assert.ok(!ids.has(vector.id), `${file}: duplicate id ${vector.id}`);
    ids.add(vector.id);

    for (const key of ["implemented_tools", "required_behaviors", "claims", "non_claims", "p1_allowed_tools", "unsupported_tools"]) {
      if (key in vector) assert.ok(Array.isArray(vector[key]), `${file}: ${key} must be an array`);
    }
  }
});

test("result-state conformance fixture keeps the canonical result-state schema", async () => {
  const fixture = JSON.parse(await readFile("conformance/vectors/result-states.json", "utf8"));
  assert.equal(fixture.schema, "resonarch.toolfabric.conformance/v1");
  assert.deepEqual(fixture.required, REQUIRED_RESULT_STATES);
});
