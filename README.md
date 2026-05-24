# holoso-web

Browser UI for [holoso-synth](../holoso-synth): write a numeric Python kernel, get synthesizable Verilog — with the
**synthesis running entirely in your browser** via [Pyodide](https://pyodide.org) (CPython compiled to WASM).

## Why client-side

holoso-synth *executes* the user's Python during synthesis (partial evaluation: it runs `numpy`/`sympy`, `__init__`,
compile-time tables). That inverts the safety model of the sibling `holoso-circt` web UI, which never ran user code
(it parsed an AST in the browser and lowered it on a server). Running the synthesizer in Pyodide puts the user's code
in the browser's WASM sandbox: **no server-side execution, no RCE surface, static hosting**. numpy is a C-extension
that only Pyodide ships for WASM, so Pyodide is the only runtime that works here.

## Layout

| path | role |
|---|---|
| `index.html` | UI shell (editor, example/entry pickers, controls, output tabs, log) |
| `app.js` | UI controller; talks to the worker over `postMessage`. Never touches Python. |
| `worker.js` | Web Worker: boots the vendored Pyodide, installs the wheel, runs synthesis off the UI thread |
| `driver.py` | the synthesis logic (`synth_to_json`, `demos_to_json`), exec'd inside Pyodide. **Single source** shared by the worker and the Node test in `tools/`. |
| `tools/` | Node-Pyodide tooling: driver regression test (`driver_test.mjs`), Pyodide vendoring (`vendor-pyodide.mjs`) + its check (`vendor-check.mjs`) |
| `Makefile` | build orchestration (`dist`, `wheel`, `vendor`, `test`, `serve`) + deploy wrappers (`image`, `deploy`, `apply`) |
| `Dockerfile` · `deploy/` | container image (nginx serving `dist/`) and k8s manifest + nginx conf |
| `wheels/` · `pyodide/` · `dist/` | build artifacts — git-ignored, regenerated on demand (see below) |

**Demo kernels** are not stored here. They live inside the holoso wheel as `holoso.demos` (function-form kernels:
`dot2`, `madd`, `cube`, `poly3`, `blend`, `ekf_update`); the worker reads them via `importlib.resources` and the
picker is populated from that. Single source of truth, no duplication — the same kernels the test suite and CLI
examples use.

## Run locally

Requires `uv` (wheel build) and `node`/`npm` (Pyodide vendoring).

```bash
make wheel vendor      # one-time: build the holoso wheel from ../holoso-synth + vendor the pinned Pyodide runtime
make serve             # serve the working dir on http://127.0.0.1:8137  (use 127.0.0.1, not localhost)
```

Iterating on `index.html` / `app.js` / `worker.js` / `driver.py` needs no rebuild — just refresh. Re-run `make wheel`
after changing holoso-synth, `make vendor` after bumping the pinned Pyodide version (`tools/package.json`).

The first page load is ~19 MB (the vendored runtime + numpy + sympy + the wheel), served locally — **no CDN at
runtime**. `make vendor` fetches the pinned Pyodide release from jsDelivr once at build time into `pyodide/`.

## Test (headless)

```bash
make test    # driver regression (every demo synthesizes; error paths; entry selection)
             # + vendored-runtime check (boots Pyodide offline from pyodide/ and runs the driver)
```

## Build & deploy

`make dist` assembles a self-contained static site into `dist/` (static files + the holoso wheel + the vendored
Pyodide runtime) — host it with any plain file server.

Deployment mirrors holoso-circt: a container (nginx serving `dist/`) pushed to `registry.rofl.ee/holoso-web` and
rolled out on the cluster via [`act`](https://github.com/nektos/act).

```bash
make image     # act -> in-cluster buildkit -> push registry.rofl.ee/holoso-web:dev
make deploy    # act -> kubectl rollout restart deploy/holoso-web -n holoso
```

The k8s manifest (Deployment + Service + HTTPRoute) lives with the cluster config in
`~/Projects/net/talos-k8s/holoso-web.yaml`, not here — exposed at `holoso.rofl.ee` via the external Envoy gateway
(`gw-external`). `make deploy` only bounces the running pods to pick up a freshly pushed image.

Environment specifics stay out of the Makefile and the committed workflows — they live in `.actrc` (git-ignored): the
act runner image, the `IMAGE` / `BUILDKIT_HOST` (`buildkit.rofl.ee:443`) vars, and bind-mounts of the talos kubeconfig
(for `deploy`) and the rofl-ca buildkit client cert/key (for the mTLS buildx driver). act resolves the container
socket itself, and `build.yml`'s inputs (`tag`, `synth_ref`) self-default. The certs rotate out-of-band (a LaunchAgent
renews them via step-ca), so there's nothing to export — `make image` just works.

The image build checks out `Zubax/holoso` at `web-synth` (where `holoso.demos` lives) for the wheel source — push
holoso-synth there first. The Docker/act/k8s path runs against the cluster and is not exercised by `make test`.

## Status

**M2/M3 done.** Output tabs: generated `<module>.v` + `holoso_support.v` + the cocotb `test_<module>.py` (Ace) and
the interactive `<module>.html` report (sandboxed iframe), all downloadable. Errors map to inline editor annotations
(HolosoError *and* import-time crashes carry the offending line). Examples sourced from `holoso.demos`. Pyodide is
self-hosted; `make dist` + container deploy via act/k8s.

Deferred: richer testbench surfacing, gate-level numbers via yosys/YoWASP.
