// check-schema-hash.ts — fails the build if the schema spec changed but SCHEMA_VERSION did not bump.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { schema } from "../src/schema";
import { SCHEMA_VERSION } from "../src/version";
import { fingerprint } from "./_schema-fingerprint";

const hashPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".schema-hash");
const current = fingerprint(schema);

let raw: string;
try {
  raw = readFileSync(hashPath, "utf8");
} catch {
  console.error("✗ schema-hash gate: .schema-hash missing. Run: npm run schema-hash:write");
  process.exit(1);
}
const stored = JSON.parse(raw) as { hash: string; schemaVersion: number };

if (stored.hash === current && stored.schemaVersion === SCHEMA_VERSION) {
  console.log(`✓ schema-hash gate: schema matches committed fingerprint (v${SCHEMA_VERSION})`);
  process.exit(0);
}
if (stored.schemaVersion === SCHEMA_VERSION) {
  console.error(`✗ schema-hash gate: schema spec CHANGED but SCHEMA_VERSION (${SCHEMA_VERSION}) was not bumped.`);
  console.error("  Intentional vocab/attr change? Bump SCHEMA_VERSION (src/version.ts), then: npm run schema-hash:write");
} else {
  console.error(`✗ schema-hash gate: .schema-hash is stale for v${SCHEMA_VERSION}. Run: npm run schema-hash:write`);
}
process.exit(1);
