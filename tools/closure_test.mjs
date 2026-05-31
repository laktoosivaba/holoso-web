// Unit test for the source-closure builder (closure.js), against the real Kulibin/holoso_support RTL.
// No Pyodide: a hand-written top that instantiates the holoso_f* wrappers exercises the real instantiation
// syntax, and we assert the BFS pulls exactly the reachable library files (and excludes the rest).

import { closure, indexModules } from "../closure.js";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SYNTH = (process.env.SYNTH || ROOT + "../holoso-synth").replace(/\/$/, "");
const HDL = `${SYNTH}/holoso/_backend/verilog`;
const KULIBIN = `${SYNTH}/lib/kulibin/float/hdl`;

const library = { "holoso_support.v": readFileSync(`${HDL}/holoso_support.v`, "utf8") };
for (const f of readdirSync(KULIBIN).filter((n) => n.endsWith(".v"))) {
  library[f] = readFileSync(`${KULIBIN}/${f}`, "utf8");
}

let failures = 0;
const check = (cond, msg) => {
  process.stdout.write(`${cond ? "  ok  " : " FAIL "} ${msg}\n`);
  if (!cond) failures++;
};

const wrap = (name, body) => `module ${name} #(parameter WEXP=8, parameter WMAN=24) ();\n${body}\nendmodule\n`;

// 1. Pure-synthetic BFS: only modules reachable from the top, transitively; unrelated files excluded.
{
  const lib = {
    "a.v": "module A(); B b(); endmodule\nmodule B(); C c(); endmodule",
    "c.v": "module C(); endmodule",
    "d.v": "module D(); endmodule", // unreferenced
  };
  const { files, reached } = closure("TOP", "module TOP(); A a(); endmodule", lib);
  check(files.join(",") === "a.v,c.v", `synthetic: TOP->A->B->C pulls a.v,c.v (got ${files.join(",")})`);
  check(!reached.has("D"), "synthetic: unreferenced D not reached");
}

// 2. Multi-module-per-file: a file is included if any of its modules is reached, but reaching one module
//    must not drag in a sibling module's deps. (holoso_support.v holds many wrappers in one file.)
{
  const top = wrap("dot2", "holoso_fmul #(.WEXP(WEXP), .WMAN(WMAN)) u_m (.clk(clk));\nholoso_fadd #(.WEXP(WEXP), .WMAN(WMAN)) u_a (.clk(clk));");
  const { files, reached } = closure("dot2", top, library);
  check(files.includes("holoso_support.v"), "dot2: holoso_support.v included");
  check(files.includes("zkf_mul.v") && files.includes("zkf_add.v"), `dot2: zkf_mul + zkf_add included (got ${files.join(",")})`);
  check(reached.has("zkf_mul") && reached.has("zkf_add"), "dot2: reached zkf_mul, zkf_add");
  check(!files.includes("zkf_div.v") && !files.includes("_zkf_div_core.v"), "dot2: divider files excluded");
}

// 3. A divider design must pull the div files; an add/mul design (case 2) must not.
{
  const top = wrap("q", "holoso_fdiv #(.WEXP(WEXP), .WMAN(WMAN)) u_d (.clk(clk));");
  const { files } = closure("q", top, library);
  check(files.includes("zkf_div.v") && files.includes("_zkf_div_core.v"), `fdiv: divider files included (got ${files.join(",")})`);
}

process.stdout.write(`\n=== ${failures ? failures + " FAILURE(S)" : "CLOSURE OK"} ===\n`);
process.exit(failures ? 1 : 0);
