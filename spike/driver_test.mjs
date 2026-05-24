// Exercise driver.py (the shared synth logic) in Node-Pyodide, the same way worker.js will in the browser.
import { loadPyodide } from "pyodide";
import { readFileSync } from "node:fs";

const ROOT = "/Users/andrey/Projects/rust/holoso";
const WHEEL = ROOT + "/holoso-synth/dist/holoso-0.1.0-py3-none-any.whl";
const DRIVER = ROOT + "/holoso-web/driver.py";

const log = (...a) => process.stdout.write(a.join(" ") + "\n");

function synth(py, src, wexp, wman, entry, name) {
  py.globals.set("_src", src);
  py.globals.set("_entry", entry);
  py.globals.set("_name", name);
  return py.runPython(`synth_to_json(_src, ${wexp}, ${wman}, _entry, _name)`);
}

function show(py, title, src, wexp, wman, entry, name) {
  log("\n=== " + title + " ===");
  let r;
  try {
    r = JSON.parse(synth(py, src, wexp, wman, entry, name));
  } catch (e) {
    log("THREW:", (e.message || String(e)).split("\n").slice(0, 20).join("\n"));
    return;
  }
  if (r.ok) {
    log(`ok target=${r.target} module=${r.module_name} verilog=${r.verilog.split("\n").length}L`);
    log("targets:", JSON.stringify(r.targets), "metrics:", JSON.stringify(r.metrics));
  } else {
    log(`NOT ok kind=${r.error.kind} targets=${JSON.stringify(r.targets ?? null)}`);
    log("message:", (r.error.message || "").split("\n").slice(-2).join(" / "));
    if (r.error.location) log("location:", JSON.stringify(r.error.location));
  }
}

try {
  const py = await loadPyodide();
  await py.loadPackage(["micropip", "numpy", "sympy"]);
  // micropip parses name/version/tags from the wheel filename -- keep the canonical PEP 427 name.
  py.FS.writeFile("/holoso-0.1.0-py3-none-any.whl", readFileSync(WHEEL));
  await py.runPythonAsync(`import micropip; await micropip.install("emfs:/holoso-0.1.0-py3-none-any.whl", deps=False)`);
  py.runPython(readFileSync(DRIVER, "utf8"));
  log("driver loaded; defined:", py.runPython("'synth_to_json' in dir()"));

  show(py, "valid dot2", "def dot2(a, b, c, d):\n    return a * b + c * d\n", 8, 24, "", "");
  show(py, "unsupported (if)", "def bad(a, b):\n    if a > b:\n        return a\n    return b\n", 8, 24, "", "");
  const multi = "def poly(x):\n    return x * x + x\n\ndef gain(x, k):\n    return x * k\n";
  show(py, "multi default entry", multi, 8, 24, "", "");
  show(py, "multi entry=poly", multi, 8, 24, "poly", "");
  show(py, "multi bad entry", multi, 8, 24, "nope", "");
  log("\n=== DRIVER TEST DONE ===");
} catch (e) {
  log("FATAL:", (e.message || String(e)).split("\n").slice(0, 25).join("\n"));
  process.exit(1);
}
