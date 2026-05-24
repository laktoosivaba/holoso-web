// PnR de-risk spike: prove that @yowasp/nextpnr-ecp5 can place-and-route a holoso design
// in-process (the browser-worker target), starting from the SAME synth_ecp5 write_json netlist
// the resource estimator already produces. Validates the open risks before any UI is built:
//   1. netlist contract -- does nextpnr accept yosys synth_ecp5's write_json output as-is?
//   2. invocation       -- which args yield a complete place+route+timing run headless,
//   3. extractable data  -- can we get post-PnR utilization + Fmax (the whole point), and from where
//                           (structured --report JSON vs. log scraping)?
//   4. cost             -- wall-clock of PnR in wasm for a tiny (dot2) and a heavy (ekf_update) design,
//                           and whether the design fits the chosen device.
//
// Run: node nextpnr-spike.mjs   (DUMP=1 to write per-design logs + report.json to /tmp)

import { runYosys } from "@yowasp/yosys";
import { runNextpnrEcp5, version as npnrVersion } from "@yowasp/nextpnr-ecp5";
import { loadPyodide } from "pyodide";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { closure } from "../closure.js";

const SYNTH = "/Users/andrey/Projects/rust/holoso/holoso-synth";
const WHEEL = SYNTH + "/dist/holoso-0.1.0-py3-none-any.whl";
const DRIVER = "/Users/andrey/Projects/rust/holoso/holoso-web/driver.py";
const HDL = SYNTH + "/holoso/hdl";
const KULIBIN = SYNTH + "/lib/kulibin/float/hdl";

// device to route onto: (flag, package). 85k = most headroom so heavy designs fit; routing is slower.
const DEVICE = process.env.DEVICE || "--25k";
const PACKAGE = process.env.PACKAGE || "CABGA256";
const ONLY = process.env.ONLY; // restrict to one demo id

const log = (...a) => process.stdout.write(a.join(" ") + "\n");

const SUPPORT = {
  "holoso_support.vh": readFileSync(HDL + "/holoso_support.vh", "utf8"),
  "holoso_support.v": readFileSync(HDL + "/holoso_support.v", "utf8"),
};
const KULIBIN_FILES = {};
for (const f of readdirSync(KULIBIN).filter((n) => n.endsWith(".v"))) {
  KULIBIN_FILES[f] = readFileSync(KULIBIN + "/" + f, "utf8");
}
const LIBRARY = { "holoso_support.v": SUPPORT["holoso_support.v"], ...KULIBIN_FILES };

// synth_ecp5 -> write_json: the exact netlist the estimator feeds nextpnr.
async function synthEcp5(mod, designV) {
  const { files: libFiles } = closure(mod, designV, LIBRARY);
  const reads = [`${mod}.v`, ...libFiles].join(" ");
  const script = [
    `read_verilog -I. ${reads}`,
    `hierarchy -top ${mod} -check`,
    `synth_ecp5 -top ${mod} -flatten -json design.json`,
    "",
  ].join("\n");
  const files = { "holoso_support.vh": SUPPORT["holoso_support.vh"], [`${mod}.v`]: designV, "job.ys": script };
  for (const f of libFiles) files[f] = LIBRARY[f];
  let out = "";
  const sink = (b) => { if (b) out += Buffer.from(b).toString("utf8"); };
  const fout = await runYosys(["job.ys"], files, { stdout: sink, stderr: sink, decodeASCII: true });
  return { json: fout["design.json"], log: out };
}

async function pnr(id, designJson) {
  let out = "";
  const sink = (b) => { if (b) out += Buffer.from(b).toString("utf8"); };
  const args = [
    "--json", "design.json",
    DEVICE, "--package", PACKAGE,
    "--report", "report.json",
    "--textcfg", "out.config",
    "--seed", "1",
  ];
  const t0 = Date.now();
  let fout, err = null;
  try {
    fout = await runNextpnrEcp5(args, { "design.json": designJson }, { stdout: sink, stderr: sink, decodeASCII: true });
  } catch (e) {
    err = e && e.message ? e.message : String(e);
  }
  const ms = Date.now() - t0;
  if (process.env.DUMP) {
    writeFileSync(`/tmp/pnr_${id}.log`, out);
    if (fout && fout["report.json"]) writeFileSync(`/tmp/pnr_${id}_report.json`, fout["report.json"]);
  }
  return { ms, log: out, report: fout && fout["report.json"], err };
}

// nextpnr prints "Info: Max frequency for clock '<name>': X MHz (PASS/FAIL at Y MHz)" to the log.
function fmaxFromLog(text) {
  const out = [];
  const re = /Max frequency for clock\s+'([^']+)':\s+([\d.]+)\s*MHz/g;
  let m;
  while ((m = re.exec(text))) out.push(`${m[1]}=${m[2]}MHz`);
  return out;
}

function summarizeReport(reportText) {
  if (!reportText) return null;
  let r;
  try { r = JSON.parse(reportText); } catch { return null; }
  const util = r.utilization || {};
  const used = Object.entries(util)
    .filter(([, v]) => (v.used || 0) > 0)
    .map(([k, v]) => `${k}=${v.used}/${v.available}`);
  const fmax = Object.entries(r.fmax || {}).map(([k, v]) => `${k}=${v.achieved}MHz(constraint ${v.constraint})`);
  return { used, fmax, keys: Object.keys(r) };
}

async function main() {
  log("booting Pyodide + holoso …");
  const py = await loadPyodide();
  await py.loadPackage(["micropip", "numpy", "sympy"]);
  py.FS.writeFile("/holoso-0.1.0-py3-none-any.whl", readFileSync(WHEEL));
  await py.runPythonAsync(`import micropip; await micropip.install("emfs:/holoso-0.1.0-py3-none-any.whl", deps=False)`);
  py.runPython(readFileSync(DRIVER, "utf8"));
  log("yosys " + (await import("@yowasp/yosys")).version + " · nextpnr-ecp5 " + npnrVersion);
  log(`target: ${DEVICE} ${PACKAGE}\n`);

  const demos = JSON.parse(py.runPython("demos_to_json()"));
  const want = (ONLY ? [ONLY] : ["dot2", "ekf_update"]);
  for (const id of want) {
    const d = demos.find((x) => x.id === id);
    if (!d) { log(`  (no demo ${id})`); continue; }
    py.globals.set("_s", d.source);
    const r = JSON.parse(py.runPython("synth_to_json(_s, 8, 24, '', '')"));
    if (!r.ok) { log(`  ${id}: synth failed (${r.error?.kind})`); continue; }

    log(`=== ${id} (${r.module_name}) ===`);
    const s = await synthEcp5(r.module_name, r.verilog);
    log(`  synth_ecp5 ok, netlist ${(s.json.length / 1024).toFixed(0)} KB`);

    const p = await pnr(id, s.json);
    if (p.err) {
      log(`  PnR FAILED in ${p.ms} ms:`);
      log(p.log.split("\n").slice(-15).map((l) => "    | " + l).join("\n"));
      log("    err: " + p.err.split("\n").slice(0, 4).join(" / "));
      continue;
    }
    log(`  PnR ok in ${(p.ms / 1000).toFixed(1)} s`);
    const sum = summarizeReport(p.report);
    log(`  report keys: ${sum ? sum.keys.join(",") : "(no report.json)"}`);
    if (sum) {
      log(`  utilization: ${sum.used.join("  ") || "(none)"}`);
      log(`  fmax(report): ${sum.fmax.join("  ") || "(none)"}`);
    }
    log(`  fmax(log): ${fmaxFromLog(p.log).join("  ") || "(none)"}`);
    log("");
  }
  log("=== spike done ===");
}

main().catch((e) => {
  log("FATAL:", (e.message || String(e)).split("\n").slice(0, 30).join("\n"));
  process.exit(1);
});
