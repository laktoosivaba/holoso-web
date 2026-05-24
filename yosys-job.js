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

export { SYNTH_CMD, synthScript, cellHistogram };
