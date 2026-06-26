// Regression test for the in-browser script runner (driver.py): boots holoso in Node-Pyodide exactly as
// the worker does, then exercises run_script against every demo plus the error / IO / bad-request paths.
// Uses the freshly built SYNTH/dist wheel (not the vendored one) so a bad build is caught here.

import { SYNTH, harness, loadDemos, bootHoloso, runScript } from "./shared.mjs";

const { log, check, done } = harness();

// Most demos ship a runnable main() and emit artifacts; a couple define only a kernel for downstream import.
// Rather than hardcode the split (it drifts as demos gain/lose a main()), the per-demo check is data-driven:
// a clean run that emits files must satisfy the build/<stem>/ + .v/.html contract, and a clean run that emits
// nothing is a valid kernel-only fixture. A corpus-wide floor on how many demos actually synthesize then
// guards against a mass regression (e.g. all float-annotated kernels silently failing to synthesize).
const MIN_SYNTHESIZING_DEMOS = 12;

try {
  const py = await bootHoloso({ wheelDir: `${SYNTH}/dist` });

  log("\n=== demo kernels load + run ===");
  const demos = loadDemos();
  check(demos.length >= 5, `loaded ${demos.length} demo kernels`);
  let synthesizing = 0;
  for (const d of demos) {
    check(typeof d.id === "string" && typeof d.filename === "string" && d.source.length > 0, `demo ${d.id}: shape`);
    const r = runScript(py, d.filename, d.source, d.extras);
    if (!r.ok) {
      const msg = (r.error?.message || "").split("\n").slice(-5).join(" | ");
      check(false, `demo ${d.id}: script ran (${r.error?.kind}: ${msg})`);
      continue;
    }
    if (r.files.length === 0) {
      check(true, `demo ${d.id}: clean kernel-only run (no main(), no files)`);
      continue;
    }
    // A demo that emits files ran its main(): pin the build/<stem>/ + .v/.html contract the UI relies on for
    // tab grouping and resource-estimate path derivation.
    synthesizing++;
    const exts = r.files.map((f) => f.ext);
    const stem = d.filename.replace(/\.py$/, "");
    check(exts.includes("v"), `demo ${d.id}: emits at least one .v (${exts.join(",") || "none"})`);
    check(exts.includes("html"), `demo ${d.id}: emits at least one .html (${exts.join(",") || "none"})`);
    check((r.stdout || "").length > 0, `demo ${d.id}: main() printed something (${(r.stdout || "").length} bytes)`);
    check(
      r.files.every((f) => f.path.startsWith(`build/${stem}/`)),
      `demo ${d.id}: artifacts live under build/${stem}/ (got ${r.files.map((f) => f.path).join(", ")})`
    );
  }
  check(
    synthesizing >= MIN_SYNTHESIZING_DEMOS,
    `corpus floor: ${synthesizing} demos synthesized to files (>= ${MIN_SYNTHESIZING_DEMOS} expected)`
  );

  log("\n=== error surfacing ===");
  let r = runScript(py, "boom.py", "raise ValueError('boom at import')\n");
  check(r.ok === false, `import-time raise -> ok=false (kind=${r.error?.kind})`);
  check(r.error?.location?.lineno === 1, `error annotates line 1 (got ${JSON.stringify(r.error?.location)})`);
  check((r.error?.kind || "").includes("ValueError"), `error kind names ValueError (got ${r.error?.kind})`);

  // A non-float/bool scalar annotation is a stable, intentional frontend rejection -- a reliable error-path
  // fixture that doesn't depend on which language constructs the frontend happens to support.
  const synthErr =
    "import holoso\n" +
    "def k(a: str) -> float:\n" +
    "    return a\n" +
    "def main():\n" +
    "    fmt = holoso.FloatFormat(wexp=8, wman=24)\n" +
    "    ops = holoso.OpConfig(\n" +
    "        holoso.FAddOperator(fmt), holoso.FMulOperator(fmt),\n" +
    "        holoso.FDivOperator(fmt), holoso.FMulILog2OperatorFamily(fmt),\n" +
    "        holoso.FCmpOperator(fmt),\n" +
    "    )\n" +
    "    holoso.synthesize(k, ops=ops)\n" +
    "main()\n";
  r = runScript(py, "synth_err.py", synthErr);
  check(r.ok === false, `unsupported parameter annotation rejected mid-main() (kind=${r.error?.kind})`);
  // Holoso's frontend tags this UnsupportedConstruct; if upstream renames the class we want a loud miss.
  check(
    (r.error?.kind || "").toLowerCase().includes("unsupported") || (r.error?.kind || "") === "UnsupportedConstruct",
    `unsupported construct surfaces a Holoso-flavored error kind (got ${r.error?.kind})`
  );

  log("\n=== stdout / stderr capture ===");
  r = runScript(py, "io.py", "import sys\nprint('hello stdout')\nprint('hello stderr', file=sys.stderr)\n");
  check(r.ok === true, `plain print() succeeds (kind=${r.error?.kind})`);
  check(r.stdout.includes("hello stdout"), `stdout captured (${JSON.stringify(r.stdout)})`);
  check(r.stderr.includes("hello stderr"), `stderr captured (${JSON.stringify(r.stderr)})`);
  check(r.files.length === 0, `no side-effect files (got ${r.files.length})`);

  log("\n=== file-emit walk ===");
  const writeSrc =
    "from pathlib import Path\n" +
    "out = Path('build/demo')\n" +
    "out.mkdir(parents=True, exist_ok=True)\n" +
    "(out / 'a.v').write_text('module a; endmodule\\n')\n" +
    "(out / 'a.html').write_text('<h1>a</h1>')\n";
  r = runScript(py, "writer.py", writeSrc);
  check(r.ok === true, `writer script ok (kind=${r.error?.kind})`);
  const paths = r.files.map((f) => f.path).sort();
  check(paths.length === 2, `two files emitted (got ${paths.length}: ${paths.join(", ")})`);
  check(paths.includes("build/demo/a.v"), `build/demo/a.v in list`);
  check(paths.includes("build/demo/a.html"), `build/demo/a.html in list`);
  const vFile = r.files.find((f) => f.ext === "v");
  check(vFile?.content?.includes("module a"), `.v content round-trips`);

  log("\n=== re-run picks up edited siblings ===");
  // The runner clears /user/* from sys.modules + linecache between runs; verify an extras edit is observed.
  const main1 = "from sib import VALUE\nprint(VALUE)\n";
  r = runScript(py, "main.py", main1, { "sib.py": "VALUE = 1\n" });
  check(r.ok && r.stdout.trim() === "1", `first run uses sib v1 (stdout=${JSON.stringify(r.stdout)})`);
  r = runScript(py, "main.py", main1, { "sib.py": "VALUE = 2\n" });
  check(r.ok && r.stdout.trim() === "2", `second run sees edited sib v2 (stdout=${JSON.stringify(r.stdout)})`);

  log("\n=== bad request shape ===");
  r = runScript(py, "x", "print('hi')\n");
  check(r.ok === false && r.error?.kind === "BadRequest", `filename without .py rejected (kind=${r.error?.kind})`);
  r = runScript(py, "../etc/main.py", "print('hi')\n");
  check(r.ok === false && r.error?.kind === "BadRequest", `path-traversal in filename rejected (kind=${r.error?.kind})`);
  r = runScript(py, "main.py", "print('hi')\n", { "../x.py": "X = 1\n" });
  check(r.ok === false && r.error?.kind === "BadRequest", `path-traversal in extras rejected (kind=${r.error?.kind})`);

  done("ALL CHECKS PASSED");
} catch (e) {
  log("FATAL:", (e.message || String(e)).split("\n").slice(0, 25).join("\n"));
  process.exit(1);
}
