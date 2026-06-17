// write-schema-hash.ts — record the current schema fingerprint + version as the committed ground truth.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { schema } from "../src/schema";
import { SCHEMA_VERSION } from "../src/version";
import { fingerprint } from "./_schema-fingerprint";

const out = { schemaVersion: SCHEMA_VERSION, hash: fingerprint(schema) };
const path = join(dirname(fileURLToPath(import.meta.url)), "..", ".schema-hash");
writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
console.log(`✓ wrote .schema-hash (v${SCHEMA_VERSION}, ${out.hash.slice(0, 12)}…)`);
