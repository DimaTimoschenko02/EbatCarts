# Generator for mars_base.json — Kenney sample-inspired island map (48x48).
# Declarative level map -> cells with auto-computed skirts (side / sideCorner /
# sideCornerInner) using the vertex-verified rotation tables from
# docs/space-kit-terrain-catalog.md. Offline tool: the runtime loader stays dumb.
import json

N = 48
LEVEL = {}  # (x,z) -> y_level int
RAMPS = {}  # (x,z) -> rot (asc direction toward higher neighbor)
ROADS = {}  # (x,z) -> (asset, rot)

def fill(x0, x1, z0, z1, lv):
    for x in range(x0, x1 + 1):
        for z in range(z0, z1 + 1):
            LEVEL[(x, z)] = lv

def clear(x0, x1, z0, z1):
    for x in range(x0, x1 + 1):
        for z in range(z0, z1 + 1):
            LEVEL.pop((x, z), None)

# ── Island shape (main plateau level 2) ──────────────────────────────────
fill(6, 41, 8, 38, 2)      # main body
fill(12, 30, 39, 43, 2)    # south bulge
fill(8, 20, 4, 7, 2)       # north-west bulge
clear(38, 41, 8, 11)       # cut NE corner (concave notch -> tests Inner)

# ── Rocket platform (north-center): core lvl 4, ring lvl 3 ──────────────
fill(24, 32, 8, 14, 3)
fill(25, 31, 9, 13, 4)

# ── Quarry pit (center-west): rim terrace lvl 1, floor lvl 0 ────────────
fill(13, 21, 16, 24, 1)
fill(14, 20, 17, 23, 0)

# ── South-east lower terrace lvl 1 ───────────────────────────────────────
fill(33, 41, 30, 38, 1)

# ── Outer skirt ring: cells just outside the island get level = neighbor-1.
# Diagonal-only neighbors included too — those become sideCorner tiles at the
# island's convex corners (edge neighbors win when both exist, via max()).
DIRS = [(1, 0), (-1, 0), (0, 1), (0, -1)]
ALL8 = DIRS + [(1, 1), (1, -1), (-1, 1), (-1, -1)]
skirt_add = {}
for (x, z), lv in list(LEVEL.items()):
    for dx, dz in ALL8:
        c = (x + dx, z + dz)
        if c not in LEVEL and 0 <= c[0] < N and 0 <= c[1] < N:
            skirt_add[c] = max(skirt_add.get(c, -99), lv - 1)
LEVEL.update(skirt_add)

# ── Ramps (rot = ascent direction per catalog: 0=+Z 90=+X 180=-Z 270=-X) ─
def ramp(x, z, rot):
    RAMPS[(x, z)] = rot

# Into the pit from the east (plateau x=22 lvl2 -> rim x=21 lvl1 -> floor x=20 lvl0)
for z in (19, 20):
    ramp(21, z, 90)   # rim cell, ascends +X toward plateau
    ramp(20, z, 90)   # floor cell, ascends +X toward rim
# Onto the rocket platform from the south (plateau z=15 -> ring z=14 -> core z=13)
for x in (27, 28):
    ramp(x, 15, 180)  # plateau-level cell ascends -Z toward ring
    ramp(x, 14, 180)  # ring cell ascends -Z toward core
# Onto SE terrace from the west (plateau x=32 lvl2 -> terrace x=33 lvl1)
for z in (33, 34):
    ramp(33, z, 270)  # terrace cell ascends -X toward plateau

# ── Roads on the main plateau (flat, texture only) ───────────────────────
# East-west trunk at z=28, x 8..32; roadStraight along X needs rot=90.
for x in range(9, 32):
    if x == 20:
        ROADS[(x, 28)] = ("terrain_roadSplit", 0)  # T: branch to the south
    else:
        ROADS[(x, 28)] = ("terrain_roadStraight", 90)
ROADS[(8, 28)] = ("terrain_roadEnd", 90)
ROADS[(32, 28)] = ("terrain_roadCorner", 0)
# North leg x=32, z 16..27 toward the platform.
for z in range(16, 28):
    ROADS[(32, z)] = ("terrain_roadStraight", 0)
ROADS[(32, 16)] = ("terrain_roadEnd", 0)
# South branch x=20, z 29..41 into the south bulge.
for z in range(29, 42):
    ROADS[(20, z)] = ("terrain_roadStraight", 0)
ROADS[(20, 42)] = ("terrain_roadEnd", 180)

# ── Classify every cell ───────────────────────────────────────────────────
# side (axial): rot by direction of the HIGHER neighbor (ascent toward it):
#   +Z -> 0, +X -> 90, -Z -> 180, -X -> 270; y_level = HIGH level.
# sideCornerInner: two perpendicular higher neighbors; y_level = LOW; rot by
#   LOW corner (away from both): 0:+X-Z 90:+X+Z 180:-X+Z 270:-X-Z.
# sideCorner: no edge higher, one diagonal higher; y_level = LOW; rot by HIGH
#   corner: 0:-X+Z 90:+X+Z 180:+X-Z 270:-X-Z.
SIDE_ROT = {(0, 1): 0, (1, 0): 90, (0, -1): 180, (-1, 0): 270}
INNER_ROT = {  # low corner (dx,dz) -> rot
    (1, -1): 0, (1, 1): 90, (-1, 1): 180, (-1, -1): 270,
}
CORNER_ROT = {  # high corner (dx,dz) -> rot
    (-1, 1): 0, (1, 1): 90, (1, -1): 180, (-1, -1): 270,
}
DIAGS = [(1, 1), (1, -1), (-1, 1), (-1, -1)]

cells = []
errors = []
for (x, z), lv in sorted(LEVEL.items()):
    if (x, z) in RAMPS:
        rot = RAMPS[(x, z)]
        d = {0: (0, 1), 90: (1, 0), 180: (0, -1), 270: (-1, 0)}[rot]
        up = LEVEL.get((x + d[0], z + d[1]))
        if up != lv + 1:
            errors.append(f"ramp at {(x, z)} rot={rot}: uphill neighbor level {up}, want {lv + 1}")
        cells.append({"asset": "terrain_ramp", "x": x, "z": z, "y_level": lv, "rot": rot})
        continue

    higher = [(dx, dz) for dx, dz in DIRS if LEVEL.get((x + dx, z + dz), -99) == lv + 1]
    too_high = [(dx, dz) for dx, dz in DIRS if LEVEL.get((x + dx, z + dz), -99) > lv + 1]
    if too_high:
        errors.append(f"cell {(x, z)} lvl {lv}: neighbor 2+ levels higher at {too_high}")

    if len(higher) == 1:
        rot = SIDE_ROT[higher[0]]
        # terrain_sideCliff, NOT terrain_side: side is a thin tilted quad that
        # hangs BELOW its pivot with no back wall — inside a pit its open
        # underside faces the camera and reads as jagged shards. sideCliff is a
        # SOLID cliff face spanning [lv, lv+0.5] ABOVE the pivot, so y_level is
        # the LOW level (lv) not the high one, and it never shows a hole.
        # Same +Z-ascent-at-rot0 basis as side, so SIDE_ROT is unchanged.
        # (vertex-verified in src/assetDiag + docs/space-kit-terrain-catalog.md)
        cells.append({"asset": "terrain_sideCliff", "x": x, "z": z, "y_level": lv, "rot": rot})
    elif len(higher) == 2:
        (ax, az), (bx, bz) = higher
        if (ax + bx, az + bz) == (0, 0):
            errors.append(f"cell {(x, z)}: opposite higher neighbors — 1-wide channel, redesign")
            cells.append({"asset": "terrain", "x": x, "z": z, "y_level": lv})
        else:
            low = (-(ax + bx), -(az + bz))
            cells.append({"asset": "terrain_sideCornerInner", "x": x, "z": z,
                          "y_level": lv, "rot": INNER_ROT[low]})
    elif len(higher) >= 3:
        errors.append(f"cell {(x, z)}: {len(higher)} higher edge neighbors — pocket, redesign")
        cells.append({"asset": "terrain", "x": x, "z": z, "y_level": lv})
    else:
        diag_higher = [(dx, dz) for dx, dz in DIAGS if LEVEL.get((x + dx, z + dz), -99) == lv + 1]
        if diag_higher:
            cells.append({"asset": "terrain_sideCorner", "x": x, "z": z,
                          "y_level": lv, "rot": CORNER_ROT[diag_higher[0]]})
        elif (x, z) in ROADS:
            asset, rot = ROADS[(x, z)]
            cells.append({"asset": asset, "x": x, "z": z, "y_level": lv, "rot": rot})
        else:
            cells.append({"asset": "terrain", "x": x, "z": z, "y_level": lv})

if errors:
    print("DESIGN ERRORS:")
    for e in errors:
        print(" -", e)
    raise SystemExit(1)

# Roads placed on non-flat cells would have been silently skipped — verify.
for (x, z) in ROADS:
    c = next((c for c in cells if c["x"] == x and c["z"] == z), None)
    if c is None or not c["asset"].startswith("terrain_road"):
        print(f"WARN: road at {(x, z)} landed on {c['asset'] if c else 'nothing'}")

data = {
    "_comment": "mars_base — Kenney sample-inspired island: plateau lvl2, rocket "
                "platform lvl4 (terraced), quarry pit lvl0, SE terrace lvl1. "
                "Generated by gen_mars_base.py (session tmp), skirts auto-derived "
                "from the level map per docs/space-kit-terrain-catalog.md tables.",
    "meta": {"name": "mars_base", "tile_size": 1.0, "level_height": 0.5,
             "origin_offset": [-(N - 1) / 2, 0, -(N - 1) / 2]},
    "cells": cells,
    "props": [],
}
out = r"C:\Users\dimti\do_chego_doshel_progress\smash-karts-clone\web-slice\public\maps\mars_base.json"
with open(out, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=1)
counts = {}
for c in cells:
    counts[c["asset"]] = counts.get(c["asset"], 0) + 1
print("cells:", len(cells))
for k, v in sorted(counts.items()):
    print(f"  {k}: {v}")
