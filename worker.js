// Web Worker: boots Pyodide, installs the holoso wheel, and runs synthesis off the UI thread.
//
// The synthesis logic itself lives in driver.py (fetched and exec'd once here) -- the SAME file the Node harness in
// spike/ exercises, so the browser path and the regression test share one source of truth. This worker is just the
// transport: bootstrap, then marshal {source, wexp, wman, entry, name} in and a JSON envelope out.
//
// The user's Python runs inside Pyodide's WASM sandbox; nothing executes on a server. See README.

"use strict";

const PYODIDE_VERSION = "0.29.4";
importScripts(`https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/pyodide.js`);

// Built from holoso-synth (`uv build --wheel`), served alongside this worker. micropip parses name/version/tags from
// the filename, so it must keep the canonical PEP 427 name.
const WHEEL_URL = "wheels/holoso-0.1.0-py3-none-any.whl";

let py = null;

const status = (msg) => postMessage({ type: "status", msg });

async function init() {
  status("loading Pyodide runtime…");
  py = await loadPyodide();
  status("loading numpy + sympy…");
  await py.loadPackage(["micropip", "numpy", "sympy"]);

  status("installing holoso…");
  const bytes = new Uint8Array(await (await fetch(WHEEL_URL)).arrayBuffer());
  const fname = WHEEL_URL.split("/").pop();
  py.FS.writeFile("/" + fname, bytes);
  // deps=False: numpy/sympy already loaded as Pyodide-native wheels; skip micropip's resolver (and its
  // Requires-Python>=3.14 gate, which Pyodide's 3.13 would otherwise trip).
  await py.runPythonAsync(`import micropip; await micropip.install("emfs:/${fname}", deps=False)`);

  py.runPython(await (await fetch("driver.py")).text());
  const versions = py.runPython(
    "import holoso, sys, numpy, sympy; " +
      "f'holoso {holoso.__version__} · CPython {sys.version.split()[0]} · numpy {numpy.__version__} · sympy {sympy.__version__}'"
  );
  postMessage({ type: "ready", versions });
}

function synth(req) {
  py.globals.set("_src", req.source);
  py.globals.set("_wexp", Number(req.wexp));
  py.globals.set("_wman", Number(req.wman));
  py.globals.set("_entry", req.entry || "");
  py.globals.set("_name", req.name || "");
  const json = py.runPython("synth_to_json(_src, _wexp, _wman, _entry, _name)");
  postMessage({ type: "result", id: req.id, json });
}

onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "init") await init();
    else if (m.type === "synth") synth(m);
  } catch (err) {
    const message = String((err && err.message) || err);
    if (m.type === "init") postMessage({ type: "fatal", msg: message });
    else postMessage({ type: "result", id: m.id, json: JSON.stringify({ ok: false, error: { kind: "WorkerError", message } }) });
  }
};
