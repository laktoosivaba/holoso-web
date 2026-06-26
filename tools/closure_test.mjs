// Unit test for the source-closure builder (closure.js), against the REAL assembled holoso_support.v.
// No Pyodide: a hand-written top that instantiates the holoso_f* wrappers exercises the real instantiation
// syntax, and we assert the BFS reaches exactly the right modules. holoso_support.v is a single self-contained
// library (the wrappers plus every vendored float primitive, inlined by the synth's _support builder), so the
// file-level closure is always just [holoso_support.v]; the interesting contract now is which *modules* the BFS
// reaches inside that one file -- a divider design must reach the divider cores, an add/mul design must not.

import { closure } from "../closure.js";
import { bootHoloso, harness } from "./shared.mjs";

const { log, check, done } = harness();

// Assemble holoso_support.v exactly as the runtime does: it is built in memory from the synth package's
// rtl/ sources, so we ask the package itself for the canonical bytes rather than reading a static file.
log("booting Pyodide + vendored Holoso for support RTL ...");
const py = await bootHoloso();
const support = py.runPython("from holoso._backend.verilog._support import support_files; support_files()['holoso_support.v']");
const library = { "holoso_support.v": support };

const wrap = (name, body) => `module ${name} #(parameter WEXP=8, parameter WMAN=24) ();\n${body}\nendmodule\n`;

// 0. Sanity: the assembled library really is one self-contained file defining every wrapper + primitive.
check(support.includes("holoso_fadd") && support.includes("zkf_add") && support.includes("zkf_div"),
  "holoso_support.v inlines wrappers + primitives (holoso_fadd, zkf_add, zkf_div)");

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

// 2. Real wrappers in the single megafile: reaching one wrapper drags in its primitive cores but not unrelated
//    ones. The file-level closure is just holoso_support.v (everything lives there), so we assert on `reached`.
{
  const top = wrap("dot2", "holoso_fmul #(.WEXP(WEXP), .WMAN(WMAN)) u_m (.clk(clk));\nholoso_fadd #(.WEXP(WEXP), .WMAN(WMAN)) u_a (.clk(clk));");
  const { files, reached } = closure("dot2", top, library);
  check(files.join(",") === "holoso_support.v", `dot2: closure is the single holoso_support.v (got ${files.join(",")})`);
  check(reached.has("holoso_fmul") && reached.has("holoso_fadd"), "dot2: reached holoso_fmul, holoso_fadd");
  check(reached.has("zkf_mul") && reached.has("zkf_add"), "dot2: reached the zkf_mul / zkf_add cores");
  check(!reached.has("zkf_div") && !reached.has("_zkf_div_core"), "dot2: divider cores not reached");
}

// 3. A divider design must reach the divider cores; the add/mul design (case 2) must not.
{
  const top = wrap("q", "holoso_fdiv #(.WEXP(WEXP), .WMAN(WMAN)) u_d (.clk(clk));");
  const { reached } = closure("q", top, library);
  check(reached.has("holoso_fdiv") && reached.has("zkf_div") && reached.has("_zkf_div_core"),
    `fdiv: reached holoso_fdiv + divider cores (zkf_div=${reached.has("zkf_div")}, _zkf_div_core=${reached.has("_zkf_div_core")})`);
}

done("CLOSURE OK");
