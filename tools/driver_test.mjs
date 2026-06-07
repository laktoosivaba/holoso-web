import { loadPyodide } from "pyodide";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("../", import.meta.url));
const SYNTH = process.env.SYNTH || WEB + "../holoso-synth";
const WHEEL = `${SYNTH.replace(/\/$/, "")}/dist/holoso-0.1.0-py3-none-any.whl`;
const DRIVER = WEB + "driver.py";
const DEMOS = WEB + "demos";

// Mirror the worker: the demo corpus is static source files listed by demos/manifest.json -- not the wheel.
// Each manifest entry may also list sibling files via `extras`; they are read alongside and passed to the driver
// as a {filename: content} bundle so cross-file imports (e.g. ekf1_stateful imports ekf1_stateless) resolve.
function loadDemos() {
  return JSON.parse(readFileSync(`${DEMOS}/manifest.json`, "utf8")).map((d) => {
    const extras = Object.fromEntries((d.extras || []).map((n) => [n, readFileSync(`${DEMOS}/${n}`, "utf8")]));
    return {
      id: d.id,
      label: d.label,
      source: readFileSync(`${DEMOS}/${d.file}`, "utf8"),
      extras,
    };
  });
}

// Stateful demos: id -> (entry, minimum slot count). Caught regressions in the candidate enumerator (default entry
// becomes ClassName.method) and the FloatStateSlot count surfacing.
const STATEFUL = {
  trapezoidal_leaky_streaming_integrator: { entry: "TrapezoidalLeakyStreamingIntegrator.__call__", slots: 2 },
  ekf1_stateful: { entry: "Ekf1.update", slots: 9 },
};

// Demos vendored from upstream that the current synth frontend does not yet support. The picker shows them with
// the same friendly error the user sees; this test pins the expected error kind so a fresh failure mode (import
// error from a missing dep, e.g.) is still caught. When a demo starts synthesizing here, drop it from the list.
const EXPECTED_FAIL = {
  iir1_lpf: ["UnsupportedConstruct"],
  iir1_hpf: ["UnsupportedConstruct"],
  finite_set_current_controller: ["UnsupportedConstruct", "ImportError"],
};

const log = (...a) => process.stdout.write(a.join(" ") + "\n");
let failures = 0;
function check(cond, msg) {
  log(`${cond ? "  ok  " : " FAIL "} ${msg}`);
  if (!cond) failures++;
}

function synth(py, src, wexp, wman, entry, name, extras = {}) {
  py.globals.set("_src", src);
  py.globals.set("_entry", entry);
  py.globals.set("_name", name);
  py.globals.set("_extras", JSON.stringify(extras));
  return JSON.parse(py.runPython(`synth_to_json(_src, ${wexp}, ${wman}, _entry, _name, _extras)`));
}

try {
  const py = await loadPyodide();
  await py.loadPackage(["micropip", "numpy", "scipy", "sympy"]);
  py.FS.writeFile("/holoso-0.1.0-py3-none-any.whl", readFileSync(WHEEL));
  await py.runPythonAsync(
    `import micropip\n` +
      `await micropip.install("emfs:/holoso-0.1.0-py3-none-any.whl", deps=False)\n` +
      `await micropip.install("jaxtyping")\n`
  );
  py.runPython(readFileSync(DRIVER, "utf8"));

  log("\n=== demo kernels load + synthesize ===");
  const demos = loadDemos();
  check(demos.length >= 5, `loaded ${demos.length} demo kernels`);
  for (const d of demos) {
    check(typeof d.id === "string" && typeof d.label === "string" && d.source.length > 0, `demo ${d.id}: shape`);
    const r = synth(py, d.source, 8, 24, "", "", d.extras);
    const allow = EXPECTED_FAIL[d.id];
    if (allow) {
      check(r.ok === false, `demo ${d.id}: known-broken, expected to fail`);
      check(allow.includes(r.error?.kind), `demo ${d.id}: error kind ∈ {${allow.join(", ")}} (got ${r.error?.kind})`);
      continue;
    }
    check(r.ok === true, `demo ${d.id}: synthesizes (${r.ok ? r.metrics.steps + " steps" : r.error?.kind})`);
    if (!r.ok) {
      const msg = (r.error?.message || "").split("\n").slice(-5).join(" | ");
      log(`         ↳ target=${r.target} message=${msg}`);
      continue;
    }
    const want = STATEFUL[d.id];
    if (want) {
      check(r.target === want.entry, `demo ${d.id}: default entry = ${want.entry} (got ${r.target})`);
      check(
        r.metrics.state_slots >= want.slots,
        `demo ${d.id}: state_slots ≥ ${want.slots} (got ${r.metrics.state_slots})`
      );
      check(
        Array.isArray(r.metrics.state_slot_names) && r.metrics.state_slot_names.length === r.metrics.state_slots,
        `demo ${d.id}: state_slot_names matches count`
      );
    } else {
      check(r.metrics.state_slots === 0, `demo ${d.id}: stateless (state_slots=0)`);
    }
  }

  log("\n=== error paths ===");
  const ifSrc = "def bad(a, b):\n    if a > b:\n        return a\n    return b\n";
  let r = synth(py, ifSrc, 8, 24, "", "");
  check(r.ok === false, `unsupported 'if' rejected (kind=${r.error?.kind})`);

  const raiseSrc = "raise ValueError('boom at import')\n\ndef f(a):\n    return a\n";
  r = synth(py, raiseSrc, 8, 24, "", "");
  check(r.ok === false && r.error.kind === "ImportError", `import-time raise -> ImportError (kind=${r.error?.kind})`);
  check(r.error.location?.lineno === 1, `import error annotates line 1 (got ${JSON.stringify(r.error.location)})`);

  log("\n=== entry selection ===");
  const multi = "def poly(x):\n    return x * x + x\n\ndef gain(x, k):\n    return x * k\n";
  r = synth(py, multi, 8, 24, "", "");
  check(r.ok && r.target === "gain", `default entry = last function (${r.target})`);
  r = synth(py, multi, 8, 24, "poly", "");
  check(r.ok && r.target === "poly", `explicit entry=poly honored (${r.target})`);
  r = synth(py, multi, 8, 24, "nope", "");
  check(r.ok === false && r.error.kind === "BadEntry", `unknown entry -> BadEntry (kind=${r.error?.kind})`);

  log("\n=== class targets ===");
  // Inline a tiny stateful class to verify class enumeration + bound-method synth without depending on demo files.
  const classSrc =
    "class Acc:\n" +
    "    def __init__(self):\n" +
    "        self.y: float = 0.0\n" +
    "    def step(self, x: float, /) -> float:\n" +
    "        self.y = self.y + x\n" +
    "        return self.y\n";
  r = synth(py, classSrc, 8, 24, "", "");
  check(r.ok && r.target === "Acc.step", `class default entry = Acc.step (got ${r.target})`);
  check(r.ok && r.metrics.state_slots === 1, `class state_slots == 1 (got ${r.metrics?.state_slots})`);
  check(r.ok && r.module_name === "Acc_step", `module_name = Acc_step (got ${r.module_name})`);

  // Helper / data classes with no synth-eligible method are filtered out of the candidate list.
  const mixedSrc =
    "from dataclasses import dataclass\n" +
    "@dataclass(frozen=True)\n" +
    "class Helper:\n" +
    "    a: float\n" +
    "class Kernel:\n" +
    "    def __call__(self, x: float, /) -> float:\n" +
    "        return x * x\n";
  r = synth(py, mixedSrc, 8, 24, "", "");
  check(r.ok && r.targets.includes("Kernel.__call__"), `data-only Helper skipped, Kernel.__call__ kept`);
  check(r.ok && !r.targets.some((t) => t.startsWith("Helper.")), `Helper has no callable methods (got ${r.targets})`);

  log("\n=== extras (cross-file import) ===");
  const helper = "def _impl(x):\n    return x * 2.0 + 1.0\n";
  const main = "from helper_mod import _impl\n\ndef wrapped(x):\n    return _impl(x) + x\n";
  r = synth(py, main, 8, 24, "", "", { "helper_mod.py": helper });
  check(r.ok === true, `extras pass-through works (${r.ok ? r.target : r.error?.kind + ": " + r.error?.message})`);
  // Invalid extras filename is rejected before import even runs.
  r = synth(py, main, 8, 24, "", "", { "../etc/passwd.py": "x = 1\n" });
  check(r.ok === false && r.error.kind === "BadRequest", `path-traversal extras rejected (kind=${r.error?.kind})`);

  log(`\n=== ${failures ? failures + " FAILURE(S)" : "ALL CHECKS PASSED"} ===`);
  process.exit(failures ? 1 : 0);
} catch (e) {
  log("FATAL:", (e.message || String(e)).split("\n").slice(0, 25).join("\n"));
  process.exit(1);
}
