# Building interiors

Some buildings rendered as hollow shells — the resort hotel most visibly, since
you can walk around inside it in game. Nothing was lost in extraction: their
interiors ship as **separate models that `house_info.json` never names**.

## How interiors are modelled

A building is split into parts that share a base name and a placement:
`building_common_hospital_a` is the exterior tower, `building_common_hospital_b`
is the ground-floor interior — inset in X/Z and only ~245 units tall against the
tower's 2322. The resolver picks parts up by base name, so this common case has
worked all along: 280 of the 310 meshes we place already contain interior floor
geometry.

The exception is buildings whose interior model does **not** share the exterior's
base name. The resort hotel is `building_jiudian_a01` outside and
`building_jiudian_b` inside — no `a01` anywhere in the interior's name — so the
resolver never saw it and we drew the shell alone.

## Finding the orphans

`scene_model_inf.json` (smcStuff `build/configs/`) lists all 5282 scene models the
game knows, with a collision type for each. That is what makes the sibling
searchable: for each rendered part `<stem>_a<NN>`, look for an unrendered
`<stem>_b<NN>`, then `<stem>_b`.

Name matching alone is not enough — `items_yanti_l_a01` (an escalator) has an
`items_yanti_l_b01` that is a *different, larger* object standing next to it, not
its interior. So a candidate is accepted only if its bounding box **fits inside
the exterior's** with 60 units of slack. Interiors are authored at the exterior's
own origin, which is what lets them be placed with the exterior's transform, and
is also why the containment test is meaningful.

`tools/find_interiors.py` does this and writes `tools/interior_parts.json`;
`build_chunks.py` merges those in as extra parts of the type.

## Result

8 building types, 15 map instances:

| type | interior model |
| --- | --- |
| `djjd_building_jiudian_a01` / `a02` / `a03` (the resort hotel) | `building_jiudian_b` / `b02` / `b03` |
| `bhsc_building_bhsc_01_a` / `02_a` / `03_a` | `building_bhsc_01_b` / `02_b` / `03_b` |
| `msq_building_xzq_15_a` | `building_xzq_15_b` |
| `msq_building_xzq_18_a` | `building_xzq_18_b` |

The hotel now shows its lobby: perimeter walls, a column grid, two escalator
pairs and the entrance doors, aligned with the shell's window bays.

## What is still missing, and the fallback

~~`x_building_kejiguan_b` is not packaged, so that building stays a shell.~~
**It ships under the unsplit name.** `x_model\05_nex` holds a *re-split* of the
science museum — `x_building_kejiguan_a`, `a1`, `c`, `dj_01`, `dj_02` — and only
that split's interior file is absent. The original single-piece family is right
there in `scene\building\common`: `building_kejiguan_{a,b,b_ggp,c,d}`, all
packaged, all authored at the same origin (`building_kejiguan_c` is byte-for-byte
the same mesh as `x_building_kejiguan_c`, which is what pins the two sets to one
frame).

`tlzx_x_building_kejiguan_a` now resolves to that family instead. The change is
bigger than an interior: the resolver had matched only `x_building_kejiguan_a`,
one piece of the re-split, so the museum was rendering as a slice through the
middle of its own footprint — which is what it looks like from the ground, a
building standing in the wrong place. Projecting each candidate's vertices onto
the game's top-down map settles it: the single `x_` piece puts 60% of its
vertices on the drawn building, the full family 80%, and the family's outline
traces the notched north-west corner, the east block and the car-park loop that
`building_kejiguan_d` supplies.

The rule to remember cuts both ways: a building can ship under an
`x_model\NN_nex` name *and* under its plain name, and neither side is reliably
the better one.

| | science museum (`kejiguan`) | art museum (`meishuguan`) |
| --- | --- | --- |
| plain `building_*` | whole, placeable | component library, unplaceable |
| `x_model\NN_nex` | partial re-split | split by location, placeable |
| what we use | plain | `x_model`, plus one plain part |

So check both names, and judge them on what the parts look like rather than on
where they live: parts in a shared frame have bboxes offset from the origin,
while a library module is authored around its own centre and straddles the
ground plane evenly. `build_chunks.py` warns when a type mixes the two. And an
`x_model` split can be missing files — `x_building_kejiguan_b` and
`x_building_meishuguan_a_04` both are — so never record a model as cut on the
strength of one spelling.

There is a second, universal source if it is ever needed: every `_a` mesh with a
second submesh carries a **collision block** covering the whole building,
interior included — floors, walls, columns and stair ramps (smcStuff
`docs/10-asset-formats.md`). For the hotel it traces the same plan as
`building_jiudian_b`. It is walkable-surface data rather than art, and it
duplicates the exterior shell, so rendering it as-is would z-fight; it is the
fallback for buildings whose interior model does not ship, not a replacement for
one that does.
