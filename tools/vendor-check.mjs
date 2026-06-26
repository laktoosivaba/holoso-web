// Offline self-host check: boot Pyodide from the VENDORED pyodide/ dir (not the npm package's CDN), install
// the vendored holoso + extra wheels, and run a demo through driver.py — proving `make dist` ships a runtime
// that works with nothing fetched at load time.

import { VENDORED_PYODIDE, harness, loadDemos, bootHoloso, runScript } from "./shared.mjs";

const { log, check, done } = harness();

try {
  log(`booting Pyodide from vendored dir: ${VENDORED_PYODIDE}`);
  const py = await bootHoloso({ indexURL: VENDORED_PYODIDE });

  const v = py.runPython("import numpy, scipy, sympy, holoso; f'numpy {numpy.__version__} scipy {scipy.__version__} sympy {sympy.__version__}'");
  check(true, `runtime up · ${v}`);

  const demos = loadDemos();
  check(demos.length >= 5, `demos load (${demos.length})`);
  // Pick madd: smallest kernel with its own main() that synthesizes + writes to build/madd/, stable across upstream churn.
  const probe = demos.find((d) => d.id === "madd") || demos[0];
  const r = runScript(py, probe.filename, probe.source, probe.extras);
  const stem = probe.filename.replace(/\.py$/, "");
  const haveVerilog = r.ok && r.files.some((f) => f.ext === "v" && f.path.startsWith(`build/${stem}/`));
  check(haveVerilog, `run ${probe.id} via vendored runtime (${r.ok ? r.files.length + " files" : r.error?.kind})`);

  done("VENDORED RUNTIME OK");
} catch (e) {
  log("FATAL:", (e.message || String(e)).split("\n").slice(0, 25).join("\n"));
  process.exit(1);
}
