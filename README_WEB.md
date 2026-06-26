# Holoso — Python → Verilog, in your browser

**Holoso** turns a plain numeric Python function into synthesizable Verilog. This page runs the whole
synthesizer **in your browser** — CPython compiled to WebAssembly via [Pyodide](https://pyodide.org).
Nothing is installed and nothing is uploaded: your code never leaves the tab, and once the page has
loaded it keeps working offline.

This is the web front-end for the [Holoso](https://github.com/Zubax/holoso) high-level-synthesis engine
(also on [PyPI](https://pypi.org/project/holoso/)) — the site behind
[holoso.digital](https://holoso.digital).

## Quick start

1. **Pick a demo** from the file list on the left of the **Python input** tab — or just keep the one
   that loads by default.
2. Press **Run** (the green button, top-right). Your Python executes in a sandboxed CPython and Holoso
   emits Verilog plus a self-contained `holoso_support.{v,vh}` support library.
3. Open the **Output** tab to browse the generated files. Click a file to preview it; **Download** one,
   or **Bundle** them all into a single `.tar.gz`.
4. Open the **Resources** tab to size the design: **Estimate** runs [Yosys](https://yosyshq.net/yosys/)
   for a gate/cell count on a generic or FPGA target, and **Route** runs
   [nextpnr](https://github.com/YosysHQ/nextpnr) place-and-route on a Lattice ECP5 for a real,
   post-route Fmax.

The log strip along the bottom shows progress, your `print()` output, and any errors — with the
offending line highlighted in the editor.

## Writing your own kernel

Start from a demo and edit it in place. A kernel is ordinary numeric Python: a function over
floats and arrays, plus a `main()` that picks the operators, synthesizes, and writes the result.
The smallest useful shape:

```python
from pathlib import Path
import holoso

def scale(x, gain, offset):
    return x * gain + offset

def main():
    fmt = holoso.FloatFormat(wexp=6, wman=18)
    ops = holoso.OpConfig(
        holoso.FAddOperator(fmt),
        holoso.FMulOperator(fmt),
        holoso.FDivOperator(fmt),
        holoso.FMulILog2OperatorFamily(fmt),
        holoso.FCmpOperator(fmt),
    )
    out = Path(__file__).resolve().parent / "build" / Path(__file__).stem
    result = holoso.synthesize(scale, ops=ops)
    for name, path in result.write(out).items():
        print(f"{name}: {path}")

if __name__ == "__main__":
    main()
```

Press **Run**, and whatever `result.write(...)` produced shows up in the Output tree. The kernel
language is a strict subset of Python; for which constructs are supported and how the type annotations
map to hardware, see the [Holoso documentation](https://github.com/Zubax/holoso).

Need a helper module? A kernel can import a sibling file — the demos that do (an IIR high-pass that
imports its low-pass core, a stateful EKF that imports its stateless step) ship the extra file
alongside, and it is placed next to your script before it runs.

## The FPGA flow (Estimate & Route)

Each tool runs as its own WebAssembly module, fetched **lazily** the first time you use it — so it is
never on the page's critical path — and cached by the browser afterwards:

- **Estimate** (~50 MB of Yosys on first use) synthesizes the selected `.v` and reports a cell-type
  histogram for a generic-gate, Lattice ECP5, Xilinx 7-series, or Lattice iCE40 target.
- **Route** (~170 MB of ECP5 chip database on first use) places and routes on a Lattice ECP5 and
  reports the achieved Fmax, post-route utilization, and critical path.

Route works on the raw kernel, which Holoso exposes with **every operand and result as a top-level
port**. That makes the design I/O-pad-bound: a kernel wider than the package has pads surfaces a
place-and-route error rather than a number — choose a larger package (or device) and try again.

## Privacy & offline use

Everything — the Python interpreter, the synthesizer, Yosys, and nextpnr — runs locally in your
browser. No code and no result is ever sent to a server. After the first load the page works fully
offline.
