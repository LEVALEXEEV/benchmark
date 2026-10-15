"""Общие параметры анализа: пути, кампания, пул платформ, подписи вариантов, правила протокола."""
from pathlib import Path

ANALYSIS_DIR = Path(__file__).resolve().parents[1]
RESULTS_DIR = ANALYSIS_DIR.parent / "results"
FIG_DIR = ANALYSIS_DIR / "figures"
TABLE_DIR = ANALYSIS_DIR / "tables"
DATA_DIR = ANALYSIS_DIR / "data"

# Кампания r2 — серии по протоколу 2026-09-21. Первая основная серия (main,
# preview, pilot, dev) — история: в выводы не идёт, её разбор в archive/main.
PRIMARY_CAMPAIGNS = ("r2",)

# Платформа = «устройство · браузер» по папке серии (device — первые три слова)
PLATFORMS = {
    "apple-m4 · chromium": "Apple M4 · Chromium",
    "apple-m4 · webkit": "Apple M4 · WebKit",
    "amd-ryzen-5 · chromium": "AMD Ryzen 5 · Chromium",
    "amd-ryzen-5 · firefox": "AMD Ryzen 5 · Firefox",
}
# В WebKit vsync не снимается (кадр ≤ 60 FPS): сравнение по фазам кадра, не по FPS
VSYNC_CAPPED = {"apple-m4 · webkit"}

# Матрица пула (nir3-plan.md, раздел 1, поправка 2026-10-15): одна сессия,
# только обязательные серии. Платформа, условие → сценарии
POOL = {
    ("apple-m4 · chromium", "base"): "s1 s2 s3 s4 s5",
    ("apple-m4 · chromium", "trace"): "s2",
    ("apple-m4 · webkit", "base"): "s2 s3 s4",
    ("apple-m4 · chromium", "cpu×4"): "s2 s3 s4",
    ("apple-m4 · chromium", "slow4g"): "s3",
    ("amd-ryzen-5 · chromium", "base"): "s1 s2 s3 s4 s5",
    ("amd-ryzen-5 · chromium", "trace"): "s2",
    ("amd-ryzen-5 · firefox", "base"): "s1 s2 s3 s4 s5",
}
# Повторов на ячейку (протокол, раздел 4)
RUNS_PER_CELL = {"s1": 10, "s2": 30, "s3": 30, "s4": 20, "s5": 8}

# Исключение прогонов по предупреждениям harness (протокол, раздел 5).
# Ключ — подстрока текста предупреждения, значение — исключать ли прогон.
# Две проверки-эвристики удалены из harness как ошибочные (поправка
# 2026-10-15), но их предупреждения остались в данных r2 — не исключаем.
WARNING_POLICY = {
    "vsync не снят": False,         # S2 cpu×4 на M4: кадр упирается в CPU и совпадает с 60 FPS
    "повтор уровня": False,         # S5: повтор после тяжёлых уровней — гистерезис кучи JS
}
EXCLUDE_UNKNOWN_WARNINGS = True

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

# Границы эквивалентности (протокол, раздел 5): центральные метрики — 5%,
# хвостовые и задержка S4 — 10%
EQUIV_MARGIN = 0.05
EQUIV_MARGIN_TAIL = 0.10
ALPHA = 0.05
N_BOOT = 10_000
SEED = 20260921
