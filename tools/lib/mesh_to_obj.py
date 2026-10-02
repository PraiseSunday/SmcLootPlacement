#!/usr/bin/env python3
"""
mesh_to_obj.py — exporter for the NeoX static mesh format used by SMC
(magic 34 80 c8 bb). Extracts vertex positions + triangle indices and writes a
Wavefront .obj. Normals/UVs/skinning are read past but not exported.

Header, little-endian:
  0x00 u32  magic 0xBBC88034
  0x04 u16  version
  0x06 u16  always 0x0005
  0x08 u16  bone_type (0/3 = static, 1/4 = skinned — skinned meshes carry a
            variable-length bone table before the geometry and are NOT handled
            here, see docs/10-asset-formats.md "Remaining mesh work")
  0x0A u16  always 0x0000
  0x0C u32  ending_address — NOT geometry data; offset of a small submesh-count +
            offset-table (u16 count, then `count` x u32 offsets) that points at
            the real geometry block(s). offsets[0] is the "main" submesh; this
            exporter only extracts that one (matching the reference NeoXtractor
            parser's own scope — it also only fully extracts the first submesh).

At the main-submesh offset sits a chain of 12-byte group records
(vertex_count u32, face_count u32, uv_layers u8, unknown u8, must_be_one u16),
one per material/UV group, continuing until a record's must_be_one field == 1 —
that terminal record is followed by the TRUE overall (vertex_count, face_count)
for the whole submesh (the individual groups' counts sum to these totals). Only
after that does the actual vertex block start. (Discovered by cross-checking
against the reference NeoXtractor project's core/mesh_loader/parsers/new_parser.py
— our original fixed-offset assumption of vcount/fcount@0x10 + vertex block@0x24
only happened to work when there's exactly one group with no material split;
multi-group meshes decoded as garbage under that assumption: real vertex data
got misread starting ~mid-header, with the wrong vertex count as well.)

Per-vertex layout resolves to one of two shapes, decided by matching a byte-count
formula (identify_mesh_type, ported from the same reference parser) against the
group-derived totals: float32 position+normal (type 1, 24B/vertex) or float16
position+normal (types 2/3/4/5/100, 12B/vertex) — SMC building meshes are mostly
the float16 shape in practice. A uint16 flag follows the position+normal blocks
and gates an optional extra per-vertex block (tangents) before the face index
table. After the faces sit the UV table (uv_total x 2 float32) and then, on some
meshes, a trailing RGBA8 vertex-colour block (4B/vertex) that closes out the
submesh. The vertex-colour block only shows up as a v*4 remainder in the
byte-count formula; because it sits past the faces it never shifts the index
table. Neither UVs nor vertex colours are needed for positions+faces, so both
are left unparsed.
"""
import struct, sys, os, glob, collections

MAGIC = b"\x34\x80\xc8\xbb"

def half_to_float(h):
    s = (h >> 15) & 1; e = (h >> 10) & 0x1f; f = h & 0x3ff
    if e == 0:
        val = (f / 1024.0) * 2**-14
    elif e == 0x1f:
        val = float("inf") if f == 0 else float("nan")
    else:
        val = (1 + f / 1024.0) * 2**(e - 15)
    return -val if s else val

def _read_half(d, off):
    return half_to_float(struct.unpack_from("<H", d, off)[0])

def _identify_mesh_type(size, vertex_count, face_count, meshes_inside_data, uv_total_data, bone_type, version):
    """Resolve the per-vertex layout by matching a byte-count formula against the
    submesh's declared size. Ported from the reference NeoXtractor parser
    (new_parser.py's identify_mesh_type) — verified against building_common_hospital_b's
    actual bytes (bone_type=3 -> type 5) during this investigation."""
    uv_total_data = uv_total_data * 8
    size = size - meshes_inside_data
    if bone_type in (1, 4):
        size = size - 20 * vertex_count
    if bone_type in (0, 1):
        test = size - vertex_count*24 - face_count*6 - uv_total_data - 2
        if test == 0 or test == 32: return 1
        # trailing RGBA8 vertex-colour block (4B/vertex) after the UV table —
        # the float32 counterpart of the bone_type 3/4 branch's type 5. The
        # block sits past the face table, so positions and faces are read
        # exactly as for type 1.
        if test - vertex_count*4 == 0 or test - vertex_count*4 == 32: return 1
        test -= vertex_count*12
        if test == 0 or test == 32: return 1
        test -= vertex_count*4
        if 0 < test < vertex_count - 1: return 2
        test -= vertex_count*4
        if 0 < test < vertex_count - 1: return 3
        return -1
    elif bone_type in (3, 4):
        test = size - vertex_count*12 - face_count*6 - uv_total_data - 2
        if test == 0 or test == 32: return 4
        test -= vertex_count*4
        if test == 0 or test == 32: return 5
        test2 = test - vertex_count*2
        if test2 == 0 or test2 == 32: return 4
        test2 -= vertex_count*4
        if test2 == 0 or test2 == 32: return 5
        return 100  # unresolved shape; treated as the float16 fallback (see docstring)
    return -98

def _scan_groups(d, start):
    """Walk the chained 12-byte group records starting at `start` until the
    must_be_one terminator; returns (vertex_count, face_count, extra_records,
    data_start) where extra_records is [(vcount,fcount,uv_layers,unknown), ...]
    for every group seen (including the terminal one) and data_start is the file
    offset where the vertex block actually begins."""
    pos = start
    extra = []
    for _ in range(500):
        vertex_count, face_count = struct.unpack_from("<II", d, pos)
        uv_layers, unknown = struct.unpack_from("<BB", d, pos + 8)
        must_be_one = struct.unpack_from("<H", d, pos + 10)[0]
        extra.append((vertex_count, face_count, uv_layers, unknown))
        if must_be_one == 1:
            pos += 12
            vertex_count, face_count = struct.unpack_from("<II", d, pos)
            pos += 8
            return vertex_count, face_count, extra, pos
        pos += 10
    raise ValueError("group-record scan did not terminate (must_be_one never seen)")

def _skip_extra_submeshes(d, offsets):
    """Reference parser's own size-accounting walk for non-main submesh offsets
    (it doesn't fully extract them either — only tallies their byte length so the
    main submesh's identify_mesh_type formula can account for them)."""
    total = 0
    for off in offsets:
        p = off
        v = struct.unpack_from("<I", d, p)[0]; p += 4 + v * 12
        v = struct.unpack_from("<I", d, p)[0]; p += 4 + v * 2
        v = struct.unpack_from("<I", d, p)[0]; p += 4 + v * 4
        total += p - off + 1
    return total

def parse(path):
    d = open(path, "rb").read()
    if d[:4] != MAGIC:
        raise ValueError("not a NeoX mesh")
    version, _always0500, bone_type, _always0000 = struct.unpack_from("<HHHH", d, 4)
    if bone_type in (1, 4):
        raise ValueError("skinned mesh (bone table present) — not handled here")

    ending_address = struct.unpack_from("<I", d, 0x0C)[0]
    p = ending_address
    meshes_inside = struct.unpack_from("<H", d, p)[0]
    p += 2
    offsets = [struct.unpack_from("<I", d, p + i * 4)[0] for i in range(meshes_inside)]
    main_offset = offsets[0]

    vcount, fcount, extra, data_start = _scan_groups(d, main_offset)
    meshes_inside_data = _skip_extra_submeshes(d, offsets[1:]) if len(offsets) > 1 else 0
    total_uv = sum(v * u for v, _, u, _ in extra)
    last_uv_layers = extra[-1][2]
    if vcount * 2 == total_uv and last_uv_layers == 1:
        total_uv = vcount

    mesh_data_size = ending_address - data_start
    mtype = _identify_mesh_type(mesh_data_size, vcount, fcount, meshes_inside_data, total_uv, bone_type, version)

    if mtype == 1:
        width, comp = 4, "<f"
    elif mtype in (2, 3, 4, 5, 100):
        width, comp = 2, None  # half floats, via _read_half
    else:
        raise ValueError(f"unresolved vertex layout (type={mtype}, bone_type={bone_type})")

    def read_vec3(off):
        if comp:
            return struct.unpack_from(comp, d, off)[0], struct.unpack_from(comp, d, off + width)[0], struct.unpack_from(comp, d, off + 2*width)[0]
        return _read_half(d, off), _read_half(d, off + width), _read_half(d, off + 2*width)

    pos = data_start
    verts = [read_vec3(pos + i * 3 * width) for i in range(vcount)]
    pos += vcount * 3 * width
    pos += vcount * 3 * width  # normals, unused

    flag = struct.unpack_from("<H", d, pos)[0]
    pos += 2
    if flag == 1 and mtype in (4, 5, 7, 100):
        pos += vcount * 6
    elif flag == 1:
        pos += vcount * 12
    elif flag > 1:
        pos += flag * 4

    faces = [struct.unpack_from("<HHH", d, pos + i * 6) for i in range(fcount)]

    return version, mtype, verts, faces

def to_obj(verts, faces):
    out = ["# exported by mesh_to_obj.py (positions+faces only)"]
    for x, y, z in verts:
        out.append(f"v {x:.5f} {y:.5f} {z:.5f}")
    for a, b, c in faces:
        out.append(f"f {a+1} {b+1} {c+1}")
    return "\n".join(out) + "\n"

def bbox(verts):
    xs = [v[0] for v in verts]; ys = [v[1] for v in verts]; zs = [v[2] for v in verts]
    return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))

def main():
    args = sys.argv[1:]
    if args and args[0] == "--test":
        files = sorted(glob.glob(args[1] + "/*.mesh"))[:int(args[2]) if len(args) > 2 else 30]
        ok = fail = 0
        TYPE = {0: "static", 3: "static", 1: "skinned", 4: "skinned"}
        seen = collections.Counter(); won = collections.Counter()
        for f in files:
            d = open(f, "rb").read()
            bt = struct.unpack_from("<H", d, 8)[0] if len(d) >= 12 else -1
            v = struct.unpack_from("<H", d, 4)[0] if len(d) >= 6 else -1
            key = f"v{v}/{TYPE.get(bt, bt)}"
            seen[key] += 1
            try:
                ver, mtype, verts, faces = parse(f)
                lo, hi = bbox(verts)
                if all(abs(c) < 1e6 for vv in verts for c in vv) and max(hi[i]-lo[i] for i in range(3)) > 0:
                    ok += 1; won[key] += 1; continue
            except Exception:
                pass
            fail += 1
        print(f"tested {len(files)}: exported={ok} ({100*ok/len(files):.0f}%) skip={fail}")
        print("by class (exported / total):")
        for k in sorted(seen):
            print(f"  {k:16s} {won[k]:5d} / {seen[k]}")
        return
    src, dst = args[0], args[1]
    ver, mtype, verts, faces = parse(src)
    open(dst, "w").write(to_obj(verts, faces))
    lo, hi = bbox(verts)
    print(f"v{ver} type={mtype} verts={len(verts)} faces={len(faces)}")
    print(f"bbox min={tuple(round(x,2) for x in lo)} max={tuple(round(x,2) for x in hi)}")
    print(f"-> {dst}")

if __name__ == "__main__":
    main()
