// Pure helpers for a Yosys resource-estimation job: the script to run and the netlist parser. No I/O and no
// runtime, so they are shared verbatim by the browser worker (yosys-worker.js) and the Node integration test.

const SYNTH_CMD = {
  generic: (top) => `synth -top ${top} -flatten`,
  ecp5: (top) => `synth_ecp5 -top ${top} -flatten`,
  xilinx: (top) => `synth_xilinx -top ${top} -flatten`,
  ice40: (top) => `synth_ice40 -top ${top} -flatten`,
};

// `<top>.v` is read first so its `include "holoso_support.vh" defines the macros holoso_support.v needs
// (read_verilog keeps preprocessor defines across the files of one invocation). hierarchy -check aborts on
// any unresolved module -- the authoritative completeness check. write_json gives the machine-readable
// netlist we histogram; stat is emitted too, for the human-readable log.
function synthScript(top, libFiles, target) {
  const reads = [`${top}.v`, ...libFiles].join(" ");
  return [
    `read_verilog -I. ${reads}`,
    `hierarchy -check -top ${top}`,
    SYNTH_CMD[target](top),
    "write_json netlist.json",
    "stat",
    "",
  ].join("\n");
}

// --- ECP5 place-and-route (nextpnr) -------------------------------------------------------------------
// PnR runs on the *raw* synthesized kernel (no timing harness). holoso exposes every operand/result as a
// parallel top-level port, so the design is I/O-pad-bound: small kernels still spend most pads, and large
// ones (full covariance EKF, etc.) overflow even the biggest package. We route onto the largest ECP5
// (85k / CABGA756 ~ most pads + logic headroom) to route as many designs as possible; pad/logic overflow
// surfaces as a nextpnr placement error, which the worker reports verbatim.
const ECP5_DEVICE = "--85k";
const ECP5_PACKAGE = "CABGA756";

// synth_ecp5 -> write_json, the exact netlist nextpnr-ecp5 consumes. `${top}.v` is read first so its
// `include "holoso_support.vh" defines reach holoso_support.v (see synthScript).
function ecp5JsonScript(top, libFiles, jsonOut = "design.json") {
  const reads = [`${top}.v`, ...libFiles].join(" ");
  return [
    `read_verilog -I. ${reads}`,
    `hierarchy -check -top ${top}`,
    `synth_ecp5 -top ${top} -flatten -json ${jsonOut}`,
    "",
  ].join("\n");
}

function nextpnrArgs({ json = "design.json", report = "report.json", device = ECP5_DEVICE, pkg = ECP5_PACKAGE } = {}) {
  // --textcfg forces a complete place+route+pack so the timing report reflects a routed design; --seed
  // pins the (otherwise randomized) placer for reproducible numbers.
  return ["--json", json, device, "--package", pkg, "--report", report, "--textcfg", "out.config", "--seed", "1"];
}

// Summarize a nextpnr --report JSON into the few things the UI shows. Pure; shared by worker + node test.
// Shape: { fmax:[{clock,achieved,constraint}], utilization:[{type,used,available}], criticalPath:{...}|null }.
function summarizePnrReport(reportText) {
  let r;
  try { r = typeof reportText === "string" ? JSON.parse(reportText) : reportText; } catch { return null; }
  if (!r || typeof r !== "object") return null;

  const fmax = Object.entries(r.fmax || {}).map(([clock, v]) => ({
    clock: cleanClock(clock),
    achieved: typeof v?.achieved === "number" ? v.achieved : null,
    constraint: typeof v?.constraint === "number" ? v.constraint : null,
  }));

  const utilization = Object.entries(r.utilization || {})
    .map(([type, v]) => ({ type, used: v?.used || 0, available: v?.available || 0 }))
    .filter((u) => u.used > 0)
    .sort((a, b) => b.used - a.used);

  // Worst path = the one with the largest summed segment delay. Keep its delay split and the unique source
  // references (file:line) it crosses, so the UI can point back at the offending RTL.
  let criticalPath = null;
  for (const cp of Array.isArray(r.critical_paths) ? r.critical_paths : []) {
    const segs = Array.isArray(cp.path) ? cp.path : [];
    let ns = 0, logic = 0, routing = 0;
    const sources = [];
    for (const s of segs) {
      const d = typeof s.delay === "number" ? s.delay : 0;
      ns += d;
      if (s.type === "routing") routing += d;
      else if (s.type === "logic" || s.type === "clk-to-q") logic += d;
      for (const src of s.sources || []) if (!sources.includes(src)) sources.push(src);
    }
    if (!criticalPath || ns > criticalPath.ns) {
      criticalPath = { ns, logic, routing, from: cleanClock(cp.from), segments: segs.length, sources };
    }
  }
  return { fmax, utilization, criticalPath };
}

// nextpnr clock names look like "posedge $glbnet$clk$TRELLIS_IO_IN"; strip the netlist mangling for display.
function cleanClock(name) {
  if (typeof name !== "string") return "";
  return name.replace(/^posedge\s+/, "").replace(/^\$glbnet\$/, "").replace(/\$TRELLIS_IO_IN$/, "");
}

// Post-synth cell-type histogram from a write_json netlist. With `-flatten` the leaf cells live in the top
// module; $scopeinfo is debug metadata, not hardware, so it is dropped.
function cellHistogram(netlist, top) {
  const module = netlist.modules?.[top];
  if (!module || typeof module.cells !== "object") return null;
  const counts = {};
  for (const cell of Object.values(module.cells)) {
    const type = cell?.type;
    if (typeof type !== "string" || type === "$scopeinfo") continue;
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

export {
  SYNTH_CMD, synthScript, cellHistogram,
  ECP5_DEVICE, ECP5_PACKAGE, ecp5JsonScript, nextpnrArgs, summarizePnrReport,
};
