"use strict";

const PYODIDE_DIR = new URL("pyodide/", location.href).href;
importScripts(PYODIDE_DIR + "pyodide.js");

const WHEEL_URL = "wheels/holoso-0.1.0-py3-none-any.whl";

let py = null;

const status = (msg) => postMessage({ type: "status", msg });

// Demo kernels are static source files shipped with the site (demos/), not part of the holoso wheel; the picker
// is built here so it never depends on the engine being up or on a synth-side demo package.
async function loadDemos() {
  const manifest = await (await fetch("demos/manifest.json")).json();
  // `extras` are sibling .py files (e.g. iir1_hpf needs iir1_lpf): each is fetched once and shipped with the demo;
  // the worker forwards them to the driver, which writes each into /user/<filename> before importing the main module.
  return Promise.all(
    manifest.map(async (d) => {
      const source = await (await fetch("demos/" + d.file)).text();
      const extraFiles = await Promise.all(
        (d.extras || []).map(async (name) => [name, await (await fetch("demos/" + name)).text()])
      );
      const extras = Object.fromEntries(extraFiles);
      return { id: d.id, label: d.label, source, extras };
    })
  );
}

async function init() {
  status("loading Pyodide runtime…");
  py = await loadPyodide({ indexURL: PYODIDE_DIR });
  status("loading numpy + scipy + sympy…");
  await py.loadPackage(["micropip", "numpy", "scipy", "sympy"]);

  status("installing holoso…");
  // cache: "reload" forces a network fetch, bypassing any stale HTTP-cache entry. The wheel keeps a fixed
  // filename across deploys, so a browser that once cached it as immutable would otherwise pin an old build.
  const bytes = new Uint8Array(await (await fetch(WHEEL_URL, { cache: "reload" })).arrayBuffer());
  const fname = WHEEL_URL.split("/").pop();
  py.FS.writeFile("/" + fname, bytes);
  // jaxtyping is a soft dep of upstream holoso examples (Float64[ndarray, "3"] annotations); it isn't in
  // pyodide-lock so we fetch it from PyPI via micropip after the wheel install.
  await py.runPythonAsync(
    `import micropip\n` +
      `await micropip.install("emfs:/${fname}", deps=False)\n` +
      `await micropip.install("jaxtyping")\n`
  );

  py.runPython(await (await fetch("driver.py")).text());
  const versions = py.runPython(
    "import holoso, sys, numpy, scipy, sympy, jaxtyping; " +
      "f'holoso {holoso.__version__} · CPython {sys.version.split()[0]} · numpy {numpy.__version__} · scipy {scipy.__version__} · sympy {sympy.__version__} · jaxtyping {jaxtyping.__version__}'"
  );
  const examples = await loadDemos();
  postMessage({ type: "ready", versions, examples });
}

function synth(req) {
  py.globals.set("_src", req.source);
  py.globals.set("_wexp", Number(req.wexp));
  py.globals.set("_wman", Number(req.wman));
  py.globals.set("_entry", req.entry || "");
  py.globals.set("_name", req.name || "");
  py.globals.set("_extras", req.extras ? JSON.stringify(req.extras) : "");
  const json = py.runPython("synth_to_json(_src, _wexp, _wman, _entry, _name, _extras)");
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
