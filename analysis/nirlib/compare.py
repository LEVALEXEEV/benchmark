"""
Сравнение варианта с three.js.

Единица — прогон: из каждого берётся одно число (медиана кадра, p99, ёмкость…),
так что на вариант приходится 8–30 значений. Для каждой пары считаются:

* отношение медиан «вариант / three.js» — во сколько раз отличается;
* 95% доверительный интервал отношения (бутстрап по прогонам);
* p-значение критерия Манна–Уитни (не требует нормальности), с поправкой
  Холма на число сравнений внутри платформы.

Вывод по одному правилу:
* «≈ равны» — весь интервал внутри ±5%: даже если разница есть, она меньше 5%;
* «больше / меньше» — интервал не содержит 1 и p (Холм) < 0,05;
* «не ясно» — данных не хватает ни для одного из выводов.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy import stats
from statsmodels.stats.multitest import multipletests

from .config import ALPHA, BASELINE, EQUIV_MARGIN, N_BOOT, SEED


def ratio_ci(x: np.ndarray, y: np.ndarray) -> tuple[float, float, float]:
    rng = np.random.default_rng(SEED)
    bx = np.median(x[rng.integers(0, len(x), (N_BOOT, len(x)))], axis=1)
    by = np.median(y[rng.integers(0, len(y), (N_BOOT, len(y)))], axis=1)
    r = bx / by
    return float(np.median(x) / np.median(y)), float(np.quantile(r, 0.025)), float(np.quantile(r, 0.975))


def compare(runs: pd.DataFrame, scenario: str, metric: str, loads=("-",), variants=None) -> pd.DataFrame:
    """Все варианты сценария против three.js на каждой платформе (и точке нагрузки S1)."""
    rows = []
    sub = runs[(runs["scenario"] == scenario) & runs["load"].isin(loads)]
    for (platform, load), g in sub.groupby(["platform", "load"], sort=False):
        y = g.loc[g["label"] == BASELINE, metric].dropna().to_numpy(float)
        for label in (variants or g["label"].unique()):
            if label == BASELINE:
                continue
            x = g.loc[g["label"] == label, metric].dropna().to_numpy(float)
            row = {"platform": platform, "scenario": scenario, "load": load, "label": label, "metric": metric}
            if len(x) >= 3 and len(y) >= 3 and np.median(y) > 0:
                row["ratio"], row["lo"], row["hi"] = ratio_ci(x, y)
                row["p"] = float(stats.mannwhitneyu(x, y).pvalue)
            rows.append(row)
    return pd.DataFrame(rows)


def conclude(df: pd.DataFrame) -> pd.DataFrame:
    """Поправка Холма внутри платформы и вывод по правилу из описания модуля."""
    df = df.copy()
    df["p_holm"] = np.nan
    for _, idx in df.dropna(subset=["p"]).groupby("platform").groups.items():
        df.loc[idx, "p_holm"] = multipletests(df.loc[idx, "p"], method="holm")[1]

    def verdict(r) -> str:
        if not np.isfinite(r.get("ratio", np.nan)):
            return "нет данных"
        if r["lo"] >= 1 - EQUIV_MARGIN and r["hi"] <= 1 + EQUIV_MARGIN:
            return "≈ равны"
        if (r["lo"] > 1 or r["hi"] < 1) and r["p_holm"] < ALPHA:
            return f"больше на {r['ratio'] - 1:.0%}" if r["ratio"] > 1 else f"меньше на {1 - r['ratio']:.0%}"
        return "не ясно"

    df["вывод"] = df.apply(verdict, axis=1)
    return df


def medians(runs: pd.DataFrame, scenario: str, metrics: dict[str, str], variants: list[str],
            platforms: dict[str, str], load: str = "-") -> pd.DataFrame:
    """
    Таблица в формате отчёта НИР2: строки — показатели, столбцы — варианты.
    Значение — медиана по прогонам (типичный прогон), для каждой платформы свой блок.
    """
    sub = runs[(runs["scenario"] == scenario) & (runs["load"] == load)]
    blocks = []
    for p, ptitle in platforms.items():
        g = sub[sub["platform"] == p].groupby("label")[list(metrics)].median().T
        g = g.reindex(columns=[v for v in variants if v in g.columns])
        g.index = pd.MultiIndex.from_product([[ptitle], [metrics[m] for m in g.index]], names=["платформа", "показатель"])
        blocks.append(g)
    return pd.concat(blocks)
