# Building rotation (bw_all06)

## The answer

`house_info.json`'s `rot` is a row-major 4×4 in the **row-vector convention** —
the engine computes `v * M`, not `M * v`. So the rotation to apply is the
**transpose** of the naive reading: column *j* of the matrix supplies world axis
*j*, not row *j*.

```python
wx = M[0][0]*lx + M[1][0]*ly + M[2][0]*lz + pos[0]
wy = M[0][1]*lx + M[1][1]*ly + M[2][1]*lz + pos[1]
wz = M[0][2]*lx + M[1][2]*ly + M[2][2]*lz + pos[2]
```

Translation lives in `pos` alone; the matrix's last row and column are always
`[0,0,0,1]`. `scale` is a separate per-axis vector applied before rotation (38 of
382 instances are non-unit).

## What the data looks like

All 382 instances are clean: orthonormal, determinant **+1** (no mirroring),
`pos`-only translation. 379 are pure yaw — pitch/roll appears in just 3
(`gk_items_inside_jizhuangxiang_03`, `yc_building_yucun_04`,
`yc_building_yucun_05`). 107 distinct yaw angles, but heavily quantised: 235 sit
on a multiple of 90°, and **101 are at yaw 0**.

## Why the error survived so long

Reading the matrix column-vector-style yaws every building the *wrong way*
(`R_y(-θ)` instead of `R_y(θ)`). That is:

- **invisible** at yaw 0 and yaw 180, where `R == Rᵀ` exactly — 127 of 355
  rendered instances, including the first entries anyone inspects by hand;
- a plain **180° flip** at yaw 90/270, which on a roughly-symmetric block reads
  as "fine" and only shows up on buildings with a distinctive front;
- only obviously wrong at the ~107 odd angles, which is exactly the "a few
  genuinely seem wrong" symptom.

Net effect of the fix: **228 of 355 buildings (64%) moved**, median max-vertex
shift 157 units, p90 637, max 4048.

## How it was verified

The `l1_*` terrain LOD tiles bake in simplified copies of the buildings at the
engine's own orientation (see `terrain-placement.md`), so they are usable as
rotation ground truth. Two independent aggregate tests, plus a per-building one.

**Per building** — voxelise (4 units, 3D so a wrong yaw puts walls in empty air)
the terrain geometry around each building and score what fraction of the
building's own vertices land inside it, over 8 candidates: `R` and `Rᵀ`, each ×
{0°, 90°, 180°, 270°}. Of the 25 buildings with a strong enough LOD match to
discriminate (score > 0.25), **`Rᵀ` wins or ties 25 / 25, with zero dissent**.
The two apparent "`R` wins" cases are yaw-0 buildings where the two are the same
matrix. Note the aliases that make the raw tally look messier than it is: at yaw
90/270, `Rᵀ ≡ R+180`; at yaw 315, `Rᵀ ≡ R+90`.

**Whole map** — both aggregate metrics agree:

| convention | verts inside terrain geometry | FFT correlation peak | SNR |
| --- | --- | --- | --- |
| `R` (column-vector) | 109,959 / 2,896,008 = 3.80% | 13666 | 16.02 |
| **`Rᵀ` (row-vector)** | **224,685 / 2,896,008 = 7.76%** | **18921** | **23.09** |

The correlation shift stays at exactly **(0, 0)** under both, which confirms this
is independent of terrain placement — rotation is per-building and local, so it
blunts the peak without moving it. Terrain pitch/origin are unaffected.

## Caveat

Only 25 of 299 buildings have an LOD copy detailed enough to score individually;
the rest are either omitted at this LOD tier or too decimated for vertex-level
voxel matching. The per-building test is therefore a *sample*, not a full audit —
it is the whole-map aggregates that carry the weight for the other 330. If a
specific building still looks wrong after this, it is worth checking on its own
rather than assuming the convention is at fault again.

Unrelated and still open: ~24 buildings fail to parse at all with
`unresolved vertex layout (type=-1, bone_type=0)`, and 2 have comma-joined
candidate paths the resolver never splits. Neither is a rotation issue.
