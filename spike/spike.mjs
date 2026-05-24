// M0 de-risk spike: can Pyodide (CPython-on-WASM) install the holoso wheel and
// actually synthesize a kernel? Probes the two known risks:
//   1. wheel METADATA says `Requires-Python: >=3.14`, Pyodide ships 3.13.x
//   2. numpy~=2.4 / sympy~=1.14 vs whatever Pyodide pins
// Runs headless in Node; the browser path is identical (loadPyodide in a worker).

import { loadPyodide } from "pyodide";
import { readFileSync } from "node:fs";

const WHEEL = "/Users/andrey/Projects/rust/holoso/holoso-synth/dist/holoso-0.1.0-py3-none-any.whl";

const KERNEL = `
def dot2(a, b, c, d):
    ab = a * b
    cd = c * d
    return ab + cd
`;

function banner(s) { console.log("\n=== " + s + " ==="); }

const py = await loadPyodide();
banner("runtime");
console.log("python:", py.runPython("import sys; sys.version"));

banner("loadPackage numpy, sympy, micropip");
const t0 = Date.now();
await py.loadPackage(["micropip", "numpy", "sympy"]);
console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log("numpy:", py.runPython("import numpy; numpy.__version__"));
console.log("sympy:", py.runPython("import sympy; sympy.__version__"));

// Put the wheel on the Pyodide FS so both install paths can reach it.
py.FS.writeFile("/holoso-0.1.0-py3-none-any.whl", readFileSync(WHEEL));

banner("attempt 1: micropip.install (expect requires-python failure)");
let micropipOk = false;
try {
  await py.runPythonAsync(`
import micropip
await micropip.install("emfs:/holoso-0.1.0-py3-none-any.whl", deps=False)
`);
  micropipOk = true;
  console.log("micropip.install: OK");
} catch (e) {
  console.log("micropip.install FAILED:\n", String(e).split("\n").slice(0, 6).join("\n"));
}

if (!micropipOk) {
  banner("attempt 2: manual unzip into site-packages (bypasses requires-python)");
  py.runPython(`
import zipfile, sysconfig, sys, importlib
sp = sysconfig.get_paths()["purelib"]
with zipfile.ZipFile("/holoso-0.1.0-py3-none-any.whl") as z:
    z.extractall(sp)
importlib.invalidate_caches()
print("extracted into", sp)
`);
}

// (packaging bug fixed in holoso-synth: hdl/ now lives inside the package and
// is read via importlib.resources, so the wheel is self-contained — no injection)

banner("import holoso + synthesize");
const out = await py.runPythonAsync(`
import sys, pathlib, importlib, json, traceback
import holoso
from holoso import synthesize, FloatFormat

# write the user kernel to a real file so inspect.getsource works under exec
pathlib.Path("/user").mkdir(exist_ok=True)
pathlib.Path("/user/k0.py").write_text(${JSON.stringify(KERNEL)})
if "/user" not in sys.path:
    sys.path.insert(0, "/user")
import k0
importlib.reload(k0)

try:
    res = synthesize(k0.dot2, float_format=FloatFormat(wexp=8, wman=24))
except Exception:
    print("PYTHON TRACEBACK >>>")
    traceback.print_exc()
    print("<<< PYTHON TRACEBACK")
    raise SystemExit("synthesize failed")

json.dumps({
    "holoso_version": holoso.__version__,
    "module_name": res.module_name,
    "verilog_lines": len(res.verilog.splitlines()),
    "support_lines": len(res.support.splitlines()),
    "testbench_lines": len(res.testbench.splitlines()),
    "report_html_bytes": len(res.report_html),
    "verilog_head": "\\n".join(res.verilog.splitlines()[:18]),
})
`);
banner("RESULT");
const r = JSON.parse(out);
console.log("holoso:", r.holoso_version, "| module:", r.module_name);
console.log(`verilog ${r.verilog_lines} lines | support ${r.support_lines} | testbench ${r.testbench_lines} | report ${r.report_html_bytes} B`);
banner("verilog head");
console.log(r.verilog_head);
banner("SPIKE OK");
