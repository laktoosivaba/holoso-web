import { loadPyodide } from "pyodide";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SYNTH = process.env.SYNTH || ROOT + "../holoso-synth";
const WHEEL = SYNTH + "/dist/holoso-0.1.0-py3-none-any.whl";
const DRIVER = ROOT + "driver.py";
const DEMOS = ROOT + "demos";

// Mirror the worker: the demo corpus is static source files listed by demos/manifest.json -- not the wheel.
function loadDemos() {
  return JSON.parse(readFileSync(`${DEMOS}/manifest.json`, "utf8")).map((d) => ({
    id: d.id,
    label: d.label,
    source: readFileSync(`${DEMOS}/${d.file}`, "utf8"),
  }));
}

const log = (...a) => process.stdout.write(a.join(" ") + "\n");
let failures = 0;
function check(cond, msg) {
  log(`${cond ? "  ok  " : " FAIL "} ${msg}`);
  if (!cond) failures++;
}

function synth(py, src, wexp, wman, entry, name) {
  py.globals.set("_src", src);
  py.globals.set("_entry", entry);
  py.globals.set("_name", name);
  return JSON.parse(py.runPython(`synth_to_json(_src, ${wexp}, ${wman}, _entry, _name)`));
}

try {
  const py = await loadPyodide();
  await py.loadPackage(["micropip", "numpy", "scipy", "sympy", "pytest", "jaxtyping"]);
  py.FS.writeFile("/holoso-0.1.0-py3-none-any.whl", readFileSync(WHEEL));
  await py.runPythonAsync(`import micropip; await micropip.install("emfs:/holoso-0.1.0-py3-none-any.whl", deps=False)`);
  py.runPython(readFileSync(DRIVER, "utf8"));

  log("\n=== demo kernels load + synthesize ===");
  const demos = loadDemos();
  check(demos.length >= 5, `loaded ${demos.length} demo kernels`);
  for (const d of demos) {
    check(typeof d.id === "string" && typeof d.label === "string" && d.source.includes("def "), `demo ${d.id}: shape`);
    const r = synth(py, d.source, 8, 24, "", "");
    check(r.ok === true, `demo ${d.id}: synthesizes (${r.ok ? r.metrics.steps + " steps" : r.error.kind})`);
  }

  log("\n=== error paths ===");
  const ifSrc = "def bad(a, b):\n    if a > b:\n        return a\n    return b\n";
  let r = synth(py, ifSrc, 8, 24, "", "");
  check(r.ok === false, `unsupported 'if' rejected (kind=${r.error?.kind})`);

  const raiseSrc = "raise ValueError('boom at import')\n\ndef f(a):\n    return a\n";
  r = synth(py, raiseSrc, 8, 24, "", "");
  check(r.ok === false && r.error.kind === "ImportError", `import-time raise -> ImportError (kind=${r.error?.kind})`);
  check(r.error.location?.lineno === 1, `import error annotates line 1 (got ${JSON.stringify(r.error.location)})`);

  log("\n=== entry selection ===");
  const multi = "def poly(x):\n    return x * x + x\n\ndef gain(x, k):\n    return x * k\n";
  r = synth(py, multi, 8, 24, "", "");
  check(r.ok && r.target === "gain", `default entry = last function (${r.target})`);
  r = synth(py, multi, 8, 24, "poly", "");
  check(r.ok && r.target === "poly", `explicit entry=poly honored (${r.target})`);
  r = synth(py, multi, 8, 24, "nope", "");
  check(r.ok === false && r.error.kind === "BadEntry", `unknown entry -> BadEntry (kind=${r.error?.kind})`);

  log(`\n=== ${failures ? failures + " FAILURE(S)" : "ALL CHECKS PASSED"} ===`);
  process.exit(failures ? 1 : 0);
} catch (e) {
  log("FATAL:", (e.message || String(e)).split("\n").slice(0, 25).join("\n"));
  process.exit(1);
}
