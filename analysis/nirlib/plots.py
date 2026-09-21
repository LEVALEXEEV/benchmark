"""Единый стиль графиков: приглушённые оси и сетка, цвет закреплён за вариантом."""
from __future__ import annotations

import matplotlib as mpl
import numpy as np
import pandas as pd

from .config import COLORS, FIG_DIR, VARIANTS

INK2, MUTED, GRID, AXIS, SURFACE = "#52514e", "#898781", "#e1e0d9", "#c3c2b7", "#fcfcfb"


def setup() -> None:
    mpl.rcParams.update({
        "figure.dpi": 110, "savefig.dpi": 200, "figure.facecolor": SURFACE, "axes.facecolor": SURFACE,
        "savefig.facecolor": SURFACE, "font.size": 9, "font.sans-serif": ["Helvetica Neue", "Arial", "DejaVu Sans"],
        "axes.edgecolor": AXIS, "axes.labelcolor": INK2, "axes.titlesize": 10, "axes.titleweight": "semibold",
        "axes.titlelocation": "left", "axes.spines.top": False, "axes.spines.right": False, "axes.grid": True,
        "grid.color": GRID, "grid.linewidth": 0.6, "axes.axisbelow": True, "xtick.color": MUTED,
        "ytick.color": MUTED, "xtick.labelcolor": INK2, "ytick.labelcolor": INK2, "legend.frameon": False,
        "legend.fontsize": 8, "lines.linewidth": 1.5, "figure.constrained_layout.use": True,
    })


def save(fig, name: str) -> None:
    FIG_DIR.mkdir(exist_ok=True)
    fig.savefig(FIG_DIR / f"{name}.png", bbox_inches="tight")
    fig.savefig(FIG_DIR / f"{name}.svg", bbox_inches="tight")


def plain_log(axis) -> None:
    """Подписи лог-оси обычными числами (20, 50, 100), а не 2×10¹."""
    axis.set_major_formatter(mpl.ticker.FuncFormatter(lambda v, _: f"{v:g}"))
    axis.set_minor_formatter(mpl.ticker.NullFormatter())


def runs_by_variant(ax, data: pd.DataFrame, metric: str, variants: list[str], log: bool = False) -> None:
    """Ящик с усами по прогонам и сами прогоны точками: видно и типичное значение, и разброс."""
    variants = [v for v in variants if v in set(data["label"])]
    for i, v in enumerate(variants):
        vals = data.loc[data["label"] == v, metric].dropna().to_numpy(float)
        if not len(vals):
            continue
        ax.boxplot(vals, positions=[i], widths=0.5, showfliers=False, medianprops={"color": COLORS[v], "lw": 2},
                   boxprops={"color": AXIS}, whiskerprops={"color": AXIS}, capprops={"color": AXIS})
        jitter = np.random.default_rng(i).uniform(-0.12, 0.12, len(vals))
        ax.scatter(i + jitter, vals, s=12, color=COLORS[v], alpha=0.7, lw=0, zorder=3)
    ax.set_xticks(range(len(variants)), [VARIANTS[v] for v in variants], rotation=20, ha="right")
    ax.grid(axis="x", visible=False)
    if log:
        ax.set_yscale("log")
        plain_log(ax.yaxis)


def fps_lines(ax) -> None:
    """Бюджеты 60 и 30 FPS на оси времени кадра."""
    for y, name in ((1000 / 60, "60 FPS"), (1000 / 30, "30 FPS")):
        ax.axhline(y, color=MUTED, ls="--", lw=1)
        ax.annotate(name, (0, y), xycoords=("axes fraction", "data"), xytext=(2, 2),
                    textcoords="offset points", fontsize=7, color=MUTED)
