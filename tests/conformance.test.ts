import test from "node:test";
import assert from "node:assert/strict";
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
