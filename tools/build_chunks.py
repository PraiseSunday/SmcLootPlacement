#!/usr/bin/env python3
"""Build chunked geometry for the bw_all06 BR map from cached extracted meshes.

Reads house_info.json (sibling smcStuff repo) for building placements, resolves
each building type's mesh part(s) via _cache/resolved.json, parses them with
smcStuff's build/mesh_to_obj.py, transforms verts to world space, and buckets
whole buildings into a coarse grid (assignment by building center — buildings
are never split, per-chunk files are just merged triangle soup). Writes one
compact binary blob per non-empty chunk plus a manifest.json index.

Binary layout (little-endian): 4-byte magic b"SLPC", u32 vertex_count,
u32 face_count, then vertex_count*3 float32 (x,y,z), then face_count*3 uint32
(triangle indices).
"""
import json, os, struct, sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SMCSTUFF = os.path.join(os.path.dirname(REPO_ROOT), "smcStuff")
sys.path.insert(0, os.path.join(SMCSTUFF, "build"))
import mesh_to_obj

CACHE = os.path.join(REPO_ROOT, "tools", "_cache")
OUT_DATA = os.path.join(REPO_ROOT, "data")
CELL = 2500  # world units per grid cell


def to_world(pos, rot16, scale, local_xyz):
    M = [rot16[0:4], rot16[4:8], rot16[8:12], rot16[12:16]]
    lx, ly, lz = (local_xyz[i] * scale[i] for i in range(3))
    wx = M[0][0] * lx + M[0][1] * ly + M[0][2] * lz + pos[0]
    wy = M[1][0] * lx + M[1][1] * ly + M[1][2] * lz + pos[1]
    wz = M[2][0] * lx + M[2][1] * ly + M[2][2] * lz + pos[2]
    return (wx, wy, wz)


def main():
    house = json.load(open(os.path.join(SMCSTUFF, "build/configs/item_control/bw_all06/house_info.json")))
    resolved = json.load(open(os.path.join(CACHE, "resolved.json")))

    mesh_cache = {}
    chunks = {}  # (cx, cz) -> {"verts": [...], "faces": [...], "buildings": 0}
    fail_resolve = set()
    fail_parse = []
    used = 0

    for e in house["data"]:
        typ = e["type"]
        info = resolved.get(typ)
        if not info:
            fail_resolve.add(typ)
            continue
        cx = int(e["pos"][0] // CELL)
        cz = int(e["pos"][2] // CELL)
        chunk = chunks.setdefault((cx, cz), {"verts": [], "faces": [], "buildings": 0})
        instance_ok = False
        for part, gim_path in info["paths"].items():
            mesh_path = gim_path.replace(".gim", ".mesh")
            local_path = os.path.join(CACHE, "meshes", mesh_path)
            if local_path not in mesh_cache:
                try:
                    _ver, _mtype, verts, faces = mesh_to_obj.parse(local_path)
                    mesh_cache[local_path] = (verts, faces)
                except Exception as ex:
                    mesh_cache[local_path] = None
                    fail_parse.append((typ, part, str(ex)))
            cached = mesh_cache[local_path]
            if cached is None:
                continue
            verts, faces = cached
            base = len(chunk["verts"])
            for v in verts:
                chunk["verts"].append(to_world(e["pos"], e["rot"], e["scale"], v))
            for a, b, c in faces:
                chunk["faces"].append((a + base, b + base, c + base))
            instance_ok = True
        if instance_ok:
            chunk["buildings"] += 1
            used += 1

    os.makedirs(OUT_DATA + "/chunks", exist_ok=True)
    for f in os.listdir(OUT_DATA + "/chunks"):
        os.remove(os.path.join(OUT_DATA, "chunks", f))

    manifest = {"cell_size": CELL, "chunks": []}
    all_x, all_y, all_z = [], [], []
    for (cx, cz), chunk in sorted(chunks.items()):
        verts, faces = chunk["verts"], chunk["faces"]
        if not verts:
            continue
        xs = [v[0] for v in verts]; ys = [v[1] for v in verts]; zs = [v[2] for v in verts]
        all_x += xs; all_y += ys; all_z += zs
        fname = f"chunk_{cx}_{cz}.bin"
        with open(os.path.join(OUT_DATA, "chunks", fname), "wb") as f:
            f.write(b"SLPC")
            f.write(struct.pack("<II", len(verts), len(faces)))
            for x, y, z in verts:
                f.write(struct.pack("<fff", x, y, z))
            for a, b, c in faces:
                f.write(struct.pack("<III", a, b, c))
        manifest["chunks"].append({
            "cx": cx, "cz": cz, "file": f"chunks/{fname}",
            "minX": min(xs), "maxX": max(xs),
            "minY": min(ys), "maxY": max(ys),
            "minZ": min(zs), "maxZ": max(zs),
            "buildings": chunk["buildings"],
            "verts": len(verts), "faces": len(faces),
        })

    manifest["bbox"] = {
        "minX": min(all_x), "maxX": max(all_x),
        "minY": min(all_y), "maxY": max(all_y),
        "minZ": min(all_z), "maxZ": max(all_z),
    }
    manifest["total_buildings"] = used
    manifest["total_instances"] = len(house["data"])

    with open(os.path.join(OUT_DATA, "manifest.json"), "w") as f:
        json.dump(manifest, f)

    print(f"instances placed: {used}/{len(house['data'])}")
    print(f"resolve failures ({len(fail_resolve)} types): {sorted(fail_resolve)}")
    print(f"parse failures: {len(fail_parse)}")
    for t, p, err in fail_parse[:10]:
        print(f"  {t} [{p}]: {err}")
    print(f"chunks written: {len(manifest['chunks'])}")
    total_size = sum(os.path.getsize(os.path.join(OUT_DATA, "chunks", os.path.basename(c['file']))) for c in manifest["chunks"])
    print(f"total chunk data size: {total_size/1e6:.2f} MB")
    print(f"manifest bbox: {manifest['bbox']}")


if __name__ == "__main__":
    main()
