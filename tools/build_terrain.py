#!/usr/bin/env python3
"""Build world-space terrain tiles for the bw_all06 BR map.

The game ships terrain (ground + roads + bridges) as a grid of separate LOD
tiles (model_new/scene/bw_all06_xc/bw_all06_content/lodmodels/l1_<x>_<y>_0.mesh),
extracted locally into tools/_cache/terrain_meshes/ (gitignored, one-time export
via extract_terrain_batch.py-equivalent -- not committed, matches the building
mesh cache convention).

Each tile's vertex data is in TILE-LOCAL space (not world space) -- no config
anywhere states the grid pitch. A first attempt reverse-engineered it from
pairs of adjacent tiles that appeared to share duplicate boundary vertices
(props straddling the seam), solved by nearest-neighbor-matching the touching
edge. That produced a plausible-looking, sub-unit-precision fit (-1663/-1133.75)
that was WRONG -- it was actually measuring the repeat spacing of a decorative
prop instanced throughout the map, not the tile grid itself. Caught by cross-
checking against house_info.json's known building world positions (ground
truth): only 53% of buildings landed inside any predicted tile footprint.

The values below instead come from a direct data-driven fit: grid-search over
(pitch_x, pitch_z, origin_x, origin_z) maximizing how many of the 382 real
building positions fall inside the terrain tile predicted to contain them.
380/382 (99.5%) land within a 300-unit margin at this optimum; the 2 misses
are isolated single buildings, not a systematic pattern.
  PITCH_X = 1691.0    (world X offset per +1 tile-x index)
  PITCH_Z = 1651.0    (world Z offset per +1 tile-y index)
  ORIGIN_X = 60.0      ORIGIN_Z = 210.0
Y (height) needs no offset -- tiles are already in world-space elevation.

Writes one binary blob per tile (same SLPC format as the building chunks) into
data/terrain/, plus data/terrain_manifest.json. Kept as a separate streaming
layer from the building chunks (data/chunks/) rather than merged into them,
since tiles are much bigger than the building grid cell size and splitting
their triangles across that grid would produce very uneven chunk sizes.
"""
import json, os, struct, sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SMCSTUFF = os.path.join(os.path.dirname(REPO_ROOT), "smcStuff")
sys.path.insert(0, os.path.join(SMCSTUFF, "build"))
import mesh_to_obj

CACHE = os.path.join(REPO_ROOT, "tools", "_cache", "terrain_meshes")
OUT_DIR = os.path.join(REPO_ROOT, "data", "terrain")

PITCH_X = 1691.0
PITCH_Z = 1651.0
ORIGIN_X = 60.0
ORIGIN_Z = 210.0

# The single global (pitch, origin) above is a good average fit but leaves
# real local drift in places (confirmed by comparing two user-dropped pins --
# one on a real building, one on its duplicate-looking baked footprint in the
# terrain -- ~450 world units apart). A per-tile local correction was tried
# and rejected: with only a handful of nearby buildings to calibrate against,
# the "best" offset for a given tile kept sliding further away the more the
# search range was widened -- a sign of an underconstrained, meaningless fit,
# not a real correction. Only regions with enough nearby buildings (>=20) to
# converge to a STABLE offset (confirmed by re-running with a much wider
# search range and getting the same answer) are trusted here. Everywhere else
# keeps the global default rather than risk a confidently-wrong local nudge.
REGIONAL_OFFSETS = json.load(open(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "terrain_regional_offsets.json")))


def local_origin(tile_cx, tile_cz):
    for r in REGIONAL_OFFSETS:
        ccx, ccz = r["centroid"]
        if (tile_cx - ccx) ** 2 + (tile_cz - ccz) ** 2 <= r["radius"] ** 2:
            return ORIGIN_X + r["dox"], ORIGIN_Z + r["doz"]
    return ORIGIN_X, ORIGIN_Z


def main():
    tiles = json.load(open(os.path.join(REPO_ROOT, "tools", "terrain_tiles.json")))

    os.makedirs(OUT_DIR, exist_ok=True)
    for f in os.listdir(OUT_DIR):
        os.remove(os.path.join(OUT_DIR, f))

    manifest = {"tiles": []}
    fail = []
    all_x, all_y, all_z = [], [], []
    total_verts = total_faces = 0

    for xi, yi in tiles:
        local_path = os.path.join(CACHE, f"l1_{xi}_{yi}_0.mesh")
        if not os.path.exists(local_path):
            fail.append((xi, yi, "missing from cache"))
            continue
        try:
            _ver, _mtype, verts, faces = mesh_to_obj.parse(local_path)
        except Exception as ex:
            fail.append((xi, yi, str(ex)))
            continue
        if not verts:
            continue

        nominal_cx, nominal_cz = xi * PITCH_X + ORIGIN_X, yi * PITCH_Z + ORIGIN_Z
        origin_x, origin_z = local_origin(nominal_cx, nominal_cz)
        ox, oz = xi * PITCH_X + origin_x, yi * PITCH_Z + origin_z
        world_verts = [(x + ox, y, z + oz) for x, y, z in verts]
        xs = [v[0] for v in world_verts]; ys = [v[1] for v in world_verts]; zs = [v[2] for v in world_verts]
        all_x += xs; all_y += ys; all_z += zs
        total_verts += len(world_verts); total_faces += len(faces)

        fname = f"terrain_{xi}_{yi}.bin"
        with open(os.path.join(OUT_DIR, fname), "wb") as f:
            f.write(b"SLPC")
            f.write(struct.pack("<II", len(world_verts), len(faces)))
            for x, y, z in world_verts:
                f.write(struct.pack("<fff", x, y, z))
            for a, b, c in faces:
                f.write(struct.pack("<III", a, b, c))
        manifest["tiles"].append({
            "xi": xi, "yi": yi, "file": f"terrain/{fname}",
            "minX": min(xs), "maxX": max(xs),
            "minY": min(ys), "maxY": max(ys),
            "minZ": min(zs), "maxZ": max(zs),
            "verts": len(world_verts), "faces": len(faces),
        })

    manifest["pitch_x"] = PITCH_X
    manifest["pitch_z"] = PITCH_Z
    if all_x:
        manifest["bbox"] = {
            "minX": min(all_x), "maxX": max(all_x),
            "minY": min(all_y), "maxY": max(all_y),
            "minZ": min(all_z), "maxZ": max(all_z),
        }

    with open(os.path.join(REPO_ROOT, "data", "terrain_manifest.json"), "w") as f:
        json.dump(manifest, f)

    print(f"tiles written: {len(manifest['tiles'])}/{len(tiles)}")
    print(f"failures: {len(fail)}: {fail[:10]}")
    print(f"total verts: {total_verts}  total faces: {total_faces}")
    total_size = sum(os.path.getsize(os.path.join(OUT_DIR, os.path.basename(t['file']))) for t in manifest["tiles"])
    print(f"total terrain data size: {total_size/1e6:.2f} MB")
    if all_x:
        print(f"terrain bbox: {manifest['bbox']}")


if __name__ == "__main__":
    main()
