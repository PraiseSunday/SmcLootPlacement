#!/usr/bin/env python3
"""Pair each rendered building part with its interior model, into interior_parts.json.

house_info.json names one model per building type, and _cache/resolved.json expands
that into the parts sharing its base name (`..._a` + `..._b`). Some buildings keep
their interior in a model whose name does NOT share the exterior's base -- the
resort hotel is `building_jiudian_a01` outside and `building_jiudian_b` inside --
so the interior never gets resolved and the building renders as a hollow shell.

scene_model_inf.json lists every scene model the game knows (5282 of them), which
is what makes the sibling searchable: for a rendered part `<stem>_a<NN>`, look for
an unrendered `<stem>_b<NN>` or `<stem>_b`. Interiors sit at the exterior's own
origin, so they are placed with the exterior's transform -- and that is also the
test: a candidate is accepted only if its bounding box fits inside the exterior's
(with slack), which rejects same-stem models that are really neighbouring props.

Writes {type: {part_name: gim_path}} for build_chunks.py to merge, and caches any
newly-needed .mesh into _cache/meshes/.
"""
import json, os, re, sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SMCSTUFF = os.path.join(os.path.dirname(REPO_ROOT), "smcStuff")
sys.path.insert(0, os.path.join(SMCSTUFF, "build"))
import mesh_to_obj
from npk_fetch import fetch

CACHE = os.path.join(REPO_ROOT, "tools", "_cache")
MESHES = os.path.join(CACHE, "meshes")
BBOX_SLACK = 60.0   # world units of tolerance on the containment test


def candidates(part, names, rendered):
    """Interior model names to try for a rendered `<stem>_a<NN>` part, most
    specific first."""
    m = re.match(r"^(.*?)_a(\d*)$", part)
    if not m:
        return []
    stem, num = m.group(1), m.group(2)
    out = ([f"{stem}_b{num}"] if num else []) + [f"{stem}_b"]
    seen = set()
    return [c for c in out
            if c in names and c not in rendered and not (c in seen or seen.add(c))]


def cached_mesh(gim_path):
    """Local .mesh for a VFS .gim path, extracting it from the npks on first use."""
    mesh_path = gim_path.replace(".gim", ".mesh")
    local = os.path.join(MESHES, mesh_path)
    if os.path.exists(local):
        return local
    got = fetch([mesh_path])
    if mesh_path not in got:
        return None
    os.makedirs(os.path.dirname(local), exist_ok=True)
    with open(local, "wb") as f:
        f.write(got[mesh_path])
    return local


def bbox_of(path):
    _ver, _mtype, verts, _faces = mesh_to_obj.parse(path)
    return mesh_to_obj.bbox(verts)


def fits_inside(inner, outer, slack=BBOX_SLACK):
    (ilo, ihi), (olo, ohi) = inner, outer
    return (ilo[0] > olo[0] - slack and ihi[0] < ohi[0] + slack and
            ilo[2] > olo[2] - slack and ihi[2] < ohi[2] + slack and
            ihi[1] < ohi[1] + slack)


def main():
    names = set(json.load(open(os.path.join(SMCSTUFF, "build/configs/scene_model_inf.json"))))
    resolved = json.load(open(os.path.join(CACHE, "resolved.json")))
    resolved.update(json.load(open(os.path.join(REPO_ROOT, "tools", "extra_resolved.json"))))
    rendered = {p for info in resolved.values() for p in info["parts"]}

    out = {}
    for typ, info in sorted(resolved.items()):
        for part, gim in info["paths"].items():
            cands = candidates(part, names, rendered)
            if not cands:
                continue
            # `paths` entries may carry two comma-joined candidate locations for
            # the same model; the interior sits in one of the same directories.
            dirs = [c.strip().rsplit("\\", 1)[0] for c in gim.split(",")]
            exterior = next((p for p in (os.path.join(MESHES, c.strip().replace(".gim", ".mesh"))
                                         for c in gim.split(",")) if os.path.exists(p)), None)
            if not exterior:
                print(f"  ??   {part}: exterior mesh not cached")
                continue
            ext_box = bbox_of(exterior)
            for cand in cands:
                hit = next(((d + "\\" + cand + ".gim", local)
                            for d in dirs
                            for local in [cached_mesh(d + "\\" + cand + ".gim")] if local), None)
                if not hit:
                    print(f"  MISS {cand}: not packaged under {dirs}")
                    continue
                gim_path, local = hit
                try:
                    box = bbox_of(local)
                except Exception as ex:
                    print(f"  BAD  {cand}: {ex}")
                    continue
                if not fits_inside(box, ext_box):
                    print(f"  SKIP {typ} + {cand}: bbox escapes the exterior")
                    continue
                print(f"  OK   {typ:32s} {part:26s} + {cand}")
                out.setdefault(typ, {})[cand] = gim_path
                break

    dest = os.path.join(REPO_ROOT, "tools", "interior_parts.json")
    with open(dest, "w") as f:
        json.dump(out, f, indent=1, sort_keys=True)
        f.write("\n")
    print(f"\n{len(out)} building types gained an interior part -> {dest}")


if __name__ == "__main__":
    main()
