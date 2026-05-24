"""In-browser synthesis driver, run inside Pyodide.

Defines ``synth_to_json``: take the user's Python source as text, materialize it as a real module on the (in-memory)
filesystem so ``inspect.getsource`` works, locate the target function, run ``holoso.synthesize``, and return a
JSON string the JS layer renders. Pure data in, JSON out -- no DOM, no globals beyond a per-call module counter --
so it is exercised identically by ``worker.js`` (browser) and ``spike/`` (Node), the single source of synth logic.

A unique module name per call (``holoso_user_<n>``) gives every run a distinct ``__file__`` -> linecache stays
correct across edits, and importlib never serves a stale cached module.
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


def synth_to_json(source: str, wexp: int, wman: int, entry: str = "", name: str = "") -> str:
    """Synthesize ``source`` and return a JSON result envelope (see module docstring)."""
    from holoso import FloatFormat, synthesize
    from holoso.errors import HolosoError

    global _counter
    _counter += 1
    mod_name = f"holoso_user_{_counter}"
    _USER_DIR.mkdir(exist_ok=True)
    (_USER_DIR / f"{mod_name}.py").write_text(source, encoding="utf-8")
    if str(_USER_DIR) not in sys.path:
        sys.path.insert(0, str(_USER_DIR))
    importlib.invalidate_caches()

    try:
        module = importlib.import_module(mod_name)
    except Exception:  # the user's own module body raised -- surface it verbatim
        return _error("ImportError", traceback.format_exc())

    candidates = _module_functions(module)
    target_name = entry.strip() or (candidates[-1] if candidates else "")
    if not target_name:
        return _error("NoTarget", "no top-level function found to synthesize", targets=candidates)
    if target_name not in candidates:
        return _error("BadEntry", f"entry {target_name!r} not found among {candidates}", targets=candidates)

    try:
        result = synthesize(
            getattr(module, target_name),
            float_format=FloatFormat(wexp=int(wexp), wman=int(wman)),
            name=(name.strip() or None),
        )
    except HolosoError as exc:
        err: dict[str, object] = {"kind": type(exc).__name__, "message": getattr(exc, "message", str(exc))}
        loc = getattr(exc, "location", None)
        if loc is not None:
            err["location"] = {"lineno": loc.lineno, "col": loc.col, "line": loc.line}
        return json.dumps({"ok": False, "error": err, "targets": candidates, "target": target_name})
    except Exception:  # a bug in holoso, not in the user's input -- show the full trace
        return json.dumps(
            {"ok": False, "error": {"kind": "InternalError", "message": traceback.format_exc()}, "targets": candidates}
        )

    metrics = result.metrics
    instances = " ".join(f"{count}×{getattr(kind, 'value', kind)}" for kind, count in metrics.operator_instances.items())
    return json.dumps(
        {
            "ok": True,
            "targets": candidates,
            "target": target_name,
            "module_name": result.module_name,
            "verilog": result.verilog,
            "support": result.support,
            "testbench": result.testbench,
            "report_html": result.report_html,
            "metrics": {
                "operator_instances": instances or "-",
                "float_regs": metrics.n_float_regs,
                "steps": metrics.step_count,
                "ii_estimate": metrics.ii_estimate,
                "op_count": metrics.op_count,
                "max_chain_len": metrics.max_chain_len,
            },
        }
    )
