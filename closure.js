// Source-closure for in-browser Yosys: given the generated top module and the support/Kulibin library,
// return only the library files whose modules are actually instantiated (transitively) from the top.
//
// Why this matters: read_verilog parses every file it is handed, so feeding the whole library drags in
// modules the design never uses -- and any parse quirk in an unused file (e.g. a real-valued helper Yosys
// cannot tokenize) aborts the run regardless. Reading only the closure keeps each job minimal and robust.
//
// Pure string analysis, no DOM/Node APIs, so it is shared verbatim by the worker (browser) and the
// Node spike/tests. Verilog has no nested modules: a module spans `module <name>` .. `endmodule`.

function indexModules(files) {
  const mods = {};
  for (const [file, src] of Object.entries(files)) {
    const re = /(?:^|\n)\s*module\s+([A-Za-z_]\w*)\b/g;
    let m;
    while ((m = re.exec(src))) {
      const start = m.index;
      const end = src.indexOf("endmodule", start);
      mods[m[1]] = { file, body: src.slice(start, end < 0 ? src.length : end + "endmodule".length) };
    }
  }
  return mods;
}

// topName: the generated module's name; designV: its source; library: { filename: source } for
// holoso_support.v + the Kulibin *.v. Returns the sorted list of library filenames to read and the set of
// reached module names. Detecting instantiations of *undefined* modules is left to Yosys `hierarchy -check`,
// which is authoritative (here every reached name is, by construction, one we have a definition for).
function closure(topName, designV, library) {
  const mods = indexModules({ ...library, "\0top": designV });
  const names = Object.keys(mods);
  const reached = new Set();
  const queue = [topName];
  while (queue.length) {
    const cur = queue.pop();
    if (reached.has(cur) || !mods[cur]) continue;
    reached.add(cur);
    // An instantiation of module n is `n [#(params)] instance (`. Match both the parameterized form
    // (`n #(`) and the bare form (`n inst (`). The trailing \b on the name is essential so that, e.g.,
    // `zkf_mul` does not match inside `zkf_mul_ilog2_const`. A plain call `n(...)` (no instance name) is
    // deliberately not matched, so helper-function names never masquerade as module instantiations.
    for (const n of names) {
      if (n !== cur && new RegExp(`\\b${n}\\b\\s*(#\\s*\\(|[A-Za-z_]\\w*\\s*\\()`).test(mods[cur].body)) queue.push(n);
    }
  }
  const files = new Set([...reached].map((n) => mods[n].file).filter((f) => f !== "\0top"));
  return { files: [...files].sort(), reached };
}

export { indexModules, closure };
