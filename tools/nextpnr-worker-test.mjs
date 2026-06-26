// Integration test for the in-browser PnR path, exercising the REAL worker helpers (closure.js +
// yosys-job.js ecp5JsonScript/nextpnrArgs/summarizePnrReport) end to end in Node, against the self-contained
// holoso_support.{v,vh} from the synth result. Mirrors yosys-worker-test.mjs.
//
// Two contracts:
//   - a small kernel (madd) places, routes, and yields a positive Fmax + non-empty utilization,
//   - a wide kernel (ekf1_stateless) overflows the package's I/O pads -> nextpnr fails, and the failure log
//     names TRELLIS_IO (the pad-overflow case the worker turns into a friendly runtime error).
//
// Heavy (~170 MB nextpnr chipdb download + real place&route): run on demand, not from `make test`.

import { runYosys } from "@yowasp/yosys";
import { runNextpnrEcp5 } from "@yowasp/nextpnr-ecp5";
import { closure } from "../closure.js";
import { ecp5JsonScript, nextpnrArgs, summarizePnrReport } from "../yosys-job.js";
import { harness, loadDemos, bootHoloso, runScript, pickVerilog } from "./shared.mjs";

const { log, check, done } = harness();

// Mirror the worker's route(): synth_ecp5 -> design.json, then nextpnr-ecp5 -> report.json.
// Returns { report, log } on success; throws { message, log } on PnR failure (log carries nextpnr's stderr).
async function routeOnce(top, verilog, support, supportVh) {
  const library = { "holoso_support.v": support };
  const { files: libFiles } = closure(top, verilog, library);
  const files = { [`${top}.v`]: verilog, "job.ys": ecp5JsonScript(top, libFiles) };
  if (supportVh) files["holoso_support.vh"] = supportVh;
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
  const py = await bootHoloso();
  log("yosys " + (await import("@yowasp/yosys")).version + " · nextpnr-ecp5 " + (await import("@yowasp/nextpnr-ecp5")).version + "\n");

  const demos = loadDemos();
  const runDemo = (id) => {
    const d = demos.find((x) => x.id === id);
    return runScript(py, d.filename, d.source, d.extras);
  };

  // 1. small kernel routes and yields real timing/area.
  const maddRun = runDemo("madd");
  check(maddRun.ok, "madd ran");
  const madd = pickVerilog(maddRun.files);
  check(madd != null, "madd emitted a .v");
  const r = await routeOnce(madd.top, madd.verilog, madd.support, madd.supportVh);
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
    await routeOnce(ekf.top, ekf.verilog, ekf.support, ekf.supportVh);
  } catch (e) {
    threw = true;
    padOverflow = /TRELLIS_IO/.test(e.log || "");
  }
  check(threw, "ekf1_stateless PnR throws (does not silently succeed)");
  check(padOverflow, "ekf1_stateless failure is pad overflow (log names TRELLIS_IO)");

  done("PnR PATH OK");
} catch (e) {
  log("FATAL:", (e.message || String(e)).split("\n").slice(0, 25).join("\n"));
  process.exit(1);
}
