// Integration test for the in-browser PnR path, exercising the REAL worker helpers (closure.js +
// yosys-job.js ecp5JsonScript/nextpnrArgs/summarizePnrReport) end to end in Node, against the *vendored*
// Kulibin RTL the browser worker fetches. Mirrors yosys-worker-test.mjs.
//
// Two contracts:
//   - a small kernel (madd) places, routes, and yields a positive Fmax + non-empty utilization,
//   - a wide kernel (ekf1_stateless) overflows the package's I/O pads -> nextpnr fails, and the failure log
//     names TRELLIS_IO (the pad-overflow case the worker turns into a friendly runtime error).
//
// Heavy (~170 MB nextpnr chipdb download + real place&route): run on demand, not from `make test`.

import { runYosys } from "@yowasp/yosys";
import { runNextpnrEcp5 } from "@yowasp/nextpnr-ecp5";
import { loadPyodide } from "pyodide";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { closure } from "../closure.js";
import { ecp5JsonScript, nextpnrArgs, summarizePnrReport } from "../yosys-job.js";

const WEB = fileURLToPath(new URL("../", import.meta.url));
const WHEEL = WEB + "wheels/holoso-0.1.0-py3-none-any.whl";
const EXTRA_WHEELS = WEB + "wheels";
const DRIVER = WEB + "driver.py";
const KULIBIN_DIR = WEB + "hdl/kulibin/";
const DEMOS = WEB + "demos";

// The demo corpus is static source files (demos/), listed by manifest.json -- same as the worker.
const loadDemos = () =>
  JSON.parse(readFileSync(`${DEMOS}/manifest.json`, "utf8")).map((d) => ({
    id: d.id,
    filename: d.file,
    source: readFileSync(`${DEMOS}/${d.file}`, "utf8"),
    extras: Object.fromEntries((d.extras || []).map((n) => [n, readFileSync(`${DEMOS}/${n}`, "utf8")])),
  }));

// Mirror app.js deriveRouteInputs: from the run_script result, return {top, verilog, support} for the
// first non-support .v emitted, with sibling holoso_support.v from the same directory.
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

const manifest = JSON.parse(readFileSync(KULIBIN_DIR + "manifest.json", "utf8"));
const kulibin = Object.fromEntries(manifest.map((n) => [n, readFileSync(KULIBIN_DIR + n, "utf8")]));

// Mirror the worker's route(): synth_ecp5 -> design.json, then nextpnr-ecp5 -> report.json.
// Returns { report, log } on success; throws { message, log } on PnR failure (log carries nextpnr's stderr).
async function routeOnce(top, verilog, support) {
  const library = { "holoso_support.v": support, ...kulibin };
  const { files: libFiles } = closure(top, verilog, library);
  const files = { [`${top}.v`]: verilog, "job.ys": ecp5JsonScript(top, libFiles) };
  for (const f of libFiles) files[f] = library[f];

  const synthOut = await runYosys(["job.ys"], files, { stdout: () => {}, stderr: () => {}, decodeASCII: true });
  const designJson = synthOut["design.json"];
  if (!designJson) throw Object.assign(new Error("no design.json"), { log: "" });

  let pnrLog = "";
  const sink = (b) => { if (b) pnrLog += typeof b === "string" ? b : Buffer.from(b).toString("utf8"); };
  try {
    const pnrOut = await runNextpnrEcp5(nextpnrArgs(), { "design.json": designJson }, { stdout: sink, stderr: sink, decodeASCII: true });
    return { report: summarizePnrReport(pnrOut["report.json"]), log: pnrLog };
  } catch (e) {
    throw Object.assign(new Error(e?.message || String(e)), { log: pnrLog });
  }
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
  log("yosys " + (await import("@yowasp/yosys")).version + " · nextpnr-ecp5 " + (await import("@yowasp/nextpnr-ecp5")).version + "\n");

  const demos = loadDemos();
  const runDemo = (id) => {
    const d = demos.find((x) => x.id === id);
    py.globals.set("_f", d.filename);
    py.globals.set("_s", d.source);
    py.globals.set("_x", JSON.stringify(d.extras || {}));
    return JSON.parse(py.runPython("run_script(_f, _s, _x)"));
  };

  // 1. small kernel routes and yields real timing/area.
  const maddRun = runDemo("madd");
  check(maddRun.ok, "madd ran");
  const madd = pickVerilog(maddRun.files);
  check(madd != null, "madd emitted a .v");
  const r = await routeOnce(madd.top, madd.verilog, madd.support);
  check(r.report != null, "madd produced a parseable PnR report");
  const fmax = r.report?.fmax?.[0]?.achieved;
  check(typeof fmax === "number" && fmax > 0, `madd Fmax reported (${fmax ? fmax.toFixed(1) + " MHz" : "MISSING"})`);
  check((r.report?.utilization?.length || 0) > 0, `madd utilization non-empty (${(r.report?.utilization || []).map((u) => u.type + "=" + u.used).join(",")})`);
  check(r.report?.criticalPath?.ns > 0, `madd critical path delay (${r.report?.criticalPath?.ns?.toFixed(2)} ns, ${r.report?.criticalPath?.segments} segs)`);

  // 2. wide kernel overflows I/O pads -> nextpnr fails, log names TRELLIS_IO.
  const ekfRun = runDemo("ekf1_stateless");
  check(ekfRun.ok, "ekf1_stateless ran");
  const ekf = pickVerilog(ekfRun.files);
  check(ekf != null, "ekf1_stateless emitted a .v");
  let threw = false, padOverflow = false;
  try {
    await routeOnce(ekf.top, ekf.verilog, ekf.support);
  } catch (e) {
    threw = true;
    padOverflow = /TRELLIS_IO/.test(e.log || "");
  }
  check(threw, "ekf1_stateless PnR throws (does not silently succeed)");
  check(padOverflow, "ekf1_stateless failure is pad overflow (log names TRELLIS_IO)");

  log(`\n=== ${failures ? failures + " FAILURE(S)" : "PnR PATH OK"} ===`);
  process.exit(failures ? 1 : 0);
} catch (e) {
  log("FATAL:", (e.message || String(e)).split("\n").slice(0, 25).join("\n"));
  process.exit(1);
}
