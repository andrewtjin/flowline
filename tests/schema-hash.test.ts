// schema-hash.test.ts — the committed .schema-hash must match the current schema.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { schema } from "../src/schema";
import { SCHEMA_VERSION } from "../src/version";
import { fingerprint } from "../scripts/_schema-fingerprint";

describe("schema-hash guard", () => {
  it("committed .schema-hash matches the current schema fingerprint + version", () => {
    const path = join(dirname(fileURLToPath(import.meta.url)), "..", ".schema-hash");
    const stored = JSON.parse(readFileSync(path, "utf8")) as { hash: string; schemaVersion: number };
    expect(stored.schemaVersion).toBe(SCHEMA_VERSION);
    expect(stored.hash).toBe(fingerprint(schema));
  });
});
