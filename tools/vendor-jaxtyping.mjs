// Download the pure-Python wheels for jaxtyping + its runtime deps from PyPI and stash them under wheels/ so the
// worker installs them via emfs:/ instead of reaching back to PyPI on every page load. Mirrors the same self-host
// invariant as vendor-pyodide/vendor-yosys/vendor-nextpnr/vendor-examples: nothing the runtime needs
// must come from a CDN at load time.
//
// jaxtyping ~0.3 is required by upstream holoso examples that use Float64[ndarray, "..."] annotations (currently
// ekf1_stateful). Its only runtime dep is wadler-lindig (pure-Python, leaf). Both ship py3-none-any wheels.
//
// `make vendor-jaxtyping` writes the wheels and a tiny `wheels/extra-manifest.json` listing them in install order
// (deps before dependents); the worker reads that manifest, fetches each wheel, and feeds micropip an emfs path.

import { writeFile, mkdir, unlink, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../wheels/", import.meta.url));

// Order: dependency first, dependent last -- matches the order micropip needs to satisfy each install with
// `deps=False` (we never want micropip resolving from PyPI at install time).
const PACKAGES = ["wadler-lindig", "jaxtyping"];

function pickWheel(release) {
  const wheel = release.find((u) => u.packagetype === "bdist_wheel" && /py3-none-any\.whl$/i.test(u.filename));
  if (!wheel) throw new Error(`no py3-none-any wheel in release`);
  return wheel;
}

await mkdir(OUT, { recursive: true });

// Clear any previously-vendored extra wheels so a version bump on PyPI removes the old one. The holoso wheel
// is named in `make wheel` and lives separately; we identify our extras by the manifest we wrote last time.
const manifestPath = OUT + "extra-manifest.json";
let prev = [];
try {
  prev = JSON.parse(await readFile(manifestPath, "utf8"));
} catch {
  prev = [];
}
for (const name of prev) {
  try {
    await unlink(OUT + name);
  } catch {
    /* already gone */
  }
}

const written = [];
for (const pkg of PACKAGES) {
  const meta = await (await fetch(`https://pypi.org/pypi/${pkg}/json`)).json();
  const version = meta.info.version;
  const wheel = pickWheel(meta.urls);
  const bytes = new Uint8Array(await (await fetch(wheel.url)).arrayBuffer());
  await writeFile(OUT + wheel.filename, bytes);
  written.push(wheel.filename);
  console.log(`vendor-jaxtyping: ${pkg} ${version} -> ${wheel.filename} (${bytes.byteLength.toLocaleString()} bytes)`);
}

await writeFile(manifestPath, JSON.stringify(written, null, 2) + "\n");
console.log(`vendor-jaxtyping: wrote ${manifestPath} (${written.length} wheels)`);
