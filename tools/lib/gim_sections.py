#!/usr/bin/env python3
"""gim_sections.py <file.gim> — read a NeoX .gim's named section table.

A `.gim` is the property-file companion to a `.mesh` (same 0x0D4159C1 container
as `.scn`/`.mtl`, so it decodes with scn_parse). Alongside model-wide flags it
carries one record per named section of the mesh:

    IndexCount   how many indices the section owns
    IndexStart   its offset into that submesh's index buffer
    Name         the source object's name, e.g. surface_qyy_a11_13902
    SubMeshIdx   which submesh the range applies to

That makes a baked LOD chunk decomposable back into the objects it was built
from: on `bw_all06`'s lodmodels/l1_*.mesh tiles, `surface_*` sections are the
ground/road shell and everything else is a simplified copy of a scene prop or
building — which is why buildings render twice if you draw the tiles and the
real building meshes together.

Section ranges index the *index buffer*, so face range = IndexStart // 3 up to
(IndexStart + IndexCount) // 3.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scn_parse

FIELDS = ("IndexCount", "IndexStart", "Name", "SubMeshIdx")


def sections(path):
    """-> [{'name','index_start','index_count','submesh'}, ...] in file order."""
    d, els, attrs, body = scn_parse.load(path)
    pending, out = {}, []
    for _off, name, value in scn_parse.scan_attrs(d, attrs, body):
        if name not in FIELDS:
            continue
        if name == "IndexCount" and pending:
            pending = {}                       # record restarted; drop the partial
        pending[name] = value
        if len(pending) == len(FIELDS):
            out.append({
                "name": pending["Name"],
                "index_start": int(pending["IndexStart"]),
                "index_count": int(pending["IndexCount"]),
                "submesh": int(pending["SubMeshIdx"]),
            })
            pending = {}
    return out


def is_ground(name):
    """True for the tile's own terrain shell (as opposed to a baked-in object)."""
    return name.startswith("surface_")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    secs = sections(sys.argv[1])
    ground = [s for s in secs if is_ground(s["name"])]
    print(f"{len(secs)} sections  ({len(ground)} ground, {len(secs)-len(ground)} objects)")
    for s in secs:
        tag = "ground" if is_ground(s["name"]) else "object"
        print(f"  [{tag}] submesh {s['submesh']}  idx {s['index_start']:6d} +{s['index_count']:6d}  {s['name']}")


if __name__ == "__main__":
    main()
