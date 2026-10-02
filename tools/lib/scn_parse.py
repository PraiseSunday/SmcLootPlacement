#!/usr/bin/env python3
"""
scn_parse.py — decode NeoX property files (magic 0x0D4159C1) into named values.

Same container as the material/`.gim` format `material_parse.py` handles, but this
one decodes the property-tree BODY rather than just scavenging strings out of it,
which is what you need for scene files (`.scn`) — where the useful content is
numeric (terrain extents, chunk sizes, fog/light settings), not asset paths.

Format (little-endian):
  0x00  u32  magic 0x0D4159C1
  0x04  u32  file size
  0x08  u32  0
  0x0C       element-name table    — LEB128 count, then that many NUL-term strings
             attribute-name table  — same encoding
             body: a node table of (element_index, child_count) pairs, followed by
                   attribute records encoded as [attr_index][type_tag][value]

Type tags: 0x01 NUL-terminated string, 0x02 int32, 0x05 float32.

The node/attribute framing is only partly understood, so `scan_attrs()` walks the
body and reports every position that parses as a plausible record instead of
following the tree. In practice the real records appear in long contiguous runs in
attribute-index order; isolated hits with empty/absurd values are false positives.
Cross-check a value against its neighbours before trusting it.

TRAP: the table counts are LEB128 varints, NOT single bytes. `material_parse.py`
historically read them as `u8`, which is indistinguishable for tables of <128
names (all materials) but silently desynchronises on larger ones — a `.scn` with
172 attribute names decodes with names split across the two tables ("OffsetX" /
"ffsetZ") and every subsequent offset wrong. Fixed there too, but if you write a
third reader for this container, use `varint()`.
"""
import struct, sys

MAGIC = 0x0D4159C1
TYPE_STR, TYPE_I32, TYPE_F32 = 0x01, 0x02, 0x05


def varint(d, off):
    """LEB128 unsigned varint -> (value, new_offset)."""
    r = s = 0
    while True:
        b = d[off]; off += 1
        r |= (b & 0x7F) << s
        if not b & 0x80:
            return r, off
        s += 7


def read_table(d, off):
    n, off = varint(d, off)
    names = []
    for _ in range(n):
        end = d.index(0, off)
        names.append(d[off:end].decode("latin1"))
        off = end + 1
    return names, off


def load(path):
    """-> (data, element_names, attribute_names, body_offset)"""
    d = open(path, "rb").read()
    if struct.unpack_from("<I", d, 0)[0] != MAGIC:
        raise ValueError("not a NeoX property file (bad magic)")
    elems, off = read_table(d, 0x0C)
    attrs, off = read_table(d, off)
    return d, elems, attrs, off


def scan_attrs(d, attrs, start):
    """Yield (offset, attr_name, value) for every decodable attribute record."""
    i = start
    while i < len(d) - 2:
        a, t = d[i], d[i + 1]
        if a < len(attrs):
            if t == TYPE_I32 and i + 6 <= len(d):
                yield i, attrs[a], struct.unpack_from("<i", d, i + 2)[0]
                i += 6; continue
            if t == TYPE_F32 and i + 6 <= len(d):
                yield i, attrs[a], round(struct.unpack_from("<f", d, i + 2)[0], 4)
                i += 6; continue
            if t == TYPE_STR:
                end = d.find(b"\0", i + 2)
                if 0 < end < i + 300:
                    yield i, attrs[a], d[i + 2:end].decode("latin1")
                    i = end + 1; continue
        i += 1


# Terrain/Landscape fields that describe where a scene's ground actually sits.
TERRAIN_FIELDS = ("GridSize", "NumColumns", "NumRows", "OffsetX", "OffsetZ",
                  "PatchSize", "ChunkSize", "HeightMin", "HeightMax",
                  "ContentPath", "DetailSize")


def main():
    if len(sys.argv) < 2:
        print(__doc__.strip().splitlines()[0])
        print("usage: scn_parse.py <file.scn> [tables|all|<AttrName> ...]")
        return
    path = sys.argv[1]
    args = sys.argv[2:]
    d, elems, attrs, body = load(path)

    if args and args[0] == "tables":
        print(f"elements ({len(elems)}):\n  {elems}\n")
        print(f"attributes ({len(attrs)}):\n  {attrs}")
        return

    want = None if (args and args[0] == "all") else (set(args) or set(TERRAIN_FIELDS))
    print(f"{len(elems)} elements, {len(attrs)} attributes, body at {body}\n")
    for off, name, val in scan_attrs(d, attrs, body):
        if want is None or name in want:
            print(f"  {off:6d}  {name:<14s} = {val}")


if __name__ == "__main__":
    main()
