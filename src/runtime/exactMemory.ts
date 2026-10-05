import {canonicalDigest, canonicalJson} from "../contracts/canonical.js";
import type {ReadMemoryRecord} from "../context/retrieval.js";
import {RuntimeExecutionError} from "./errors.js";

export type {ReadMemoryRecord} from "../context/retrieval.js";

const MAX_RECORDS = 10_000;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_KEYS = 64;
const MAX_QUERY_TERMS = 64;

interface StoredMemoryRecord {
  id: string;
  kind: string;
  text: string;
  keys: string[];
  metadata: Record<string, unknown> | null;
}

interface SearchHit {
  id: string;
  kind: string;
  keys: string[];
  record_digest: string;
  match: "id" | "key" | "phrase" | "all_terms";
  score: number;
}

function boundedString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.includes("\0")) {
    throw new RuntimeExecutionError("INVALID_RUNTIME_CONFIG", `${name} must be a non-empty string <= ${maxLength} chars`, "denied");
  }
  return value;
}

function canonicalMetadata(value: ReadMemoryRecord["metadata"]): Record<string, unknown> | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeExecutionError("INVALID_RUNTIME_CONFIG", "memory metadata must be an object", "denied");
  }
  let encoded: string;
  try {
    encoded = canonicalJson(value);
  } catch (error) {
    throw new RuntimeExecutionError(
      "INVALID_RUNTIME_CONFIG",
      error instanceof Error ? error.message : String(error),
      "denied",
    );
  }
  if (new TextEncoder().encode(encoded).byteLength > 256 * 1024) {
    throw new RuntimeExecutionError("INVALID_RUNTIME_CONFIG", "memory metadata exceeds 256 KiB", "denied");
  }
  return JSON.parse(encoded) as Record<string, unknown>;
}

function normalizeRecord(record: ReadMemoryRecord, index: number): StoredMemoryRecord {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new RuntimeExecutionError("INVALID_RUNTIME_CONFIG", `memory record ${index} must be an object`, "denied");
  }
  const id = boundedString(record.id, `memory record ${index} id`, 512);
  const kind = boundedString(record.kind, `memory record ${index} kind`, 128);
  if (typeof record.text !== "string" || record.text.includes("\0")) {
    throw new RuntimeExecutionError("INVALID_RUNTIME_CONFIG", `memory record ${index} text must be a string`, "denied");
  }
  if (new TextEncoder().encode(record.text).byteLength > MAX_TEXT_BYTES) {
    throw new RuntimeExecutionError("INVALID_RUNTIME_CONFIG", `memory record ${index} text exceeds 1 MiB`, "denied");
  }
  const rawKeys = record.keys ?? [];
  if (!Array.isArray(rawKeys) || rawKeys.length > MAX_KEYS) {
    throw new RuntimeExecutionError("INVALID_RUNTIME_CONFIG", `memory record ${index} keys must contain at most ${MAX_KEYS} entries`, "denied");
  }
  const keys = rawKeys.map((key, keyIndex) => boundedString(key, `memory record ${index} key ${keyIndex}`, 1024));
  if (new Set(keys).size !== keys.length) {
    throw new RuntimeExecutionError("INVALID_RUNTIME_CONFIG", `memory record ${index} contains duplicate keys`, "denied");
  }
  return {id, kind, text: record.text, keys: [...keys], metadata: canonicalMetadata(record.metadata)};
}

function positiveInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new RuntimeExecutionError("INVALID_ARGUMENT", `expected integer in range ${min}..${max}`, "denied");
  }
  return Number(value);
}

function queryArgument(input: Record<string, unknown>): string {
  if (typeof input.query !== "string" || input.query.length > 4096 || input.query.trim().length === 0 || input.query.includes("\0")) {
    throw new RuntimeExecutionError("INVALID_ARGUMENT", "memory.search_exact requires a non-empty query <= 4096 chars", "denied");
  }
  return input.query;
}

function modeArgument(input: Record<string, unknown>): "exact" | "lexical" {
  if (input.mode === undefined) return "exact";
  if (input.mode !== "exact" && input.mode !== "lexical") {
    throw new RuntimeExecutionError("INVALID_ARGUMENT", "memory.search_exact mode must be exact or lexical", "denied");
  }
  return input.mode;
}

function kindArgument(input: Record<string, unknown>): string | undefined {
  if (input.kind === undefined) return undefined;
  if (typeof input.kind !== "string" || input.kind.length === 0 || input.kind.length > 128 || input.kind.includes("\0")) {
    throw new RuntimeExecutionError("INVALID_ARGUMENT", "memory.search_exact kind must be a non-empty string <= 128 chars", "denied");
  }
  return input.kind;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function lexicalNormalize(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function lexicalTokens(value: string): string[] {
  return lexicalNormalize(value).match(/[\p{L}\p{N}_./:@-]+/gu) ?? [];
}

function countToken(tokens: readonly string[], term: string): number {
  let count = 0;
  for (const token of tokens) if (token === term) count += 1;
  return count;
}

function cloneRecord(record: StoredMemoryRecord): StoredMemoryRecord {
  return {
    id: record.id,
    kind: record.kind,
    text: record.text,
    keys: [...record.keys],
    metadata: record.metadata === null
      ? null
      : JSON.parse(canonicalJson(record.metadata)) as Record<string, unknown>,
  };
}

function candidateHit(
  record: StoredMemoryRecord,
  match: SearchHit["match"],
  score: number,
): SearchHit {
  return {
    id: record.id,
    kind: record.kind,
    keys: [...record.keys],
    record_digest: canonicalDigest(record),
    match,
    score,
  };
}

export class ExactMemorySnapshot {
  private readonly records: StoredMemoryRecord[];
  private readonly byId: Map<string, StoredMemoryRecord>;
  private readonly byKey: Map<string, StoredMemoryRecord[]>;
  private readonly lexicalIndex: Map<string, Set<string>>;
  private readonly lexicalTokensById: Map<string, string[]>;
  private readonly normalizedSearchableById: Map<string, string>;
  readonly digest: string;

  constructor(records: readonly ReadMemoryRecord[] = []) {
    if (!Array.isArray(records) || records.length > MAX_RECORDS) {
      throw new RuntimeExecutionError("INVALID_RUNTIME_CONFIG", `memoryRecords must contain at most ${MAX_RECORDS} entries`, "denied");
    }
    const normalizedRecords: StoredMemoryRecord[] = [];
    let totalBytes = 0;
    for (let index = 0; index < records.length; index += 1) {
      const normalized = normalizeRecord(records[index]!, index);
      totalBytes += new TextEncoder().encode(canonicalJson(normalized)).byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new RuntimeExecutionError("INVALID_RUNTIME_CONFIG", "memory snapshot exceeds 32 MiB", "denied");
      }
      normalizedRecords.push(normalized);
    }
    this.records = normalizedRecords.sort((a, b) => compareCodeUnits(a.id, b.id));
    this.byId = new Map<string, StoredMemoryRecord>();
    this.byKey = new Map<string, StoredMemoryRecord[]>();
    this.lexicalIndex = new Map<string, Set<string>>();
    this.lexicalTokensById = new Map<string, string[]>();
    this.normalizedSearchableById = new Map<string, string>();
    for (const record of this.records) {
      if (this.byId.has(record.id)) {
        throw new RuntimeExecutionError("DUPLICATE_MEMORY_ID", `DUPLICATE_MEMORY_ID: ${record.id}`, "denied");
      }
      this.byId.set(record.id, record);
      for (const key of record.keys) {
        const keyed = this.byKey.get(key) ?? [];
        keyed.push(record);
        this.byKey.set(key, keyed);
      }
      const searchable = [record.id, ...record.keys, record.text].join("\n");
      const normalized = lexicalNormalize(searchable);
      const tokens = lexicalTokens(searchable);
      this.normalizedSearchableById.set(record.id, normalized);
      this.lexicalTokensById.set(record.id, tokens);
      for (const token of new Set(tokens)) {
        const ids = this.lexicalIndex.get(token) ?? new Set<string>();
        ids.add(record.id);
        this.lexicalIndex.set(token, ids);
      }
    }
    this.digest = canonicalDigest(this.records);
  }

  get(input: Record<string, unknown>): Record<string, unknown> {
    const hasId = input.id !== undefined;
    const hasKey = input.key !== undefined;
    if (hasId === hasKey) {
      throw new RuntimeExecutionError("INVALID_ARGUMENT", "memory.get requires exactly one of id or key", "denied");
    }
    let record: StoredMemoryRecord | undefined;
    if (hasId) {
      if (typeof input.id !== "string" || input.id.length === 0 || input.id.length > 512 || input.id.includes("\0")) {
        throw new RuntimeExecutionError("INVALID_ARGUMENT", "memory.get id must be a non-empty string <= 512 chars", "denied");
      }
      record = this.byId.get(input.id);
      if (!record) throw new RuntimeExecutionError("MEMORY_NOT_FOUND", `memory record not found: ${input.id}`);
    } else {
      if (typeof input.key !== "string" || input.key.length === 0 || input.key.length > 1024 || input.key.includes("\0")) {
        throw new RuntimeExecutionError("INVALID_ARGUMENT", "memory.get key must be a non-empty string <= 1024 chars", "denied");
      }
      const matches = this.byKey.get(input.key) ?? [];
      if (matches.length === 0) throw new RuntimeExecutionError("MEMORY_NOT_FOUND", `memory key not found: ${input.key}`);
      if (matches.length > 1) throw new RuntimeExecutionError("MEMORY_KEY_AMBIGUOUS", `memory key is ambiguous: ${input.key}`);
      record = matches[0]!;
    }
    return {
      record: cloneRecord(record),
      record_digest: canonicalDigest(record),
      snapshot_digest: this.digest,
    };
  }

  search(input: Record<string, unknown>): Record<string, unknown> {
    const query = queryArgument(input);
    const mode = modeArgument(input);
    const kind = kindArgument(input);
    const limit = positiveInteger(input.limit, 20, 1, 100);
    const candidates = kind === undefined ? this.records : this.records.filter(record => record.kind === kind);
    const hits = mode === "exact"
      ? this.searchExact(candidates, query)
      : this.searchLexical(candidates, query);
    return {
      query,
      mode,
      kind: kind ?? null,
      hits: hits.slice(0, limit),
      total_hits: hits.length,
      snapshot_digest: this.digest,
      semantic_used: false,
    };
  }

  private searchExact(records: readonly StoredMemoryRecord[], query: string): SearchHit[] {
    const hits: SearchHit[] = [];
    for (const record of records) {
      if (record.id === query) {
        hits.push(candidateHit(record, "id", 2));
        continue;
      }
      if (record.keys.includes(query)) hits.push(candidateHit(record, "key", 1));
    }
    return hits.sort((a, b) => b.score - a.score || compareCodeUnits(a.id, b.id));
  }

  private searchLexical(records: readonly StoredMemoryRecord[], query: string): SearchHit[] {
    const terms = [...new Set(lexicalTokens(query))];
    if (terms.length === 0) {
      throw new RuntimeExecutionError("INVALID_ARGUMENT", "lexical query contains no searchable terms", "denied");
    }
    if (terms.length > MAX_QUERY_TERMS) {
      throw new RuntimeExecutionError("INVALID_ARGUMENT", `lexical query exceeds ${MAX_QUERY_TERMS} terms`, "denied");
    }
    const postingLists = terms.map(term => this.lexicalIndex.get(term));
    if (postingLists.some(list => list === undefined)) return [];
    const [first, ...rest] = postingLists as Set<string>[];
    const candidateIds = [...first].filter(id => rest.every(list => list.has(id)));
    const allowed = new Set(records.map(record => record.id));
    const phrase = lexicalNormalize(query).trim().replace(/\s+/g, " ");
    const hits: SearchHit[] = [];
    for (const id of candidateIds) {
      if (!allowed.has(id)) continue;
      const record = this.byId.get(id)!;
      const normalized = this.normalizedSearchableById.get(id)!;
      const tokens = this.lexicalTokensById.get(id)!;
      const phraseMatch = normalized.includes(phrase);
      const frequency = terms.reduce((sum, term) => sum + countToken(tokens, term), 0);
      hits.push(candidateHit(
        record,
        phraseMatch ? "phrase" : "all_terms",
        (phraseMatch ? 1000 : 0) + frequency,
      ));
    }
    return hits.sort((a, b) => b.score - a.score || compareCodeUnits(a.id, b.id));
  }
}
