import test from "node:test";
import assert from "node:assert/strict";
import {assertAdapterResultStates,REQUIRED_RESULT_STATES} from "../conformance/provider.js";
test("adapter conformance rejects loss of uncertain",()=>assert.throws(()=>assertAdapterResultStates(REQUIRED_RESULT_STATES.filter(x=>x!=="uncertain")),/ADAPTER_STATE_LOSS:uncertain/));
test("adapter conformance accepts all canonical result states",()=>assert.doesNotThrow(()=>assertAdapterResultStates(REQUIRED_RESULT_STATES)));
