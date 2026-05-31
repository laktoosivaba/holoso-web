import { loadPyodide } from "pyodide";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const VENDOR = fileURLToPath(new URL("../pyodide/", import.meta.url));
const WEB = fileURLToPath(new URL("../", import.meta.url));
const WHEEL = WEB + "wheels/holoso-0.1.0-py3-none-any.whl";
const DRIVER = WEB + "driver.py";
const DEMOS = WEB + "demos";

function loadDemos() {
  return JSON.parse(readFileSync(`${DEMOS}/manifest.json`, "utf8")).map((d) => ({
    id: d.id,
    source: readFileSync(`${DEMOS}/${d.file}`, "utf8"),
  }));
}

const log = (...a) => process.stdout.write(a.join(" ") + "\n");
let failures = 0;
const check = (cond, msg) => {
  log(`${cond ? "  ok  " : " FAIL "} ${msg}`);
  if (!cond) failures++;
};

try {
  log(`booting Pyodide from vendored dir: ${VENDOR}`);
  const py = await loadPyodide({ indexURL: VENDOR });
  await py.loadPackage(["micropip", "numpy", "scipy", "sympy"]);
  py.FS.writeFile("/holoso-0.1.0-py3-none-any.whl", readFileSync(WHEEL));
  await py.runPythonAsync(`import micropip; await micropip.install("emfs:/holoso-0.1.0-py3-none-any.whl", deps=False)`);
  py.runPython(readFileSync(DRIVER, "utf8"));

  const v = py.runPython("import numpy, scipy, sympy, holoso; f'numpy {numpy.__version__} scipy {scipy.__version__} sympy {sympy.__version__}'");
  check(true, `runtime up · ${v}`);
  const demos = loadDemos();
  check(demos.length >= 5, `demos load (${demos.length})`);
  py.globals.set("_s", demos[0].source);
  const r = JSON.parse(py.runPython("synth_to_json(_s, 8, 24, '', '')"));
  check(r.ok === true, `synthesize ${demos[0].id} via vendored runtime (${r.ok ? r.metrics.steps + " steps" : r.error.kind})`);

  log(`\n=== ${failures ? failures + " FAILURE(S)" : "VENDORED RUNTIME OK"} ===`);
  process.exit(failures ? 1 : 0);
} catch (e) {
  log("FATAL:", (e.message || String(e)).split("\n").slice(0, 25).join("\n"));
  process.exit(1);
}
