"""In-browser synthesis driver, run inside Pyodide.

Defines ``synth_to_json``: take the user's Python source as text, materialize it as a real module on the (in-memory)
filesystem so ``inspect.getsource`` works, locate the target function, run ``holoso.synthesize``, and return a
JSON string the JS layer renders. Pure data in, JSON out -- no DOM, no globals beyond a per-call module counter --
so it is exercised identically by ``worker.js`` (browser) and ``tools/`` (Node), the single source of synth logic.

A unique module name per call (``holoso_user_<n>``) gives every run a distinct ``__file__`` -> linecache stays
correct across edits, and importlib never serves a stale cached module.

The demo kernels shown in the picker are static source files in this repo (``demos/``), listed by the worker --
they are not part of the holoso wheel, so this driver never imports them.
"""

from __future__ import annotations

import importlib
import json
import pathlib
import sys
import traceback
import types

_USER_DIR = pathlib.Path("/user")
_counter = 0


def _module_functions(module: types.ModuleType) -> list[str]:
    """Top-level functions *defined in* this module (not imported), in definition order -- the synthesis candidates."""
    return [
        name
        for name, obj in vars(module).items()
        if isinstance(obj, types.FunctionType) and getattr(obj, "__module__", None) == module.__name__
    ]


def _error(kind: str, message: str, **extra: object) -> str:
    return json.dumps({"ok": False, "error": {"kind": kind, "message": message}, **extra})


def _user_location(user_file: pathlib.Path) -> dict[str, object] | None:
    """Pull the last traceback frame inside the user's module file, so an import-time crash annotates the right line."""
    import linecache

    frames = traceback.extract_tb(sys.exc_info()[2])
    hits = [f for f in frames if f.filename == str(user_file)]
    if not hits:
        return None
    frame = hits[-1]
    line = frame.line or linecache.getline(str(user_file), frame.lineno or 0)
    return {"lineno": frame.lineno, "col": 0, "line": line.rstrip("\n")}


def _default_ops(wexp: int, wman: int):
    """Build the default per-operator configuration: every float operator at the requested ZKF format, no extra
    pipeline stages. holoso.synthesize requires an explicit OpConfig; the web always synthesizes the bare kernel."""
    from holoso import FAddOperator, FDivOperator, FMulILog2OperatorFamily, FMulOperator, FloatFormat, OpConfig

    fmt = FloatFormat(wexp=int(wexp), wman=int(wman))
    return OpConfig(
        fadd=FAddOperator(fmt),
        fmul=FMulOperator(fmt),
        fdiv=FDivOperator(fmt),
        fmul_ilog2=FMulILog2OperatorFamily(fmt),
    )


def synth_to_json(source: str, wexp: int, wman: int, entry: str = "", name: str = "") -> str:
    """Synthesize ``source`` and return a JSON result envelope (see module docstring)."""
    from collections import Counter

    from holoso import HolosoError, synthesize

    global _counter
    _counter += 1
    mod_name = f"holoso_user_{_counter}"
    _USER_DIR.mkdir(exist_ok=True)
    user_file = _USER_DIR / f"{mod_name}.py"
    user_file.write_text(source, encoding="utf-8")
    if str(_USER_DIR) not in sys.path:
        sys.path.insert(0, str(_USER_DIR))
    importlib.invalidate_caches()

    try:
        module = importlib.import_module(mod_name)
    except Exception:
        err: dict[str, object] = {"kind": "ImportError", "message": traceback.format_exc()}
        loc = _user_location(user_file)
        if loc is not None:
            err["location"] = loc
        return json.dumps({"ok": False, "error": err, "targets": []})

    candidates = _module_functions(module)
    target_name = entry.strip() or (candidates[-1] if candidates else "")
    if not target_name:
        return _error("NoTarget", "no top-level function found to synthesize", targets=candidates)
    if target_name not in candidates:
        return _error("BadEntry", f"entry {target_name!r} not found among {candidates}", targets=candidates)

    try:
        result = synthesize(getattr(module, target_name), ops=_default_ops(wexp, wman), name=(name.strip() or None))
    except HolosoError as exc:
        err = {"kind": type(exc).__name__, "message": getattr(exc, "message", str(exc))}
        loc = getattr(exc, "location", None)
        if loc is not None:
            err["location"] = {"lineno": loc.lineno, "col": loc.col, "line": loc.line}
        return json.dumps({"ok": False, "error": err, "targets": candidates, "target": target_name})
    except Exception:
        return json.dumps(
            {"ok": False, "error": {"kind": "InternalError", "message": traceback.format_exc()}, "targets": candidates}
        )

    # Post-synthesis figures live on the numerical model's Lir (the only public handle that carries them); the
    # support RTL comes back as a name->text map alongside the generated module.
    lir = result.numerical_model.lir
    support = result.verilog_output.support_files
    counts = Counter(inst.operator.mnemonic for inst in lir.float_instances)
    instances = " ".join(f"{n}×{m}" for m, n in sorted(counts.items()))
    return json.dumps(
        {
            "ok": True,
            "targets": candidates,
            "target": target_name,
            "module_name": result.module_name,
            "verilog": result.verilog_output.verilog,
            "support": support.get("holoso_support.v", ""),
            "testbench": result.cocotb_output.testbench,
            "report_html": result.html_output.html,
            "metrics": {
                "operator_instances": instances or "-",
                "float_regs": lir.float_regfile.nreg,
                "steps": lir.makespan,
                "ii_cycles": lir.initiation_interval,
                "op_count": lir.op_count,
                "max_chain_len": lir.max_chain_len,
            },
        }
    )
