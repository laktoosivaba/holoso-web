// Y0 de-risk spike: prove that @yowasp/yosys can read the full source closure of a
// holoso-generated design (generated <mod>.v + holoso_support.{v,vh} + Kulibin float/hdl/*.v)
// and produce gate-level / FPGA resource numbers in-process (the browser-worker target).
//
// It validates the three open risks before any UI is built:
//   1. closure completeness  -- `hierarchy -check` aborts on any unresolved (black-box) module,
//   2. real-function path    -- a synthetic `x*2.5+1.0` kernel forces holoso_fconst -> zkf_const,
//                               whose elaboration uses $realtobits/$ln/$pow/$floor/$rtoi,
//   3. arch mapping          -- generic `synth` plus synth_ecp5/xilinx/ice40 (do the techlibs ship?).

import { runYosys } from "@yowasp/yosys";
import { loadPyodide } from "pyodide";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { closure } from "../closure.js";

const SYNTH = "/Users/andrey/Projects/rust/holoso/holoso-synth";
const WHEEL = SYNTH + "/dist/holoso-0.1.0-py3-none-any.whl";
const DRIVER = "/Users/andrey/Projects/rust/holoso/holoso-web/driver.py";
const HDL = SYNTH + "/holoso/hdl";
const KULIBIN = SYNTH + "/lib/kulibin/float/hdl";

const log = (...a) => process.stdout.write(a.join(" ") + "\n");

// Static support closure -- fixed at build time, identical for every design.
const SUPPORT = {
  "holoso_support.vh": readFileSync(HDL + "/holoso_support.vh", "utf8"),
  "holoso_support.v": readFileSync(HDL + "/holoso_support.v", "utf8"),
};
const KULIBIN_FILES = {};
for (const f of readdirSync(KULIBIN).filter((n) => n.endsWith(".v"))) {
  KULIBIN_FILES[f] = readFileSync(KULIBIN + "/" + f, "utf8");
}
const KULIBIN_NAMES = Object.keys(KULIBIN_FILES).sort();
log(`support library: holoso_support.{v,vh} + ${KULIBIN_NAMES.length} Kulibin sources`);

const LIBRARY = { "holoso_support.v": SUPPORT["holoso_support.v"], ...KULIBIN_FILES };

function script(mod, libFiles, target) {
  // <mod>.v first: its `include "holoso_support.vh" defines the macros holoso_support.v relies on,
  // and read_verilog keeps preprocessor defines across the files of one invocation.
  const reads = [`${mod}.v`, ...libFiles].join(" ");
  const synth = {
    generic: `synth -top ${mod} -flatten`,
    ecp5: `synth_ecp5 -top ${mod} -flatten`,
    xilinx: `synth_xilinx -top ${mod} -flatten`,
    ice40: `synth_ice40 -top ${mod} -flatten`,
  }[target];
  return [
    `read_verilog -I. ${reads}`,
    `hierarchy -top ${mod} -check`,
    `tee -o pre_stat.txt stat`,
    synth,
    `tee -o post_stat.txt stat`,
  ].join("\n");
}

async function runTarget(mod, designV, target) {
  const { files: libFiles } = closure(mod, designV, LIBRARY);
  const files = { "holoso_support.vh": SUPPORT["holoso_support.vh"], [`${mod}.v`]: designV, "job.ys": script(mod, libFiles, target) };
  for (const f of libFiles) files[f] = { ...SUPPORT, ...KULIBIN_FILES }[f];
  let out = "";
  const sink = (b) => {
    if (b) out += Buffer.from(b).toString("utf8");
  };
  try {
    const fout = await runYosys(["job.ys"], files, { stdout: sink, stderr: sink, decodeASCII: true });
    return { ok: true, log: out, stat: fout["post_stat.txt"] || "", lib: libFiles };
  } catch (e) {
    return { ok: false, log: out + "\n" + (e && e.message ? e.message : String(e)), lib: libFiles };
  }
}

// Parse the LAST `stat` block (post-synth). yowasp yosys 0.64 prints the summary as bare
// "<n> cells" / "<n> wires" lines, then an indented per-type breakdown ("<n>  <CellType>").
function summarizeStat(text) {
  if (!text) return null;
  const blocks = text.split(/\n=== /);
  const block = blocks[blocks.length - 1];
  const totalM = block.match(/^\s*(\d+)\s+cells\b/m);
  if (!totalM) return null;
  const wiresM = block.match(/^\s*(\d+)\s+wires\b/m);
  const cells = [];
  for (const ln of block.slice(block.indexOf(totalM[0]) + totalM[0].length).split("\n")) {
    const m = ln.match(/^\s+(\d+)\s+(\S+)\s*$/);
    if (m) cells.push(`${m[2]}=${m[1]}`);
    else if (cells.length) break;
  }
  return { total: totalM[1], wires: wiresM?.[1], cells: cells.join(" ") };
}

async function main() {
  log("\nbooting Pyodide + holoso to generate designs ...");
  const py = await loadPyodide();
  await py.loadPackage(["micropip", "numpy", "sympy"]);
  py.FS.writeFile("/holoso-0.1.0-py3-none-any.whl", readFileSync(WHEEL));
  await py.runPythonAsync(`import micropip; await micropip.install("emfs:/holoso-0.1.0-py3-none-any.whl", deps=False)`);
  py.runPython(readFileSync(DRIVER, "utf8"));
  log("yosys " + (await import("@yowasp/yosys")).version);

  const demos = JSON.parse(py.runPython("demos_to_json()"));
  // a synthetic kernel that forces the constant path (holoso_fconst -> zkf_const real funcs).
  const constProbe = { id: "const_probe", source: "def k(x):\n    return x * 2.5 + 1.0\n" };

  const designs = [];
  for (const d of [...demos, constProbe]) {
    py.globals.set("_s", d.source);
    const r = JSON.parse(py.runPython("synth_to_json(_s, 8, 24, '', '')"));
    if (!r.ok) {
      log(`  ${d.id}: SYNTH FAILED (${r.error?.kind}) -- skipping`);
      continue;
    }
    const usesConst = /holoso_fconst/.test(r.verilog);
    designs.push({ id: d.id, mod: r.module_name, v: r.verilog, usesConst });
  }

  log("\n=== generic synth (closure + black-box check) on every design ===");
  for (const d of designs) {
    const res = await runTarget(d.mod, d.v, "generic");
    if (process.env.DUMP) writeFileSync(`/tmp/spike_${d.id}.log`, res.log);
    const s = res.ok ? summarizeStat(res.log) : null;
    const flag = d.usesConst ? " [const-path]" : "";
    if (res.ok && s) {
      log(`  ok   ${d.id}${flag}: ${s.total} cells, ${s.wires} wires (${res.lib.length} lib files)  ${s.cells}`);
    } else {
      log(`  FAIL ${d.id}${flag} (${res.lib.length} lib files: ${res.lib.join(",")}):`);
      log(res.log.split("\n").slice(-10).map((l) => "       | " + l).join("\n"));
    }
  }

  // deep arch sweep on a pure-arith baseline + the heavy EKF + the const probe.
  const deep = designs.filter((d) => ["dot2", "ekf_update", "const_probe"].includes(d.id));
  for (const target of ["ecp5", "xilinx", "ice40"]) {
    log(`\n=== synth_${target} ===`);
    for (const d of deep) {
      const res = await runTarget(d.mod, d.v, target);
      const s = res.ok ? summarizeStat(res.log) : null;
      if (res.ok && s) log(`  ok   ${d.id}: ${s.total} cells  ${s.cells}`);
      else {
        log(`  FAIL ${d.id}:`);
        log(res.log.split("\n").slice(-10).map((l) => "       | " + l).join("\n"));
      }
    }
  }
  log("\n=== spike done ===");
}

main().catch((e) => {
  log("FATAL:", (e.message || String(e)).split("\n").slice(0, 30).join("\n"));
  process.exit(1);
});
