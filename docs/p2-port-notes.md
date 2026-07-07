# P2 Port Notes — Weapons, Pickups, Spawn, Lobby

> Извлечено из Godot-версии (frozen reference) для порта на three.js/TS/Colyseus.
> Источник истины — **код**. GDD документы (`design/gdd/*.md`) описывают intent/будущее
> и во многих местах **разошлись с тем что реально запрограммировано**. Ниже везде,
> где есть расхождение, зафиксированы ОБА варианта с явной пометкой `⚠ DISCREPANCY`.
> Это НЕ инструкция "как надо" — следующий агент решает, что портировать as-is,
> а что доделывать по GDD, вместе с game-designer/systems-designer.

---

## 1. Оружие / Стрельба

### Статус реализации (важно прочитать первым)

⚠ **DISCREPANCY, крупное**: GDD `weapon-system.md` описывает полноценный
`WeaponComponent` с 5 типами оружия (Rocket/Shotgun/Mine/Dynamite/Laser),
3 fire mode (INSTANT/CHARGE/CONTINUOUS), ammo-счётчиком, `WeaponResource` .tres.
**Реально в коде реализован только один тип оружия — "rocket", без ammo-счётчика,
без отдельного WeaponComponent-класса.** Вся логика стрельбы живёт прямо в
`kart_controller.gd`. Остальные 4 оружия из GDD **не существуют в коде вообще**
(нет `.gd` файлов, нет `.tres` ресурсов кроме `rocket_config.tres`).

Портировать нужно то, что реально работает (одно оружие, "выстрелил → EMPTY"),
и заложить архитектуру так, чтобы остальные 4 типа из GDD добавлялись как
data-driven записи (см. раздел "Данные для data-driven порта").

### Параметры

| Параметр | Значение | Откуда | Комментарий |
|---|---|---|---|
| `speed` (скорость ракеты) | **40.0 m/s** | `resources/rocket_config.tres:7` | ⚠ GDD `projectile-system.md` таблица говорит 28 m/s, и там же "Open Question" отмечает расхождение 45→28. Реальное текущее значение в .tres — **40**, не 28 и не 45. |
| `lifetime` | **6.0 s** | `resources/rocket_config.tres:8` | GDD говорит 3.5s. Реально 6.0s → max range = 40×6 = 240m (весь GDD расчёт max_range из формулы устарел) |
| `gravity_scale` | 0.0 | `resources/rocket_config.tres:9` | прямая линия, без параболы |
| `base_damage` | **40** | `resources/rocket_config.tres:10` | совпадает с GDD |
| `aoe_radius` | **3.5 m** | `resources/rocket_config.tres:11` | совпадает с GDD, linear falloff |
| `self_damage` | **false** | `resources/rocket_config.tres:12` | ⚠ GDD `weapon-system.md` Open Question #4 явно решает "self-damage = yes (как у ракеты)". В коде `.tres` стоит `false`. Расхождение между явным дизайн-решением и текущим конфигом. |
| `weapon_name` | `"rocket"` | `resources/rocket_config.tres:13` | используется только для `DamageInfo.weapon_name` (аналитика) |
| `ROCKET_SPREAD_DEG` | **10.0°** | `scripts/kart_controller.gd:60` | угол разлёта для боковых стволов (см. ниже) |
| Fire input | клавиша `fire` (Space/ЛКМ) | `kart_controller.gd:407` | `Input.is_action_just_pressed("fire")` |
| Кулдаун между выстрелами | **нет отдельного кулдауна** | — | оружие потребляется полностью за один `_fire()` вызов (см. "Поведение") |
| Пусковых установок (launchers) на карте | до 3: `Socket_Left`, `Socket_Right`, `Socket_Center` | `kart_controller.gd:64-66, 811` | если сокет существует в сцене карта — стреляет из него |

### Поведение (пошагово)

1. Игрок держит `WeaponState.ARMED` (получено через pickup, см. раздел 2). Нажимает `fire`.
2. **Клиент**: `_fire()` вызывается локально для визуала (`_launch_visual()` — анимация ракеты в сокете, `_show_fire_flash()` — вспышка). Если это НЕ сервер — клиент шлёт `_rpc_request_fire.rpc_id(1)` серверу и ждёт (визуал уже показан оптимистично).
3. **Сервер** (или локальный игрок = сервер): проверяет `StateManager.can_fire(peer_id)` → `can_move() AND weapon_state == ARMED`. Если ок:
   - `StateManager.server_consume_weapon(peer_id)` — **сразу** переводит `WeaponState: ARMED → EMPTY`. Нет промежуточных `FIRING`/`COOLDOWN` состояний, хотя они формально объявлены в `game_states.gd` enum и transition table — фактически не используются в текущем flow стрельбы.
   - Для каждого активного сокета (1-3 шт.) сервер вычисляет направление выстрела через `_apply_rocket_spread()`:
     - Если сокетов < 3 → без разброса, все летят строго вперёд из своей позиции.
     - Если сокетов == 3 → левый ствол получает `-10°` yaw, правый `+10°`, центральный `0°` (индексы 0/1/2 = left/right/center порядок массива `_launcher_nodes`).
   - Сервер рассылает `_rpc_spawn_projectile.rpc(shooter_id, muzzle_pos, dir)` **по одному вызову на каждый сокет** — то есть один выстрел может заспавнить 1-3 отдельные ракеты одновременно (с независимым дублирующим уроном каждая). Это отличается от GDD "1 projectile per rocket shot".
4. Все клиенты (включая сервер) инстанцируют `RocketProjectile` (`_rpc_spawn_projectile`, authority→all, reliable), `rocket.setup(config.duplicate(), shooter_id, dir)`, ставят в позицию муззла, ориентируют по direction.
5. Каждая ракета **симулируется на каждом клиенте независимо** (`_physics_process`: `global_position += direction * speed * delta`) — детерминированное движение, без position-sync по сети.
6. **Урон считается только на сервере** (`if not multiplayer.is_server(): return` во всех damage-функциях):
   - При столкновении (`Area3D.body_entered`, кроме групп `"rockets"` — ракеты друг друга игнорируют): `_on_hit()` → если `_age < 0.1s` → игнор (защита от самоподрыва на старте, **не проверяет что тело именно shooter**, просто общий guard по времени для ЛЮБОГО столкновения в первые 0.1с) → иначе `_apply_aoe_damage(global_position)` + explosion VFX + `_die()`.
   - При истечении lifetime (6s): тот же `_apply_aoe_damage` + explosion + `_die()`.
   - AOE: для каждого kart в группе `"karts"`: `dist = center.distance_to(kart.pos)`; если `dist > aoe_radius` → skip; `falloff = max(0, 1 - dist/aoe_radius)`; `final_dmg = floor(base_damage * falloff)`; если `self_damage == false` и `kart.player_id == shooter_id` → skip.
   - `DamageInfo.create(Type.AOE_EXPLOSION, final_dmg, shooter_id, center, weapon_name)` → `health_component.apply_damage(info)`.
7. `HealthComponent.apply_damage()` (сервер): guard `StateManager.can_take_damage(owner_id)` (не DEAD/RESPAWNING/INVULNERABLE), `current_hp -= final_damage` (после `class_resist_modifier`), если `<= 0` → kill flow (см. раздел Health/Damage ниже), иначе → `damaged` signal + hp sync RPC.
8. Смерть игрока → `WeaponState` НЕ управляется автоматически кодом смерти напрямую (`server_kill_kart` не трогает weapon state) — **⚠ DISCREPANCY**: GDD говорит "Death clears weapon (EMPTY state)" явно, но в реальном коде явного вызова `server_consume_weapon`/сброса на смерть не найдено (только `_force_all_weapons_empty()` при завершении матча). Т.е. если игрок умер держа ARMED оружие — по коду он его сохраняет после респавна (если respawn не проходит через registration reset). Нужно перепроверить при портировании — вероятно баг/недосмотр в оригинале, не осознанное решение.

### Авторитетность

Полностью server authoritative: клиент только шлёт `_rpc_request_fire` (для non-host) и рисует визуал оптимистично; весь урон/state считается сервером; спавн ракеты идёт от сервера ко всем (`@rpc("authority", "call_local", "reliable")`).

### Данные для data-driven порта (аналог `KART_TYPES` в `web-slice/src/kart/stats.ts`)

Сейчас в коде существует только один "weapon type" — жёстко зашитый rocket-конфиг. Для порта рекомендуется завести `WEAPON_TYPES` реестр в стиле `stats.ts`, но **заполнить реально нужно только запись `rocket`** — остальное (shotgun/mine/dynamite/laser) существует только как таблица в GDD `weapon-system.md`, не как рабочий код. Если решаете портировать только rocket (MVP-скоуп P2) — не тратьте время на остальные 4, они не реализованы даже в reference-версии.

```ts
// предлагаемая форма (не хардкодить в логику!)
interface ProjectileStats {
  readonly id: string;          // "rocket"
  readonly speed: number;        // 40 m/s (реальное значение из .tres, НЕ 28 из GDD-таблицы)
  readonly lifetime: number;     // 6.0 s
  readonly gravityScale: number; // 0
  readonly baseDamage: number;   // 40
  readonly aoeRadius: number;    // 3.5 m
  readonly selfDamage: boolean;  // false (текущий .tres; GDD-решение говорит true — уточнить у game-designer перед портом)
}
```

### Сигналы/события

- `BaseProjectile.exploded(pos: Vector3)` — сигнал для VFX/audio (взрыв). В коде подписчиков на верхнем уровне не найдено кроме использования внутри самой ракеты (`_spawn_explosion_vfx`); порт может завести отдельный EventBus event `weapon:exploded`.
- `EventBus.damage_dealt(attacker_id, victim_id, info, final_amount)` — эмитится из `HealthComponent.apply_damage()`, слушает `GameManager._on_damage_dealt` (накопление статы damage_dealt/damage_taken).
- `EventBus.player_killed(victim_id, killer_id, info)` — эмитится из `GameManager.record_kill()`.

### Что НЕ переносим в MVP

- Shotgun, Mine, Dynamite, Laser — не реализованы вообще, не путать "не переносим" с "надо перенести" — их physически нет в reference-коде, GDD описывает их как design intent для будущего.
- Charge-механика, Continuous/beam fire mode — не реализованы.
- Ammo-счётчик (несколько выстрелов на один pickup) — не реализован, сейчас 1 pickup = 1 "залп" (1-3 ракеты одновременно из имеющихся сокетов) → EMPTY.
- FIRING/COOLDOWN state — объявлены в enum, не используются в реальном flow.

---

## 2. Weapon-боксы (пикапы)

### Статус реализации

⚠ **DISCREPANCY, крупное**: GDD `pickup-system.md` описывает архитектуру
`BasePickup` → `WeaponPickup`/`PowerupPickup`, weighted `PickupPoolResource`
(5 типов оружия с весами 30/25/20/15/10), Ghost-preview state, player-count
scaling кулдауна. **В реальном коде — один файл `scripts/weapon_pickup.gd`,
монолитный, без наследования, без pool (выдаёт единственное доступное
оружие — фактически просто переводит `WeaponState: EMPTY → ARMED`, не
выбирая ничего, потому что выбирать не из чего), без Ghost state, без
player-count scaling.** PowerupPickup не существует вообще (нет файла).

### Параметры

| Параметр | Значение | Откуда |
|---|---|---|
| `RESPAWN_TIME` (респавн бокса после подбора) | **10.0 s**, константа, не масштабируется по числу игроков | `scripts/weapon_pickup.gd:3` |
| Радиус подбора (collision shape) | Sphere ~1.2m (описано в GDD, но реальный `.tscn`-shape не проверялся напрямую — берите значение из сцены `WeaponPickup_N` в карте, не из этого документа) | GDD `pickup-system.md:59`, TODO проверить точный radius в `.tscn` |
| Скорость вращения меша бокса | **2.0 rad/s** (`rotate_y(delta * 2.0)`) | `scripts/weapon_pickup.gd:17` |
| Ghost preview time | **не реализовано** | GDD говорит 2.0s, в коде отсутствует |

### Поведение (пошагово)

1. `Area3D.body_entered` fires **на всех peer'ах** (клиент и сервер получают сигнал локально — Godot не рассылает это по сети автоматически, это чисто локальная физика).
2. Non-server peers: `return` сразу — вся логика ниже только на сервере.
3. Guard: если бокс уже `not active` → `return` (защита от повторного триггера).
4. Guard: тело должно быть `CharacterBody3D` (кроме karts ничего не даёт эффекта).
5. `_try_give_weapon(body)`: если `StateManager.get_weapon_state(pid) != EMPTY` → **return без замены** (⚠ DISCREPANCY: GDD правило "Pickup while armed: ALWAYS replace current weapon/powerup" — в реальном коде НЕ реализовано, подбор игнорируется если у игрока уже есть оружие). Проверяет `StateManager.can_move(pid)` (не DEAD/RESPAWNING).
6. Если проверки прошли: `StateManager.server_give_weapon(pid)` → `WeaponState: EMPTY → ARMED`. Бокс скрывается: `_set_state(false)` локально + `_rpc_set_state.rpc(false)` всем клиентам (visible=false, monitoring=false).
7. Стартует `get_tree().create_timer(RESPAWN_TIME=10.0).timeout` (без player-count scaling, без ghost-предупреждения) → по истечении: `_set_state(true)` + `_rpc_set_state.rpc(true)` (снова видим и активен), затем ждёт 2 physics-кадра и вызывает `_try_give_from_overlaps()` — проверяет, не стоит ли уже кто-то на респавнящемся боксе (auto-collect для игрока который "спамил" стоя на месте бокса).
8. Никакого выбора предмета — оружие всегда одно и то же ("rocket", жёстко в `kart_controller.gd`, не через pickup-переданный ресурс). Pickup буквально не знает ЧТО он выдаёт — просто триггерит `ARMED`.

### Авторитетность

Server-only логика подбора (`if not multiplayer.is_server(): return` в начале). Визуальное состояние (видимость/коллизия) синхронизируется через `@rpc("authority", "call_remote")` `_rpc_set_state(on: bool)`.

### Сигналы/события

Нет отдельных сигналов у pickup — весь эффект идёт через прямой вызов `StateManager.server_give_weapon()`, который сам эмитит `weapon_state_changed(peer_id, from, to)` (слушает `kart_controller.gd._on_weapon_state_changed` для показа/скрытия visual weapon model).

### Данные для data-driven порта

Поскольку реального pool нет — портировать нужно как "один тип пикапа, respawn=10s, без weighted selection". Если решите добавить pool заранее (для будущих weapons) — это НЕ откат от GDD, а забегание вперёд; явно пометьте в коде как "not yet exercised, only 1 entry populated".

### Что НЕ переносим в MVP

- PowerupPickup — не существует.
- Weighted pool — не существует (только один "приз").
- Ghost preview state — не существует.
- Player-count-scaled respawn cooldown — не существует, всегда фиксированные 10s.
- "Replace on pickup while armed" — GDD-правило, в коде НЕ реализовано (текущее поведение — игнорировать подбор при уже занятом слоте).

---

## 3. Спавн-система

### Статус реализации

Реализация близко следует GDD, но с одним значимым пробелом — **Spawn Protection
(soft push) не реализован в коде вообще**, хотя подробно расписан в GDD с формулами
и tuning knobs.

### Параметры

| Параметр | Значение | Откуда |
|---|---|---|
| `MIN_KART_SPAWNS` | **4** | `scripts/spawn_manager.gd:3` — совпадает с GDD |
| Discovery механизм | `get_tree().get_nodes_in_group("kart_spawn")`, только `Marker3D` учитываются | `scripts/spawn_manager.gd:20-23` |
| `RESPAWN_DELAY` (DEAD → RESPAWNING) | **3.0 s** | `scripts/state_manager.gd:13` — совпадает с GDD |
| `RESPAWN_INVULN_DURATION` (RESPAWNING → DRIVING) | **2.0 s** | `scripts/state_manager.gd:14` — совпадает с GDD |
| Spawn push radius | **не реализовано** (GDD: 3.0m) | — |
| Spawn push force | **не реализовано** (GDD: 8.0 m/s impulse) | — |
| Initial spawn — режим выбора | Sequential round-robin (`_next_index % count`) | `scripts/spawn_manager.gd:40-47` — совпадает с GDD |
| Respawn после смерти — режим выбора | Farthest-from-alive-enemies (см. алгоритм ниже) | `scripts/spawn_manager.gd:50-73` — совпадает с GDD концептуально |

### Поведение (пошагово)

**Discovery (lazy, один раз за жизнь SpawnManager):**
1. `_ensure_discovered()` вызывается лениво при первом обращении к любому public-методу (НЕ в `_ready()`, вопреки формулировке GDD "SpawnManager discovers points via get_tree().get_nodes_in_group() in _ready()" — фактически discovery отложен до первого вызова, `_ready()` пустой (`pass`) с комментарием "Lazy discovery via _ensure_discovered()").
2. Собирает все `Marker3D` из группы `kart_spawn` → `_spawn_points`.
3. `validate_map()`: если `count < MIN_KART_SPAWNS` → `push_error` (НЕ `assert` как в GDD псевдокоде — в реальности только warning-уровня error, не крашит игру).

**Initial spawn (`get_initial_spawn_point`)**: круговой перебор `_spawn_points[_next_index % size]`, инкремент `_next_index`. Никакой информации о том кто вызывает не используется (чистая round-robin, без учёта уже занятых позиций).

**Respawn (`get_respawn_point(karts_container)`)**: для каждой spawn-точки считает `min_dist` до ближайшего **живого** карта (исключаются карты в состоянии `DEAD` или `RESPAWNING` — **не исключает `INVULNERABLE`**, то есть только что заспавненные неуязвимые враги всё равно учитываются как "живые" при выборе точки для следующего респавна). Выбирает точку с максимальным `min_dist` (argmax по min-distance = farthest-from-nearest-enemy).

**Полный flow смерть→респавн** (подтверждено чтением `scripts/game_world.gd` целиком — TODO из прошлой версии этого документа закрыт):
1. `HealthComponent.apply_damage()` доводит `current_hp` до 0 → вызывает `GameManager.record_kill(victim_id, killer_id, info)`.
2. `GameManager.record_kill()`: инкремент deaths/kills в stats, рассылает `_rpc_kill.rpc()` всем (обновление scoreboard), затем **сам вызывает** `StateManager.server_kill_kart(victim_id, killer_id)`.
3. `StateManager.server_kill_kart()`: валидирует transition через `KART_TRANSITIONS` table, рассылает `_rpc_set_kart_state.rpc(peer_id, DEAD, from, killer_id)`, запускает `_delayed_kart_transition(peer_id, DEAD, RESPAWNING, delay=3.0)`.
4. Спустя 3s: если игрок всё ещё в `DEAD` (guard от гонки состояний) → `_server_transition_kart(peer_id, RESPAWNING)` → рассылает `_rpc_set_kart_state.rpc()` → на приёме эмитит `kart_state_changed(peer_id, from, RESPAWNING)` и `kart_respawned(peer_id)`.
5. **`game_world.gd` подписан на `StateManager.kart_state_changed`** (`game_world.gd:34`) → `_on_kart_state_changed()` фильтрует `to == RESPAWNING` → вызывает `_on_kart_respawning(pid)` (`game_world.gd:164-178`), которая:
   - guard `if not multiplayer.is_server(): return` (это единственное место с явной server-проверкой во всей цепочке спавна/респавна — сам `SpawnManager` таких guard'ов не содержит),
   - находит kart-ноду по `karts.get_node_or_null(str(pid))`,
   - `spawn_pos = spawn_manager.get_respawn_point(karts)` — здесь **реально** вызывается `SpawnManager`,
   - `spawn_rot = _face_center_rotation(spawn_pos)` — **доп. деталь, не описанная в GDD**: kart разворачивается лицом к центру арены (`atan2` от вектора `ZERO - spawn_pos`, если позиция не в центре), а не сохраняет ориентацию Marker3D из редактора. GDD Open Question #1 ("face center or Marker3D rotation?") **разрешён в коде в пользу "face center"**.
   - `kart.respawn.rpc(spawn_pos, spawn_rot)` — RPC на конкретный kart-узел (не через StateManager), применяет позицию/ротацию на всех клиентах,
   - `StateManager.server_respawn_complete(pid)` — сразу же (без ожидания) стартует `_delayed_kart_transition(pid, RESPAWNING, DRIVING, RESPAWN_INVULN_DURATION=2.0)`.
6. Спустя `RESPAWN_INVULN_DURATION=2.0s` от входа в `RESPAWNING` → `DRIVING` (если игрок ещё `RESPAWNING`).

**Initial spawn** (match start / late join) идёт по отдельному пути, НЕ через `kart_state_changed`: `game_world.gd._register()` (RPC `@rpc("any_peer", "call_remote", "reliable")` от клиента "я загрузился, вот моё имя") →
1. сервер шлёт новому клиенту `_rpc_world_state.rpc_id(pid, _build_world_state())` — **до** спавна каких-либо карт (`scores`, `pickups` active-состояния, `match_state`, `hp_states` всех текущих игроков);
2. сервер спавнит на новом клиенте карты всех уже существующих игроков (`_rpc_spawn_kart.rpc_id(pid, ...)` для каждого `existing_pid`);
3. `_spawn_for_player(pid, player_name)`: `GameManager.register_player()` + `spawn_manager.get_initial_spawn_point()` (round-robin) + та же `_face_center_rotation()` → `_rpc_spawn_kart.rpc(pid, name, pos, rot)` — создаёт kart-ноду **на всех клиентах** (включая новичка);
4. `synced_peers.append(pid)`;
5. `StateManager.sync_state_to_peer(pid)` — досылает текущие kart/weapon states новому peer'у.

**Дисконнект**: `game_world.gd._on_player_disconnected(pid)` (сервер слушает `NetworkManager.player_disconnected`) → рассылает `_rpc_kart_disconnect.rpc(pid)` всем **до** очистки (чтобы клиенты успели убрать kart-ноду), затем `GameManager.unregister_player(pid)` (внутри вызывает `StateManager.unregister_kart`), удаление из локальных Dictionary/Array, `kart.queue_free()`.

### Авторитетность

`SpawnManager` сам по себе не имеет server-check внутри (никаких `if not multiplayer.is_server()` guard'ов в файле!) — авторитетность обеспечивается тем, что **единственный вызывающий код** (`game_world.gd._on_kart_respawning()` и `_spawn_for_player()`) сам обёрнут в server-only ветки. ⚠ **Замечание для Colyseus-порта**: вся цепочка (`kart died → wait 3s → pick respawn point → wait 2s invuln → DRIVING`) в оригинале — не отдельный сетевой сервис, а chain of `Timer`-колбэков внутри уже-серверного `game_world.gd`/`state_manager.gd`. При портировании это естественно ложится на server-side room scheduled callbacks (`clock.setTimeout` в Colyseus) — никакого отдельного "spawn microservice" не нужно, чисто внутренняя логика room.

### Сигналы/события

- `StateManager.kart_died(peer_id, killer_peer_id)` — эмитится при входе в DEAD.
- `StateManager.kart_respawned(peer_id)` — эмитится при входе в RESPAWNING (по факту это сигнал "начал респавниться", не "закончил").
- `StateManager.kart_state_changed(peer_id, from, to)` — общий сигнал всех транзиций.

### Что НЕ переносим в MVP

- Spawn Protection soft push (3m radius, 8 m/s impulse) — полностью отсутствует в коде, только в GDD. Решить с game-designer, нужен ли он для P2, или остаётся deferred.
- Random Spawn Mode — explicitly "Not implemented at MVP" даже в GDD, не реализовано.
- Учёт `INVULNERABLE` состояния при выборе farthest spawn — в коде не исключается (минорная неточность vs GDD intent).

---

## 4. Лобби-флоу

### Экраны и переходы (ASCII-схема, из реального кода `lobby_controller.gd` + панели)

```
                     ┌───────────────┐
        (autohost /  │  SplashPanel  │
         room-server │  auth check   │
         spawn path   ──────┬────────┘
          bypasses           │
          all panels)        │ ProfileManager.auth_check_async()
                              │
              ┌───────────────┼──────────────────┐
   token invalid/absent       │        token valid, no ?join
   (или reason != no_token    │        code pending
    → "сессия истекла")       │
              ▼               │                  ▼
     ┌─────────────────┐      │         ┌──────────────────┐
     │ FirstTimePanel  │      │         │  LobbyHomePanel   │
     │ (ник + валидация)│─────┼────────▶│ (список комнат,   │
     └─────────────────┘  profile_loaded│  создать комнату) │
              │                         └─────────┬─────────┘
              │ register_async → profile_loaded    │ клик "ЗАЙТИ" /
              │                                     │ create_room_async
              ▼                                     ▼
     ┌────────────────────────────────────────────────────┐
     │              RoomLobbyPanel                          │
     │  (roster, invite link, Start [видна всем!], Leave)   │
     └───────────────────────┬──────────────────────────────┘
                              │ match_starting (любой клиент может
                              │ вызвать request_match_start)
                              ▼
                   change_scene_to_file("game.tscn")
```

`?join=CODE` (deep link) обрабатывается в `SplashPanel` **до** показа любого другого
экрана: если профиль валиден → сразу `RoomsClient.resolve_room_async(code)` →
`NetworkManager.join_game(ws_url)` → при успехе `goto_room_lobby.emit(code)`,
минуя `LobbyHomePanel` целиком (совпадает с GDD).

Отдельного `ProfileDashboard`-экрана из GDD **не реализовано** — в коде только 4
панели: `SplashPanel`, `FirstTimePanel`, `LobbyHomePanel`, `RoomLobbyPanel`
(`lobby_controller.gd:8-11`). Нет K/D dashboard, нет "Сменить аккаунт" экрана
отдельно от logout.

⚠ **DISCREPANCY, важное для геймплея**: GDD `lobby-ui.md` §7 явно говорит
"Кнопка Старт: Видна только у host (peer_id == 1)", "Disabled если current_players < 2".
Реальный код `room_lobby_panel.gd:36-38` — комментарий в коде: `# Friend-game: any
client may start the match` — `start_btn.disabled = false` безусловно для всех,
включая гостей, и **нет проверки на минимум 2 игрока** нигде в `_on_start_pressed()`.
Это осознанное упрощение для игры с друзьями (комментарий в коде это подтверждает),
не баг — но явно расходится с GDD.

### Экраны — детали ввода/полей

| Экран | Поля ввода | Валидация |
|---|---|---|
| FirstTimePanel | Никнейм, `LineEdit`, max 20 симв. | Клиент: длина 2-20, charset `^[A-Za-z0-9_-]+$`. Сервер (debounce 500ms — `CHECK_DEBOUNCE_S=0.5`, ⚠ GDD говорит 400ms, код — 500ms): `GET /api/profile/check?nick=`, при конфликте показывает suggestions-чипы |
| LobbyHomePanel | Нет полей ввода ника. Есть `DurationDropdown` (5/10/20 минут) для создания комнаты — **это не описано в GDD вообще**, GDD говорит "дефолтные параметры, никакого диалога" | — |
| RoomLobbyPanel | Нет полей ввода. Invite-строка (readonly) + кнопка "Скопировать" | — |

### Формирование deep-link комнаты

```
invite_url = "{origin}/?join={ROOM_CODE}"
```
`room_lobby_panel.gd:45-51`: origin читается через `JavaScriptBridge.eval("window.location.origin")` на web-платформе, иначе fallback `"http://localhost:8060"`. Копирование в буфер: `navigator.clipboard.writeText()` на web, `DisplayServer.clipboard_set()` иначе.

### API endpoints, которые дёргает лобби (реальные из `server/` контроллеров — код, не GDD; TODO из прошлой версии документа закрыты чтением `profile_manager.gd`, `rooms_client.gd`, `master_client.gd`, `rooms.dto.js`, `rooms.service.js`, `rooms.constants.js`, `profiles.dto.js`, `internal.middleware.js`)

| Endpoint | Метод | Вызывающий код (Godot) | Тело/query | Ответ / валидация | Комментарий |
|---|---|---|---|---|---|
| `/api/profile/check` | GET | `ProfileManager.check_nick_async(nickname)` (`profile_manager.gd:126-137`) | `?nick=VALUE` (URL-encoded) | `{ available: bool, suggestions: [...] }` (предположительно — сервисный код `profiles.service.js` не читан) | debounce на клиенте не в `ProfileManager`, а в вызывающей панели (`first_time_panel.gd`, 500ms) |
| `/api/profile/register` | POST | `ProfileManager.register_async(nickname)` | `{ nickname }` | `201` + `{ nickname, auth_token, profile }` (профиль — см. `serializeProfile()` ниже). При конфликте (`409`): `{ details: { suggestions: [...] } }` | Валидация ника (`profiles.dto.js validateNickname`): 2-20 символов (проверено `NICK_MIN_LEN`/`NICK_MAX_LEN` из `profiles.constants.js`, не прочитаны точные числа — предположительно совпадают с клиентскими 2/20), regex `NICK_REGEX`, плюс серверный blacklist зарезервированных ников через `isReserved()` |
| `/api/profile/auth` | POST | `ProfileManager.auth_check_async()` | `{ auth_token }` | `{ nickname, profile }` при успехе. `401`/`404` → клиент удаляет локальный токен (`_clear_token_on_unauth`) | ⚠ **DISCREPANCY подтверждена**: GDD говорит `GET /api/profile/auth`, реальный endpoint — **POST** с телом `{auth_token}` (`profiles.controller.js:21-24`, `profiles.dto.js validateAuthToken` — просто non-empty string, никакого формата токена не проверяется на этом уровне) |
| `/api/profile/claim` | POST | `ProfileManager.claim_async(nickname)` — **вызывающий код найден**: используется в `_desktop_auto_login()` при `409 Conflict` от `/register` (т.е. "профиль с этим ником уже существует локально — перевыпусти токен") | `{ nickname }` | `{ nickname, auth_token, profile }` | ⚠ **Замечание безопасности, важно для Colyseus/production-порта**: `claim` перевыпускает токен **просто по нику, без пароля/верификации владения** — это работает только потому что desktop debug использует фиксированный ник `"Desktop"` в локальной dev-среде. Для браузерного P2 порта **не копировать это поведение как есть** без явного решения design/security — иначе любой может "угнать" чужой ник запросом `/claim` |
| `/api/rooms` | GET | `RoomsClient.fetch_rooms_async()` (poll каждые 4s, `lobby_home_panel.gd:8, 62-63`) | — | `{ rooms: [serializeRoom(...), ...] }` | `rooms.controller.js:36-39` |
| `/api/rooms` | POST | `RoomsClient.create_room_async(opts)` | Реально клиент шлёт **только** `{ host_name, max_players: 8, duration_min }` (`lobby_home_panel.gd:175-179`) | `201` + `serializeRoom(room)` (поля см. ниже) | ⚠ **DISCREPANCY** (уточнена серверным DTO `rooms.dto.js validateCreateRoomBody`): сервер **поддерживает** опциональные `name` (по умолчанию `"{host_name}'s room"`, макс `ROOM_NAME_MAX=32` симв., regex `ROOM_NAME_REGEX = /^[\p{L}\p{N} _\-!?.,()'`]{1,32}$/u` — юникод-буквы/цифры/пробел/пунктуация) и `map_id` (по умолчанию `DEFAULT_MAP_ID="map_1"`), но **клиент их никогда не передаёт** — так что на практике всегда дефолт. `max_players` валидируется диапазоном `MAX_PLAYERS_MIN=2..MAX_PLAYERS_MAX=8`. `duration_min` валидируется строго по whitelist `DURATION_MIN_OPTIONS=[5,10,20]` (`rooms.constants.js:11`) — не произвольное число, сервер **отклонит** любое другое значение |
| `/api/rooms/:code` | GET | `RoomsClient.resolve_room_async(code)` (deep link + клик по карточке комнаты) | — | `serializeRoom(room)`, `404` если комнаты нет | `rooms.controller.js:51-54` |
| `/api/rooms/:code` | DELETE | не вызывается из Godot-клиента (admin/internal use, вероятно debug tooling) | — | `{ deleted: true, code }` / `404` | `rooms.controller.js:56-60` |
| `/api/internal/match/submit` | POST | `MasterClient.submit_match_async(payload)` (`master_client.gd:27-53`), только на **серверном** Godot-процессе (`is_active()` требует `RoomsReporter.is_room_server && RoomsReporter.internal_token != ""`) | Полный match payload (см. раздел "Оружие/Health" — `_build_match_payload()` в `game_manager.gd`) | — | Заголовок `Authorization: Bearer {internal_token}`, проверяется `internal.middleware.js internalAuth()`: сравнение строкой с `config.internalToken` (единый shared-secret между master и Godot subprocess, передаётся Godot при спавне как `--internal-token`) |

**`serializeRoom()` — полный список полей ответа** (`rooms.dto.js:46-67`, подтверждено, ранее в документе была только выборка из UI-кода):
```
room_code, room_id (alias = room_code), name, host_name, map_id,
max_players, current_players, duration_min, state (WAITING/IN_MATCH/POST_MATCH/CLEANUP),
is_full (current_players >= max_players), created_at (unix sec),
ws_url ("{wsBaseUrl}/ws/{code}" или null), invite_link ("{inviteBaseUrl}/?join={code}" или null)
```

**`serializeProfile()` — полный список полей профиля** (`profiles.dto.js:31-50`):
```
nickname, nickname_lower, created_at, last_seen_at,
stats: { total_kills, total_deaths, total_assists, total_damage_dealt,
         total_damage_taken, total_shots_fired, total_shots_hit,
         total_matches, total_wins }
```
Это те же поля что использует `lobby_home_panel.gd:52-57` (`ProfileManager.profile.get("stats", {})`).

### Палитра Neon Stadium (точные значения из `scripts/ui/ui_palette.gd`)

**Backgrounds:**
| Токен | RGBA (0-1) | Hex (approx) |
|---|---|---|
| `BG_DEEP` | (0.045, 0.06, 0.12, 1.0) | `#0C0F1F` |
| `BG_PANEL` | (0.115, 0.13, 0.245, 1.0) | `#1D213E` |
| `BG_PANEL_LIGHT` | (0.165, 0.195, 0.34, 1.0) | `#2A3257` |
| `BG_INPUT` | (0.05, 0.07, 0.13, 1.0) | `#0D1221` |
| `BG_BUTTON` | (0.16, 0.22, 0.4, 1.0) | `#293666` |
| `BG_BUTTON_HOVER` | (0.24, 0.34, 0.62, 1.0) | `#3D579E` |
| `BG_BUTTON_PRESSED` | (0.10, 0.14, 0.27, 1.0) | `#1A2445` |
| `BG_BUTTON_DISABLED` | (0.085, 0.10, 0.18, 1.0) | `#161A2E` |
| `BG_DESTRUCTIVE` | (0.42, 0.13, 0.20, 1.0) | `#6B2133` |
| `BG_DESTRUCTIVE_HOVER` | (0.62, 0.18, 0.27, 1.0) | `#9E2E45` |

**Accents:**
| Токен | RGBA | Hex |
|---|---|---|
| `ACCENT_GOLD` | (1.000, 0.840, 0.200, 1.0) | `#FFD633` |
| `ACCENT_CYAN` | (0.300, 0.920, 1.000, 1.0) | `#4CEBFF` |
| `ACCENT_MAGENTA` | (0.960, 0.300, 0.780, 1.0) | `#F44CC7` |
| `ACCENT_RED` | (1.000, 0.300, 0.360, 1.0) | `#FF4C5C` |
| `ACCENT_LIME` | (0.400, 0.960, 0.450, 1.0) | `#66F573` |

**Text:**
| Токен | RGBA | Hex |
|---|---|---|
| `TEXT_PRIMARY` | (0.960, 0.980, 1.000, 1.0) | `#F5FAFF` |
| `TEXT_SECONDARY` | (0.700, 0.780, 0.920, 1.0) | `#B3C7EB` |
| `TEXT_DIM` | (0.480, 0.560, 0.720, 1.0) | `#7A8FB8` |

**Status:**
| Токен | RGBA | Hex |
|---|---|---|
| `STATUS_OK` | (0.400, 1.000, 0.500, 1.0) | `#66FF80` |
| `STATUS_ERROR` | (1.000, 0.420, 0.520, 1.0) | `#FF6B85` |
| `STATUS_PENDING` | (0.760, 0.780, 0.860, 1.0) | `#C2C7DB` |

**Borders:**
| Токен | RGBA | Hex |
|---|---|---|
| `BORDER_NORMAL` | (0.300, 0.860, 1.000, 0.550) | `#4CDBFF` @ 55% alpha |
| `BORDER_HOVER` | (0.300, 0.920, 1.000, 1.000) | `#4CEBFF` |
| `BORDER_FOCUS` | (1.000, 0.840, 0.200, 1.000) | `#FFD633` |
| `BORDER_DESTRUCTIVE` | (1.000, 0.300, 0.360, 0.900) | `#FF4C5C` @ 90% alpha |

**Dimensions:**
| Токен | Значение |
|---|---|
| `RADIUS_CARD` | 18px |
| `RADIUS_BUTTON` | 10px |
| `RADIUS_INPUT` | 10px |
| `PADDING_CARD` | 36px |
| `PADDING_BUTTON_H` | 28px |
| `PADDING_BUTTON_V` | 18px |

**Шрифты/размеры (из `resources/ui/theme_main.tres`):**
| Элемент | default_font_size |
|---|---|
| Theme default | 18 |
| Button | 22 |
| Label | 18 |
| LineEdit | 22 |

Цвета кнопки: `font_color=(0.95,0.97,1,1)`, `font_hover_color=font_focus_color=font_pressed_color=(1,0.84,0.2,1)` (золото ACCENT_GOLD при hover/focus/pressed), `font_disabled_color=(0.42,0.5,0.66,1)`.

### Формирование deep-link / nickname / room name — сводка полей ввода

- Игрок вводит только **никнейм** (2-20 симв, `A-Za-z0-9_-`) — единственное текстовое поле во всём лобби-флоу.
- Имя комнаты **не вводится игроком** в текущем коде — `LobbyHomePanel._on_create_pressed()` не шлёт `name` вообще. Уточнено: сервер **умеет** принять `name` в теле POST (см. `validateCreateRoomBody`), генерирует дефолт `"{host_name}'s room"` если поле отсутствует — то есть архитектурно готово к кастомному имени комнаты (GDD Open Question #2 "нужна ли форма для кастомного имени"), просто UI пока не даёт такой возможности. При порте на Colyseus можно сразу добавить это поле в Create Room форму без серверных изменений (аналог уже есть).
- Единственный доп. выбор при создании — `duration_min` (5/10/20 через dropdown, whitelist на сервере — см. таблицу endpoint'ов выше), сразу отправляется на сервер.

### Хранение токена / auth (клиент)

`ProfileManager` (`scripts/profile/profile_manager.gd`) — единственный источник `auth_token` на клиенте:

| Платформа | Где хранится | Ключ |
|---|---|---|
| Web (браузер) | `window.localStorage` через `JavaScriptBridge.eval()` | `smash_karts_token` (`TOKEN_LS_KEY`, `profile_manager.gd:13`) |
| Desktop (не-web билд) | `ConfigFile` на диске | `user://profile.cfg`, секция `auth`, ключ `token` |

`_api_base` конфигурируется в приоритете: env var `MASTER_URL` → URL-параметр `?master=URL` → дефолт `http://127.0.0.1:8080/api`. Тот же паттерн (`MASTER_URL` env override) используется в `RoomsClient` и `MasterClient` независимо — три отдельных autoload'а, каждый со своей копией HTTP-plumbing (не общий HTTP-клиент).

**Desktop debug shortcut** (`_desktop_auto_login()`, только если `OS.is_debug_build() and not OS.has_feature("web")`): если токена нет ИЛИ токен невалиден — автоматически логинится под фиксированным ником `"Desktop"`, минуя FirstTimePanel полностью; при конфликте (профиль `"Desktop"` уже существует от прошлого запуска) — вызывает `/api/profile/claim` для перевыпуска токена. **Это чисто dev-удобство для локальной разработки**, не переносить в браузерный prod-флоу как есть (см. предупреждение про `/claim` выше).

**Web fetch реализация** (`ProfileManager`/`RoomsClient`, идентичный паттерн в обоих): HTTP-запросы на web НЕ идут через `HTTPRequest` Godot-ноду (та даёт CORS-проблемы в браузере) — вместо этого через `JavaScriptBridge.eval()` инжектится raw `fetch()` JS-код с колбэком через `window["_smk_cb_N"]`/`window["_smk_rc_cb_N"]` (уникальный ключ на каждый запрос). `credentials: 'omit'`, `mode: 'cors'`. На desktop — обычный `HTTPRequest` с `timeout=10.0`.

### Что НЕ переносим в MVP

- Отдельный экран Profile Dashboard — не реализован.
- Host-only Start button + min-2-players gate — сознательно упрощено до "любой может стартовать в любой момент" (комментарий в коде подтверждает намеренность для friends-game).
- Ghost/toast notification system, exponential backoff при ошибках поллинга — не проверялось в этой сессии (сигналы `request_failed` есть, но retry/backoff логика внутри вызывающих панелей не аудировалась подробно).
- Ping display — известный баг, см. `docs/known-issues.md`: RPC `_rpc_ping`/`_rpc_pong` не работает, "Ping: --" никогда не обновляется. Низкий приоритет, косметика.
- Desktop-only `/claim`-based auto-login — dev convenience, не production auth flow. Не переносить логику "перевыпустить токен просто по нику" в браузерный клиент без явного design/security решения.

---

## Как в reference-версии спавнится "комната" (важно для замены на Colyseus)

Прочитаны `server/rooms/rooms.service.js`, `server/rooms/rooms.spawn.js`, `server/rooms/rooms.dto.js`, `server/rooms/rooms.constants.js` — TODO из прошлой версии документа закрыт.

**Модель сейчас**: 1 комната = 1 отдельный **headless Godot subprocess**, запускается через Node.js `child_process.spawn()`:

```
"C:\Godot..._console.exe" --headless --path <godotProjectPath> --
  --port <N> --room <CODE> --map <mapId> --max-players <N>
  --duration-min <N> --healthcheck-port <N+1000> [--internal-token <TOKEN>]
```

Пошагово (`rooms.service.js create()`):
1. `portPool.allocate()` — выделяет свободный порт из пула (`config.portPoolStart`..`+portPoolSize`); если пул исчерпан → `409 ConflictError("port_pool_exhausted")`.
2. `generateRoomCode()` — генерит уникальный 6-символьный код из charset `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (без `0/O/I/1` — неоднозначные глифы), проверяет уникальность среди активных комнат.
3. `healthcheckPort = port + HEALTHCHECK_PORT_OFFSET(1000)` — отдельный HTTP-порт для healthcheck (не WS).
4. `processManager.spawnRoom(...)` — реально запускает Godot-процесс с CLI-аргументами выше; `internalToken` передаётся **только если сконфигурирован** (`config.internalToken`) — это тот же shared-secret что проверяет `internal.middleware.js` на `/api/internal/match/submit`.
5. Слушает `child.on("exit", ...)` для немедленного обнаружения краша → `cleanupRoom(code, "child_exit:...")`.
6. **Ждёт готовности** (`SPAWN_READY_TIMEOUT_MS = 12000`): поллит `GET http://127.0.0.1:{healthcheckPort}/healthcheck` каждые 250ms пока не получит `200 OK` (или timeout → `cleanupRoom("spawn_timeout")` + `409 ConflictError`). Это устраняет race "клиент получил ws_url и подключился раньше чем Godot-процесс поднял WS-сервер".
7. Только после успешного healthcheck — `POST /api/rooms` возвращает `201` клиенту.

**Cleanup** (`cleanupRoom`): помечает `state = CLEANUP`, `processManager.killProcess(child, "SIGTERM")`, освобождает порт обратно в пул, удаляет из repo.

**Fake spawn для тестов/дева** (`createFakeProcessManager`, активен если `config.devMode && SKIP_SPAWN=1` env): не запускает реальный Godot-процесс, инкрементальный fake pid, `waitReady()` сразу возвращает `true` — используется в CI/dev без установленного Godot.

### ⚠ Что это значит для замены на Colyseus

Вся эта инфраструктура (`portPool`, `processManager.spawnRoom`, healthcheck-polling, CLI-аргументы Godot) — **специфична для модели "1 комната = 1 OS-процесс"**. При переходе на Colyseus эта модель **не нужна вообще**: Colyseus `Room` — это objects внутри одного Node.js-процесса (game server), а не отдельные subprocess'ы. Соответственно для P2-порта:
- `rooms.service.js create()` можно радикально упростить: вместо `portPool.allocate()` + `spawn()` + healthcheck-polling → просто `matchMaker.createRoom("arena", options)` (Colyseus API) — комната появляется мгновенно в памяти, никакого `SPAWN_READY_TIMEOUT_MS` не нужно.
- `--port`/`--healthcheck-port`/`--internal-token` CLI-аргументы теряют смысл — Colyseus room получает опции через `onCreate(options)` напрямую в том же процессе.
- `ws_url` в `serializeRoom()` — вместо `{wsBaseUrl}/ws/{code}` (прямой WS на выделенный порт конкретного Godot-процесса) станет единый Colyseus WS endpoint + `roomId`/`sessionId` — клиент подключается через `client.joinById(roomId)`, а не по кастомному URL с портом.
- `MasterClient` (`/api/internal/match/submit`, Bearer-токен) — эта часть контракта **не завязана** на модель процессов, её можно перенести почти as-is: Colyseus room по окончании матча делает тот же `POST` с тем же payload на master (или, если Colyseus room и Express API теперь в одном процессе — прямой вызов сервиса вместо HTTP).
- `rooms.constants.js` (charset кода комнаты, `MAX_PLAYERS_MIN/MAX`, `DURATION_MIN_OPTIONS`, `ROOM_NAME_REGEX/MAX`) — это чисто доменные правила, переносятся без изменений независимо от транспорта.

---

## Общие TODO для агента-порта (оставшиеся, не покрыты в этом документе)

1. Точный `CollisionShape3D` radius пикапа (1.2m заявлено в GDD, не подтверждено чтением `.tscn`-файла сцены пикапа — не входило в scope этой сессии).
2. `HealthComponent.max_hp` дефолт = 100 (`health_component.gd:10`) — совпадает с GDD "Standard 100 HP". `class_resist_modifier` (дефолт 1.0) намекает на будущие типы карта с разным resist — не проверено, есть ли уже где-то в ресурсах карт отличные от 1.0 значения (не входило в scope: не читались `.tres` файлы конкретных kart types, если они есть).
3. `profiles.service.js`/`profiles.repository.js` (не читаны) — точный формат ответа `/api/profile/check` (`{available, suggestions}` предполагается по вызывающему коду `first_time_panel.gd`, но сам сервис не открывался) и точные значения `NICK_MIN_LEN`/`NICK_MAX_LEN`/`isReserved()` списка из `profiles.constants.js` (не открывался).
4. `db/migrations.js`/`db/index.js` — схема таблицы профилей в SQLite (поля `nickname_display`, `nickname_lower`, статы) — не открывались, для порта на новый backend может понадобиться, если данные профилей мигрируют, а не создаются с нуля.
