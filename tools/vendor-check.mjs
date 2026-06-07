import { loadPyodide } from "pyodide";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const VENDOR = fileURLToPath(new URL("../pyodide/", import.meta.url));
const WEB = fileURLToPath(new URL("../", import.meta.url));
const WHEEL = WEB + "wheels/holoso-0.1.0-py3-none-any.whl";
const EXTRA_WHEELS = WEB + "wheels";
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
  const wheels = ["holoso-0.1.0-py3-none-any.whl"];
  py.FS.writeFile("/" + wheels[0], readFileSync(WHEEL));
  for (const name of JSON.parse(readFileSync(`${EXTRA_WHEELS}/extra-manifest.json`, "utf8"))) {
    py.FS.writeFile("/" + name, readFileSync(`${EXTRA_WHEELS}/${name}`));
    wheels.push(name);
  }
  const installs = wheels.map((n) => `await micropip.install("emfs:/${n}", deps=False)`).join("\n");
  await py.runPythonAsync(`import micropip\n${installs}\n`);
  py.runPython(readFileSync(DRIVER, "utf8"));

  const v = py.runPython("import numpy, scipy, sympy, holoso; f'numpy {numpy.__version__} scipy {scipy.__version__} sympy {sympy.__version__}'");
  check(true, `runtime up · ${v}`);
  const demos = loadDemos();
  check(demos.length >= 5, `demos load (${demos.length})`);
  // Pick madd specifically: smallest stateless kernel, no extras, guaranteed to synthesize across upstream churn.
  const probe = demos.find((d) => d.id === "madd") || demos[0];
  py.globals.set("_s", probe.source);
  py.globals.set("_x", "{}");
  const r = JSON.parse(py.runPython("synth_to_json(_s, 8, 24, '', '', _x)"));
  check(r.ok === true, `synthesize ${probe.id} via vendored runtime (${r.ok ? r.metrics.steps + " steps" : r.error.kind})`);

  log(`\n=== ${failures ? failures + " FAILURE(S)" : "VENDORED RUNTIME OK"} ===`);
  process.exit(failures ? 1 : 0);
} catch (e) {
  log("FATAL:", (e.message || String(e)).split("\n").slice(0, 25).join("\n"));
  process.exit(1);
}
