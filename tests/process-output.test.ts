import test from "node:test";
import assert from "node:assert/strict";
import {BoundedProcessOutput} from "../src/runtime/processOutput.js";

test("process output shares one byte budget across stdout and stderr", () => {
  const output = new BoundedProcessOutput(5);
  output.append("stdout", Buffer.from("abcd"));
  output.append("stderr", Buffer.from("wxyz"));
  const page = output.read(0, 0, 20);
  assert.equal(page.stdout_base64, "YWJjZA==");
  assert.equal(page.stderr_base64, "dw==");
  assert.equal(page.retained_bytes, 5);
  assert.equal(page.discarded_bytes, 3);
  assert.equal(page.truncated, true);
});

test("process output pages exact bytes without losing split UTF-8 characters", () => {
  const output = new BoundedProcessOutput(32);
  const bytes = Buffer.from("a€b", "utf8");
  output.append("stdout", bytes.subarray(0, 2));
  output.append("stdout", bytes.subarray(2));
  const first = output.read(0, 0, 2);
  const second = output.read(first.stdout_next, first.stderr_next, 10);
  assert.equal(first.stdout_base64, "YeI=");
  assert.equal(second.stdout_base64, "gqxi");
  assert.equal(Buffer.concat([Buffer.from(first.stdout_base64, "base64"), Buffer.from(second.stdout_base64, "base64")]).toString("utf8"), "a€b");
  assert.equal(second.stdout_next, 5);
  assert.equal(second.discarded_bytes, 0);
});

test("process output owns retained bytes and rejects invalid cursors", () => {
  const output = new BoundedProcessOutput(10);
  const bytes = Buffer.from("abc");
  output.append("stdout", bytes);
  bytes.fill(0);
  assert.equal(output.read(0, 0, 3).stdout_base64, "YWJj");
  assert.throws(() => output.read(-1, 0, 3), {code: "INVALID_OUTPUT_CURSOR"});
  assert.throws(() => output.read(4, 0, 3), {code: "INVALID_OUTPUT_CURSOR"});
  assert.throws(() => output.read(0, 0, 0), {code: "INVALID_OUTPUT_PAGE_SIZE"});
});
