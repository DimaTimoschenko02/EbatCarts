// Pure-logic tests for the dev param panel — no DOM involved (DOM wiring is
// exercised manually in-browser per the ui-programmer task; see main.ts).
import { describe, expect, it } from "vitest";
import { DEFAULT_KART_PHYSICS_PARAMS } from "../physics/types";
import {
  applyOverrides,
  computeOverridesAtIndex,
  diffFromDefaults,
  type HistoryEntry,
  parseDevParamsFile,
  parseHistoryEntries,
  parseStoredOverrides,
  pushHistoryEntry,
  revertToIndex,
  undoLast,
} from "./paramPanel";

describe("diffFromDefaults", () => {
  it("returns empty object when nothing changed", () => {
    const current = { ...DEFAULT_KART_PHYSICS_PARAMS };
    expect(diffFromDefaults(current)).toEqual({});
  });

  it("includes only the fields that differ from defaults", () => {
    const current = { ...DEFAULT_KART_PHYSICS_PARAMS, maxSpeed: 30, rearGripStiffness: 5 };
    const diff = diffFromDefaults(current);
    expect(diff).toEqual({ maxSpeed: 30, rearGripStiffness: 5 });
  });

  it("picks up a changed boolean field", () => {
    const current = { ...DEFAULT_KART_PHYSICS_PARAMS, autoDriftEnabled: !DEFAULT_KART_PHYSICS_PARAMS.autoDriftEnabled };
    expect(diffFromDefaults(current)).toEqual({ autoDriftEnabled: !DEFAULT_KART_PHYSICS_PARAMS.autoDriftEnabled });
  });
});

describe("parseStoredOverrides", () => {
  it("returns {} for null / invalid JSON", () => {
    expect(parseStoredOverrides(null)).toEqual({});
    expect(parseStoredOverrides("not json")).toEqual({});
  });

  it("returns {} for a JSON value that isn't an object", () => {
    expect(parseStoredOverrides("42")).toEqual({});
    expect(parseStoredOverrides("null")).toEqual({});
  });

  it("keeps only known KartPhysicsParams keys with number/boolean values", () => {
    const raw = JSON.stringify({
      maxSpeed: 30,
      autoDriftEnabled: false,
      thisFieldWasRenamedOrRemoved: 123,
      rearGripStiffness: "not a number",
    });
    expect(parseStoredOverrides(raw)).toEqual({ maxSpeed: 30, autoDriftEnabled: false });
  });
});

describe("applyOverrides", () => {
  it("mutates the target object in place (live-apply mechanism)", () => {
    const target = { ...DEFAULT_KART_PHYSICS_PARAMS };
    applyOverrides(target, { maxSpeed: 99, autoDriftEnabled: false });
    expect(target.maxSpeed).toBe(99);
    expect(target.autoDriftEnabled).toBe(false);
    // Everything else untouched.
    expect(target.accelForce).toBe(DEFAULT_KART_PHYSICS_PARAMS.accelForce);
  });

  it("round-trips through diffFromDefaults + applyOverrides back to the same values", () => {
    const tuned = { ...DEFAULT_KART_PHYSICS_PARAMS, kDrag: 0.03, driftYawBonus: 2.5 };
    const diff = diffFromDefaults(tuned);
    const rebuilt = { ...DEFAULT_KART_PHYSICS_PARAMS };
    applyOverrides(rebuilt, diff);
    expect(rebuilt).toEqual(tuned);
  });
});

function entry(key: HistoryEntry["key"], oldValue: HistoryEntry["oldValue"], newValue: HistoryEntry["newValue"], ts = 0): HistoryEntry {
  return { ts, key, oldValue, newValue };
}

describe("pushHistoryEntry", () => {
  it("appends to an empty history", () => {
    const h = pushHistoryEntry([], entry("maxSpeed", 24.5, 30));
    expect(h).toEqual([entry("maxSpeed", 24.5, 30)]);
  });

  it("keeps the ring buffer at maxLen, dropping the oldest entries first", () => {
    let h: HistoryEntry[] = [];
    for (let i = 0; i < 5; i++) h = pushHistoryEntry(h, entry("maxSpeed", i, i + 1), 3);
    expect(h).toHaveLength(3);
    // Entries for i=0,1 got dropped; i=2,3,4 survive.
    expect(h.map(e => e.oldValue)).toEqual([2, 3, 4]);
  });

  it("does not mutate the input array", () => {
    const original: HistoryEntry[] = [entry("maxSpeed", 1, 2)];
    const next = pushHistoryEntry(original, entry("kDrag", 0.07, 0.05));
    expect(original).toHaveLength(1);
    expect(next).toHaveLength(2);
  });
});

describe("computeOverridesAtIndex", () => {
  it("returns {} for index 0 (nothing replayed yet)", () => {
    const h = [entry("maxSpeed", 24.5, 30)];
    expect(computeOverridesAtIndex(h, 0)).toEqual({});
  });

  it("folds a single field change into an overrides diff", () => {
    const h = [entry("maxSpeed", 24.5, 30)];
    expect(computeOverridesAtIndex(h, 1)).toEqual({ maxSpeed: 30 });
  });

  it("folds multiple changes to different fields", () => {
    const h = [entry("maxSpeed", 24.5, 30), entry("kDrag", 0.07, 0.05)];
    expect(computeOverridesAtIndex(h, 2)).toEqual({ maxSpeed: 30, kDrag: 0.05 });
  });

  it("later changes to the same field win, and returning to the default drops the key", () => {
    const h = [
      entry("maxSpeed", 24.5, 30),
      entry("maxSpeed", 30, 35),
      entry("maxSpeed", 35, DEFAULT_KART_PHYSICS_PARAMS.maxSpeed), // back to default
    ];
    expect(computeOverridesAtIndex(h, 3)).toEqual({});
    expect(computeOverridesAtIndex(h, 2)).toEqual({ maxSpeed: 35 });
  });

  it("a __reset__ entry clears everything before it, folding continues after", () => {
    const h = [
      entry("maxSpeed", 24.5, 30),
      entry("__reset__", { maxSpeed: 30 }, {}),
      entry("kDrag", 0.07, 0.05),
    ];
    expect(computeOverridesAtIndex(h, 3)).toEqual({ kDrag: 0.05 });
    expect(computeOverridesAtIndex(h, 2)).toEqual({});
  });

  it("clamps out-of-range index instead of throwing", () => {
    const h = [entry("maxSpeed", 24.5, 30)];
    expect(computeOverridesAtIndex(h, 99)).toEqual({ maxSpeed: 30 });
    expect(computeOverridesAtIndex(h, -5)).toEqual({});
  });
});

describe("revertToIndex", () => {
  it("returns the pre-entry overrides state and truncates history to that point", () => {
    const h = [entry("maxSpeed", 24.5, 30), entry("kDrag", 0.07, 0.05)];
    const result = revertToIndex(h, 1);
    expect(result.overrides).toEqual({ maxSpeed: 30 });
    expect(result.history).toEqual([entry("maxSpeed", 24.5, 30)]);
  });

  it("reverting to index 0 wipes history and overrides entirely", () => {
    const h = [entry("maxSpeed", 24.5, 30), entry("kDrag", 0.07, 0.05)];
    const result = revertToIndex(h, 0);
    expect(result.overrides).toEqual({});
    expect(result.history).toEqual([]);
  });

  it("does not mutate the input history array", () => {
    const h = [entry("maxSpeed", 24.5, 30), entry("kDrag", 0.07, 0.05)];
    revertToIndex(h, 1);
    expect(h).toHaveLength(2);
  });
});

describe("undoLast", () => {
  it("returns null for empty history", () => {
    expect(undoLast([])).toBeNull();
  });

  it("reverts the single most recent entry", () => {
    const h = [entry("maxSpeed", 24.5, 30), entry("kDrag", 0.07, 0.05)];
    const result = undoLast(h);
    expect(result).not.toBeNull();
    expect(result?.overrides).toEqual({ maxSpeed: 30 });
    expect(result?.history).toEqual([entry("maxSpeed", 24.5, 30)]);
  });

  it("undoing a __reset__ entry restores the pre-reset overrides", () => {
    const h = [entry("maxSpeed", 24.5, 30), entry("__reset__", { maxSpeed: 30 }, {})];
    const result = undoLast(h);
    expect(result?.overrides).toEqual({ maxSpeed: 30 });
    expect(result?.history).toEqual([entry("maxSpeed", 24.5, 30)]);
  });
});

describe("parseHistoryEntries", () => {
  it("returns [] for non-array input", () => {
    expect(parseHistoryEntries(null)).toEqual([]);
    expect(parseHistoryEntries({})).toEqual([]);
    expect(parseHistoryEntries("nope")).toEqual([]);
  });

  it("keeps well-formed entries for known keys", () => {
    const raw = [{ ts: 123, key: "maxSpeed", oldValue: 24.5, newValue: 30 }];
    expect(parseHistoryEntries(raw)).toEqual([{ ts: 123, key: "maxSpeed", oldValue: 24.5, newValue: 30 }]);
  });

  it("drops entries with unknown keys, missing ts, or wrong value types", () => {
    const raw = [
      { ts: 1, key: "thisFieldWasRenamedOrRemoved", oldValue: 1, newValue: 2 },
      { key: "maxSpeed", oldValue: 1, newValue: 2 }, // missing ts
      { ts: 1, key: "maxSpeed", oldValue: "not a number", newValue: 2 },
      { ts: 1, key: "maxSpeed", oldValue: 1, newValue: 2 }, // valid
    ];
    expect(parseHistoryEntries(raw)).toEqual([{ ts: 1, key: "maxSpeed", oldValue: 1, newValue: 2 }]);
  });

  it("keeps a well-formed __reset__ entry with object old/new values", () => {
    const raw = [{ ts: 5, key: "__reset__", oldValue: { maxSpeed: 30 }, newValue: {} }];
    expect(parseHistoryEntries(raw)).toEqual([{ ts: 5, key: "__reset__", oldValue: { maxSpeed: 30 }, newValue: {} }]);
  });
});

describe("parseDevParamsFile", () => {
  it("returns empty overrides/history for malformed input", () => {
    expect(parseDevParamsFile(null)).toEqual({ overrides: {}, history: [] });
    expect(parseDevParamsFile("not an object")).toEqual({ overrides: {}, history: [] });
  });

  it("parses overrides and history together", () => {
    const data = {
      overrides: { maxSpeed: 30 },
      history: [{ ts: 1, key: "maxSpeed", oldValue: 24.5, newValue: 30 }],
    };
    expect(parseDevParamsFile(data)).toEqual({
      overrides: { maxSpeed: 30 },
      history: [{ ts: 1, key: "maxSpeed", oldValue: 24.5, newValue: 30 }],
    });
  });

  it("tolerates a file with overrides but no history field", () => {
    expect(parseDevParamsFile({ overrides: { kDrag: 0.05 } })).toEqual({ overrides: { kDrag: 0.05 }, history: [] });
  });
});
