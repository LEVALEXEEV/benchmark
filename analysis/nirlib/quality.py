"""
Проверка допуска серий и качества данных (nir3-plan.md, разделы 2 и 5).

Смотрит серии напрямую по манифестам, включая те, что загрузчик пропускает
(незавершённые, `protocol.usable = false`), чтобы было видно, что и почему
не вошло. Запуск из каталога analysis: `python -m nirlib.quality`.
"""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

from .config import POOL, PRIMARY_CAMPAIGNS, RESULTS_DIR, RUNS_PER_CELL
from .load import condition, exclude_reason

SCENARIOS = ("s1", "s2", "s3", "s4", "s5")

# Метрика прогона для проверки дрейфа по порядку — основная метрика сценария
DRIFT_METRIC = {"s1": "frame_ms_median", "s2": "frame_ms_median", "s3": "ttfr_submit_ms",
                "s4": "latency_render_ms_median", "s5": "capacity_fps60"}


def series(root: Path = RESULTS_DIR, campaigns=PRIMARY_CAMPAIGNS) -> pd.DataFrame:
    """Одна строка на серию: условия допуска раздела 2 и полнота расписания."""
    rows = []
    for path in sorted(root.glob("*/*/*/*/manifest.json")):
        device_dir, browser, scenario, folder = path.relative_to(root).parts[:4]
        campaign, _, stamp = folder.partition(" ")
        if not stamp or campaign not in campaigns:
            continue
        m = json.loads(path.read_text())
        cfg, git, br = m["config"], m["host"].get("git") or {}, m["browser"]
        runs = m["runs"]
        measured = [r for r in runs if not r["warmup"] and not r.get("control")]
        cells = Counter((r["label"], r.get("load") or "-") for r in measured)
        warned = [r for r in measured if (r.get("validity") or {}).get("warnings")]
        images = [e.get("image") or {} for p in m.get("parity") or [] for e in p["entries"]]
        rows.append({
            "campaign": campaign,
            "platform": f"{'-'.join(device_dir.split('-')[:3])} · {browser}",
            "condition": condition(cfg),
            "scenario": scenario,
            "series": folder,
            "usable": m.get("protocol", {}).get("usable"),
            "violations": "; ".join(m.get("protocol", {}).get("violations") or []),
            "commit": (git.get("commit") or "")[:7],
            "dirty": git.get("dirty"),
            "browser": br["version"],
            "pinned": br.get("pinned"),
            "vsync_uncapped": br.get("vsyncUncapped"),
            "isolated": all(s.get("coop") == "same-origin" and s.get("coep") == "require-corp"
                            for s in m["servers"].values()),
            "parity": all(p["ok"] for p in m.get("parity") or []) and bool(m.get("parity")),
            "frame_exact": all(i.get("exact") for i in images) and bool(images),
            "complete": len(runs) == len(m.get("schedule") or []),
            "cells": len(cells),
            "n_min": min(cells.values(), default=0),
            "n_expected": RUNS_PER_CELL[scenario],
            "fatal": sum(bool((r.get("validity") or {}).get("fatal")) for r in runs),
            "retries": len(m.get("retries") or []),
            "drift_spread": (m.get("drift") or {}).get("spread", np.nan),
            "warned_runs": len(warned),
            "excluded_runs": sum(bool(exclude_reason(r["validity"]["warnings"])) for r in warned),
        })
    df = pd.DataFrame(rows)
    df["admitted"] = (df["usable"].eq(True) & ~df["dirty"].astype(bool) & df["pinned"].eq(True) & df["isolated"]
                      & df["parity"] & df["frame_exact"] & df["complete"] & df["n_min"].ge(df["n_expected"])
                      & df["fatal"].eq(0))
    return df


def coverage(ser: pd.DataFrame) -> pd.DataFrame:
    """
    Покрытие матрицы пула допущенными сериями: ● снято, ✗ не снято,
    пусто — ячейки нет в матрице.
    """
    done = set(ser.loc[ser["admitted"], ["platform", "condition", "scenario"]].itertuples(index=False))
    rows = []
    for (platform, cond), req in POOL.items():
        row = {"platform": platform, "condition": cond}
        for s in SCENARIOS:
            row[s] = ("●" if (platform, cond, s) in done else "✗") if s in req.split() else ""
        rows.append(row)
    return pd.DataFrame(rows)


def warnings(runs: pd.DataFrame) -> pd.DataFrame:
    """Прогоны с предупреждениями по ячейкам: сколько и исключаются ли (runs — load(keep_excluded=True))."""
    w = runs[runs["warnings"] != ""]
    if w.empty:
        return pd.DataFrame()
    kind = w["warnings"].str.replace(r"\d[\d.,]*", "N", regex=True).str.split(" — ").str[0]
    total = runs.groupby(["platform", "condition", "scenario", "label"]).size().rename("runs")
    out = (w.assign(kind=kind, excluded=w["exclude_reason"] != "")
             .groupby(["platform", "condition", "scenario", "label", "kind"])
             .agg(warned=("run_id", "size"), excluded=("excluded", "sum")).reset_index())
    return out.merge(total.reset_index(), on=["platform", "condition", "scenario", "label"])


def order_drift(runs: pd.DataFrame, alpha: float = 0.05) -> pd.DataFrame:
    """
    Ранговая корреляция основной метрики с порядковым номером прогона в серии
    (протокол, раздел 5, «Дрейф»). Отмечаются ячейки с p < alpha без поправки:
    это сигнал для раздела «Качество данных», а не вывод.
    """
    rows = []
    for key, g in runs.groupby(["platform", "condition", "scenario", "label", "load"]):
        metric = DRIFT_METRIC[key[2]]
        g = g.dropna(subset=[metric])
        if len(g) < 5 or g[metric].nunique() < 2:
            continue
        rho, p = stats.spearmanr(g["order"], g[metric])
        rows.append(dict(zip(["platform", "condition", "scenario", "label", "load"], key),
                         metric=metric, n=len(g), rho=float(rho), p=float(p), flagged=bool(p < alpha)))
    return pd.DataFrame(rows)


def report(root: Path = RESULTS_DIR, campaigns=PRIMARY_CAMPAIGNS) -> None:
    from .load import load

    pd.set_option("display.width", 200, "display.max_columns", 30, "display.max_rows", 200)
    ser = series(root, campaigns)
    print("Серии:\n", ser.drop(columns=["series", "violations"]).to_string(index=False), "\n")
    print("Покрытие матрицы пула:\n", coverage(ser).to_string(index=False), "\n")
    conds = tuple(ser["condition"].unique())
    runs, _, _ = load(root, campaigns, conds, keep_excluded=True)
    print("Предупреждения:\n", warnings(runs).to_string(index=False), "\n")
    d = order_drift(runs)
    print("Дрейф по порядку прогонов (p < 0,05):\n", d[d["flagged"]].to_string(index=False))


if __name__ == "__main__":
    report()
