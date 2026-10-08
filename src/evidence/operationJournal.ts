import {DatabaseSync} from "node:sqlite";
import {createHmac, randomUUID, timingSafeEqual} from "node:crypto";
import {existsSync, lstatSync, mkdirSync, realpathSync} from "node:fs";
import {isAbsolute, join} from "node:path";
import {canonicalDigest, canonicalJson, sha256} from "../contracts/canonical.js";
import {RuntimeExecutionError} from "../runtime/errors.js";

export interface OperationLease {owner: string; generation: number; fencing_token: string; lease_until: number;}
export interface JournalRecord {
  operation_key: string; semantic_digest: string; state: string; payload: Record<string, unknown>;
  lease: OperationLease | null; result: any; publication_count: number;
  event_seq: number; created_at: number; updated_at: number;
}
export interface OperationJournalOptions {directory: string; namespace: string; signing_key: Uint8Array;}

interface Root {journal_id: string; namespace: string; schema_hash: string; last_seq: number; last_hash: string;}
interface Event {seq: number; operation_key: string; kind: string; record_digest: string; previous_hash: string; at: number;}
type SignedRow = {body_json: string; mac: string};
const PHASES = new Set(["reserved", "prepared", "started", "finished", "uncertain", "cancelled", "published"]);

export class OperationJournal {
  readonly database_path: string;
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  private identifier = "";
  private closed = false;
  private inTransaction = false;

  private constructor(private readonly options: OperationJournalOptions) {
    if (!isAbsolute(options.directory) || !options.namespace || options.namespace.length > 256 || options.signing_key.byteLength < 32) {
      throw new RuntimeExecutionError("INVALID_JOURNAL_CONFIG", "journal requires absolute state directory, namespace and host-owned signing key >=32 bytes", "denied");
    }
    this.key = Buffer.from(options.signing_key);
    mkdirSync(options.directory, {recursive: true, mode: 0o700});
    if (lstatSync(options.directory).isSymbolicLink()) throw new RuntimeExecutionError("INVALID_JOURNAL_CONFIG", "state directory cannot be a symbolic link", "denied");
    this.database_path = join(realpathSync(options.directory), "operations.sqlite");
    if (existsSync(this.database_path) && lstatSync(this.database_path).isSymbolicLink()) {
      throw new RuntimeExecutionError("INVALID_JOURNAL_CONFIG", "journal file cannot be a symbolic link", "denied");
    }
    const existed = existsSync(this.database_path);
    this.db = new DatabaseSync(this.database_path);
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;");
      if (!existed) {
        this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;");
        this.db.exec("CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), body_json TEXT NOT NULL, mac TEXT NOT NULL);"
          + "CREATE TABLE operations (operation_key TEXT PRIMARY KEY, body_json TEXT NOT NULL, mac TEXT NOT NULL);"
          + "CREATE TABLE events (seq INTEGER PRIMARY KEY, body_json TEXT NOT NULL, event_hash TEXT NOT NULL, mac TEXT NOT NULL);"
          + "CREATE TABLE artifacts (ref TEXT PRIMARY KEY, bytes BLOB NOT NULL, mac TEXT NOT NULL);");
        this.identifier = randomUUID();
        this.saveRoot({journal_id: this.identifier, namespace: options.namespace, schema_hash: this.schemaHash(), last_seq: 0, last_hash: "sha256:GENESIS"});
        this.db.exec("COMMIT;");
      } else {
        const raw = this.db.prepare("SELECT body_json,mac FROM metadata WHERE id=1").get() as SignedRow | undefined;
        if (!raw) throw new Error("metadata missing");
        this.identifier = JSON.parse(raw.body_json).journal_id;
        this.root(); // Authenticate existing state before changing any schema or journal mode.
        this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      }
      if (!this.verify()) throw new Error("journal verification failed");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      this.db.close(); this.key.fill(0);
      throw new RuntimeExecutionError("JOURNAL_INTEGRITY_FAILED", error instanceof Error ? error.message : String(error), "denied");
    }
  }

  static open(options: OperationJournalOptions): OperationJournal { return new OperationJournal(options); }
  get identity():string {return this.identifier;}

  private mac(kind: string, body: unknown): string {
    return createHmac("sha256", this.key).update(canonicalJson({journal_id: this.identifier, namespace: this.options.namespace, kind, body})).digest("hex");
  }
  private authenticated<T>(kind: string, row: SignedRow): T {
    const body = JSON.parse(row.body_json);
    const expected = Buffer.from(this.mac(kind, body), "hex");
    const actual = /^[a-f0-9]{64}$/.test(row.mac) ? Buffer.from(row.mac, "hex") : Buffer.alloc(0);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new RuntimeExecutionError("JOURNAL_INTEGRITY_FAILED", "signed state was modified or uses a different key", "denied");
    }
    return body as T;
  }
  private schemaHash(): string {
    return canonicalDigest(this.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all());
  }
  private root(): Root {
    const raw = this.db.prepare("SELECT body_json,mac FROM metadata WHERE id=1").get() as SignedRow;
    const root = this.authenticated<Root>("root", raw);
    if (root.journal_id !== this.identifier || root.namespace !== this.options.namespace || root.schema_hash !== this.schemaHash()) {
      throw new RuntimeExecutionError("JOURNAL_INTEGRITY_FAILED", "journal identity or schema changed", "denied");
    }
    return root;
  }
  private saveRoot(root: Root): void {
    this.db.prepare("INSERT INTO metadata(id,body_json,mac) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET body_json=excluded.body_json,mac=excluded.mac")
      .run(canonicalJson(root), this.mac("root", root));
  }
  private transaction<T>(work: () => T): T {
    if (this.closed) throw new RuntimeExecutionError("JOURNAL_CLOSED", "journal is closed", "denied");
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try { if (!this.verifySnapshot()) throw new RuntimeExecutionError("JOURNAL_INTEGRITY_FAILED", "journal audit/state changed", "denied"); const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
    finally {this.inTransaction = false;}
  }
  private readSnapshot<T>(work: () => T): T {
    if (this.inTransaction) return work();
    this.db.exec("BEGIN"); this.inTransaction = true;
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { try {this.db.exec("ROLLBACK");} catch {} throw error; }
    finally {this.inTransaction = false;}
  }
  private save(record: JournalRecord, kind: string): JournalRecord {
    const root = this.root();
    record.updated_at = Date.now(); record.event_seq = root.last_seq + 1;
    const text = canonicalJson(record);
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new RuntimeExecutionError("JOURNAL_RECORD_TOO_LARGE", "journal records are bounded to 2 MiB", "denied");
    const event: Event = {seq: record.event_seq, operation_key: record.operation_key, kind, record_digest: canonicalDigest(record), previous_hash: root.last_hash, at: Date.now()};
    const eventHash = canonicalDigest(event);
    this.db.prepare("INSERT INTO operations(operation_key,body_json,mac) VALUES (?,?,?) ON CONFLICT(operation_key) DO UPDATE SET body_json=excluded.body_json,mac=excluded.mac")
      .run(record.operation_key, text, this.mac("operation", record));
    this.db.prepare("INSERT INTO events(seq,body_json,event_hash,mac) VALUES (?,?,?,?)").run(event.seq, canonicalJson(event), eventHash, this.mac("event", event));
    this.saveRoot({...root, last_seq: event.seq, last_hash: eventHash});
    return JSON.parse(text) as JournalRecord;
  }
  private require(operation: string): JournalRecord {
    const record = this.get(operation);
    if (!record) throw new RuntimeExecutionError("OPERATION_NOT_FOUND", "operation is not recorded", "denied");
    return record;
  }
  private assertFence(record: JournalRecord, lease: OperationLease): void {
    const current = record.lease;
    if (!current || current.owner !== lease.owner || current.generation !== lease.generation || current.fencing_token !== lease.fencing_token || current.lease_until <= Date.now()) {
      throw new RuntimeExecutionError("STALE_OPERATION_FENCE", "operation ownership is stale", "denied");
    }
  }
  reserve(operation_key: string, semantic_digest: string, payload: Record<string, unknown>) {
    if (!operation_key || operation_key.length > 256 || !/^sha256:[a-f0-9]{64}$/.test(semantic_digest)) throw new RuntimeExecutionError("INVALID_OPERATION_KEY", "invalid operation identity", "denied");
    return this.transaction(() => {
      const existing = this.get(operation_key);
      if (existing) {
        if (existing.semantic_digest !== semantic_digest) throw new RuntimeExecutionError("IDEMPOTENCY_CONFLICT", "same operation key has different semantic input", "denied");
        return {created: false, record: existing};
      }
      const at = Date.now();
      const record: JournalRecord = {operation_key,semantic_digest,payload: JSON.parse(canonicalJson(payload)),state:"reserved",lease:null,result:null,publication_count:0,event_seq:0,created_at:at,updated_at:at};
      return {created: true, record: this.save(record, "reserved")};
    });
  }
  claim(operation: string, owner: string, milliseconds: number): OperationLease {
    if (!owner || !Number.isInteger(milliseconds) || milliseconds < 100 || milliseconds > 120000) throw new RuntimeExecutionError("INVALID_OPERATION_LEASE", "invalid controller or lease lifetime", "denied");
    return this.transaction(() => {
      const record = this.require(operation);
      if (record.state === "published") throw new RuntimeExecutionError("OPERATION_ALREADY_PUBLISHED", "use the immutable cached result", "denied");
      if (record.lease && record.lease.lease_until > Date.now()) {
        if (record.lease.owner !== owner) throw new RuntimeExecutionError("OPERATION_LEASE_HELD", "another live controller owns operation", "denied");
        return {...record.lease};
      }
      const lease = {owner,generation:(record.lease?.generation ?? 0)+1,fencing_token:randomUUID(),lease_until:Date.now()+milliseconds};
      this.save({...record,lease}, "lease_claimed"); return lease;
    });
  }
  renew(operation: string, lease: OperationLease, milliseconds: number): OperationLease {
    return this.transaction(() => {
      const record = this.require(operation); this.assertFence(record, lease);
      if (!Number.isInteger(milliseconds) || milliseconds < 100 || milliseconds > 120000) throw new RuntimeExecutionError("INVALID_OPERATION_LEASE", "invalid renewal lifetime", "denied");
      const renewed = {...record.lease!,lease_until:Date.now()+milliseconds};
      this.save({...record,lease:renewed}, "lease_renewed"); return renewed;
    });
  }
  update(operation: string, lease: OperationLease, state: string, payload: Record<string, unknown>): void {
    if (!PHASES.has(state) || state === "published") throw new RuntimeExecutionError("INVALID_OPERATION_STATE", "publication requires publish()", "denied");
    this.transaction(() => {
      const record = this.require(operation); this.assertFence(record, lease);
      if (record.state === "published") throw new RuntimeExecutionError("OPERATION_ALREADY_PUBLISHED", "published state is immutable", "denied");
      this.save({...record,state,payload:{...record.payload,...JSON.parse(canonicalJson(payload))}}, "updated");
    });
  }
  publish(operation: string, lease: OperationLease, result: unknown): JournalRecord {
    return this.transaction(() => {
      const record = this.require(operation);
      if (record.state === "published") {
        if (canonicalDigest(record.result) !== canonicalDigest(result)) throw new RuntimeExecutionError("PUBLISHED_RESULT_CONFLICT", "result was already published", "denied");
        return record;
      }
      this.assertFence(record, lease);
      if(result && typeof result==="object" && Array.isArray((result as any).artifacts)) {
        for(const ref of (result as any).artifacts)this.readArtifact(ref);
      }
      return this.save({...record,state:"published",result:JSON.parse(canonicalJson(result)),publication_count:1}, "published");
    });
  }
  private readRecord(operation: string): JournalRecord | null {
    const row = this.db.prepare("SELECT body_json,mac FROM operations WHERE operation_key=?").get(operation) as SignedRow | undefined;
    if (!row) return null;
    const record = this.authenticated<JournalRecord>("operation", row);
    if (record.operation_key !== operation) throw new RuntimeExecutionError("JOURNAL_INTEGRITY_FAILED", "operation identity changed", "denied");
    return record;
  }
  get(operation: string): JournalRecord | null {
    return this.readSnapshot(() => {
      if (!this.verifySnapshot()) throw new RuntimeExecutionError("JOURNAL_INTEGRITY_FAILED", "journal audit/state changed", "denied");
      return this.readRecord(operation);
    });
  }
  private records(): JournalRecord[] {
    return (this.db.prepare("SELECT operation_key FROM operations ORDER BY operation_key").all() as Array<{operation_key:string}>).map(row => this.readRecord(row.operation_key)!);
  }
  list(): JournalRecord[] {
    return this.readSnapshot(() => {
      if (!this.verifySnapshot()) throw new RuntimeExecutionError("JOURNAL_INTEGRITY_FAILED", "journal audit/state changed", "denied");
      return this.records();
    });
  }
  verify(): boolean {return this.readSnapshot(() => this.verifySnapshot());}
  private verifySnapshot(): boolean {
    try {
      const root = this.root(); let hash = "sha256:GENESIS"; let seq = 0;
      const latest = new Map<string,{seq:number;digest:string}>();
      for (const row of this.db.prepare("SELECT body_json,mac,event_hash FROM events ORDER BY seq").all() as Array<SignedRow & {event_hash:string}>) {
        const event = this.authenticated<Event>("event", row);
        if (event.seq !== ++seq || event.previous_hash !== hash || canonicalDigest(event) !== row.event_hash) return false;
        hash = row.event_hash; latest.set(event.operation_key, {seq,digest:event.record_digest});
      }
      if (root.last_seq !== seq || root.last_hash !== hash) return false;
      for (const record of this.records()) {
        const last = latest.get(record.operation_key);
        if (!last || record.event_seq !== last.seq || canonicalDigest(record) !== last.digest) return false;
        latest.delete(record.operation_key);
        if(record.state==="published"&&Array.isArray(record.result?.artifacts))for(const ref of record.result.artifacts)this.readArtifact(ref);
      }
      for(const row of this.db.prepare("SELECT ref FROM artifacts").all() as Array<{ref:string}>)this.readArtifact(row.ref);
      return latest.size === 0;
    } catch { return false; }
  }
  putArtifact(bytes:Uint8Array):string {
    if(bytes.byteLength>2*1024*1024)throw new RuntimeExecutionError("ARTIFACT_TOO_LARGE","durable blobs are limited to 2 MiB","denied");
    const ref="artifact://"+sha256(bytes);
    return this.transaction(()=>{
      const existing=this.db.prepare("SELECT ref FROM artifacts WHERE ref=?").get(ref);
      if(existing){this.readArtifact(ref);return ref;}
      const signature=this.mac("artifact",{ref,length:bytes.byteLength,digest:sha256(bytes)});
      this.db.prepare("INSERT INTO artifacts(ref,bytes,mac) VALUES (?,?,?)").run(ref,bytes,signature);
      return ref;
    });
  }
  private readArtifact(ref:string):Uint8Array {
    if(!/^artifact:\/\/sha256:[a-f0-9]{64}$/.test(ref))throw new RuntimeExecutionError("INVALID_ARTIFACT_REF","invalid durable artifact reference","denied");
    const row=this.db.prepare("SELECT bytes,mac FROM artifacts WHERE ref=?").get(ref) as {bytes:Uint8Array;mac:string}|undefined;
    if(!row)throw new RuntimeExecutionError("JOURNAL_INTEGRITY_FAILED","published artifact is missing","denied");
    const digest=sha256(row.bytes);
    if("artifact://"+digest!==ref||this.mac("artifact",{ref,length:row.bytes.byteLength,digest})!==row.mac) {
      throw new RuntimeExecutionError("JOURNAL_INTEGRITY_FAILED","durable artifact bytes changed","denied");
    }
    return Uint8Array.from(row.bytes);
  }
  getArtifact(operation:string,ref:string):Uint8Array {
    return this.readSnapshot(()=>{
      if(!this.verifySnapshot())throw new RuntimeExecutionError("JOURNAL_INTEGRITY_FAILED","journal state changed","denied");
      const record=this.readRecord(operation);
      if(record?.state!=="published"||!Array.isArray(record.result?.artifacts)||!record.result.artifacts.includes(ref)) {
        throw new RuntimeExecutionError("ARTIFACT_NOT_PUBLISHED","artifact is not published for this operation","denied");
      }
      return this.readArtifact(ref);
    });
  }
  close(): void {if (!this.closed) {this.db.close();this.key.fill(0);this.closed=true;}}
}
