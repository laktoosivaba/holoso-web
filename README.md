# holoso-web

Browser UI for [holoso-synth](../holoso-synth): write a numeric Python kernel, get synthesizable Verilog — with the
**synthesis running entirely in your browser** via [Pyodide](https://pyodide.org) (CPython compiled to WASM).

## Why client-side

holoso-synth *executes* the user's Python during synthesis (partial evaluation: it runs `numpy`/`sympy`,
`__init__`, compile-time tables). That inverts the safety model of the sibling `holoso-circt` web UI, which never
ran user code (it parsed an AST in the browser and lowered it on a server). Running the synthesizer in Pyodide puts
the user's code in the browser's WASM sandbox: **no server-side execution, no RCE surface, static hosting**. numpy is
a C-extension that only Pyodide ships for WASM, so Pyodide is the only runtime that works here — see the project
memory / design notes for the full rationale.

## Layout

| file | role |
|---|---|
| `index.html` | UI shell (editor, controls, output tabs, log) |
| `app.js` | UI controller; talks to the worker over `postMessage`. Never touches Python. |
| `worker.js` | Web Worker: boots Pyodide, installs the wheel, runs synthesis off the UI thread |
| `driver.py` | the synthesis logic (`synth_to_json`), exec'd inside Pyodide. **Single source** shared by the worker and the Node test in `spike/`. |
| `wheels/` | the holoso wheel, built from holoso-synth (git-ignored; build it, see below) |
| `spike/` | Node-Pyodide harness — M0 feasibility (`spike.mjs`) and the driver regression test (`driver_test.mjs`) |

## Run locally

```bash
# 1. build the holoso wheel from the sibling package
( cd ../holoso-synth && uv build --wheel )
mkdir -p wheels && cp ../holoso-synth/dist/holoso-*.whl wheels/

# 2. serve (workers + Pyodide need http://, not file://)
python3 -m http.server 8000
# open http://localhost:8000
```

First load pulls the Pyodide runtime + numpy + sympy (tens of MB) from the jsDelivr CDN; subsequent loads are cached
by the browser. Synthesis itself is fast.

## Test the driver (headless)

```bash
cd spike && npm install        # pulls the `pyodide` npm package
node driver_test.mjs           # runs synth_to_json over valid/error/multi-function cases
```

## Status

**M1 — UI shell.** Output: generated Verilog (`<module>.v`) + `holoso_support.v` tabs, with download. Errors map to
inline editor annotations. Deferred: report-HTML view, cocotb testbench tab, curated example picker, self-hosted
Pyodide, CI wheel build + static deploy, gate-level numbers via yosys/YoWASP.

> v0 of holoso-synth accepts a single straight-line scalar-float **function** (no classes/state/control-flow yet),
> so the example kernels here are function-form.
