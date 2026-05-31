// Integration test for the in-browser PnR path, exercising the REAL worker helpers (closure.js +
// yosys-job.js ecp5JsonScript/nextpnrArgs/summarizePnrReport) end to end in Node, against the *vendored*
// Kulibin RTL the browser worker fetches. Mirrors yosys-worker-test.mjs.
//
// Two contracts:
//   - a small kernel (dot2) places, routes, and yields a positive Fmax + non-empty utilization,
//   - a wide kernel (ekf_update) overflows the package's I/O pads -> nextpnr fails, and the failure log
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
  py.FS.writeFile("/holoso-0.1.0-py3-none-any.whl", readFileSync(WHEEL));
  await py.runPythonAsync(`import micropip; await micropip.install("emfs:/holoso-0.1.0-py3-none-any.whl", deps=False)`);
  py.runPython(readFileSync(DRIVER, "utf8"));
  log("yosys " + (await import("@yowasp/yosys")).version + " · nextpnr-ecp5 " + (await import("@yowasp/nextpnr-ecp5")).version + "\n");

  const demos = loadDemos();
  const synth = (id) => {
    const d = demos.find((x) => x.id === id);
    py.globals.set("_s", d.source);
    return JSON.parse(py.runPython("synth_to_json(_s, 8, 24, '', '')"));
  };

  // 1. small kernel routes and yields real timing/area.
  const dot2 = synth("dot2");
  check(dot2.ok, "dot2 synthesized");
  const r = await routeOnce(dot2.module_name, dot2.verilog, dot2.support);
  check(r.report != null, "dot2 produced a parseable PnR report");
  const fmax = r.report?.fmax?.[0]?.achieved;
  check(typeof fmax === "number" && fmax > 0, `dot2 Fmax reported (${fmax ? fmax.toFixed(1) + " MHz" : "MISSING"})`);
  check((r.report?.utilization?.length || 0) > 0, `dot2 utilization non-empty (${(r.report?.utilization || []).map((u) => u.type + "=" + u.used).join(",")})`);
  check(r.report?.criticalPath?.ns > 0, `dot2 critical path delay (${r.report?.criticalPath?.ns?.toFixed(2)} ns, ${r.report?.criticalPath?.segments} segs)`);

  // 2. wide kernel overflows I/O pads -> nextpnr fails, log names TRELLIS_IO.
  const ekf = synth("ekf_update");
  check(ekf.ok, "ekf_update synthesized");
  let threw = false, padOverflow = false;
  try {
    await routeOnce(ekf.module_name, ekf.verilog, ekf.support);
  } catch (e) {
    threw = true;
    padOverflow = /TRELLIS_IO/.test(e.log || "");
  }
  check(threw, "ekf_update PnR throws (does not silently succeed)");
  check(padOverflow, "ekf_update failure is pad overflow (log names TRELLIS_IO)");

  log(`\n=== ${failures ? failures + " FAILURE(S)" : "PnR PATH OK"} ===`);
  process.exit(failures ? 1 : 0);
} catch (e) {
  log("FATAL:", (e.message || String(e)).split("\n").slice(0, 25).join("\n"));
  process.exit(1);
}
