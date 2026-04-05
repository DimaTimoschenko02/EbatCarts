# Known Issues (fix after MVP)

## 1. Ping display not updating
**Status**: Not working
**Symptom**: "Ping: --" shows but never updates with actual RTT value
**Where**: Browser client (HTML5), also visible on host
**Root cause**: Unknown — `_rpc_ping`/`_rpc_pong` RPC calls don't seem to fire. Debug prints added but don't appear in output. Possible issues: RPC annotation, Autoload RPC routing, or connection status check timing.
**Files**: `scripts/network_manager.gd` (lines 40-44, 136-151), `scripts/hud.gd`
**Priority**: Low — cosmetic, does not affect gameplay
**Added**: 2026-04-05
