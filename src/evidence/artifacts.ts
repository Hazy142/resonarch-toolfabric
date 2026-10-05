import {randomUUID} from "node:crypto";
import {mkdir, open, readFile, rename, rm} from "node:fs/promises";
import {join} from "node:path";
import {sha256} from "../contracts/canonical.js";

const ARTIFACT_REF = /^artifact:\/\/(sha256:[0-9a-f]{64})$/;

function parseRef(ref: string): string {
  const match = ARTIFACT_REF.exec(ref);
  if (!match) throw new Error("INVALID_ARTIFACT_REF");
  return match[1]!;
}

export class ArtifactStore {
  constructor(readonly root: string) {}

  private pathForDigest(digest: string): string {
    return join(this.root, digest.slice("sha256:".length));
  }

  async put(bytes: Uint8Array): Promise<string> {
    const digest = sha256(bytes);
    const ref = "artifact://" + digest;
    await mkdir(this.root, {recursive: true});
    const target = this.pathForDigest(digest);

    try {
      const existing = await readFile(target);
      if (sha256(existing) !== digest) throw new Error("ARTIFACT_DIGEST_MISMATCH");
      return ref;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const temporary = join(this.root, `.${digest.slice(7)}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await rename(temporary, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      const existing = await readFile(target);
      if (sha256(existing) !== digest) throw new Error("ARTIFACT_DIGEST_MISMATCH");
    } finally {
      await rm(temporary, {force: true}).catch(() => undefined);
    }
    return ref;
  }

  async get(ref: string): Promise<Uint8Array> {
    const digest = parseRef(ref);
    const data = await readFile(this.pathForDigest(digest));
    if (sha256(data) !== digest) throw new Error("ARTIFACT_DIGEST_MISMATCH");
    return data;
  }
}
