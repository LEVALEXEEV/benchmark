#!/usr/bin/env python3
"""
Разбор серий стенда: отдельно по устройству, браузеру, сценарию и кампании.

Почему так дробно: устройства различаются железом и драйверами, браузеры —
движком и политикой кадров (в Firefox здесь не снят vsync), а кампании
разнесены во времени. Дрейф между сессиями на одной машине достигает 8% при
разбросе между прогонами 1,6%, поэтому варианты сравниваются ТОЛЬКО внутри
своей сессии, где они чередовались в рандомизированном порядке.

Единица анализа — прогон. Из каждого берётся одна робастная величина, по
прогонам ячейки считается медиана, а различие выражается отношением медиан
варианта и three.js с доверительным интервалом бутстрапа.

Вывод (эквивалентность / различие / неопределённо) строится по 90-процентному
интервалу отношения: это двусторонняя проверка на уровне 0,05, то есть для
эквивалентности интервал целиком должен лежать в границах ±5%, а для вывода о
различии — не накрывать единицу.

Только стандартная библиотека.
"""
from __future__ import annotations

import json
import math
import random
import statistics as st
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

BOOTSTRAP_REPS = 5000
BOOTSTRAP_SEED = 20260921
CI_ALPHA = 0.10          # 90% интервал ⇔ две односторонние проверки по 0,05
EQUIV_MARGIN = 0.05      # граница эквивалентности ±5%
BASELINE = "threejs"

# метрика прогона по типу результата; первая — основная
METRICS: dict[str, tuple[str, ...]] = {
    "frame": ("frame_ms_median", "frame_ms_p99", "fps_p1_low", "gpu_ms_median", "framework_share", "jank_60_share", "heap_mb_peak"),
    "init": ("ttfr_submit_ms", "init_ms", "js_ready_ms", "heap_mb_at_ttfr"),
    "input": ("latency_render_ms_median", "latency_render_ms_p95", "dispatch_ms_median", "apply_ms_median"),
    "scale": ("capacity_fps60", "capacity_fps30"),
}
KIND_BY_SCENARIO = {"s1": "frame", "s2": "frame", "s3": "init", "s4": "input", "s5": "scale"}
PRIMARY = {k: v[0] for k, v in METRICS.items()}

# vsync снят не везде: кадр, упёршийся в частоту монитора, сравнивать нельзя
VSYNC_WARNING = "vsync не снят"


def short_device(name: str) -> str:
    parts = name.split("-")
    return "-".join(parts[:3]) if len(parts) > 3 else name


@dataclass
class Session:
    device: str
    browser: str
    scenario: str
    campaign: str
    stamp: str
    browser_version: str
    commit: str
    parity_ok: bool | None
    bundles: dict[str, float]
    # (вариант, точка нагрузки) -> метрика -> значения по прогонам
    cells: dict[tuple[str, str], dict[str, list[float]]] = field(default_factory=lambda: defaultdict(lambda: defaultdict(list)))
    vsync_capped: set[tuple[str, str]] = field(default_factory=set)
    warnings: int = 0

    @property
    def kind(self) -> str:
        return KIND_BY_SCENARIO[self.scenario]


def run_values(result: dict) -> dict[str, float]:
    kind = result["kind"]
    if kind == "frame":
        s = result["summary"]
        out = {k: s.get(k) for k in ("frame_ms_median", "frame_ms_p99", "fps_p1_low", "gpu_ms_median", "jank_60_share", "heap_mb_peak")}
        frame, upd, oth = s["frame_ms_median"], s["update_ms_median"], s["other_ms_median"]
        # доля кадра вне renderer.render(): обновление сцены и работа между кадрами
        out["framework_share"] = (upd + oth) / frame if frame else None
        return out
    if kind == "init":
        return {k: result.get(k) for k in METRICS["init"]}
    if kind == "input":
        return {k: result["summary"].get(k) for k in METRICS["input"]}
    if kind == "scale":
        return {k: result.get(k) for k in METRICS["scale"]}
    return {}


def load_sessions(root: Path) -> list[Session]:
    sessions: list[Session] = []
    for manifest_path in sorted(root.rglob("manifest.json")):
        rel = manifest_path.relative_to(root).parts  # device/browser/scenario/stamp/manifest.json
        if len(rel) != 5:
            continue
        manifest = json.loads(manifest_path.read_text())
        cfg, host = manifest["config"], manifest["host"]
        folder = rel[3]
        # каталог может быть помечен кампанией: «preview 2026-…», «pilot 2026-…»
        campaign, _, stamp = folder.partition(" ")
        if not stamp:
            campaign, stamp = "main", folder
        parity = manifest.get("parity")
        parity_ok = all(p["ok"] for p in parity) if isinstance(parity, list) else (parity or {}).get("ok")
        s = Session(
            device=short_device(rel[0]),
            browser=rel[1],
            scenario=cfg["scenario"],
            campaign=campaign,
            stamp=stamp,
            browser_version=str((manifest.get("browser") or {}).get("version", "?")).split(".")[0],
            commit=(host["git"]["commit"] or "")[:7],
            parity_ok=parity_ok,
            bundles={b["impl"]: b["total_gzip_bytes"] / 1024 for b in (manifest.get("bundles") or [])},
        )
        for row in manifest["runs"]:
            if row["warmup"]:
                continue
            s.warnings += len(row["validity"]["warnings"])
            key = (row["label"], row.get("load", "-"))
            if any(VSYNC_WARNING in w for w in row["validity"]["warnings"]):
                s.vsync_capped.add(key)
            result = json.loads((manifest_path.parent / row["file"]).read_text())["result"]
            for name, value in run_values(result).items():
                if isinstance(value, (int, float)) and not math.isnan(value):
                    s.cells[key][name].append(float(value))
        sessions.append(s)
    return sessions


def ratio_ci(variant: list[float], base: list[float]) -> tuple[float, float, float]:
    """Отношение медиан и перцентильный бутстрап-интервал."""
    rng = random.Random(BOOTSTRAP_SEED)
    point = st.median(variant) / st.median(base)
    ratios = []
    for _ in range(BOOTSTRAP_REPS):
        mb = st.median(rng.choices(base, k=len(base)))
        if mb:
            ratios.append(st.median(rng.choices(variant, k=len(variant))) / mb)
    ratios.sort()
    lo = ratios[int(CI_ALPHA / 2 * len(ratios))]
    hi = ratios[min(len(ratios) - 1, int((1 - CI_ALPHA / 2) * len(ratios)))]
    return point, lo, hi


def verdict(lo: float, hi: float) -> str:
    if lo >= 1 - EQUIV_MARGIN and hi <= 1 + EQUIV_MARGIN:
        return f"эквивалентно (±{EQUIV_MARGIN:.0%})"
    if lo > 1 or hi < 1:
        return "различие"
    return "неопределённо"


def cv(xs: list[float]) -> float:
    m = st.mean(xs)
    return st.stdev(xs) / m * 100 if len(xs) > 1 and m else float("nan")


def print_inventory(sessions: list[Session]) -> None:
    print("# Состав данных\n")
    print("| устройство | браузер | сценарий | кампания | ячеек | прогонов | паритет | предупр. | коммит |")
    print("|" + "---|" * 9)
    for s in sessions:
        runs = sum(len(v[PRIMARY[s.kind]]) for v in s.cells.values())
        print(
            f"| {s.device} | {s.browser} {s.browser_version} | {s.scenario} | {s.campaign} | {len(s.cells)} "
            f"| {runs} | {'да' if s.parity_ok else 'НЕТ'} | {s.warnings} | {s.commit} |"
        )


def print_session(s: Session) -> None:
    metrics = METRICS[s.kind]
    primary = PRIMARY[s.kind]
    loads = sorted({load for _, load in s.cells})
    print(f"\n### {s.scenario} · {s.campaign} · {s.stamp[:10]}\n")
    if s.bundles:
        print(f"Бандлы (gzip): " + ", ".join(f"{k} {v:.1f} КБ" for k, v in sorted(s.bundles.items())) + "\n")
    print("| точка | вариант | n | медиана | CV, % | к three.js | 90% ДИ | вывод |")
    print("|" + "---|" * 8)
    for load in loads:
        base_vals = s.cells.get((BASELINE, load), {}).get(primary)
        for (label, ld), values in sorted(s.cells.items()):
            if ld != load or primary not in values:
                continue
            vals = values[primary]
            note = " ⚠vsync" if (label, ld) in s.vsync_capped else ""
            if label == BASELINE or not base_vals:
                print(f"| {load} | {label}{note} | {len(vals)} | {st.median(vals):.4g} | {cv(vals):.1f} | — | — | эталон |")
                continue
            point, lo, hi = ratio_ci(vals, base_vals)
            print(
                f"| {load} | {label}{note} | {len(vals)} | {st.median(vals):.4g} | {cv(vals):.1f} "
                f"| ×{point:.3f} | {lo:.3f}–{hi:.3f} | {verdict(lo, hi)} |"
            )
    # остальные метрики — без интервалов, для интерпретации механизма
    extra = [m for m in metrics if m != primary]
    if extra:
        print(f"\nОстальные метрики (медианы по прогонам):\n")
        header = "| точка | вариант | " + " | ".join(extra) + " |"
        print(header)
        print("|" + "---|" * (len(extra) + 2))
        for (label, ld), values in sorted(s.cells.items()):
            cells = [f"{st.median(values[m]):.4g}" if values.get(m) else "—" for m in extra]
            print(f"| {ld} | {label} | " + " | ".join(cells) + " |")


def print_cross_summary(sessions: list[Session], campaigns: tuple[str, ...] = ("main", "preview")) -> None:
    """
    Сводка по связкам «устройство · браузер»: отношение к three.js с 90% ДИ.

    Берутся только основные кампании; повторные (pilot, dev) остаются в
    подробных разделах как проверка воспроизводимости.
    """
    targets = sorted({(s.device, s.browser) for s in sessions if s.campaign in campaigns})
    rows: dict[tuple[str, str, str], dict[tuple[str, str], str]] = defaultdict(dict)
    for s in sessions:
        if s.campaign not in campaigns:
            continue
        primary = PRIMARY[s.kind]
        for (label, load), values in s.cells.items():
            if label == BASELINE or primary not in values:
                continue
            base = s.cells.get((BASELINE, load), {}).get(primary)
            if not base:
                continue
            point, lo, hi = ratio_ci(values[primary], base)
            mark = {"различие": "", "неопределённо": " ?"}.get(verdict(lo, hi), " =")
            cap = " ⚠" if (label, load) in s.vsync_capped or (BASELINE, load) in s.vsync_capped else ""
            rows[(s.scenario, load, label)][(s.device, s.browser)] = f"×{point:.2f} [{lo:.2f}–{hi:.2f}]{mark}{cap}"

    print("\n\n# Сводка: отношение к three.js по связкам «устройство · браузер»\n")
    print("Знак «=» — эквивалентность в пределах ±5%, «?» — интервал слишком широк,")
    print("без знака — различие значимо. «⚠» — ячейка упёрлась в vsync.\n")
    print("| сценарий | метрика | вариант | " + " | ".join(f"{d} · {b}" for d, b in targets) + " |")
    print("|" + "---|" * (len(targets) + 3))
    for (scenario, load, label), by_target in sorted(rows.items()):
        metric = PRIMARY[KIND_BY_SCENARIO[scenario]]
        name = scenario + ("" if load == "-" else f" [{load}]")
        cells = [by_target.get(t, "—") for t in targets]
        print(f"| {name} | {metric} | {label} | " + " | ".join(cells) + " |")


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "results"
    sessions = load_sessions(root)
    if not sessions:
        print(f"Не найдено сессий в {root}")
        return 1
    print(f"<!-- источник: {root}; бутстрап {BOOTSTRAP_REPS} повторов, seed {BOOTSTRAP_SEED} -->\n")
    print_inventory(sessions)
    print_cross_summary(sessions)
    by_target: dict[tuple[str, str], list[Session]] = defaultdict(list)
    for s in sessions:
        by_target[(s.device, s.browser)].append(s)
    for (device, browser), group in sorted(by_target.items()):
        print(f"\n\n## {device} · {browser}\n")
        for s in sorted(group, key=lambda x: (x.scenario, x.campaign)):
            print_session(s)
    print(
        f"\n\n---\n\nВывод об эквивалентности: 90% интервал отношения целиком внутри "
        f"±{EQUIV_MARGIN:.0%}. «Различие» — интервал не накрывает 1. «⚠vsync» — кадр упёрся "
        f"в частоту монитора, сравнение времени кадра в этой ячейке недействительно."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
