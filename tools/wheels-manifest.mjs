// Write wheels/manifest.json: the list of every wheel the browser worker installs at load time — the
// holoso wheel plus the vendored extras — derived from the .whl files actually present, so a holoso
// version bump needs no edit anywhere. Order is irrelevant (installed with deps=False before any import);
// holoso is listed first for readability.

import { readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WHEELS = fileURLToPath(new URL("../wheels/", import.meta.url));
const whl = readdirSync(WHEELS).filter((f) => f.endsWith(".whl"));
const holoso = whl.filter((f) => /^holoso-/.test(f)).sort();
const extras = whl.filter((f) => !/^holoso-/.test(f)).sort();
if (holoso.length !== 1) {
  throw new Error(`expected exactly one holoso-*.whl in wheels/, found ${holoso.length}: ${holoso.join(", ") || "none"}`);
}
const manifest = [...holoso, ...extras];
writeFileSync(`${WHEELS}manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
console.log(`wheels/manifest.json: ${manifest.join(", ")}`);
