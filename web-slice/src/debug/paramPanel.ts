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
// Dev-server-only route registered by the devParamsFilePlugin in
// vite.config.ts. Doesn't exist under `vite build` (prod) — every fetch
// against it there 404s/network-errors, which the panel treats as "no file
// backing available, stay on localStorage".
const DEV_PARAMS_ENDPOINT = "/__dev-params";
export type ParamKey = keyof KartPhysicsParams;

interface ParamDescriptor {
  key: ParamKey;
  group: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  // First sentence only — always visible next to the slider (what this
  // changes about the FEEL, no numbers). Full example-value prose lives in
  // `detail` (collapsed behind a ▸ toggle) — see .claude/rules/param-tuner-
  // descriptions.md structure guidance and the 2026-07-08 UX pass that split
  // these apart (owner: "text дохуя, can't tell what I changed").
  short: string;
  detail?: string;
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
    short: "Условная макс скорость — используется для расчёта дрифта и камеры.",
    detail: "НЕ ограничивает реальную скорость напрямую (это задают accelForce и kDrag вместе)." },
  { key: "accelForce", group: "Скорость", min: 10, max: 100, step: 2, unit: "m/s²",
    short: "Сила мотора.",
    detail: "Низкое (15-17) — разгон ленивый, чувствуется вес (дефолт 17, разгон до ~8.5 м/с ~30% дольше чем раньше). Среднее (25-35) — аркадный стандарт. Высокое (50+) — моментальный разгон, пропадает ощущение веса. Осторожно: терминальная скорость жёстко завязана на kDrag/kRolling — если опустить ниже ~17, машина может вообще перестать разгоняться выше ~9.5 м/с (см. комментарий в types.ts)." },
  { key: "kDrag", group: "Скорость", min: 0.01, max: 0.2, step: 0.005, unit: "",
    short: "Сопротивление воздуха — главный ограничитель максималки.",
    detail: "При accel=25: 0.02 → ~35 м/с потолок, 0.05 → ~22 м/с, 0.1 → ~16 м/с (густой воздух)." },
  { key: "kRolling", group: "Скорость", min: 0.1, max: 5, step: 0.1, unit: "",
    short: "Трение качения — торможение по инерции когда отпустил газ.",
    detail: "0.5 — долго катится как на льду, 1.5 — стандарт, 4 — почти сразу встаёт." },
  { key: "brakeForce", group: "Скорость", min: 1, max: 60, step: 1, unit: "m/s²",
    short: "Сила торможения кнопкой S.",
    detail: "3-6 — плавный тормоз (~0.8-1с с крейсерской скорости до почти-стоп, дефолт 5), 15-25 — жёстче, ~0.3-0.4с, 40+ — почти мгновенная остановка (было дефолтом раньше — ощущалось как стена)." },
  { key: "reverseRatio", group: "Скорость", min: 0.2, max: 1.0, step: 0.05, unit: "x",
    short: "Сила заднего хода относительно переднего.",
    detail: "0.3 — еле ползёт, 0.5 — удобно для манёвров, 0.88 (дефолт) — почти как вперёд, задний ход с рулём реально едет а не тонет в собственном сопротивлении повороту (см. reverseCorneringDragFloor)." },
  { key: "reverseEngageSpeed", group: "Скорость", min: 0.2, max: 4, step: 0.1, unit: "m/s",
    short: "Ниже какой скорости зажатая S реально включает задний ход, а не просто тормозит.",
    detail: "Пока едешь вперёд быстрее этого порога — S только тормозит (как в реальной машине: сначала тормоз, потом задняя передача). 1.2 (дефолт) — задний ход включается практически сразу как машина остановилась, но не раньше." },
  { key: "reverseSteerGain", group: "Скорость", min: 1.0, max: 3.0, step: 0.05, unit: "x",
    short: "Насколько острее крутится руль когда едешь ЗАДНИМ ходом (плавно усиливается по мере ухода в минус, на переднем ходу вообще не действует).",
    detail: "1.0 — руль одинаково вялый что вперёд, что назад (задом было в 2 раза медленнее разворот — неприятно при парковке/развороте). 2.5 (дефолт, было 2.2) — разворот назад заметно бодрее (при 2.2 было ~85°/с, стал ~101°/с; 2.5 чуть острее ещё), но НЕ настолько же резкий как передом (170°/с) — выше этого числа машина просто теряет скорость и крутится почти на месте, а не разворачивается быстрее. 3+ — почти пятится волчком, разворот дальше не ускоряется." },
  { key: "reverseCorneringDragFloor", group: "Скорость", min: 0.1, max: 1.0, step: 0.05, unit: "x",
    short: "Насколько слабее тормозит 'занос на повороте' когда едешь ЗАДНИМ ходом (плавно, на переднем ходу не действует).",
    detail: "Раньше острый руль на реверсе (см. reverseSteerGain) сам же создавал столько бокового сопротивления, что задний ход с рулём еле полз (боковая скорость была БОЛЬШЕ продольной). 0.35 (дефолт) — тормозит-в-повороте на 65% слабее чем передом, задний ход с рулём реально едет. 1.0 — без изменений (реверс тормозит в повороте так же сильно как перед). Ниже 0.2 — почти не тормозит в повороте задом, но дальше уже не помогает (см. комментарий в types.ts — упирается в другую петлю обратной связи)." },
  { key: "mass", group: "Скорость", min: 0.25, max: 4, step: 0.05, unit: "",
    short: "Масса машинки.",
    detail: "Влияет на то, как резко тяга/торможение/занос раскручивают и тормозят корпус. Ниже 1 — юркая и лёгкая, выше 1 — тяжёлая, реагирует с задержкой." },
  { key: "slopeGravityAccel", group: "Скорость", min: 0, max: 25, step: 0.5, unit: "m/s²",
    short: "Насколько машинку тормозит на подъёме в горку и разгоняет на спуске — работает и под газом, и накатом.",
    detail: "0 — рампы едутся как ровный пол (машина не чувствует уклон). 10 (дефолт) — на рампе арены (~18-20°) заметно теряешь скорость в горку (~9.4 м/с вместо ~10.8 на ровном при полном газе) и набираешь на спуске (~12 м/с). 20+ — крутой подъём почти останавливает разгон, а спуск ощутимо бросает вперёд." },

  // ── Сглаживание ввода ────────────────────────────────────────────────
  { key: "steerSlewRateIn", group: "Сглаживание ввода", min: 1, max: 20, step: 0.5, unit: "/s",
    short: "Как быстро руль докручивается до упора при нажатии A/D.",
    detail: "1.4 — тяжёлый руль, ~0.7с до упора (машина не дёргается в поворот сразу как нажал, но читается как лаг). 6.5 (дефолт, было 1.4) — заметно отзывчивее, руль докручивается быстро, но ещё чувствуется как физическое усилие, не тумблер. 10+ — почти мгновенно, как тумблер." },
  { key: "steerSlewRateOut", group: "Сглаживание ввода", min: 1, max: 15, step: 0.5, unit: "/s",
    short: "Как быстро руль возвращается в центр после отпускания A/D.",
    detail: "1.5 — машина долго катится боком. 3.5 — естественное распрямление. 6.5 (дефолт, было 11) — быстро возвращается в центр, но не мгновенно. 8+ — почти мгновенно в центр." },
  { key: "throttleSlewRate", group: "Сглаживание ввода", min: 1, max: 20, step: 0.5, unit: "/s",
    short: "Как быстро газ раскручивается до полного при нажатии W.",
    detail: "Маленькое (2) — ощущение педали, большое (10+) — почти мгновенный газ." },

  // ── Рулёжка ──────────────────────────────────────────────────────────
  { key: "steerLowSpeedMult", group: "Рулёжка", min: 0.5, max: 3, step: 0.05, unit: "x",
    short: "Насколько острее руль на малой скорости (для парковки/манёвров).",
    detail: "0.72 — заметно спокойнее, поворот (и обычный, и в дрифте) ощутимо мягче (использовалось для борьбы с 'машина крутится втрое резче эталона' вместе с maxSteerAngleDeg). 0.9 (дефолт) — стандартный отклик руля на малой скорости. 1.0 — без разницы, 2.0 — очень острый разворот на месте." },
  { key: "steerHighSpeedMult", group: "Рулёжка", min: 0.1, max: 1.5, step: 0.05, unit: "x",
    short: "Насколько руль 'успокаивается' на максимальной скорости.",
    detail: "0.62 (дефолт, было 0.85) — плавные широкие повороты на скорости. 0.5 — ещё шире, 1.0 — руль одинаково острый везде." },

  // ── Bicycle v3.0 ─────────────────────────────────────────────────────
  { key: "maxSteerAngleDeg", group: "Bicycle v3.0", min: 10, max: 55, step: 1, unit: "°",
    short: "Максимальный угол передних колёс — главная ручка остроты руля.",
    detail: "16° — самый мягкий, широкий радиус дрифта (~3.6м). 20° (дефолт, было 16°) — рулится ощутимо острее, но всё ещё далеко от старого 28°. 28° — как было изначально (втрое круче эталона SmashKarts). 35°+ — очень острая, 45°+ — почти дёрганая." },
  { key: "frontGripStiffness", group: "Bicycle v3.0", min: 3, max: 40, step: 0.5, unit: "",
    short: "Сила удержания передней оси — насколько точно нос идёт куда повёрнут руль.",
    detail: "6 — передок сносит как на льду. 17 (дефолт, было 17.5) — держит с занесённым задом. 30+ — 'на рельсах'." },
  { key: "rearGripStiffness", group: "Bicycle v3.0", min: 1, max: 30, step: 0.5, unit: "",
    short: "Сила удержания задней оси — ГЛАВНЫЙ параметр длины и выраженности заноса.",
    detail: "Меньше = хвост охотнее уходит в занос и дольше скользит." },
  { key: "tireSaturationSpeed", group: "Bicycle v3.0", min: 0.5, max: 15, step: 0.25, unit: "m/s",
    short: "При какой боковой скорости шина 'перегружается' и срывается в занос.",
    detail: "Маленькое — шины срываются от лёгкого касания, большое — почти не заносит. Дефолт 4.5 (было 5) — почти без изменения ощущений." },
  { key: "inertiaScale", group: "Bicycle v3.0", min: 0.2, max: 4.0, step: 0.05, unit: "x",
    short: "Инерция вращения кузова — ощущение веса при повороте.",
    detail: "0.3 — юркая машина, разворачивается мгновенно, 2.5+ — тяжёлая, реагирует с задержкой." },
  { key: "omegaDamping", group: "Bicycle v3.0", min: 0.5, max: 15, step: 0.25, unit: "/s",
    short: "Как быстро гаснет вращение кузова после отпускания руля.",
    detail: "1 — крутится долго как юла. 4.5 (дефолт, было 5) — стабилизируется за ~0.25с. 14 — мгновенно." },
  { key: "driftMaxSlipSpeed", group: "Bicycle v3.0", min: 2, max: 20, step: 0.5, unit: "m/s",
    short: "При какой боковой скорости задних колёс считается 'полный занос' (intensity=1) — влияет на VFX/наклон, на физику дрифта не влияет." },
  { key: "omegaLeanScale", group: "Bicycle v3.0", min: 0.5, max: 8, step: 0.25, unit: "rad/s",
    short: "При какой угловой скорости корпус наклоняется максимально (визуальный крен в повороте).",
    detail: "Чисто эстетика, на физику не влияет." },
  { key: "kinematicBlendLoSpeed", group: "Bicycle v3.0", min: 0.2, max: 4, step: 0.1, unit: "m/s",
    short: "Ниже этой скорости машина крутится 'как велосипед' — нос идёт точно куда повёрнут руль, почти без бокового скольжения (парковочный разворот).",
    detail: "1.5 (дефолт) — уже на пешеходной скорости нос чётко ведёт." },
  { key: "kinematicBlendHiSpeed", group: "Bicycle v3.0", min: 2, max: 15, step: 0.5, unit: "m/s",
    short: "Выше этой скорости включается полноценная физика заноса (шины могут сорваться, задняя ось может пойти боком).",
    detail: "Между Lo и Hi — плавный переход. 6 (дефолт) — на обычной скорости модель уже 'живая'." },
  { key: "kinematicLateralMute", group: "Bicycle v3.0", min: 0, max: 1, step: 0.05, unit: "x",
    short: "Насколько машину всё ещё может потащить вбок от силы шин на самой малой скорости (ниже kinematicBlendLoSpeed).",
    detail: "0 — чистый разворот носом без сноса, 0.3+ — лёгкий остаточный снос даже на парковочной скорости." },

  // ── Дрифт (сигналы и эффекты, bicycle-слой) ─────────────────────────
  { key: "driftMinSpeed", group: "Дрифт: сигналы и эффекты", min: 0.5, max: 8.0, step: 0.5, unit: "m/s",
    short: "Минимальная скорость для дрифт-эффектов (дым, наклон).",
    detail: "Ниже неё intensity принудительно 0 — защита от 'дрифта' стоя." },
  { key: "slipSmoothing", group: "Дрифт: сигналы и эффекты", min: 1, max: 20, step: 0.5, unit: "/s",
    short: "Скорость нарастания intensity к реальному заносу.",
    detail: "2 — дым отстаёт (~350мс), 5 — стандарт, 12 — почти мгновенно (может дёргаться на кочках)." },
  { key: "driftActiveThreshold", group: "Дрифт: сигналы и эффекты", min: 0.3, max: 0.95, step: 0.05, unit: "",
    short: "С какой интенсивности включается VFX/audio-флаг 'is_drifting'.",
    detail: "Не влияет на физику — только on/off триггер со встроенным гистерезисом." },
  { key: "driftDragMultiplier", group: "Дрифт: сигналы и эффекты", min: 1.0, max: 3.0, step: 0.05, unit: "x",
    short: "Доп. сопротивление воздуха в дрифте — снижает терминальную скорость пока дрифтуешь.",
    detail: "1.0 — нет эффекта, 2.6 — топ ≈67% обычного." },
  { key: "driftRollingMultiplier", group: "Дрифт: сигналы и эффекты", min: 1.0, max: 2.0, step: 0.05, unit: "x",
    short: "Доп. rolling-сопротивление в дрифте, заметно на малых скоростях.",
    detail: "1.0 — нет эффекта, 1.8 — явное торможение в медленном дрифте." },
  { key: "corneringDragCoeff", group: "Дрифт: сигналы и эффекты", min: 0.0, max: 15.0, step: 0.5, unit: "",
    short: "Базовое торможение в ЛЮБОМ повороте (даже без дрифта), поверх emergent-замедления от шин.",
    detail: "0 — только emergent, 5 (дефолт) — лёгкое, но заметное замедление в резком повороте, 12+ — руль тормозит почти как ручник даже без дрифта." },
  { key: "corneringDragDriftMult", group: "Дрифт: сигналы и эффекты", min: 1.0, max: 8.0, step: 0.25, unit: "x",
    short: "Во сколько раз усиливается торможение из corneringDragCoeff, когда машина реально в активном дрифте (не в обычном повороте).",
    detail: "1.0 — дрифт тормозит так же как обычный поворот, 5.5 (дефолт, было 4) — в дрифте машина заметнее теряет скорость сразу на входе, вне дрифта тормозит слабо." },
  { key: "driftPenaltyTau", group: "Дрифт: сигналы и эффекты", min: 0.1, max: 3.0, step: 0.05, unit: "s",
    short: "Насколько 'инерционно' торможение из заноса реагирует на реальный занос задней оси (используется для трёх штрафов выше).",
    detail: "Маленькое (0.1-0.2) — машина резко проседает по скорости прямо в момент входа в занос, потом отпускает (ощущение 'сброса' от заноса). 1.0 (дефолт, было 2.0) — просадка на входе быстрее и заметнее чем раньше, но ещё без резкого рывка. 2.0-3.0 — торможение почти не успевает включиться за короткий дрифт." },

  // ── Continuous Drift v4.0 ────────────────────────────────────────────
  { key: "driftSteerGateLo", group: "Дрифт v4.0 (continuous)", min: 0.05, max: 0.6, step: 0.05, unit: "",
    short: "Нижняя граница руля, ниже которой дрифт-сигнал точно 0.",
    detail: "Работает в паре с driftSteerGateHi — между ними плавный нарастающий переход, без скачков." },
  { key: "driftSteerGateHi", group: "Дрифт v4.0 (continuous)", min: 0.2, max: 0.95, step: 0.05, unit: "",
    short: "Верхняя граница руля, выше которой дрифт-сигнал набирает полную силу.",
    detail: "Должна быть больше driftSteerGateLo, иначе переход схлопывается в скачок." },
  { key: "driftSpeedGateLo", group: "Дрифт v4.0 (continuous)", min: 0.5, max: 15, step: 0.5, unit: "m/s",
    short: "Нижняя граница скорости для 'ворот' дрифта — ниже неё дрифт полностью гасится, даже при полном руле и газе.",
    detail: "Работает и на входе (задержка), и постоянно на выходе (дрифт глохнет если тачка притормозила). 1.5 (дефолт) — дрифт уже почти на трогании с места." },
  { key: "driftSpeedGateHi", group: "Дрифт v4.0 (continuous)", min: 1, max: 25, step: 0.5, unit: "m/s",
    short: "Верхняя граница скорости — выше неё дрифт-сигнал уже не растёт от скорости, только от руля/газа.",
    detail: "3 (дефолт) — полноценный дрифт доступен буквально через пару метров разгона." },
  { key: "driftThrottleGate", group: "Дрифт v4.0 (continuous)", min: 0, max: 0.5, step: 0.02, unit: "",
    short: "Минимальный газ, нужный для полного дрифт-намерения.",
    detail: "0 — дрифт срабатывает даже без газа (только рулём), выше — требует явного нажатия W." },
  { key: "driftHeatTau", group: "Дрифт v4.0 (continuous)", min: 0.1, max: 3.0, step: 0.05, unit: "s",
    short: "Постоянная времени 'разогрева шин' — насколько долго держится широкий вход в занос прежде чем машина 'ужимается' в стабильный круг.",
    detail: "Больше = шире и дольше widening на входе." },
  { key: "driftGripReleasePeak", group: "Дрифт v4.0 (continuous)", min: 0.0, max: 0.9, step: 0.05, unit: "",
    short: "Насколько сильно теряется сцепление в момент резкого входа в дрифт (пока 'шины ещё холодные').",
    detail: "0 — эффекта нет, 0.6 — заметный широкий занос на входе, 0.9 — экстремальный срыв." },
  { key: "driftGripFloor", group: "Дрифт v4.0 (continuous)", min: 0.0, max: 0.3, step: 0.01, unit: "x",
    short: "Абсолютный минимум сцепления задней оси в дрифте — страховка, чтобы грип никогда не падал до нуля даже на пике широкого входа." },
  { key: "driftPowerTau", group: "Дрифт v4.0 (continuous)", min: 0.1, max: 3.0, step: 0.05, unit: "s",
    short: "Постоянная времени накопления 'заряда' дрифта для буста на выходе.",
    detail: "Меньше — заряжается быстрее, за короткий занос уже можно получить буст." },
  { key: "driftExitBoostK", group: "Дрифт v4.0 (continuous)", min: 0.0, max: 20.0, step: 0.5, unit: "",
    short: "Сила буста на выходе из дрифта на единицу скорости 'разрядки' накопленного заноса.",
    detail: "0 — буста нет, выше — резче рывок вперёд сразу после отпускания руля." },
  { key: "driftVisualOffsetDeg", group: "Дрифт v4.0 (continuous)", min: 5, max: 45, step: 1, unit: "°",
    short: "На сколько градусов кузов визуально 'кладётся' в дрифте относительно направления движения.",
    detail: "Чисто декоративный офсет — на реальное направление езды НЕ влияет. Камера теперь следит за направлением движения, а не за носом кузова (см. группу 'Камера'), поэтому большой занос больше не мотает экран. 15° — лёгкий читаемый занос. 30° (дефолт) — эффектный занос как в SmashKarts, кузов заметно уходит боком в скольжение. 45° — почти боком." },
  { key: "driftEngageInRate", group: "Дрифт v4.0 (continuous)", min: 1.0, max: 15.0, step: 0.5, unit: "/s",
    short: "Как быстро дрифт-сигнал нарастает на ВХОДЕ.",
    detail: "1.5 — медленно, чувствуется секундная задержка перед заносом, 7 (дефолт) — дрифт подхватывается почти сразу (0.1-0.2с) при зажатом руле+газе, 12+ — мгновенный щелчок в занос." },
  { key: "driftEngageOutRate", group: "Дрифт v4.0 (continuous)", min: 0.5, max: 10.0, step: 0.25, unit: "/s",
    short: "Как быстро дрифт-сигнал затухает на ВЫХОДЕ.",
    detail: "Обычно медленнее driftEngageInRate — резкое выключение ощущается как обрыв, плавное даёт 'послевкусие' заноса. 2.5 (дефолт) — плавный, но не тягучий выход." },
  { key: "driftReversalRate", group: "Дрифт v4.0 (continuous)", min: 0.8, max: 3.0, step: 0.1, unit: "/s",
    short: "[v4.1] Насколько плавно кузов перекладывается, когда ты резко крутишь руль в другую сторону ПРЯМО В ДРИФТЕ (занос вправо → сразу занос влево, газ держишь).",
    detail: "Раньше в этот момент кузов мгновенно щёлкал в новую сторону, хотя машину физически ещё доворачивало в старую — ощущалось как 'нет веса', будто это не машина, а картинка. Теперь перекладка идёт медленнее и плавнее, как будто у машины есть инерция. При 3.0 перекладка почти как раньше — резкая, почти щелчок. При 1.5 — заметная, но живая перекладка примерно за 0.7-1с, кузов явно 'борется' с новым направлением прежде чем повернуть. При 0.8 (дефолт) — тягучая, киношная перекладка, кузов ощутимо сопротивляется смене стороны. Крути ВВЕРХ если перекладка кажется вязкой/тормозной, крути ВНИЗ если машина всё ещё телепортируется на другую сторону при резкой смене руля. На вход в дрифт с нуля (не в перекладке) этот параметр НЕ влияет." },
  { key: "driftRearGripMult", group: "Дрифт v4.0 (continuous)", min: 0.05, max: 1.0, step: 0.05, unit: "x",
    short: "Во сколько раз срывается задняя ось на пике активного дрифта.",
    detail: "0.1 — почти нет грипа (едет боком), 0.25 (дефолт) — явный контролируемый занос, 1.0 — грип не меняется." },
  { key: "driftYawBonus", group: "Дрифт v4.0 (continuous)", min: 0.0, max: 4.0, step: 0.1, unit: "rad/s",
    short: "Доп. угловая скорость в дрифте — машина 'довинчивается' резче чем чистая физика.",
    detail: "0.2 (дефолт, было 1.5) — лёгкий довинт поверх физики шин; на старом значении это ОДНО было почти половиной всей скорости поворота в дрифте (машина крутилась втрое резче эталона SmashKarts). 0 — совсем без довинчивания, 3 — легко закрутить машину на 540°." },
  { key: "driftForwardAssist", group: "Дрифт v4.0 (continuous)", min: 0.0, max: 15.0, step: 0.5, unit: "m/s²",
    short: "Доп. тяга вперёд в дрифте, компенсирует естественную потерю скорости в заносе.",
    detail: "0 — заметно тормозишь в дрифте, 6+ — дрифт почти не теряет темп." },

  // ── Визуал ───────────────────────────────────────────────────────────
  { key: "visualDriftMaxDeg", group: "Визуал", min: 10, max: 60, step: 2, unit: "°",
    short: "Максимальный визуальный наклон кузова (крен) в дрифте — чисто декоративно, физика не затрагивается.",
    detail: "20° сдержанно, 45°+ SmashKarts-стиль." },
  { key: "visualLeanRecoverySpeed", group: "Визуал", min: 1, max: 30, step: 0.5, unit: "rad/s",
    short: "Как быстро кузов выравнивается после выхода из дрифта.",
    detail: "3 — плавно (~0.27с), 6 — стандарт (~0.13с), 15+ — почти мгновенно." },

  // ── Камера ───────────────────────────────────────────────────────────
  { key: "camYawFollowRate", group: "Камера", min: 1, max: 15, step: 0.5, unit: "/s",
    short: "Как быстро камера доворачивается за машинкой, когда та меняет направление движения (например, в дрифте).",
    detail: "2 — камера заметно отстаёт, догоняет с 'ленцой'. 4 — было раньше, при резком развороте (~100°) камера ощутимо не успевала. 7 (дефолт) — успевает за резким дрифтом без видимого лага, но не дёргается. 10+ — почти мгновенно разворачивается, как приклеенная." },
  { key: "camVelHeadingBlendLo", group: "Камера", min: 0, max: 3, step: 0.1, unit: "m/s",
    short: "Ниже этой скорости камера смотрит строго по носу машинки (физический разворот), а не по направлению движения — это то, что не даёт камере крутиться на 180° при езде задним ходом.",
    detail: "Работает в паре с camVelHeadingBlendHi. 0.5 (дефолт) — переход начинается уже на подходе к полной остановке." },
  { key: "camVelHeadingBlendHi", group: "Камера", min: 1, max: 8, step: 0.25, unit: "m/s",
    short: "Выше этой скорости камера полностью следует за направлением РЕАЛЬНОГО движения машинки, а не за носом кузова — поэтому глубокий занос в дрифте не мотает весь экран вслед за корпусом.",
    detail: "2.5 (дефолт) — уже на небольшом разгоне камера полностью 'смотрит по треку'." },

  // ── Прыжки и трамплины ───────────────────────────────────────────────
  { key: "verticalGravity", group: "Прыжки и трамплины", min: 5, max: 40, step: 1, unit: "m/s²",
    short: "Сила притяжения ПОКА МАШИНКА В ВОЗДУХЕ (не земная 9.8, а аркадная).",
    detail: "10 — падает медленно, зависает в воздухе как в невесомости, 22 (дефолт) — бодрый аркадный прыжок, 35+ — падает камнем, почти не летит." },
  { key: "verticalGroundFollowRate", group: "Прыжки и трамплины", min: 5, max: 40, step: 1, unit: "/s",
    short: "Как плотно машинка 'приклеена' к земле пока едет по ней (сглаживание высоты по рельефу).",
    detail: "Ниже — заметно проседает на кочках/стыках плит, выше — жёстко следует земле. Не трогай без причины, 20 подобрано под текущий рельеф карты." },
  { key: "verticalAirborneDropThreshold", group: "Прыжки и трамплины", min: 0.2, max: 10, step: 0.1, unit: "m/s",
    short: "Насколько резко должна 'уйти' земля из-под колёс, чтобы машинка оторвалась и полетела, а не просто плавно съехала вниз по склону.",
    detail: "0.5 — отрывается почти на любой мелкой ямке (дёргано), 2.5 (дефолт) — отрывается только на настоящих трамплинах/обрывах, 8+ — почти никогда не взлетает, даже с крутого обрыва просто 'сползает'." },
  { key: "verticalLandingMargin", group: "Прыжки и трамплины", min: 0.01, max: 0.3, step: 0.01, unit: "m",
    short: "Насколько близко к земле нужно подлететь, чтобы машинка 'приземлилась' (гасит вертикальную скорость).",
    detail: "Маленькое (0.02) — точное приземление, чуть проваливается сквозь мелкие щели на стыках; побольше (0.1+) — приземляется чуть раньше, надёжнее, но может 'срезать' самый конец прыжка." },
  { key: "attitudeFollowRate", group: "Прыжки и трамплины", min: 3, max: 30, step: 1, unit: "/s",
    short: "Как быстро корпус наклоняется вслед за рельефом (подъём/спуск/бок) пока едешь по земле.",
    detail: "Малое (8) — на скорости кажется что машина вообще не наклоняется (не успевает), 20 (дефолт) — заметный наклон даже на топовой скорости через рампу, 30 — почти мгновенно повторяет форму рельефа." },
  { key: "attitudeAirborneRelaxRate", group: "Прыжки и трамплины", min: 0.5, max: 15, step: 0.5, unit: "/s",
    short: "Как быстро корпус выравнивается в горизонт пока летит по воздуху (после трамплина не должен оставаться перекошенным).",
    detail: "1 — долго 'помнит' угол схода с рампы, 3 (дефолт) — плавно выравнивается за прыжок средней длины, 10+ — почти сразу горизонтально в полёте." },

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
  "Камера",
  "Прыжки и трамплины",
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

// "Did the player touch this slider?" — drives the row highlight + group
// counter + reset-button visibility. Floats compared with a tiny epsilon
// (sliders/number inputs always land on an exact step value, but defends
// against any future float-math path landing a hair off); booleans compared
// strictly (no epsilon concept for a checkbox).
const FLOAT_EPSILON = 1e-9;

export function isParamModified(
  key: ParamKey,
  current: KartPhysicsParams,
  defaults: KartPhysicsParams = DEFAULT_KART_PHYSICS_PARAMS
): boolean {
  const cur = getParamValue(current, key);
  const def = getParamValue(defaults, key);
  if (typeof cur === "boolean" || typeof def === "boolean") return cur !== def;
  return Math.abs((cur as number) - (def as number)) > FLOAT_EPSILON;
}

// Group title suffix — "Рулёжка (2)" tells the tuner at a glance which
// collapsed groups have anything worth reopening, without expanding each one.
export function countModifiedInGroup(
  groupName: string,
  current: KartPhysicsParams,
  defaults: KartPhysicsParams = DEFAULT_KART_PHYSICS_PARAMS
): number {
  return PARAM_DESCRIPTORS.filter(d => d.group === groupName && isParamModified(d.key, current, defaults)).length;
}

function formatScalarValue(v: number | boolean): string {
  return typeof v === "boolean" ? (v ? "true" : "false") : String(v);
}

// First line of every expanded `detail` panel — "what was this before I
// touched it". Unmodified params just show the default; modified ones show
// the before/after so the tuner doesn't have to remember what they changed.
export function formatDefaultLine(
  key: ParamKey,
  current: KartPhysicsParams,
  defaults: KartPhysicsParams = DEFAULT_KART_PHYSICS_PARAMS
): string {
  const descriptor = PARAM_DESCRIPTORS.find(d => d.key === key);
  const unit = descriptor?.unit ?? "";
  const def = getParamValue(defaults, key);
  const defStr = `${formatScalarValue(def)}${unit}`;
  if (!isParamModified(key, current, defaults)) return `Дефолт: ${defStr}`;
  const cur = getParamValue(current, key);
  return `Дефолт: ${defStr} → сейчас: ${formatScalarValue(cur)}${unit}`;
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

// ─── History / revert (pure) ────────────────────────────────────────────
// One entry per slider commit. `key: "__reset__"` is the special "Reset all"
// snapshot: oldValue is the full overrides diff that was active right before
// the reset (so it can be replayed back), newValue is always `{}` (meaning
// "defaults"). Every other entry is a single-field change with old/new as
// plain number|boolean.
export interface HistoryEntry {
  ts: number;
  key: ParamKey | "__reset__";
  oldValue: number | boolean | Partial<KartPhysicsParams>;
  newValue: number | boolean | Partial<KartPhysicsParams>;
}

export const HISTORY_MAX_LEN = 200;

// Ring buffer: append then drop from the front once over maxLen. Returns a
// new array (caller reassigns its `history` binding) rather than mutating,
// matching the rest of this module's pure-function style.
export function pushHistoryEntry(
  history: HistoryEntry[],
  entry: HistoryEntry,
  maxLen: number = HISTORY_MAX_LEN
): HistoryEntry[] {
  const next = [...history, entry];
  if (next.length > maxLen) next.splice(0, next.length - maxLen);
  return next;
}

// Replays history[0..index) and folds it into an overrides diff — i.e. "the
// overrides state as it was right before history[index] was applied". This
// is how revert/undo compute their target state: no separate snapshot
// storage needed, just fold the log up to a cut point. A `__reset__` entry
// hard-resets the running overrides to its recorded newValue (always `{}`)
// before folding continues; every other entry sets/deletes a single key
// (deletes when the new value happens to equal the default, keeping the
// invariant that `overrides` only ever holds fields that differ from
// defaults — same invariant diffFromDefaults produces).
export function computeOverridesAtIndex(
  history: HistoryEntry[],
  index: number,
  defaults: KartPhysicsParams = DEFAULT_KART_PHYSICS_PARAMS
): Partial<KartPhysicsParams> {
  const clamped = Math.max(0, Math.min(index, history.length));
  let overrides: Partial<KartPhysicsParams> = {};
  for (let i = 0; i < clamped; i++) {
    const entry = history[i];
    if (entry.key === "__reset__") {
      overrides = { ...(entry.newValue as Partial<KartPhysicsParams>) };
      continue;
    }
    const key = entry.key;
    const next: Partial<Record<ParamKey, number | boolean>> = { ...overrides };
    if (entry.newValue === defaults[key]) {
      delete next[key];
    } else {
      next[key] = entry.newValue as number | boolean;
    }
    overrides = next as Partial<KartPhysicsParams>;
  }
  return overrides;
}

// "Revert to this point in time": undo every entry from `index` onward
// (inclusive), i.e. land on the state as it was immediately before
// history[index] happened. Truncates the log itself (the undone entries are
// gone, not just their effects) — a subsequent revert-to-an-earlier-point
// still works correctly since it only ever needs entries before it.
export function revertToIndex(
  history: HistoryEntry[],
  index: number
): { overrides: Partial<KartPhysicsParams>; history: HistoryEntry[] } {
  const clamped = Math.max(0, Math.min(index, history.length));
  return { overrides: computeOverridesAtIndex(history, clamped), history: history.slice(0, clamped) };
}

// "Undo" = revert to the point right before the most recent entry. Returns
// null when there's nothing to undo (empty history) so callers can show a
// "nothing to undo" status instead of silently no-op'ing.
export function undoLast(
  history: HistoryEntry[]
): { overrides: Partial<KartPhysicsParams>; history: HistoryEntry[] } | null {
  if (history.length === 0) return null;
  return revertToIndex(history, history.length - 1);
}

// ─── Dev-params file parsing (pure) ─────────────────────────────────────
// Same defensive philosophy as parseStoredOverrides: the file on disk is
// user/hand-editable and can outlive renamed/removed fields, so every entry
// is individually validated and unknown junk is silently dropped rather than
// blowing up the panel.
export function parseHistoryEntries(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const knownKeys = new Set<string>(PARAM_DESCRIPTORS.map(d => d.key));
  const out: HistoryEntry[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;
    if (typeof e.ts !== "number") continue;
    if (e.key === "__reset__") {
      const oldValue = typeof e.oldValue === "object" && e.oldValue !== null ? (e.oldValue as Partial<KartPhysicsParams>) : {};
      const newValue = typeof e.newValue === "object" && e.newValue !== null ? (e.newValue as Partial<KartPhysicsParams>) : {};
      out.push({ ts: e.ts, key: "__reset__", oldValue, newValue });
      continue;
    }
    if (
      typeof e.key === "string" &&
      knownKeys.has(e.key) &&
      (typeof e.oldValue === "number" || typeof e.oldValue === "boolean") &&
      (typeof e.newValue === "number" || typeof e.newValue === "boolean")
    ) {
      out.push({ ts: e.ts, key: e.key as ParamKey, oldValue: e.oldValue, newValue: e.newValue });
    }
  }
  return out;
}

export interface DevParamsFile {
  overrides: Partial<KartPhysicsParams>;
  history: HistoryEntry[];
}

export function parseDevParamsFile(data: unknown): DevParamsFile {
  if (typeof data !== "object" || data === null) return { overrides: {}, history: [] };
  const obj = data as Record<string, unknown>;
  return {
    overrides: parseStoredOverrides(JSON.stringify(obj.overrides ?? {})),
    history: parseHistoryEntries(obj.history),
  };
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

// GET at startup: if the dev-server route answers, the file is the source of
// truth (survives a browser localStorage wipe / a different browser). If the
// route doesn't exist (prod build, offline) fetch throws or the request
// never lands — either way we return null and the caller just keeps
// whatever localStorage already applied.
async function fetchDevParamsFile(): Promise<DevParamsFile | null> {
  try {
    const res = await fetch(DEV_PARAMS_ENDPOINT);
    if (!res.ok) return null;
    const data: unknown = await res.json();
    return parseDevParamsFile(data);
  } catch {
    return null;
  }
}

// Fire-and-forget POST; failures (prod build / offline) are silently
// swallowed — localStorage already has the up-to-date state regardless, this
// is purely the "also survive outside the browser" path.
async function postDevParamsFile(payload: DevParamsFile): Promise<void> {
  try {
    await fetch(DEV_PARAMS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // route unavailable — nothing to do, see comment above.
  }
}

// ─── DOM ────────────────────────────────────────────────────────────────

const PANEL_ID = "sk-param-panel";

export async function initParamPanel(kart: Kart): Promise<void> {
  if (document.getElementById(PANEL_ID)) return; // idempotent — no double-mount
  const params = kart.physicsParams;

  // Apply whatever was persisted from a previous session before building the
  // UI, so sliders start at the already-tuned values. This is the
  // localStorage-only bootstrap (synchronous, always available); the
  // file-backed GET below runs after the panel is built and, if it answers,
  // overwrites this with the on-disk state (file wins — see task write-up).
  let history: HistoryEntry[] = [];
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
  toolbar.appendChild(makeButton("Undo", () => undo()));
  toolbar.appendChild(makeButton("История", () => toggleHistoryPanel()));
  toolbar.appendChild(status);

  // "Copy JSON" fallback surface: navigator.clipboard.writeText needs a
  // secure context (https or localhost) and can also reject on permission
  // denial — neither case should leave the owner digging through devtools
  // console. Always-available manual-copy textarea, shown whenever the
  // Clipboard API path (and its execCommand("copy") fallback) both fail.
  const jsonPanel = document.createElement("div");
  Object.assign(jsonPanel.style, { display: "none", marginBottom: "10px" });
  const jsonTextarea = document.createElement("textarea");
  jsonTextarea.readOnly = true;
  jsonTextarea.rows = 8;
  Object.assign(jsonTextarea.style, {
    width: "100%", boxSizing: "border-box", background: "#0f1a30", color: "#eee",
    border: "1px solid #444", borderRadius: "4px", font: "10px/1.3 monospace", padding: "4px 6px",
  } satisfies Partial<CSSStyleDeclaration>);
  jsonPanel.appendChild(jsonTextarea);
  panel.appendChild(jsonPanel);

  function showJsonFallback(text: string): void {
    jsonTextarea.value = text;
    jsonPanel.style.display = "block";
    jsonTextarea.focus();
    jsonTextarea.select();
  }

  // Collapsed by default (dev tool — history is a "break glass" tool, not
  // something glanced at every slider tweak). Rebuilt from scratch on every
  // change rather than diffed/patched — this list tops out at
  // HISTORY_MAX_LEN (200) rows, a full innerHTML rebuild of that is cheap
  // and far simpler than incremental DOM patching for a dev-only panel.
  const historyPanel = document.createElement("div");
  Object.assign(historyPanel.style, {
    display: "none", marginBottom: "12px", padding: "6px 8px",
    background: "rgba(255,255,255,.04)", border: "1px solid #333",
    borderRadius: "6px", maxHeight: "260px", overflowY: "auto",
  });
  panel.appendChild(historyPanel);

  let historyVisible = false;
  function toggleHistoryPanel(): void {
    historyVisible = !historyVisible;
    historyPanel.style.display = historyVisible ? "block" : "none";
    if (historyVisible) renderHistoryList();
  }

  function renderHistoryList(): void {
    historyPanel.innerHTML = "";
    if (history.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "История пуста";
      Object.assign(empty.style, { color: "#666", fontSize: "11px" });
      historyPanel.appendChild(empty);
      return;
    }
    // Newest first — most useful entry (what did I just do / what do I most
    // likely want to roll back to) at the top, no scrolling needed for the
    // common case.
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      const row = document.createElement("div");
      Object.assign(row.style, {
        display: "flex", justifyContent: "space-between", alignItems: "center",
        gap: "6px", padding: "3px 0", borderBottom: "1px solid #222", fontSize: "10px",
      });
      const label = document.createElement("span");
      label.textContent = `${formatTime(entry.ts)}  ${formatHistoryEntry(entry)}`;
      Object.assign(label.style, { color: "#aaa", flex: "1" });
      row.appendChild(label);
      const revertBtn = makeButton("↩", () => revertTo(i));
      Object.assign(revertBtn.style, { padding: "1px 6px", fontSize: "10px" });
      revertBtn.title = "Откатить до состояния перед этим изменением";
      row.appendChild(revertBtn);
      historyPanel.appendChild(row);
    }
  }

  const rowsByKey = new Map<ParamKey, { numberInput: HTMLInputElement; rangeInput: HTMLInputElement | null; refreshRow: () => void }>();
  const groupTitleEls = new Map<string, HTMLElement>();

  for (const groupName of GROUP_ORDER) {
    const groupDescriptors = PARAM_DESCRIPTORS.filter(d => d.group === groupName);
    if (groupDescriptors.length === 0) continue;

    const groupEl = document.createElement("div");
    Object.assign(groupEl.style, { marginBottom: "8px" });
    const groupTitle = document.createElement("div");
    groupTitle.textContent = groupName;
    Object.assign(groupTitle.style, {
      color: "#e94560", fontWeight: "bold", fontSize: "11px",
      borderBottom: "1px solid #333", marginBottom: "3px", paddingBottom: "2px",
    });
    groupEl.appendChild(groupTitle);
    groupTitleEls.set(groupName, groupTitle);

    for (const d of groupDescriptors) {
      groupEl.appendChild(buildParamRow(d, params, rowsByKey, (key, oldValue, newValue) => onParamChange(key, oldValue, newValue)));
    }
    panel.appendChild(groupEl);
  }

  // Left-border highlight + "(N)" group counter both depend on the same
  // isModified/countModifiedInGroup pure helpers — called after every path
  // that can move a value (live slider drag, reset button, Reset all, Undo,
  // history revert, initial file/localStorage load) so the highlight never
  // goes stale relative to what's actually in `params`.
  function refreshAllModifiedState(): void {
    for (const row of rowsByKey.values()) row.refreshRow();
    for (const [groupName, titleEl] of groupTitleEls) {
      const n = countModifiedInGroup(groupName, params);
      titleEl.textContent = n > 0 ? `${groupName} (${n})` : groupName;
    }
  }

  function onAnyChange(): void {
    const diff = diffFromDefaults(params);
    saveOverrides(diff);
    refreshAllModifiedState();
    status.textContent = "saved";
    setTimeout(() => { if (status.textContent === "saved") status.textContent = ""; }, 800);
  }

  // Debounced disk write (~500ms after the last slider move) — file I/O per
  // tick of a dragged range input would be wasteful and can race itself;
  // localStorage (onAnyChange, above) stays instant since it's synchronous
  // and local.
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  function schedulePersist(): void {
    if (persistTimer !== null) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void postDevParamsFile({ overrides: diffFromDefaults(params), history });
    }, 500);
  }

  function onParamChange(key: ParamKey, oldValue: number | boolean, newValue: number | boolean): void {
    if (oldValue === newValue) return; // range "input" can fire without an actual value change
    history = pushHistoryEntry(history, { ts: Date.now(), key, oldValue, newValue });
    onAnyChange();
    schedulePersist();
    if (historyVisible) renderHistoryList();
  }

  function syncRowsFromParams(): void {
    for (const d of PARAM_DESCRIPTORS) {
      const row = rowsByKey.get(d.key);
      if (!row) continue;
      const val = getParamValue(params, d.key);
      if (d.bool) {
        row.numberInput.checked = Boolean(val);
        row.numberInput.value = val ? "1" : "0";
      } else {
        row.numberInput.value = String(val);
        if (row.rangeInput) row.rangeInput.value = String(val);
      }
    }
    refreshAllModifiedState();
  }

  function copyDiffToClipboard(): void {
    const diff = diffFromDefaults(params);
    const text = JSON.stringify(diff, null, 2);
    const done = (): void => { status.textContent = "copied!"; setTimeout(() => { status.textContent = ""; }, 1200); };
    // Both automatic paths failed (Clipboard API unavailable/rejected AND
    // execCommand("copy") unavailable/rejected, e.g. plain-http dev server +
    // an old browser) — surface the JSON directly in the panel, selected and
    // focused, so the owner can Ctrl+C it by hand instead of hunting through
    // devtools console output.
    const fail = (): void => {
      showJsonFallback(text);
      status.textContent = "автокопирование не сработало — JSON ниже, выдели и скопируй (Ctrl+C)";
      setTimeout(() => { status.textContent = ""; }, 3000);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => {
        // Promise REJECTED (not thrown) — e.g. insecure context or a denied
        // permission prompt. Explicitly handled here (this is the "silently
        // falls through" bug report: the old code's `fail` callback DID run,
        // it just quietly logged to console with no on-screen indication).
        if (execCommandCopy(text)) done();
        else fail();
      });
    } else if (execCommandCopy(text)) {
      done();
    } else {
      fail();
    }
  }

  function resetAll(): void {
    // Snapshot what's about to be thrown away *before* touching params, so
    // the history entry (and therefore "revert to here") can bring it all
    // back.
    const prevOverrides = diffFromDefaults(params);
    history = pushHistoryEntry(history, { ts: Date.now(), key: "__reset__", oldValue: prevOverrides, newValue: {} });
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    applyOverrides(params, DEFAULT_KART_PHYSICS_PARAMS);
    syncRowsFromParams();
    status.textContent = "reset to defaults";
    setTimeout(() => { status.textContent = ""; }, 1200);
    schedulePersist();
    if (historyVisible) renderHistoryList();
  }

  function undo(): void {
    const result = undoLast(history);
    if (result === null) {
      status.textContent = "нечего откатывать";
      setTimeout(() => { status.textContent = ""; }, 1200);
      return;
    }
    applyResult(result, "undo");
  }

  function revertTo(index: number): void {
    applyResult(revertToIndex(history, index), "откат выполнен");
  }

  // Shared tail end of undo()/revertTo(): both compute a target
  // {overrides, history} pair the same way (revertToIndex under the hood) —
  // this just applies it live and refreshes every surface that shows state
  // (sliders, localStorage, disk, history list, status text).
  function applyResult(result: { overrides: Partial<KartPhysicsParams>; history: HistoryEntry[] }, statusText: string): void {
    history = result.history;
    applyOverrides(params, DEFAULT_KART_PHYSICS_PARAMS);
    applyOverrides(params, result.overrides);
    syncRowsFromParams();
    saveOverrides(result.overrides);
    schedulePersist();
    status.textContent = statusText;
    setTimeout(() => { status.textContent = ""; }, 1200);
    if (historyVisible) renderHistoryList();
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

  // File is the source of truth when reachable (dev server only — see
  // devParamsFilePlugin in vite.config.ts). Runs after the panel is already
  // built and interactive on the localStorage-only state so there's no
  // blank/loading flash; if the fetch answers, it overwrites that state
  // (and mirrors it back into localStorage) a moment later.
  const fileState = await fetchDevParamsFile();
  if (fileState !== null) {
    history = fileState.history;
    applyOverrides(params, DEFAULT_KART_PHYSICS_PARAMS);
    applyOverrides(params, fileState.overrides);
    syncRowsFromParams();
    saveOverrides(fileState.overrides);
    if (historyVisible) renderHistoryList();
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Legacy copy path — works in plain-http contexts where the async Clipboard
// API is unavailable (navigator.clipboard is undefined outside a secure
// context in most browsers). Deprecated by browsers but still functional;
// used only as the second fallback rung before giving up to the visible
// textarea (showJsonFallback).
function execCommandCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  Object.assign(ta.style, { position: "fixed", top: "-1000px", left: "-1000px" } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

function formatValue(v: number | boolean | Partial<KartPhysicsParams>): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  return "{...}";
}

function formatHistoryEntry(entry: HistoryEntry): string {
  if (entry.key === "__reset__") {
    const n = Object.keys(entry.oldValue as Partial<KartPhysicsParams>).length;
    return `RESET ALL (${n} парам. → дефолт)`;
  }
  return `${entry.key}: ${formatValue(entry.oldValue)} → ${formatValue(entry.newValue)}`;
}

// Modified-state left-border/background highlight — kept as constants so the
// row-build code and the live refreshRow() closure agree on the exact same
// colors (gold #FFD54A per the requested "changed param" highlight).
const MODIFIED_BORDER_COLOR = "#FFD54A";
const MODIFIED_BG_COLOR = "rgba(255,213,74,.08)";

function buildParamRow(
  d: ParamDescriptor,
  params: KartPhysicsParams,
  rowsByKey: Map<ParamKey, { numberInput: HTMLInputElement; rangeInput: HTMLInputElement | null; refreshRow: () => void }>,
  onChange: (key: ParamKey, oldValue: number | boolean, newValue: number | boolean) => void
): HTMLElement {
  const row = document.createElement("div");
  Object.assign(row.style, {
    marginBottom: "2px", padding: "2px 4px 2px 6px",
    borderLeft: "3px solid transparent", borderRadius: "3px",
  });

  const nameLine = document.createElement("div");
  Object.assign(nameLine.style, { display: "flex", alignItems: "center", gap: "5px" });

  // Collapsed by default — only rendered when there's actually a `detail`
  // to reveal, so single-sentence descriptors (already fully visible in
  // `short`) don't get a dead-end arrow.
  let detailVisible = false;
  let toggleBtn: HTMLButtonElement | null = null;
  if (d.detail) {
    toggleBtn = document.createElement("button");
    toggleBtn.textContent = "▸"; // ▸
    toggleBtn.title = "Показать примеры значений / дефолт";
    Object.assign(toggleBtn.style, {
      background: "none", border: "none", color: "#666", cursor: "pointer",
      fontSize: "10px", padding: "0 2px", lineHeight: "1", width: "12px",
    } satisfies Partial<CSSStyleDeclaration>);
    nameLine.appendChild(toggleBtn);
  }

  const name = document.createElement("span");
  name.textContent = d.key + (d.unit ? ` (${d.unit})` : "");
  Object.assign(name.style, { color: d.legacy ? "#777" : "#7fb3d3", fontWeight: "bold", fontSize: "11px" });
  nameLine.appendChild(name);

  const spacer = document.createElement("span");
  Object.assign(spacer.style, { flex: "1" });
  nameLine.appendChild(spacer);

  // Reset-to-default (⟲) — only shown while the param is actually modified;
  // refreshRow() below toggles its visibility. Routes through the same
  // onChange callback as a slider drag so the reset lands in history/undo
  // like any other edit.
  const resetBtn = document.createElement("button");
  resetBtn.textContent = "⟲"; // ⟲
  resetBtn.title = "Сбросить к дефолту";
  Object.assign(resetBtn.style, {
    background: "none", border: "none", color: MODIFIED_BORDER_COLOR, cursor: "pointer",
    fontSize: "12px", padding: "0 2px", lineHeight: "1", display: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  nameLine.appendChild(resetBtn);

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
      const oldValue = getParamValue(params, d.key);
      const newValue = numberInput.checked;
      setParamValue(params, d.key, newValue);
      numberInput.value = newValue ? "1" : "0";
      onChange(d.key, oldValue, newValue);
    });
    nameLine.insertBefore(numberInput, spacer);
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
      width: "58px", background: "#0f3460", color: "#eee", border: "1px solid #444",
      borderRadius: "4px", padding: "1px 3px",
    });

    const range = rangeInput; // narrow for closures below (non-null)
    range.addEventListener("input", () => {
      const oldValue = getParamValue(params, d.key);
      const newValue = Number(range.value);
      setParamValue(params, d.key, newValue);
      numberInput.value = range.value;
      onChange(d.key, oldValue, newValue);
    });
    numberInput.addEventListener("change", () => {
      const oldValue = getParamValue(params, d.key);
      const newValue = Number(numberInput.value);
      if (!Number.isFinite(newValue)) return;
      setParamValue(params, d.key, newValue);
      range.value = String(newValue);
      onChange(d.key, oldValue, newValue);
    });

    controlLine.appendChild(rangeInput);
    controlLine.appendChild(numberInput);
    row.appendChild(controlLine);
  }

  const short = document.createElement("div");
  short.textContent = d.short;
  Object.assign(short.style, { color: d.legacy ? "#665" : "#888", fontSize: "10px", lineHeight: "1.25", marginTop: "1px" });
  row.appendChild(short);

  // Detail panel: collapsed div holding the "Дефолт: X [→ сейчас: Y]" line
  // (kept live via refreshRow so switching values while it's open updates
  // it in place) plus the example-value prose moved out of `short`.
  let defaultLineEl: HTMLElement | null = null;
  let detailPanel: HTMLElement | null = null;
  if (d.detail) {
    detailPanel = document.createElement("div");
    Object.assign(detailPanel.style, {
      display: "none", marginTop: "3px", padding: "3px 6px",
      background: "rgba(255,255,255,.03)", borderRadius: "3px",
    });

    defaultLineEl = document.createElement("div");
    Object.assign(defaultLineEl.style, { color: "#7fd3a3", fontSize: "10px", marginBottom: "2px" });
    detailPanel.appendChild(defaultLineEl);

    const detailText = document.createElement("div");
    detailText.textContent = d.detail;
    Object.assign(detailText.style, { color: d.legacy ? "#665" : "#999", fontSize: "10px", lineHeight: "1.3" });
    detailPanel.appendChild(detailText);

    row.appendChild(detailPanel);

    toggleBtn!.addEventListener("click", () => {
      detailVisible = !detailVisible;
      detailPanel!.style.display = detailVisible ? "block" : "none";
      toggleBtn!.textContent = detailVisible ? "▾" : "▸"; // ▾ / ▸
    });
  }

  function refreshRow(): void {
    const modified = isParamModified(d.key, params);
    row.style.borderLeftColor = modified ? MODIFIED_BORDER_COLOR : "transparent";
    row.style.background = modified ? MODIFIED_BG_COLOR : "transparent";
    resetBtn.style.display = modified ? "inline" : "none";
    if (defaultLineEl) defaultLineEl.textContent = formatDefaultLine(d.key, params);
  }

  resetBtn.addEventListener("click", () => {
    const oldValue = getParamValue(params, d.key);
    const newValue = getParamValue(DEFAULT_KART_PHYSICS_PARAMS, d.key);
    if (oldValue === newValue) return;
    setParamValue(params, d.key, newValue);
    if (d.bool) {
      numberInput.checked = Boolean(newValue);
      numberInput.value = newValue ? "1" : "0";
    } else {
      numberInput.value = String(newValue);
      if (rangeInput) rangeInput.value = String(newValue);
    }
    onChange(d.key, oldValue, newValue);
  });

  rowsByKey.set(d.key, { numberInput, rangeInput, refreshRow });
  refreshRow();

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
