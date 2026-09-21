"""
Чтение результатов стенда в таблицы pandas.

`runs` — одна строка на прогон со сводными показателями (из summary прогона);
`levels` — уровни свипа S5; `bundles` — размер сборок. Сырые покадровые ряды
не грузятся целиком: для графиков они читаются по одному прогону (`frames`).

Контрольные прогоны three.js (дрейф среды) в `runs` не попадают — они
отдельно, в `controls()`. Серии с `protocol.usable = false` (незакоммиченный
код, питание от батареи, dev-сервер, без паритета) пропускаются.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from .config import PRIMARY_CAMPAIGNS, RESULTS_DIR


def _num(v) -> float:
    return float(v) if isinstance(v, (int, float)) else np.nan


def _run_values(result: dict) -> dict[str, float]:
    kind = result["kind"]
    if kind == "frame":
        return {k: _num(v) for k, v in result["summary"].items()}
    if kind == "init":
        keys = ("js_ready_ms", "ttfr_submit_ms", "init_ms", "first_frame_render_ms", "heap_mb_at_ttfr")
        out = {k: _num(result.get(k)) for k in keys}
        # в Firefox нет Long Tasks API — TBT там не измерен, а не равен нулю
        out["tbt_total_ms"] = _num(result.get("tbt_total_ms")) if result.get("long_tasks_supported") else np.nan
        return out
    if kind == "input":
        out = {k: _num(v) for k, v in result["summary"].items()}
        out["miss_share"] = out["miss"] / out["clicks"] if out.get("clicks") else np.nan
        return out
    if kind == "scale":
        out = {k: _num(result.get(k)) for k in ("capacity_fps60", "capacity_fps30")}
        ctl = result.get("control")
        out["control_frame_ratio"] = _num(ctl["frame_ratio"]) if ctl else np.nan
        return out
    return {}


def condition(cfg: dict) -> str:
    """Условие серии из пула (nir3-plan.md): base, cpu×N, slow4g, vsync, trace."""
    parts = []
    if cfg.get("cpuThrottle", 1) != 1:
        parts.append(f"cpu×{cfg['cpuThrottle']:g}")
    if cfg.get("network", "none") != "none":
        parts.append(cfg["network"])
    if cfg.get("vsync"):
        parts.append("vsync")
    # трасса CDP замедляет прогон — серия для разбора GC, не для основных метрик
    if cfg.get("trace"):
        parts.append("trace")
    return "+".join(parts) or "base"


def _series(root: Path, campaigns, conditions):
    """Манифесты серий, прошедших отбор: (путь, платформа, условие, манифест)."""
    for manifest_path in sorted(root.glob("*/*/*/*/manifest.json")):
        device_dir, browser, _, folder = manifest_path.relative_to(root).parts[:4]
        campaign, _, stamp = folder.partition(" ")
        if not stamp:
            campaign = "main"
        if campaign not in campaigns:
            continue
        manifest = json.loads(manifest_path.read_text())
        # schema < 3 — серии до протокола 2026-09-21, поля protocol в них нет
        if not manifest.get("protocol", {}).get("usable", True):
            continue
        # прерванная серия (сбой, Ctrl+C): кампания снимет её заново целиком
        schedule = manifest.get("schedule") or []
        if schedule and len(manifest["runs"]) < len(schedule):
            continue
        cond = condition(manifest["config"])
        if cond not in conditions:
            continue
        device = "-".join(device_dir.split("-")[:3])
        yield manifest_path, f"{device} · {browser}", cond, manifest


def load(root: Path = RESULTS_DIR, campaigns=PRIMARY_CAMPAIGNS,
         conditions=("base",)) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    runs, levels, bundles = [], [], []
    for manifest_path, platform, cond, manifest in _series(root, campaigns, conditions):
        scenario = manifest["config"]["scenario"]
        for b in manifest.get("bundles") or []:
            bundles.append({"platform": platform, "impl": b["impl"], "raw_kb": b["total_bytes"] / 1024,
                            "gzip_kb": b["total_gzip_bytes"] / 1024, "brotli_kb": b["total_brotli_bytes"] / 1024})
        for row in manifest["runs"]:
            if row["warmup"] or row.get("control"):
                continue
            path = manifest_path.parent / row["file"]
            result = json.loads(path.read_text())["result"]
            run_id = f"{platform}|{cond}|{scenario}|{path.stem}"
            runs.append({"run_id": run_id, "platform": platform, "condition": cond, "scenario": scenario,
                         "label": row["label"],
                         "load": row.get("load") or "-", "iteration": row["iteration"], "file": str(path),
                         **_run_values(result)})
            for lvl in result.get("levels") or []:
                levels.append({"run_id": run_id, "platform": platform, "label": row["label"], "N": lvl["count"],
                               **{k: _num(v) for k, v in lvl["summary"].items()}})
    bundles_df = pd.DataFrame(bundles).drop_duplicates(["platform", "impl"])
    return pd.DataFrame(runs), pd.DataFrame(levels), bundles_df


def controls(root: Path = RESULTS_DIR, campaigns=PRIMARY_CAMPAIGNS, conditions=("base",)) -> pd.DataFrame:
    """Контрольные прогоны three.js по сериям: разброс между ними — дрейф среды."""
    rows = []
    for manifest_path, platform, cond, manifest in _series(root, campaigns, conditions):
        for pos, row in enumerate(manifest["runs"]):
            if not row.get("control"):
                continue
            rows.append({"platform": platform, "condition": cond, "scenario": manifest["config"]["scenario"],
                         "series": manifest_path.parent.name, "position": pos, "iteration": row["iteration"],
                         **{k: v for k, v in (row.get("brief") or {}).items()}})
    return pd.DataFrame(rows)


def frames(run_file: str) -> pd.DataFrame:
    """Покадровый ряд одного прогона (для графиков временных рядов)."""
    raw = json.loads(Path(run_file).read_text())["result"]["raw"]
    return pd.DataFrame({k: raw[k] for k in ("start_ms", "frame_ms", "update_ms", "render_ms")})
