#!/usr/bin/env python3
"""
Разбор пилота: разброс метрик МЕЖДУ ПРОГОНАМИ и необходимое число повторов.

Единица анализа — прогон, а не кадр: кадры внутри прогона автокоррелированы,
и по ним нельзя судить о воспроизводимости. Поэтому из каждого прогона берётся
одна робастная величина (медиана или готовая сводная метрика), а разброс
считается по прогонам одной ячейки плана «сценарий × вариант × точка нагрузки».

Число повторов оценивается на логарифмической шкале: сравниваются отношения
величин (во сколько раз), а не разности, и распределения времён правее нуля.
    n на группу = 2 (z(1-a/2) + z(1-b))^2 * sd_log^2 / ln(1+delta)^2

Только стандартная библиотека: на этапе пилота окружение для анализа ещё не
разворачивается (основной анализ — Python + Jupyter, этап 5).
"""
from __future__ import annotations

import json
import math
import statistics as st
import sys
from collections import defaultdict
from pathlib import Path

# z для alpha = 0.05 (двусторонний) и мощности 0.8
Z_ALPHA = 1.959964
Z_POWER = 0.841621
# относительные эффекты, для которых считаем нужное n
EFFECTS = (0.05, 0.10)

# какие величины прогона берём по типу результата
METRICS: dict[str, tuple[str, ...]] = {
    "frame": ("frame_ms_median", "frame_ms_p99", "fps_p1_low", "gpu_ms_median", "framework_share"),
    "init": ("ttfr_submit_ms", "init_ms", "js_ready_ms", "tbt_to_ttfr_ms"),
    "input": ("latency_render_ms_median", "latency_render_ms_p95", "apply_ms_median"),
    "scale": ("capacity_fps60", "capacity_fps30"),
}


def run_values(result: dict) -> dict[str, float]:
    kind = result["kind"]
    if kind == "frame":
        s = result["summary"]
        out = {k: s.get(k) for k in ("frame_ms_median", "frame_ms_p99", "fps_p1_low", "gpu_ms_median")}
        # доля кадра, не относящаяся к renderer.render(): обновления сцены и работа между кадрами
        frame, upd, oth = s["frame_ms_median"], s["update_ms_median"], s["other_ms_median"]
        out["framework_share"] = (upd + oth) / frame if frame else None
        return out
    if kind == "init":
        return {k: result.get(k) for k in METRICS["init"]}
    if kind == "input":
        return {k: result["summary"].get(k) for k in METRICS["input"]}
    if kind == "scale":
        return {k: result.get(k) for k in METRICS["scale"]}
    return {}


def required_n(sd_log: float, effect: float) -> float:
    if sd_log <= 0:
        return 1.0
    return 2 * (Z_ALPHA + Z_POWER) ** 2 * sd_log**2 / math.log1p(effect) ** 2


def collect(root: Path) -> dict[tuple[str, str, str, str], dict[str, list[float]]]:
    cells: dict[tuple[str, str, str, str], dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    for manifest_path in sorted(root.rglob("manifest.json")):
        manifest = json.loads(manifest_path.read_text())
        scenario = manifest["config"]["scenario"]
        browser = manifest["config"]["browser"]
        for row in manifest["runs"]:
            if row["warmup"]:
                continue
            result = json.loads((manifest_path.parent / row["file"]).read_text())["result"]
            key = (browser, scenario, row["label"], row.get("load", "-"))
            for name, value in run_values(result).items():
                if isinstance(value, (int, float)):
                    cells[key][name].append(float(value))
    return cells


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "results")
    cells = collect(root)
    if not cells:
        print(f"Не найдено прогонов в {root}")
        return 1

    print(f"# Разброс между прогонами и требуемое n\n\nИсточник: {root}\n")
    header = "| сценарий | вариант | точка | метрика | n | медиана | CV, % | n для 5% | n для 10% |"
    print(header)
    print("|" + "---|" * 9)
    for (browser, scenario, label, load), metrics in sorted(cells.items()):
        for name in METRICS.get(next_kind(scenario), ()):  # порядок метрик как в METRICS
            values = metrics.get(name)
            if not values or len(values) < 2:
                continue
            median = st.median(values)
            cv = st.stdev(values) / st.mean(values) * 100 if st.mean(values) else float("nan")
            # логарифмическая шкала неприменима, если величина бывает нулевой
            # (например, apply_ms у императивных путей — там сравнивать нечего)
            if all(v > 0 for v in values):
                sd_log = st.stdev([math.log(v) for v in values])
                ns = [str(math.ceil(required_n(sd_log, e))) for e in EFFECTS]
            else:
                ns = ["—", "—"]
            print(
                f"| {scenario} | {label} | {load} | {name} | {len(values)} | {median:.4g} | {cv:.1f} "
                f"| {ns[0]} | {ns[1]} |"
            )
    print_comparison(cells)
    print(
        "\nCV — коэффициент вариации между прогонами. Столбцы «n для X%» — сколько прогонов\n"
        "нужно на КАЖДЫЙ вариант, чтобы обнаружить относительную разницу X% при alpha=0,05\n"
        "и мощности 0,8. Для проверки эквивалентности (H1) требуется примерно столько же\n"
        "при границе эквивалентности, равной X."
    )
    return 0


def print_comparison(cells: dict) -> None:
    """Медианы по вариантам и отношение к three.js — предварительный взгляд на эффекты."""
    print("\n\n# Медианы по вариантам (отношение к three.js)\n")
    by_cell: dict[tuple[str, str, str], dict[str, float]] = defaultdict(dict)
    for (_browser, scenario, label, load), metrics in cells.items():
        for name, values in metrics.items():
            if values:
                by_cell[(scenario, load, name)][label] = st.median(values)

    prev_key = None
    for (scenario, load, name), by_label in sorted(by_cell.items()):
        if not by_label:
            continue
        key = (scenario, load)
        if key != prev_key:
            title = f"## {scenario}" + (f", точка {load}" if load != "-" else "")
            print(f"\n{title}\n")
            print("| метрика | " + " | ".join(sorted(by_label)) + " |")
            print("|" + "---|" * (len(by_label) + 1))
            prev_key = key
        base = by_label.get("threejs")
        cells_out = []
        for label in sorted(by_label):
            v = by_label[label]
            ratio = f" (×{v / base:.2f})" if base and label != "threejs" and base > 0 else ""
            cells_out.append(f"{v:.4g}{ratio}")
        print(f"| {name} | " + " | ".join(cells_out) + " |")


def next_kind(scenario: str) -> str:
    return {"s1": "frame", "s2": "frame", "s3": "init", "s4": "input", "s5": "scale"}[scenario]


if __name__ == "__main__":
    raise SystemExit(main())
