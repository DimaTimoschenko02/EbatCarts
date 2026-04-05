---
status: active
date: 2026-04-03
last-updated: 2026-04-03
---

# Systems Index — SmashKarts Clone

## Summary

- **Total systems**: 24
- **MVP**: 16 systems
- **Alpha**: 4 systems
- **Beta**: 4 systems
- **High-risk bottlenecks**: Network Layer (10 dependents), State Machine (6), Health & Damage (6)

---

## Systems Enumeration

| # | System | Category | Layer | Milestone | Status |
|---|--------|----------|-------|-----------|--------|
| 1 | State Machine | Foundation | 1 | MVP | Implemented |
| 2 | Network Layer | Foundation | 1 | MVP | Implemented |
| 3 | HTML5 Export Pipeline | Infrastructure | 1 | MVP | Broken |
| 4 | Health & Damage | Core | 2 | MVP | Designed |
| 5 | Camera System | Core | 2 | MVP | Designed |
| 6 | Kart Physics | Core | 2 | MVP | Designed |
| 7 | Kart Classes | Feature | 3 | Alpha | Not Started |
| 8 | Spawn System | Core | 3 | MVP | Designed |
| 9 | Pickup System | Core | 3 | MVP | Designed |
| 10 | Projectile System | Core | 3 | MVP | Designed |
| 11 | Weapon System | Feature | 3 | MVP | Designed |
| 12 | Powerup System | Feature | 3 | Alpha | Not Started |
| 13 | Match System | Feature | 3 | MVP | Designed |
| 14 | Lobby | Feature | 3 | MVP | Partial (no kart select, no match integration) |
| 15 | Map System | Content | 3 | MVP | Partial (1 basic map) |
| 16 | HUD | Presentation | 4 | MVP | Partial (basic exists) |
| 17 | Scoreboard UI | Presentation | 4 | Beta | Not Started |
| 18 | Audio System | Presentation | 4 | Alpha | Not Started |
| 19 | VFX System | Presentation | 4 | Alpha | Broken (explosion stub) |
| 20 | Analytics (in-game) | Meta | 5 | Beta | Not Started |
| 21 | Account System | Meta | 5 | Beta | Not Started |
| 22 | Analytics (external) | Meta | 5 | Beta | Not Started |
| 23 | Automated Test Pipeline | QA | 1-5 | MVP | Not Started |
| 24 | Playtest Protocol | QA | 5 | MVP | Not Started |

---

## Dependency Map

### Layer 1 — Foundation (no dependencies)

- **State Machine** → used by: Health & Damage, Camera, Kart Physics, Spawn, Match
- **Network Layer** → used by: Health & Damage, Kart Physics, Spawn, Pickup, Projectile, Weapon, Powerup, Match, Lobby, Account
- **HTML5 Export Pipeline** → used by: (parallel infrastructure, not a code dependency)
- **Automated Test Pipeline** → used by: (parallel QA infrastructure, grows with each system)

### Layer 2 — Core (depends on Foundation)

- **Health & Damage** → State Machine, Network Layer
- **Camera System** → State Machine
- **Kart Physics** → State Machine, Network Layer

### Layer 3 — Feature (depends on Core)

- **Kart Classes** → Kart Physics, Health & Damage
- **Spawn System** → Network Layer, State Machine
- **Pickup System** → Network Layer, Spawn System
- **Projectile System** → Network Layer, Health & Damage, Kart Physics
- **Weapon System** → Pickup System, Projectile System, Kart Classes
- **Powerup System** → Pickup System, Kart Classes, Health & Damage
- **Match System** → State Machine, Network Layer, Health & Damage, Spawn System
- **Lobby** → Network Layer, Kart Classes, Match System
- **Map System** → Spawn System, Pickup System

### Layer 4 — Presentation (wraps gameplay)

- **HUD** → Health & Damage, Weapon System, Powerup System, Match System
- **Scoreboard UI** → Match System, Analytics (in-game)
- **Audio System** → Kart Physics, Weapon System, Powerup System
- **VFX System** → Projectile System, Powerup System, Kart Physics

### Layer 5 — Meta/Polish

- **Analytics (in-game)** → Match System, Health & Damage
- **Account System** → Network Layer (external backend)
- **Analytics (external)** → Account System, Analytics (in-game)
- **Playtest Protocol** → All gameplay systems (generates checklists based on what changed)

---

## High-Risk Systems (Bottlenecks)

| System | Dependents Count | Risk |
|--------|-----------------|------|
| Network Layer | 10 | Highest — everything multiplayer depends on this |
| State Machine | 6 | High — kart, match, spawn all need clean states |
| Health & Damage | 6 | High — combat core, currently scattered |
| Pickup System | 3 | Medium — weapons and powerups both depend on it |

---

## Recommended Design Order

MVP systems first, ordered by dependencies (can't design #9 before #8, etc.)

### Phase 1: Foundation (parallel)

| Order | System | Rationale |
|-------|--------|-----------|
| 1 | State Machine | Zero deps, 6 systems need it |
| 2 | Network Layer | Zero deps, 10 systems need it. Refactor existing. |
| — | HTML5 Export Pipeline | Parallel with 1-2, infrastructure task |
| — | Automated Test Pipeline | Parallel, grows incrementally with each system |

### Phase 2: Core

| Order | System | Rationale |
|-------|--------|-----------|
| 3 | Health & Damage | Depends on 1,2. Unlocks weapons, powerups, match |
| 4 | Kart Physics | Depends on 1,2. Drift tuning, Resource-based stats |
| 5 | Camera System | Depends on 1. Extract from kart_controller |

### Phase 3: Gameplay Systems

| Order | System | Rationale |
|-------|--------|-----------|
| 6 | Spawn System | Depends on 1,2. Player + pickup respawn |
| 7 | Projectile System | Depends on 2,3,4. Base class for all projectiles |
| 8 | Pickup System | Depends on 2,6. Shared weapon/powerup pickup logic |
| 9 | Weapon System | Depends on 7,8. Resource-based weapons |
| 10 | Match System | Depends on 1,2,3,6. Timer, scoring, rounds |

### Phase 4: Integration

| Order | System | Rationale |
|-------|--------|-----------|
| 11 | Lobby | Update existing. Kart select + match flow |
| 12 | Map System | Finalize map_1, add pickup/spawn point config |
| 13 | HUD | Update existing. Add match timer, powerup slot |

### Phase 5: Alpha Features

| Order | System | Rationale |
|-------|--------|-----------|
| 14 | Kart Classes | Resource-based class system |
| 15 | Powerup System | Depends on 8,14,3 |
| 16 | VFX System | Fix explosions, add effects |
| 17 | Audio System | Sound for all interactions |

### Phase 6: Beta Features

| Order | System | Rationale |
|-------|--------|-----------|
| 18 | Playtest Protocol | Checklist generator for visual/feel testing |
| 19 | Scoreboard UI | Post-match stats screen |
| 20 | Analytics (in-game) | K/D, damage, accuracy tracking |
| 21 | Account System | Lightweight auth (NestJS backend) |
| 22 | Analytics (external) | Persistent dashboard |

---

## Progress Tracker

| System | GDD | Implemented | Tested | Notes |
|--------|-----|-------------|--------|-------|
| State Machine | Designed | Implemented | - | design/gdd/state-machine.md, scripts/game_states.gd, scripts/state_manager.gd |
| Network Layer | Designed | Implemented | - | design/gdd/network-layer.md, scripts/snapshot_buffer.gd, scripts/network_manager.gd |
| HTML5 Export Pipeline | - | Broken | - | Gray screen issue |
| Health & Damage | Designed | Implemented | - | design/gdd/health-damage.md, scripts/health_component.gd, scripts/damage_info.gd, scripts/event_bus.gd |
| Camera System | Designed | Partial | - | design/gdd/camera-system.md |
| Kart Physics | Designed | Partial | - | design/gdd/kart-physics.md |
| Kart Classes | - | - | - | |
| Spawn System | Designed | Partial | - | design/gdd/spawn-system.md |
| Pickup System | Designed | Partial | - | design/gdd/pickup-system.md |
| Projectile System | Designed | Partial | - | design/gdd/projectile-system.md |
| Weapon System | Designed | Partial | - | design/gdd/weapon-system.md |
| Powerup System | - | - | - | |
| Match System | Designed | - | - | design/gdd/match-system.md |
| Lobby | - | Partial | - | No kart select, no match integration |
| Map System | - | Partial | - | 1 basic map |
| HUD | - | Partial | - | Basic HP/weapon/killfeed |
| Scoreboard UI | - | - | - | |
| Audio System | - | - | - | |
| VFX System | - | Broken | - | explosion_rockets.gd is stub |
| Analytics (in-game) | - | - | - | |
| Account System | - | - | - | |
| Analytics (external) | - | - | - | |
| Automated Test Pipeline | - | - | - | Chrome MCP + headless Godot + pre-commit hooks |
| Playtest Protocol | - | - | - | AI generates, human clicks Yes/No |
