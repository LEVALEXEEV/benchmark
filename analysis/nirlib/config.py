"""Общие параметры анализа: пути, порядок и подписи вариантов, порог «практически равны»."""
from pathlib import Path

ANALYSIS_DIR = Path(__file__).resolve().parents[1]
RESULTS_DIR = ANALYSIS_DIR.parent / "results"
FIG_DIR = ANALYSIS_DIR / "figures"
TABLE_DIR = ANALYSIS_DIR / "tables"
DATA_DIR = ANALYSIS_DIR / "data"

# Основная серия на каждой платформе. На M4 серий несколько (pilot, dev,
# preview) — в анализ идёт одна, preview; остальные были проверкой протокола.
PRIMARY_CAMPAIGNS = ("main", "preview")

PLATFORMS = {
    "apple-m4 · chrome": "Apple M4 · Chrome",
    "amd-ryzen-5 · chrome": "AMD Ryzen 5 · Chrome",
    "amd-ryzen-5 · firefox": "AMD Ryzen 5 · Firefox",
}

BASELINE = "threejs"
VARIANTS = {
    "threejs": "three.js",
    "r3f": "R3F",
    "r3f-ref": "R3F ref",
    "r3f-ref-central": "R3F ref-central",
    "r3f-events": "R3F events",
    "r3f-state": "R3F state",
    "r3f-ref+parent-state": "R3F ref + parent-state",
}
# цвет закреплён за вариантом; r3f (S3) и r3f-ref — одна сборка, один цвет
COLORS = {
    "threejs": "#2a78d6",
    "r3f": "#eb6834",
    "r3f-ref": "#eb6834",
    "r3f-ref-central": "#1baf7a",
    "r3f-events": "#008300",
    "r3f-state": "#eda100",
    "r3f-ref+parent-state": "#e87ba4",
}

# Разница меньше 5% считается практически несущественной (порог из протокола пилота)
EQUIV_MARGIN = 0.05
ALPHA = 0.05
N_BOOT = 10_000
SEED = 20260921
