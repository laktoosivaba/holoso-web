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
const EXTRA_WHEELS = WEB + "wheels";
const DRIVER = WEB + "driver.py";
const KULIBIN_DIR = WEB + "hdl/kulibin/";
const DEMOS = WEB + "demos";

// The demo corpus is static source files (demos/), listed by manifest.json -- same as the worker.
// Sibling `extras` are read alongside so cross-file demos (ekf1_stateful imports ekf1_stateless) resolve.
const loadDemos = () =>
  JSON.parse(readFileSync(`${DEMOS}/manifest.json`, "utf8")).map((d) => ({
    id: d.id,
    filename: d.file,
    source: readFileSync(`${DEMOS}/${d.file}`, "utf8"),
    extras: Object.fromEntries((d.extras || []).map((n) => [n, readFileSync(`${DEMOS}/${n}`, "utf8")])),
  }));

// Pull the synthesizable .v + sibling holoso_support.v out of a run_script result, mirroring the app's
// deriveRouteInputs: skip the support file when picking the top module, then find support in the same dir.
function pickVerilog(files) {
  const verilogs = files.filter((f) => f.ext === "v");
  const main = verilogs.find((f) => !f.path.endsWith("holoso_support.v")) || verilogs[0];
  if (!main) return null;
  const dir = main.path.includes("/") ? main.path.slice(0, main.path.lastIndexOf("/")) : "";
  const supportPath = dir ? `${dir}/holoso_support.v` : "holoso_support.v";
  const support = files.find((f) => f.path === supportPath);
  const top = main.path.slice(main.path.lastIndexOf("/") + 1).replace(/\.v$/, "");
  return { top, verilog: main.content, support: support?.content || "" };
}

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

async function run(top, verilog, support, target) {
  const library = { "holoso_support.v": support, ...kulibin };
  const { files: libFiles } = closure(top, verilog, library);
  const files = { [`${top}.v`]: verilog, "job.ys": synthScript(top, libFiles, target) };
  for (const f of libFiles) files[f] = library[f];
  const out = await runYosys(["job.ys"], files, { stdout: () => {}, stderr: () => {}, decodeASCII: true });
  return cellHistogram(JSON.parse(out["netlist.json"]), top);
}

try {
  log("booting Pyodide + holoso …");
  const py = await loadPyodide();
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
  log("yosys " + (await import("@yowasp/yosys")).version + "\n");

  const demos = loadDemos();
  // Upstream demos that define a kernel but ship no main() -- run_script succeeds but emits no files,
  // so there is no yosys-side contract to check here. Skip rather than count as a failure.
  const NO_MAIN = new Set(["iir1_lpf", "iir1_hpf", "finite_set_current_controller"]);

  const exec = (filename, source, extras) => {
    py.globals.set("_f", filename);
    py.globals.set("_s", source);
    py.globals.set("_x", JSON.stringify(extras || {}));
    return JSON.parse(py.runPython("run_script(_f, _s, _x)"));
  };

  for (const d of demos) {
    if (NO_MAIN.has(d.id)) { log(`  skip ${d.id}: kernel-only, no main() to run`); continue; }
    const r = exec(d.filename, d.source, d.extras);
    if (!r.ok) { check(false, `${d.id}: script failed (${r.error?.kind})`); continue; }
    const v = pickVerilog(r.files);
    if (!v) { check(false, `${d.id}: no .v emitted (${r.files.map((f) => f.path).join(", ") || "no files"})`); continue; }
    check(v.support.includes("holoso_fadd"), `${d.id}: sibling holoso_support.v co-emitted`);
    const counts = await run(v.top, v.verilog, v.support, "generic");
    const total = counts && Object.values(counts).reduce((a, b) => a + b, 0);
    check(counts && total > 0, `${d.id}: generic netlist has cells (${total})`);
  }

  // Arch sweep uses madd: smallest stateless kernel with its own main(), stable across upstream churn.
  log("\n--- arch sweep on madd (write_json cell types) ---");
  const maddDemo = demos.find((d) => d.id === "madd");
  const maddRun = exec(maddDemo.filename, maddDemo.source, maddDemo.extras);
  const maddV = pickVerilog(maddRun.files);
  if (!maddV) {
    check(false, `madd produced no .v (${maddRun.error?.kind || maddRun.files.map((f) => f.path).join(", ")})`);
  } else {
    for (const [target, dspRe] of [["ecp5", /MULT18X18D/], ["xilinx", /DSP48E1/], ["ice40", /SB_LUT4/]]) {
      const counts = await run(maddV.top, maddV.verilog, maddV.support, target);
      const keys = Object.keys(counts || {});
      check(keys.some((k) => dspRe.test(k)), `madd/${target}: netlist has ${dspRe.source} (${keys.filter((k) => dspRe.test(k)).map((k) => k + "=" + counts[k]).join(",") || "MISSING"})`);
    }
  }

  log(`\n=== ${failures ? failures + " FAILURE(S)" : "WORKER PATH OK"} ===`);
  process.exit(failures ? 1 : 0);
} catch (e) {
  log("FATAL:", (e.message || String(e)).split("\n").slice(0, 25).join("\n"));
  process.exit(1);
}
