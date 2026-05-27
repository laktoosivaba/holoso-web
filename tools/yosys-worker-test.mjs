// Integration test for the in-browser resource-estimation path, exercising the REAL worker helpers
// (closure.js + yosys-job.js) end to end in Node: synthesize demos via the wheel, load the *vendored*
// Kulibin RTL (the exact files the browser worker fetches), then read_verilog -> hierarchy -check ->
// synth[/_arch] -> write_json and histogram the netlist. Validates the write_json/cellHistogram contract
// (the spike only checks text `stat`) and that the vendored hdl/kulibin/ closure is complete.

import { runYosys } from "@yowasp/yosys";
import { loadPyodide } from "pyodide";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { closure } from "../closure.js";
import { synthScript, cellHistogram } from "../yosys-job.js";

const WEB = fileURLToPath(new URL("../", import.meta.url));
const WHEEL = WEB + "wheels/holoso-0.1.0-py3-none-any.whl";
const DRIVER = WEB + "driver.py";
const KULIBIN_DIR = WEB + "hdl/kulibin/";
const DEMOS = WEB + "demos";

// The demo corpus is static source files (demos/), listed by manifest.json -- same as the worker.
const loadDemos = () =>
  JSON.parse(readFileSync(`${DEMOS}/manifest.json`, "utf8")).map((d) => ({
    id: d.id,
    source: readFileSync(`${DEMOS}/${d.file}`, "utf8"),
  }));

const log = (...a) => process.stdout.write(a.join(" ") + "\n");
let failures = 0;
const check = (cond, msg) => {
  log(`${cond ? "  ok  " : " FAIL "} ${msg}`);
  if (!cond) failures++;
};

// Load Kulibin exactly as the worker does: from the vendored manifest under hdl/kulibin/.
const manifest = JSON.parse(readFileSync(KULIBIN_DIR + "manifest.json", "utf8"));
const kulibin = Object.fromEntries(manifest.map((n) => [n, readFileSync(KULIBIN_DIR + n, "utf8")]));
check(manifest.length >= 20, `vendored kulibin manifest has ${manifest.length} files`);

async function run(top, verilog, support, supportHeader, target) {
  const library = { "holoso_support.v": support, ...kulibin };
  const { files: libFiles } = closure(top, verilog, library);
  const files = { "holoso_support.vh": supportHeader, [`${top}.v`]: verilog, "job.ys": synthScript(top, libFiles, target) };
  for (const f of libFiles) files[f] = library[f];
  const out = await runYosys(["job.ys"], files, { stdout: () => {}, stderr: () => {}, decodeASCII: true });
  return cellHistogram(JSON.parse(out["netlist.json"]), top);
}

try {
  log("booting Pyodide + holoso …");
  const py = await loadPyodide();
  await py.loadPackage(["micropip", "numpy", "sympy"]);
  py.FS.writeFile("/holoso-0.1.0-py3-none-any.whl", readFileSync(WHEEL));
  await py.runPythonAsync(`import micropip; await micropip.install("emfs:/holoso-0.1.0-py3-none-any.whl", deps=False)`);
  py.runPython(readFileSync(DRIVER, "utf8"));
  log("yosys " + (await import("@yowasp/yosys")).version + "\n");

  const demos = loadDemos();
  const constProbe = { id: "const_probe", source: "def k(x):\n    return x * 2.5 + 1.0\n" };

  for (const d of [...demos, constProbe]) {
    py.globals.set("_s", d.source);
    const r = JSON.parse(py.runPython("synth_to_json(_s, 8, 24, '', '')"));
    if (!r.ok) { check(false, `${d.id}: synth failed (${r.error?.kind})`); continue; }
    check(typeof r.support_header === "string" && r.support_header.includes("HOLOSO_REGFILE"), `${d.id}: result carries support_header (.vh)`);
    const counts = await run(r.module_name, r.verilog, r.support, r.support_header, "generic");
    const total = counts && Object.values(counts).reduce((a, b) => a + b, 0);
    check(counts && total > 0, `${d.id}: generic netlist has cells (${total})`);
  }

  log("\n--- arch sweep on dot2 (write_json cell types) ---");
  py.globals.set("_s", demos.find((d) => d.id === "dot2").source);
  const dot2 = JSON.parse(py.runPython("synth_to_json(_s, 8, 24, '', '')"));
  for (const [target, dspRe] of [["ecp5", /MULT18X18D/], ["xilinx", /DSP48E1/], ["ice40", /SB_LUT4/]]) {
    const counts = await run(dot2.module_name, dot2.verilog, dot2.support, dot2.support_header, target);
    const keys = Object.keys(counts || {});
    check(keys.some((k) => dspRe.test(k)), `dot2/${target}: netlist has ${dspRe.source} (${keys.filter((k) => dspRe.test(k)).map((k) => k + "=" + counts[k]).join(",") || "MISSING"})`);
  }

  log(`\n=== ${failures ? failures + " FAILURE(S)" : "WORKER PATH OK"} ===`);
  process.exit(failures ? 1 : 0);
} catch (e) {
  log("FATAL:", (e.message || String(e)).split("\n").slice(0, 25).join("\n"));
  process.exit(1);
}
