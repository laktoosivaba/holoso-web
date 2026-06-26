// Shared plumbing for the holoso-web Node tooling: path constants, a tiny pass/fail harness, the demo
// loader, the Pyodide + holoso bootstrap, the run_script bridge, and Verilog-pick. Each test/check script
// imports what it needs and is then just its own assertions, not a re-implementation of the setup.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const WEB = fileURLToPath(new URL("../", import.meta.url));
export const SYNTH = (process.env.SYNTH || WEB + "../holoso-synth").replace(/\/$/, "");
export const DEMOS = WEB + "demos";
export const WHEELS = WEB + "wheels";              // vendored wheels: holoso + jaxtyping/deps (extra-manifest)
export const DRIVER = WEB + "driver.py";
export const VENDORED_PYODIDE = WEB + "pyodide/";

// Find the holoso-*.whl in a directory (version-agnostic, so a version bump needs no edit).
function holosoWheel(dir) {
  const name = readdirSync(dir).find((f) => /^holoso-.*\.whl$/.test(f));
  if (!name) throw new Error(`no holoso-*.whl in ${dir}`);
  return { name, path: `${dir.replace(/\/$/, "")}/${name}` };
}

// Minimal harness: check(cond, msg) logs a line and tallies failures; done(okLabel) prints the summary
// banner and exits 0/1. Replaces the identical log/check/failures block every script used to carry.
export function harness() {
  let failures = 0;
  const log = (...a) => process.stdout.write(a.join(" ") + "\n");
  const check = (cond, msg) => { log(`${cond ? "  ok  " : " FAIL "} ${msg}`); if (!cond) failures++; };
  const done = (okLabel) => {
    log(`\n=== ${failures ? `${failures} FAILURE(S)` : okLabel} ===`);
    process.exit(failures ? 1 : 0);
  };
  return { log, check, done };
}

// The demo corpus: static .py sources listed by demos/manifest.json (the same set the browser worker
// fetches), each with its sibling `extras` read alongside so cross-file demos resolve.
export function loadDemos() {
  return JSON.parse(readFileSync(`${DEMOS}/manifest.json`, "utf8")).map((d) => ({
    id: d.id,
    label: d.label,
    filename: d.file,
    source: readFileSync(`${DEMOS}/${d.file}`, "utf8"),
    extras: Object.fromEntries((d.extras || []).map((n) => [n, readFileSync(`${DEMOS}/${n}`, "utf8")])),
  }));
}

// Boot Pyodide, install the holoso wheel + the vendored extra wheels from the in-memory FS (never PyPI),
// and exec driver.py so run_script is defined — mirroring worker.js init(). `indexURL` boots from a
// specific Pyodide dir (vendor-check passes the vendored one); `wheelDir` is where the holoso wheel is
// taken from (driver_test points at the freshly built SYNTH/dist; default is the vendored wheels/). The
// extras always come from the vendored wheels/ via extra-manifest.json.
export async function bootHoloso({ indexURL, wheelDir = WHEELS } = {}) {
  const { loadPyodide } = await import("pyodide");
  const py = await loadPyodide(indexURL ? { indexURL } : undefined);
  await py.loadPackage(["micropip", "numpy", "scipy", "sympy"]);
  const holoso = holosoWheel(wheelDir);
  const names = [holoso.name];
  py.FS.writeFile("/" + holoso.name, readFileSync(holoso.path));
  for (const name of JSON.parse(readFileSync(`${WHEELS}/extra-manifest.json`, "utf8"))) {
    py.FS.writeFile("/" + name, readFileSync(`${WHEELS}/${name}`));
    names.push(name);
  }
  const installs = names.map((n) => `await micropip.install("emfs:/${n}", deps=False)`).join("\n");
  await py.runPythonAsync(`import micropip\n${installs}\n`);
  py.runPython(readFileSync(DRIVER, "utf8"));
  return py;
}

// Run a user script through the driver's run_script and return the parsed JSON envelope.
export function runScript(py, filename, source, extras = {}) {
  py.globals.set("_filename", filename);
  py.globals.set("_src", source);
  py.globals.set("_extras", JSON.stringify(extras || {}));
  return JSON.parse(py.runPython("run_script(_filename, _src, _extras)"));
}

// From a run_script result, pick the synthesizable top .v plus its sibling holoso_support.{v,vh} —
// mirrors app.js deriveRouteInputs. Returns {top, verilog, support, supportVh} or null if no .v emitted.
export function pickVerilog(files) {
  const verilogs = files.filter((f) => f.ext === "v");
  const main = verilogs.find((f) => !f.path.endsWith("holoso_support.v")) || verilogs[0];
  if (!main) return null;
  const dir = main.path.includes("/") ? main.path.slice(0, main.path.lastIndexOf("/")) : "";
  const support = files.find((f) => f.path === (dir ? `${dir}/holoso_support.v` : "holoso_support.v"));
  const supportVh = files.find((f) => f.path === (dir ? `${dir}/holoso_support.vh` : "holoso_support.vh"));
  const top = main.path.slice(main.path.lastIndexOf("/") + 1).replace(/\.v$/, "");
  return { top, verilog: main.content, support: support?.content || "", supportVh: supportVh?.content || "" };
}
