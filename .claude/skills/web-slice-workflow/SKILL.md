---
name: web-slice-workflow
description: "Use when working on any code in web-slice/ (the three.js/TS game client). Covers commands (tsc/vitest/dev server), the window.__* self-test API, fixed-step physics, and the module boundaries the code must respect."
---

# Web Slice Workflow

`web-slice/` — three.js + TypeScript + Vite клиент, порт с Godot bicycle-физики. Node/npm стек, полностью отдельный от `server/` (Express) и замороженного Godot-проекта.

## Команды (ВСЕГДА из папки `web-slice/`, не из корня репо!)

```bash
cd web-slice
npx tsc --noEmit        # typecheck, без вывода файлов
npx vitest run          # весь test suite один раз (не watch)
npm run dev             # Vite dev server, host:true, strictPort → 0.0.0.0:8090
```

Также есть `npm test` (= `vitest run`) и `npm run build`/`npm run preview` (prod build — на 2026-07-07 ещё не настроен `rollupOptions.input` для второго entry `editor.html`, single-entry build работает).

**Hard gate перед любым коммитом в `web-slice/`:** `npx tsc --noEmit` без ошибок И `npx vitest run` весь зелёный. Это не рекомендация — как failing test в остальном репо, красный tsc/vitest блокирует коммит.

## Dev-сервер: открывать по LAN IP, не localhost

Игра: `http://192.168.0.101:8090/` (или актуальный LAN IP машины с сервером — проверить `ipconfig`/`ifconfig`, IP может смениться). Редактор карт: `http://192.168.0.101:8090/editor.html`.

**Почему не localhost:** сессия Claude Code и Chrome с claude-in-chrome MCP иногда сидят на разных машинах/сетевых namespace — `localhost` в браузере не резолвится на сервер, который слушает на другом хосте. LAN IP работает всегда. Это не гипотетическая проблема — реально ловили (P0, 2026-07-06).

## Самотестирование без участия человека

Игра предоставляет `window.__*` API (единственный источник истины: `web-slice/src/debug/telemetry.ts` — читай его при любом сомнении, комментарий в файле явно говорит "external self-test scripts are wired to these exact names — do not rename without updating the scripts"):

| API | Назначение |
|---|---|
| `window.__ready` | `true` когда карта+модель машинки догрузились асинхронно. Ждать перед любым скриптованным тестом — до этого физика едет на fallback-плоскости (height=0). |
| `window.__runScript(steps)` | `steps: {throttle, steer, ms}[]` — детерминированный заезд в **sim-времени** (не wall-clock). Возвращает строку-подтверждение. Управление — ТОЛЬКО через это (нет "удержания клавиши" в claude-in-chrome `computer.key`, только press). |
| `window.__scriptDone` | `true` когда текущий `__runScript` дошёл до конца — поллить перед чтением финального состояния. |
| `window.__reset()` | Сбрасывает карт в spawn и чистит trace-буфер. |
| `window.__telemetry` | Снимок последнего substep'а: `x,z,y,yaw,omega,speed,fwdSpeed,latSpeed,throttle,steer,driftIntensity,driftActive,engageFactor,driftPower,rearGripMult,rearLat,scriptDone`. |
| `window.__trace` | Кольцевой буфер (макс 600 записей, сэмпл каждые 0.1 sim-сек) той же структуры — вся история заезда для анализа траектории. |
| `window.__camMode` | `"chase"` (дефолт) / `"top"` — переключение клавишей `C`, программно тоже можно выставить. |
| `window.__topHeight` | Высота top-камеры (число, крутить из консоли для зума при диагностике). |
| `window.__map`, `window.__scene` | Выставляются после загрузки карты (`Telemetry.setMapHandles`) — сырые ссылки на `GameMap` и `THREE.Scene` для vertex-инспекции прямо из консоли/скрипта (см. `map-building-js` скилл). |

Типичный self-test цикл: открыть URL через claude-in-chrome → дождаться `window.__ready` → `window.__runScript([...])` → поллить `window.__scriptDone` → прочитать `window.__trace`/`window.__telemetry` → сделать вывод по числам (радиус поворота, скорость, drift intensity), не только по скриншоту. Скриншоты дополняют, не заменяют телеметрию — визуальные баги (например, невидимая стена, меш едет не туда) всё равно требуют скриншота/GIF.

## Физика — почему setInterval, не requestAnimationFrame

`src/core/loop.ts` (`FixedStepLoop`) + `src/main.ts`: физика тикает на `setInterval(physTick, 50)` с фиксированным substep `PHYS_STEP = 1/120` и catch-up по wall-clock (макс ~1.1 сек за тик, чтобы долгий стол — свёрнутая вкладка — не улетел в спираль). Отдельно `requestAnimationFrame` дергает тот же `physTick()` + рендер + камеру, но **rAF НЕ является источником физического времени**.

Причина: Chrome полностью останавливает rAF (0 fps) для occluded/background окон — если бы физика жила на rAF, агент, тестирующий игру в фоновой вкладке, увидел бы замёршую сцену. `setInterval` продолжает тикать в фоне.

Скриптовые заезды (`__runScript`) идут в **sim-time** (счётчик `simTime` в `Telemetry`, шаг `ScriptStep.ms` расходуется по substep'ам) — значит результат детерминирован независимо от реального fps браузера/машины.

## Правило smooth-values применяется и в TS

`.claude/rules/smooth-values.md` — не GDScript-специфика, действует для всего continuous-физике-кода в `web-slice/src/physics/` и визуального сглаживания (камера, наклон карта, drift intensity). Экспоненциальные фильтры `1 - exp(-rate * dt)`, `smoothstep` для порогов, никаких `if x > threshold` скачков в значениях, которые в реальности непрерывны. `driftContinuous.ts` (v4.0) — эталонный пример: один непрерывный signed сигнал вместо бинарной state machine (`driftStateMachine.ts` оставлен только для сравнения/тестов, не для новой логики).

## Архитектурные инварианты (не нарушать без явного решения)

- **`main.ts` — тонкий boot-файл.** Вся логика разнесена по модулям: `core/` (camera, input, loop — общая инфраструструктура), `kart/` (модель+статы), `map/` (loader+assets), `fx/` (skidMarks, sky — визуальные эффекты без геймплейной логики), `debug/` (telemetry/window API), `physics/` (чистая математика, без THREE-зависимостей). Новый код почти никогда не идёт в `main.ts` — найди подходящий модуль или создай новый в правильной директории.
- **Новая машинка = запись в `KART_TYPES`** (`src/kart/stats.ts`), НЕ правка физики. `KartStats.physics: Partial<KartPhysicsParams>` накладывается на `DEFAULT_KART_PHYSICS_PARAMS` (`buildKartPhysicsParams`, юнит-тестируемая чистая функция). Если нужен другой wheelbase/trackWidth на новый тип — сейчас все карты используют единый `DEFAULT_AXLE_GEOMETRY` (`kart/kart.ts`) — добавить per-kart override только когда реально понадобится второй тип, не заранее.
- **Будущее оружие (P2) — тот же паттерн**: registry конфигов (аналог `KART_TYPES`), не хардкод в игровом цикле.
- **Данные отдельно от логики**: `KartStats`/будущие weapon-конфиги — plain data объекты, физика/меши их читают, не наоборот.
- Синхронизация палитры редактора и игры: `MAP_ASSETS` в `main.ts` и `PALETTE`/`ASSET_NAMES` в `editor/main.ts` перечисляют одни и те же ассеты — если добавляешь новый тайл/проп в один список, добавь и в другой, иначе Drive-карта из редактора молча теряет плитки при загрузке в игру (реальный баг, уже случался и был исправлен, 2026-07-06).

## Один change = один тест

Любой новый кусок логики (не рендер, не чисто визуальный твик) — сразу же юнит-тест в `vitest`. Примеры соседних test-файлов: `physics/bicyclePhysics.test.ts`, `physics/driftContinuous.test.ts`, `map/mapLoader.test.ts`, `kart/stats.test.ts` — смотри на них как на образец стиля (Vitest `describe/it/expect`, чистые функции без THREE где возможно).

## Временные/диагностические файлы — НЕ в `src/`

`npx vitest run` подхватывает **любой** `*.test.ts` под `src/`. Одноразовый скретч-скрипт для диагностики (например, ручной прогон heightfield-сканера) кладётся в `tools/` (корень репо, рядом с `tools/glb-catalog.mjs`) или запускается вне репозитория — никогда в `web-slice/src/**`, даже "временно". Реальный инцидент: скретч-тест, оставленный в `src/`, сломался после параллельного рефакторинга другого агента и заблокировал `vitest run` для всех.
