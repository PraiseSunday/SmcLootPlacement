#!/usr/bin/env python3
"""Build world-space terrain tiles for the bw_all06 BR map.

The game ships terrain (ground + roads + bridges) as a grid of separate LOD
tiles (model_new/scene/bw_all06_xc/bw_all06_content/lodmodels/l1_<x>_<y>_0.mesh),
extracted locally into tools/_cache/terrain_meshes/ (gitignored, one-time export
via extract_terrain_batch.py-equivalent -- not committed, matches the building
mesh cache convention).

Each tile's vertex data is in TILE-LOCAL space, centred on the tile (local
coordinates run roughly +-832 about 0), so placing a tile only needs its world
centre. Tile indices are signed and centred on the map origin: xi in [-16, 15],
yi in [-15, 15].

The grid comes from the scene file the client itself loads,
scene/bw_all06_xc/bw_all06.scn (NeoX property format, magic 0x0D4159C1 -- see
docs/terrain-placement.md for the decode). Its Terrain/Landscape node states:

  GridSize   = 26      heightfield cell size
  NumColumns = 2048    heightfield cells across
  NumRows    = 2048
  OffsetX    = -27040  world position of the heightfield's low corner
  OffsetZ    = -27040

so the terrain spans 26 * 2048 = 53248 units from -27040 to +26208. That is
exactly 32 tiles of 53248 / 32 = 1664, which the same file confirms directly as
a LODChunk ChunkSize of 1664 (the finer 832 chunk level is the l0 tier we don't
use). Tile xi = -16 therefore has its low edge at -27040 and its CENTRE at
-27040 + 832 = -26208, giving centre(xi) = xi * 1664 + 416.

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

PITCH_X = PITCH_Z = 1664.0     # 53248 / 32, == the scene's LODChunk ChunkSize
ORIGIN_X = ORIGIN_Z = 416.0    # world centre of tile index 0

# NeoX is LEFT-handed; three.js is right-handed. Emitting engine coordinates
# unchanged renders the whole map as its own mirror image. Negating Z on the way
# out (and reversing triangle winding to keep normals pointing outwards) puts the
# viewer in the same chirality as the game -- a top-down view then reads +X right
# and +Z up, matching the in-game map. See docs/handedness.md.
def mirror(x, y, z):
    return (x, y, -z)

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

        ox, oz = xi * PITCH_X + ORIGIN_X, yi * PITCH_Z + ORIGIN_Z
        world_verts = [mirror(x + ox, y, z + oz) for x, y, z in verts]
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
                f.write(struct.pack("<III", a, c, b))
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
