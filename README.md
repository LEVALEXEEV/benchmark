# Стенд: three.js vs react-three-fiber

Воспроизводимое сравнение производительности императивного `three.js` и
декларативного `react-three-fiber` (R3F) на одинаковых сценах.

## Принципы

1. **Одна спецификация сцены** (`packages/scene-spec`) — контент и параметры
   рендерера. Реализации различаются только способом управления сценой.
2. **Одинаковые точки замера**: `beginFrame → update → beginRender → render →
   endRender` в обеих реализациях; коллекторы общие (`packages/metrics`).
3. **Проверка паритета перед каждой серией**: снимки сцены всех вариантов
   сравниваются с three.js вплоть до побитового равенства кадра.
4. **Условия эксперимента контролируются**: production-сборка, cross-origin
   isolation (таймер 5 мкс), рандомизированный порядок прогонов, паузы,
   метаданные среды, сырые ряды в датасете. Нарушение условий прерывает серию.

## Сценарии

| ID | Нагрузка | Варианты |
|----|----------|----------|
| S1 | 3000 TorusKnot, PBR, тени, орбита камеры | threejs, r3f-ref, r3f-ref+parent-state* |
| S2 | 3000 анимированных Box | threejs, r3f-ref, r3f-ref-central, r3f-state, r3f-ref+parent-state |
| S3 | холодный старт, 100 TorusKnot | threejs, r3f |
| S4 | задержка ввода, 2000 Box, клик → подсветка | threejs, r3f-ref, r3f-state, r3f-events |
| S5 | свип числа объектов 100…51200 (шаг √2) | threejs, r3f-ref, r3f-ref-central, r3f-state |

\* только по `--targets`.

## Запуск

```bash
npm install
npm run typecheck
npm run bench:parity -- s1        # проверка паритета сцены
npm run bench:s2                   # серия S2 в Google Chrome
npm run bench -- --scenario s5 --browser webkit --iterations 3
```

Результаты: `results/<устройство>/<браузер>/<сценарий>/<время>/`
- `manifest.json` — конфигурация, окружение (хост, браузер, git-коммит, версии),
  размер бандлов, отчёт паритета, порядок и краткие сводки прогонов;
- `parity.json` — подробный отчёт паритета;
- `runs/NNN_<вариант>_<i|w><номер>.json` — полный результат прогона: meta,
  сводка, сырые ряды (кадры, клики, уровни), термальное состояние, проверки.

Ручной просмотр: `npm run dev:r3f` → `http://localhost:5174/?scenario=s4&mode=events`.
