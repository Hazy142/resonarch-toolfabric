import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {OperationJournal} from "../src/evidence/operationJournal.js";

const key = Buffer.alloc(32, 42); // Public fixture key, never a production credential.
const digest = "sha256:" + "a".repeat(64);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "toolfabric-journal-"));
  return {directory, journal: OperationJournal.open({directory, namespace: "fixture", signing_key: key})};
}

test("durable journal rejects a semantic conflict for an existing operation key", async t => {
  const f = await fixture(); t.after(() => f.journal.close());
  const first = f.journal.reserve("operation", digest, {plan_digest: digest});
  assert.equal(first.created, true);
  assert.equal(f.journal.reserve("operation", digest, {plan_digest: digest}).created, false);
  assert.throws(() => f.journal.reserve("operation", "sha256:" + "b".repeat(64), {}), {code: "IDEMPOTENCY_CONFLICT"});
});

test("durable journal persists one final result and reopens its authenticated state", async () => {
  const f = await fixture();
  f.journal.reserve("operation", digest, {plan_digest: digest});
  const lease = f.journal.claim("operation", "controller", 10000);
  f.journal.update("operation", lease, "prepared", {backend_id: "owned-backend"});
  const published = f.journal.publish("operation", lease, {status: "succeeded", artifact: digest});
  assert.equal(published.publication_count, 1);
  f.journal.close();
  const reopened = OperationJournal.open({directory: f.directory, namespace: "fixture", signing_key: key});
  try {
    assert.deepEqual(reopened.get("operation")?.result, {status: "succeeded", artifact: digest});
    assert.equal(reopened.get("operation")?.publication_count, 1);
    assert.equal(reopened.verify(), true);
    assert.equal(reopened.reserve("operation", digest, {}).created, false);
  } finally { reopened.close(); }
});

test("durable journal prevents concurrent owners and stale fenced publication", async t => {
  const f = await fixture(); t.after(() => f.journal.close());
  const other = OperationJournal.open({directory: f.directory, namespace: "fixture", signing_key: key}); t.after(() => other.close());
  f.journal.reserve("operation", digest, {});
  const lease = f.journal.claim("operation", "first", 10000);
  assert.throws(() => other.claim("operation", "second", 10000), {code: "OPERATION_LEASE_HELD"});
  const forged = {...lease, fencing_token: "forged"};
  assert.throws(() => other.publish("operation", forged, {status: "succeeded"}), {code: "STALE_OPERATION_FENCE"});
  assert.equal(other.get("operation")?.publication_count, 0);
});

test("durable journal detects changed persisted payloads and wrong signing keys", async () => {
  const f = await fixture();
  f.journal.reserve("operation", digest, {immutable: "original"}); f.journal.close();
  assert.throws(() => OperationJournal.open({directory: f.directory, namespace: "fixture", signing_key: Buffer.alloc(32, 7)}), {code: "JOURNAL_INTEGRITY_FAILED"});
  const db = new DatabaseSync(join(f.directory, "operations.sqlite"));
  db.prepare("UPDATE operations SET body_json = ? WHERE operation_key = ?").run('{"tampered":true}', "operation"); db.close();
  assert.throws(() => OperationJournal.open({directory: f.directory, namespace: "fixture", signing_key: key}), {code: "JOURNAL_INTEGRITY_FAILED"});
});

test("durable journal rejects rollback to an authentic older operation record while open", async t => {
  const f = await fixture(); t.after(() => f.journal.close());
  f.journal.reserve("operation", digest, {});
  const lease = f.journal.claim("operation", "controller", 10000);
  const external = new DatabaseSync(join(f.directory, "operations.sqlite")); t.after(() => external.close());
  const old = external.prepare("SELECT body_json,mac FROM operations WHERE operation_key='operation'").get() as {body_json:string;mac:string};
  f.journal.publish("operation", lease, {status: "succeeded", value: "first"});
  external.prepare("UPDATE operations SET body_json=?,mac=? WHERE operation_key='operation'").run(old.body_json, old.mac);
  assert.throws(() => f.journal.get("operation"), {code: "JOURNAL_INTEGRITY_FAILED"});
});
