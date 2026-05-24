import { createRequire } from "node:module";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const VERSION = require("pyodide/package.json").version;
const BASE = `https://cdn.jsdelivr.net/pyodide/v${VERSION}/full/`;
const OUT = new URL("../pyodide/", import.meta.url);

const NEEDED = ["micropip", "numpy", "sympy"];
const CORE = ["pyodide.js", "pyodide.asm.js", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];

async function fetchBytes(name) {
  const res = await fetch(BASE + name);
  if (!res.ok) throw new Error(`fetch ${name}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const lock = JSON.parse((await fetchBytes("pyodide-lock.json")).toString("utf8"));
const byName = {};
for (const key of Object.keys(lock.packages)) byName[lock.packages[key].name.toLowerCase()] = lock.packages[key];

const seen = new Set();
const queue = [...NEEDED];
while (queue.length) {
  const name = queue.pop().toLowerCase();
  if (seen.has(name)) continue;
  seen.add(name);
  const pkg = byName[name];
  if (!pkg) throw new Error(`package not in pyodide-lock.json: ${name}`);
  for (const dep of pkg.depends || []) queue.push(dep);
}
const wheels = [...seen].map((n) => byName[n].file_name);

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

let bytes = 0;
await Promise.all(
  [...CORE, ...wheels].map(async (name) => {
    const buf = await fetchBytes(name);
    await writeFile(new URL(name, OUT), buf);
    bytes += buf.length;
  })
);

const mib = (bytes / 1024 / 1024).toFixed(1);
console.log(`vendored Pyodide ${VERSION} from ${BASE}`);
console.log(`  -> ${fileURLToPath(OUT)}`);
console.log(`  packages (closure of ${NEEDED.join(", ")}): ${[...seen].sort().join(", ")}`);
console.log(`  ${CORE.length + wheels.length} files, ${mib} MiB`);
