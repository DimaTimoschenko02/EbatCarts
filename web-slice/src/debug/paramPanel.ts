// Dev-only physics param tuner overlay. Sibling in spirit to the Godot-era
// tools/param_tuner.html (repo root, pre-migration) — same idea (live
// slider → instant feel, persisted to disk/storage, human-language
// descriptions per .claude/rules/param-tuner-descriptions.md) ported to the
// web-slice's params object.
//
// Live-apply mechanism: Kart.physicsParams returns the SAME KartPhysicsParams
// object BicyclePhysics and ContinuousDrift were constructed with (both take
// it by reference, never clone — see their constructors). So every slider
// here just writes `params[key] = value` directly; the very next physics
// substep reads the new number. No patch/dispatch layer needed.
//
// Toggle: P key. Persistence: localStorage["sk-dev-params"], only the fields
// that differ from DEFAULT_KART_PHYSICS_PARAMS (so a future change to a
// default doesn't get silently pinned by a stale override the user never
// touched).
import { DEFAULT_KART_PHYSICS_PARAMS, type KartPhysicsParams } from "../physics/types";
import type { Kart } from "../kart/kart";

const STORAGE_KEY = "sk-dev-params";
type ParamKey = keyof KartPhysicsParams;

interface ParamDescriptor {
  key: ParamKey;
  group: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  short: string;
  bool?: boolean;
  // True for fields kept in KartPhysicsParams for legacy/rollback reasons
  // but not read by any code path the running Kart actually exercises
  // (v3.1 DriftStateMachine fields — kart.ts wires ContinuousDrift v4.0
  // instead). Moving these sliders is a no-op in this build; tagged rather
  // than dropped because the task asked for every numeric field, and a
  // silently-missing slider is more confusing than a labeled dead one.
  legacy?: boolean;
}

// ─── Descriptors ─────────────────────────────────────────────────────────
// `short` text ported from tools/param_tuner.html (repo root) where a
// matching Godot key exists (name noted in comments); freshly written in the
// project's human-language style (.claude/rules/param-tuner-descriptions.md)
// for the v4.0-only fields that have no Godot-era equivalent.
const PARAM_DESCRIPTORS: ParamDescriptor[] = [
  // ── Скорость ──────────────────────────────────────────────────────────
  { key: "maxSpeed", group: "Скорость", min: 5, max: 50, step: 0.5, unit: "m/s",
    short: "Условная макс скорость — используется для расчёта дрифта и камеры. НЕ ограничивает реальную скорость напрямую (это задают accelForce и kDrag вместе)." },
  { key: "accelForce", group: "Скорость", min: 10, max: 100, step: 2, unit: "m/s²",
    short: "Сила мотора. Низкое (15-20) — разгон ленивый. Среднее (25-35) — аркадный стандарт. Высокое (50+) — моментальный разгон, пропадает ощущение веса." },
  { key: "kDrag", group: "Скорость", min: 0.01, max: 0.2, step: 0.005, unit: "",
    short: "Сопротивление воздуха — главный ограничитель максималки. При accel=25: 0.02 → ~35 м/с потолок, 0.05 → ~22 м/с, 0.1 → ~16 м/с (густой воздух)." },
  { key: "kRolling", group: "Скорость", min: 0.1, max: 5, step: 0.1, unit: "",
    short: "Трение качения — торможение по инерции когда отпустил газ. 0.5 — долго катится как на льду, 1.5 — стандарт, 4 — почти сразу встаёт." },
  { key: "brakeForce", group: "Скорость", min: 5, max: 60, step: 1, unit: "m/s²",
    short: "Сила торможения кнопкой S. 10-15 — мягкий тормоз (~2-3с с максималки), 20-30 — стандарт, 40-50 — резкий (~0.5-1с)." },
  { key: "reverseRatio", group: "Скорость", min: 0.2, max: 0.8, step: 0.05, unit: "x",
    short: "Сила заднего хода относительно переднего. 0.3 — еле ползёт, 0.5 — удобно для манёвров, 0.7 — почти как вперёд." },
  { key: "mass", group: "Скорость", min: 0.25, max: 4, step: 0.05, unit: "",
    short: "Масса машинки. Влияет на то, как резко тяга/торможение/занос раскручивают и тормозят корпус. Ниже 1 — юркая и лёгкая, выше 1 — тяжёлая, реагирует с задержкой." },

  // ── Сглаживание ввода ────────────────────────────────────────────────
  { key: "steerSlewRateIn", group: "Сглаживание ввода", min: 1, max: 20, step: 0.5, unit: "/s",
    short: "Как быстро руль докручивается до упора при нажатии A/D. 2 — руль тяжёлый (~0.5с до упора), 5 — отзывчиво, 10+ — почти как тумблер." },
  { key: "steerSlewRateOut", group: "Сглаживание ввода", min: 1, max: 15, step: 0.5, unit: "/s",
    short: "Как быстро руль возвращается в центр после отпускания A/D. 1.5 — машина долго катится боком, 3.5 — естественное распрямление, 8+ — мгновенно в центр." },
  { key: "throttleSlewRate", group: "Сглаживание ввода", min: 1, max: 20, step: 0.5, unit: "/s",
    short: "Как быстро газ раскручивается до полного при нажатии W. Маленькое (2) — ощущение педали, большое (10+) — почти мгновенный газ." },

  // ── Рулёжка ──────────────────────────────────────────────────────────
  { key: "steerLowSpeedMult", group: "Рулёжка", min: 0.5, max: 3, step: 0.05, unit: "x",
    short: "Насколько острее руль на малой скорости (для парковки/манёвров). 1.0 — без разницы, 2.0 — очень острый разворот на месте." },
  { key: "steerHighSpeedMult", group: "Рулёжка", min: 0.1, max: 1.5, step: 0.05, unit: "x",
    short: "Насколько руль 'успокаивается' на максимальной скорости. 0.5 — плавные широкие повороты на скорости, 1.0 — руль одинаково острый везде." },

  // ── Bicycle v3.0 ─────────────────────────────────────────────────────
  { key: "maxSteerAngleDeg", group: "Bicycle v3.0", min: 10, max: 55, step: 1, unit: "°",
    short: "Максимальный угол передних колёс — главная ручка остроты руля. 20° — рулится как грузовик, 35° — комфортная аркада, 45°+ — почти дёрганая." },
  { key: "frontGripStiffness", group: "Bicycle v3.0", min: 3, max: 40, step: 0.5, unit: "",
    short: "Сила удержания передней оси — насколько точно нос идёт куда повёрнут руль. 6 — передок сносит как на льду, 17.5 — держит с занесённым задом, 30+ — 'на рельсах'." },
  { key: "rearGripStiffness", group: "Bicycle v3.0", min: 1, max: 30, step: 0.5, unit: "",
    short: "Сила удержания задней оси — ГЛАВНЫЙ параметр длины и выраженности заноса. Меньше = хвост охотнее уходит в занос и дольше скользит." },
  { key: "tireSaturationSpeed", group: "Bicycle v3.0", min: 0.5, max: 15, step: 0.25, unit: "m/s",
    short: "При какой боковой скорости шина 'перегружается' и срывается в занос. Маленькое — шины срываются от лёгкого касания, большое — почти не заносит." },
  { key: "inertiaScale", group: "Bicycle v3.0", min: 0.2, max: 4.0, step: 0.05, unit: "x",
    short: "Инерция вращения кузова — ощущение веса при повороте. 0.3 — юркая машина, разворачивается мгновенно, 2.5+ — тяжёлая, реагирует с задержкой." },
  { key: "omegaDamping", group: "Bicycle v3.0", min: 0.5, max: 15, step: 0.25, unit: "/s",
    short: "Как быстро гаснет вращение кузова после отпускания руля. 1 — крутится долго как юла, 5 — стабилизируется за ~0.25с, 14 — мгновенно." },
  { key: "driftMaxSlipSpeed", group: "Bicycle v3.0", min: 2, max: 20, step: 0.5, unit: "m/s",
    short: "При какой боковой скорости задних колёс считается 'полный занос' (intensity=1) — влияет на VFX/наклон, на физику дрифта не влияет." },
  { key: "omegaLeanScale", group: "Bicycle v3.0", min: 0.5, max: 8, step: 0.25, unit: "rad/s",
    short: "При какой угловой скорости корпус наклоняется максимально (визуальный крен в повороте). Чисто эстетика, на физику не влияет." },
  { key: "kinematicBlendLoSpeed", group: "Bicycle v3.0", min: 0.2, max: 4, step: 0.1, unit: "m/s",
    short: "Ниже этой скорости машина крутится 'как велосипед' — нос идёт точно куда повёрнут руль, почти без бокового скольжения (парковочный разворот). 1.5 (дефолт) — уже на пешеходной скорости нос чётко ведёт." },
  { key: "kinematicBlendHiSpeed", group: "Bicycle v3.0", min: 2, max: 15, step: 0.5, unit: "m/s",
    short: "Выше этой скорости включается полноценная физика заноса (шины могут сорваться, задняя ось может пойти боком). Между Lo и Hi — плавный переход. 6 (дефолт) — на обычной скорости модель уже 'живая'." },
  { key: "kinematicLateralMute", group: "Bicycle v3.0", min: 0, max: 1, step: 0.05, unit: "x",
    short: "Насколько машину всё ещё может потащить вбок от силы шин на самой малой скорости (ниже kinematicBlendLoSpeed). 0 — чистый разворот носом без сноса, 0.3+ — лёгкий остаточный снос даже на парковочной скорости." },

  // ── Дрифт (сигналы и эффекты, bicycle-слой) ─────────────────────────
  { key: "driftMinSpeed", group: "Дрифт: сигналы и эффекты", min: 0.5, max: 8.0, step: 0.5, unit: "m/s",
    short: "Минимальная скорость для дрифт-эффектов (дым, наклон). Ниже неё intensity принудительно 0 — защита от 'дрифта' стоя." },
  { key: "slipSmoothing", group: "Дрифт: сигналы и эффекты", min: 1, max: 20, step: 0.5, unit: "/s",
    short: "Скорость нарастания intensity к реальному заносу. 2 — дым отстаёт (~350мс), 5 — стандарт, 12 — почти мгновенно (может дёргаться на кочках)." },
  { key: "driftActiveThreshold", group: "Дрифт: сигналы и эффекты", min: 0.3, max: 0.95, step: 0.05, unit: "",
    short: "С какой интенсивности включается VFX/audio-флаг 'is_drifting'. Не влияет на физику — только on/off триггер со встроенным гистерезисом." },
  { key: "driftDragMultiplier", group: "Дрифт: сигналы и эффекты", min: 1.0, max: 3.0, step: 0.05, unit: "x",
    short: "Доп. сопротивление воздуха в дрифте — снижает терминальную скорость пока дрифтуешь. 1.0 — нет эффекта, 2.6 — топ ≈67% обычного." },
  { key: "driftRollingMultiplier", group: "Дрифт: сигналы и эффекты", min: 1.0, max: 2.0, step: 0.05, unit: "x",
    short: "Доп. rolling-сопротивление в дрифте, заметно на малых скоростях. 1.0 — нет эффекта, 1.8 — явное торможение в медленном дрифте." },
  { key: "corneringDragCoeff", group: "Дрифт: сигналы и эффекты", min: 0.0, max: 15.0, step: 0.5, unit: "",
    short: "Базовое торможение в ЛЮБОМ повороте (даже без дрифта), поверх emergent-замедления от шин. 0 — только emergent, 5 (дефолт) — лёгкое, но заметное замедление в резком повороте, 12+ — руль тормозит почти как ручник даже без дрифта." },
  { key: "corneringDragDriftMult", group: "Дрифт: сигналы и эффекты", min: 1.0, max: 8.0, step: 0.25, unit: "x",
    short: "Во сколько раз усиливается торможение из corneringDragCoeff, когда машина реально в активном дрифте (не в обычном повороте). 1.0 — дрифт тормозит так же как обычный поворот, 4 (дефолт) — в дрифте машина заметно теряет скорость, вне дрифта тормозит слабо." },

  // ── Continuous Drift v4.0 ────────────────────────────────────────────
  { key: "driftSteerGateLo", group: "Дрифт v4.0 (continuous)", min: 0.05, max: 0.6, step: 0.05, unit: "",
    short: "Нижняя граница руля, ниже которой дрифт-сигнал точно 0. Работает в паре с driftSteerGateHi — между ними плавный нарастающий переход, без скачков." },
  { key: "driftSteerGateHi", group: "Дрифт v4.0 (continuous)", min: 0.2, max: 0.95, step: 0.05, unit: "",
    short: "Верхняя граница руля, выше которой дрифт-сигнал набирает полную силу. Должна быть больше driftSteerGateLo, иначе переход схлопывается в скачок." },
  { key: "driftSpeedGateLo", group: "Дрифт v4.0 (continuous)", min: 0.5, max: 15, step: 0.5, unit: "m/s",
    short: "Нижняя граница скорости для 'ворот' дрифта — ниже неё дрифт полностью гасится, даже при полном руле и газе. Работает и на входе (задержка), и постоянно на выходе (дрифт глохнет если тачка притормозила). 1.5 (дефолт) — дрифт уже почти на трогании с места." },
  { key: "driftSpeedGateHi", group: "Дрифт v4.0 (continuous)", min: 1, max: 25, step: 0.5, unit: "m/s",
    short: "Верхняя граница скорости — выше неё дрифт-сигнал уже не растёт от скорости, только от руля/газа. 3 (дефолт) — полноценный дрифт доступен буквально через пару метров разгона." },
  { key: "driftThrottleGate", group: "Дрифт v4.0 (continuous)", min: 0, max: 0.5, step: 0.02, unit: "",
    short: "Минимальный газ, нужный для полного дрифт-намерения. 0 — дрифт срабатывает даже без газа (только рулём), выше — требует явного нажатия W." },
  { key: "driftHeatTau", group: "Дрифт v4.0 (continuous)", min: 0.1, max: 3.0, step: 0.05, unit: "s",
    short: "Постоянная времени 'разогрева шин' — насколько долго держится широкий вход в занос прежде чем машина 'ужимается' в стабильный круг. Больше = шире и дольше widening на входе." },
  { key: "driftGripReleasePeak", group: "Дрифт v4.0 (continuous)", min: 0.0, max: 0.9, step: 0.05, unit: "",
    short: "Насколько сильно теряется сцепление в момент резкого входа в дрифт (пока 'шины ещё холодные'). 0 — эффекта нет, 0.6 — заметный широкий занос на входе, 0.9 — экстремальный срыв." },
  { key: "driftGripFloor", group: "Дрифт v4.0 (continuous)", min: 0.0, max: 0.3, step: 0.01, unit: "x",
    short: "Абсолютный минимум сцепления задней оси в дрифте — страховка, чтобы грип никогда не падал до нуля даже на пике широкого входа." },
  { key: "driftPowerTau", group: "Дрифт v4.0 (continuous)", min: 0.1, max: 3.0, step: 0.05, unit: "s",
    short: "Постоянная времени накопления 'заряда' дрифта для буста на выходе. Меньше — заряжается быстрее, за короткий занос уже можно получить буст." },
  { key: "driftExitBoostK", group: "Дрифт v4.0 (continuous)", min: 0.0, max: 20.0, step: 0.5, unit: "",
    short: "Сила буста на выходе из дрифта на единицу скорости 'разрядки' накопленного заноса. 0 — буста нет, выше — резче рывок вперёд сразу после отпускания руля." },
  { key: "driftVisualOffsetDeg", group: "Дрифт v4.0 (continuous)", min: 5, max: 45, step: 1, unit: "°",
    short: "На сколько градусов кузов визуально 'кладётся' в дрифте относительно направления движения. 10° — еле заметно, 39° (дефолт) — явный занос как в SmashKarts, 45° — почти боком." },
  { key: "driftEngageInRate", group: "Дрифт v4.0 (continuous)", min: 1.0, max: 15.0, step: 0.5, unit: "/s",
    short: "Как быстро дрифт-сигнал нарастает на ВХОДЕ. 1.5 — медленно, чувствуется секундная задержка перед заносом, 7 (дефолт) — дрифт подхватывается почти сразу (0.1-0.2с) при зажатом руле+газе, 12+ — мгновенный щелчок в занос." },
  { key: "driftEngageOutRate", group: "Дрифт v4.0 (continuous)", min: 0.5, max: 10.0, step: 0.25, unit: "/s",
    short: "Как быстро дрифт-сигнал затухает на ВЫХОДЕ. Обычно медленнее driftEngageInRate — резкое выключение ощущается как обрыв, плавное даёт 'послевкусие' заноса. 2.5 (дефолт) — плавный, но не тягучий выход." },
  { key: "driftRearGripMult", group: "Дрифт v4.0 (continuous)", min: 0.05, max: 1.0, step: 0.05, unit: "x",
    short: "Во сколько раз срывается задняя ось на пике активного дрифта. 0.1 — почти нет грипа (едет боком), 0.25 (дефолт) — явный контролируемый занос, 1.0 — грип не меняется." },
  { key: "driftYawBonus", group: "Дрифт v4.0 (continuous)", min: 0.0, max: 4.0, step: 0.1, unit: "rad/s",
    short: "Доп. угловая скорость в дрифте — машина 'довинчивается' резче чем чистая физика. 0 — мягкий дрифт без довинчивания, 3 — легко закрутить машину на 540°." },
  { key: "driftForwardAssist", group: "Дрифт v4.0 (continuous)", min: 0.0, max: 15.0, step: 0.5, unit: "m/s²",
    short: "Доп. тяга вперёд в дрифте, компенсирует естественную потерю скорости в заносе. 0 — заметно тормозишь в дрифте, 6+ — дрифт почти не теряет темп." },

  // ── Визуал ───────────────────────────────────────────────────────────
  { key: "visualDriftMaxDeg", group: "Визуал", min: 10, max: 60, step: 2, unit: "°",
    short: "Максимальный визуальный наклон кузова (крен) в дрифте — чисто декоративно, физика не затрагивается. 20° сдержанно, 45°+ SmashKarts-стиль." },
  { key: "visualLeanRecoverySpeed", group: "Визуал", min: 1, max: 30, step: 0.5, unit: "rad/s",
    short: "Как быстро кузов выравнивается после выхода из дрифта. 3 — плавно (~0.27с), 6 — стандарт (~0.13с), 15+ — почти мгновенно." },

  // ── Legacy v3.1 (не используются в web-порте v4.0) ──────────────────
  { key: "autoDriftEnabled", group: "Legacy v3.1 (не используется в v4.0)", min: 0, max: 1, step: 1, unit: "", bool: true, legacy: true,
    short: "[не используется] Оставлен от Godot-версии — web-порт всегда работает на continuous drift v4.0, этот выключатель ничего не переключает." },
  { key: "driftVisualSmoothRate", group: "Legacy v3.1 (не используется в v4.0)", min: 1.0, max: 15.0, step: 0.5, unit: "/s", legacy: true,
    short: "[не используется] Заменён на driftEngageInRate/OutRate в continuous drift v4.0." },
  { key: "driftEnterSteer", group: "Legacy v3.1 (не используется в v4.0)", min: 0.3, max: 0.95, step: 0.05, unit: "", legacy: true,
    short: "[не используется] v3.1 discrete state machine убрана; используй driftSteerGateHi." },
  { key: "driftEnterSpeed", group: "Legacy v3.1 (не используется в v4.0)", min: 1, max: 25, step: 0.5, unit: "m/s", legacy: true,
    short: "[не используется] используй driftSpeedGateHi." },
  { key: "driftEnterDebounce", group: "Legacy v3.1 (не используется в v4.0)", min: 0.0, max: 0.5, step: 0.02, unit: "s", legacy: true,
    short: "[не используется] v4.0 не использует debounce — только плавные smoothstep-ворота." },
  { key: "driftExitSteer", group: "Legacy v3.1 (не используется в v4.0)", min: 0.1, max: 0.6, step: 0.05, unit: "", legacy: true,
    short: "[не используется] используй driftSteerGateLo." },
  { key: "driftExitSpeed", group: "Legacy v3.1 (не используется в v4.0)", min: 0.5, max: 15, step: 0.5, unit: "m/s", legacy: true,
    short: "[не используется] используй driftSpeedGateLo." },
  { key: "driftExitDuration", group: "Legacy v3.1 (не используется в v4.0)", min: 0.05, max: 1.0, step: 0.05, unit: "s", legacy: true,
    short: "[не используется] v3.1 EXITING-фаза убрана в v4.0." },
  { key: "driftRecoveryRate", group: "Legacy v3.1 (не используется в v4.0)", min: 1.0, max: 12.0, step: 0.5, unit: "/s", legacy: true,
    short: "[не используется] snap-grip recovery overlay убран в v4.0 (грип теперь непрерывная функция от dFast)." },
  { key: "driftExitGripMult", group: "Legacy v3.1 (не используется в v4.0)", min: 1.0, max: 4.0, step: 0.1, unit: "x", legacy: true,
    short: "[не используется] см. driftRecoveryRate." },
  { key: "driftPowerFullTime", group: "Legacy v3.1 (не используется в v4.0)", min: 0.3, max: 4.0, step: 0.1, unit: "s", legacy: true,
    short: "[не используется] используй driftPowerTau." },
  { key: "driftMinActiveForBoost", group: "Legacy v3.1 (не используется в v4.0)", min: 0.0, max: 3.0, step: 0.1, unit: "s", legacy: true,
    short: "[не используется] v4.0 буст не имеет минимального порога — сила буста аналитически масштабируется от длительности заноса." },
  { key: "driftExitBoostForce", group: "Legacy v3.1 (не используется в v4.0)", min: 0.0, max: 30.0, step: 1.0, unit: "m/s²", legacy: true,
    short: "[не используется] используй driftExitBoostK." },
  { key: "driftExitBoostDuration", group: "Legacy v3.1 (не используется в v4.0)", min: 0.1, max: 2.0, step: 0.05, unit: "s", legacy: true,
    short: "[не используется] v4.0 буст не таймерный — гаснет сам по мере разрядки энергии." },
];

// Render order for groups (Object key insertion order from PARAM_DESCRIPTORS
// would work too, but spelling it out keeps a stable, designer-friendly
// order even if entries above get reshuffled later).
const GROUP_ORDER = [
  "Скорость",
  "Сглаживание ввода",
  "Рулёжка",
  "Bicycle v3.0",
  "Дрифт: сигналы и эффекты",
  "Дрифт v4.0 (continuous)",
  "Визуал",
  "Legacy v3.1 (не используется в v4.0)",
];

// ─── Pure logic (unit-tested without DOM) ──────────────────────────────────

// Only the fields that differ from the tuned defaults — this is both the
// localStorage payload and the "Copy JSON" clipboard payload. Booleans and
// numbers compared with strict equality; every value in KartPhysicsParams is
// either a plain number or `autoDriftEnabled: boolean`, so no float-epsilon
// dance is needed (sliders always land on the exact number stored).
export function diffFromDefaults(
  current: KartPhysicsParams,
  defaults: KartPhysicsParams = DEFAULT_KART_PHYSICS_PARAMS
): Partial<KartPhysicsParams> {
  const out: Partial<Record<ParamKey, number | boolean>> = {};
  for (const d of PARAM_DESCRIPTORS) {
    const cur = current[d.key];
    const def = defaults[d.key];
    if (cur !== def) out[d.key] = cur;
  }
  return out as Partial<KartPhysicsParams>;
}

// Parses whatever is in localStorage, dropping any key that isn't a known
// param (defends against stale overrides surviving a refactor that renamed
// or removed a field).
export function parseStoredOverrides(raw: string | null): Partial<KartPhysicsParams> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const knownKeys = new Set<string>(PARAM_DESCRIPTORS.map(d => d.key));
  const out: Partial<Record<ParamKey, number | boolean>> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!knownKeys.has(key)) continue;
    if (typeof value !== "number" && typeof value !== "boolean") continue;
    out[key as ParamKey] = value;
  }
  return out as Partial<KartPhysicsParams>;
}

// Mutates `target` in place with every field present in `overrides` — this
// is the live-apply step: `target` is the exact object BicyclePhysics /
// ContinuousDrift hold by reference, so this is the whole mechanism.
export function applyOverrides(target: KartPhysicsParams, overrides: Partial<KartPhysicsParams>): void {
  (Object.keys(overrides) as ParamKey[]).forEach(key => {
    const value = overrides[key];
    if (value === undefined) return;
    setParamValue(target, key, value);
  });
}

function setParamValue(target: KartPhysicsParams, key: ParamKey, value: number | boolean): void {
  (target as unknown as Record<ParamKey, number | boolean>)[key] = value;
}

function getParamValue(target: KartPhysicsParams, key: ParamKey): number | boolean {
  return (target as unknown as Record<ParamKey, number | boolean>)[key];
}

function saveOverrides(overrides: Partial<KartPhysicsParams>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // localStorage unavailable (private mode / storage full) — dev tool
    // only, silently degrade to "changes apply live but don't persist".
  }
}

// ─── DOM ────────────────────────────────────────────────────────────────

const PANEL_ID = "sk-param-panel";

export function initParamPanel(kart: Kart): void {
  if (document.getElementById(PANEL_ID)) return; // idempotent — no double-mount
  const params = kart.physicsParams;

  // Apply whatever was persisted from a previous session before building the
  // UI, so sliders start at the already-tuned values.
  applyOverrides(params, parseStoredOverrides(localStorage.getItem(STORAGE_KEY)));

  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  Object.assign(panel.style, {
    position: "fixed", top: "0", right: "0", width: "360px", height: "100vh",
    overflowY: "auto", zIndex: "1000", background: "rgba(10,10,26,.92)",
    color: "#eee", font: "12px/1.4 monospace", padding: "10px 12px",
    borderLeft: "1px solid #444", boxSizing: "border-box", display: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(panel);

  const header = document.createElement("div");
  header.textContent = "Kart Physics Tuner (P to toggle)";
  Object.assign(header.style, { fontWeight: "bold", marginBottom: "8px", color: "#4ecca3" });
  panel.appendChild(header);

  const toolbar = document.createElement("div");
  Object.assign(toolbar.style, { display: "flex", gap: "6px", marginBottom: "10px", flexWrap: "wrap" });
  panel.appendChild(toolbar);

  const status = document.createElement("span");
  Object.assign(status.style, { color: "#888", alignSelf: "center", fontSize: "11px" });
  toolbar.appendChild(makeButton("Copy JSON", () => copyDiffToClipboard()));
  toolbar.appendChild(makeButton("Reset all", () => resetAll()));
  toolbar.appendChild(status);

  const rowsByKey = new Map<ParamKey, { numberInput: HTMLInputElement; rangeInput: HTMLInputElement | null }>();

  for (const groupName of GROUP_ORDER) {
    const groupDescriptors = PARAM_DESCRIPTORS.filter(d => d.group === groupName);
    if (groupDescriptors.length === 0) continue;

    const groupEl = document.createElement("div");
    Object.assign(groupEl.style, { marginBottom: "14px" });
    const groupTitle = document.createElement("div");
    groupTitle.textContent = groupName;
    Object.assign(groupTitle.style, {
      color: "#e94560", fontWeight: "bold", fontSize: "11px",
      borderBottom: "1px solid #333", marginBottom: "6px", paddingBottom: "2px",
    });
    groupEl.appendChild(groupTitle);

    for (const d of groupDescriptors) {
      groupEl.appendChild(buildParamRow(d, params, rowsByKey, () => onAnyChange()));
    }
    panel.appendChild(groupEl);
  }

  function onAnyChange(): void {
    const diff = diffFromDefaults(params);
    saveOverrides(diff);
    status.textContent = "saved";
    setTimeout(() => { if (status.textContent === "saved") status.textContent = ""; }, 800);
  }

  function copyDiffToClipboard(): void {
    const diff = diffFromDefaults(params);
    const text = JSON.stringify(diff, null, 2);
    const done = (): void => { status.textContent = "copied!"; setTimeout(() => { status.textContent = ""; }, 1200); };
    const fail = (): void => { status.textContent = "copy failed (see console)"; console.log("[paramPanel] diff JSON:\n" + text); };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, fail);
    } else {
      fail();
    }
  }

  function resetAll(): void {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    applyOverrides(params, DEFAULT_KART_PHYSICS_PARAMS);
    for (const d of PARAM_DESCRIPTORS) {
      const row = rowsByKey.get(d.key);
      if (!row) continue;
      const val = getParamValue(params, d.key);
      row.numberInput.value = String(val);
      if (row.rangeInput) row.rangeInput.value = String(val);
    }
    status.textContent = "reset to defaults";
    setTimeout(() => { status.textContent = ""; }, 1200);
  }

  // Block WASD/Space/etc. from reaching the game's InputController (which
  // listens on `window`) while the user is interacting with panel controls —
  // stopPropagation on the bubble phase here runs before the event reaches
  // `window`. The panel's own P-toggle listener below is registered in the
  // CAPTURE phase specifically so it still fires even with a slider/number
  // input focused inside the panel (capture runs before any bubble-phase
  // stopPropagation further down the tree).
  panel.addEventListener("keydown", e => e.stopPropagation());
  panel.addEventListener("keyup", e => e.stopPropagation());

  let visible = false;
  function setVisible(next: boolean): void {
    visible = next;
    panel.style.display = visible ? "block" : "none";
    if (!visible && document.activeElement instanceof HTMLElement && panel.contains(document.activeElement)) {
      document.activeElement.blur(); // hand keyboard focus back to the page/canvas
    }
  }

  addEventListener("keydown", e => {
    if (e.code !== "KeyP" || e.repeat) return;
    setVisible(!visible);
  }, { capture: true });
}

function buildParamRow(
  d: ParamDescriptor,
  params: KartPhysicsParams,
  rowsByKey: Map<ParamKey, { numberInput: HTMLInputElement; rangeInput: HTMLInputElement | null }>,
  onChange: () => void
): HTMLElement {
  const row = document.createElement("div");
  Object.assign(row.style, { marginBottom: "8px" });

  const nameLine = document.createElement("div");
  Object.assign(nameLine.style, { display: "flex", alignItems: "center", gap: "6px" });
  const name = document.createElement("span");
  name.textContent = d.key + (d.unit ? ` (${d.unit})` : "");
  Object.assign(name.style, { color: d.legacy ? "#777" : "#7fb3d3", fontWeight: "bold", fontSize: "11px" });
  nameLine.appendChild(name);
  row.appendChild(nameLine);

  const current = getParamValue(params, d.key);

  let rangeInput: HTMLInputElement | null = null;
  let numberInput: HTMLInputElement;

  if (d.bool) {
    numberInput = document.createElement("input");
    numberInput.type = "checkbox";
    numberInput.checked = Boolean(current);
    numberInput.value = current ? "1" : "0";
    numberInput.addEventListener("change", () => {
      setParamValue(params, d.key, numberInput.checked);
      numberInput.value = numberInput.checked ? "1" : "0";
      onChange();
    });
    nameLine.appendChild(numberInput);
  } else {
    const controlLine = document.createElement("div");
    Object.assign(controlLine.style, { display: "flex", alignItems: "center", gap: "6px" });

    rangeInput = document.createElement("input");
    rangeInput.type = "range";
    rangeInput.min = String(d.min);
    rangeInput.max = String(d.max);
    rangeInput.step = String(d.step);
    rangeInput.value = String(current);
    Object.assign(rangeInput.style, { flex: "1" });

    numberInput = document.createElement("input");
    numberInput.type = "number";
    numberInput.min = String(d.min);
    numberInput.max = String(d.max);
    numberInput.step = String(d.step);
    numberInput.value = String(current);
    Object.assign(numberInput.style, {
      width: "64px", background: "#0f3460", color: "#eee", border: "1px solid #444",
      borderRadius: "4px", padding: "2px 4px",
    });

    const range = rangeInput; // narrow for closures below (non-null)
    range.addEventListener("input", () => {
      const value = Number(range.value);
      setParamValue(params, d.key, value);
      numberInput.value = range.value;
      onChange();
    });
    numberInput.addEventListener("change", () => {
      const value = Number(numberInput.value);
      if (!Number.isFinite(value)) return;
      setParamValue(params, d.key, value);
      range.value = String(value);
      onChange();
    });

    controlLine.appendChild(rangeInput);
    controlLine.appendChild(numberInput);
    row.appendChild(controlLine);
  }

  rowsByKey.set(d.key, { numberInput, rangeInput });

  if (d.short) {
    const short = document.createElement("div");
    short.textContent = d.short;
    Object.assign(short.style, { color: d.legacy ? "#665" : "#888", fontSize: "10px", lineHeight: "1.3", marginTop: "2px" });
    row.appendChild(short);
  }

  return row;
}

function makeButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.textContent = label;
  Object.assign(btn.style, {
    padding: "4px 10px", border: "none", borderRadius: "5px", cursor: "pointer",
    fontSize: "11px", fontWeight: "600", background: "#0f3460", color: "#eee",
  } satisfies Partial<CSSStyleDeclaration>);
  btn.addEventListener("click", onClick);
  return btn;
}
