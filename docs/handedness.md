# Handedness: the map really was mirrored

## The answer

NeoX is **left-handed**. three.js is right-handed. Feeding the game's world
coordinates into the viewer unchanged renders the entire map as its own mirror
image — layout flipped, and every asymmetric building reversed.

The builders now negate Z on the way out (`mirror()` in `build_terrain.py`,
`to_world()` in `build_chunks.py`) and reverse triangle winding so normals still
point outwards. **Everything inside the viewer is therefore in mirrored space.**
The database and the on-screen coordinate readout carry TRUE game coordinates;
`toViewer` / `toGame` in `app.js` flip Z at that boundary.

## Why it has to be a mirror, not a camera setting

The game's own map UI is unambiguous. `PartMap.get_map_pos_in_world` computes

```python
world_x = u * MAP_WIDTH_DIST  + final_left
world_z = v * MAP_HEIGHT_DIST + final_bottom
```

so `u` grows with +X (rightwards) and `v` grows with +Z from the *bottom* — the
in-game map is **+X right, +Z up**.

For a camera above the world looking down, the screen basis must satisfy
`right × up = toward the viewer = +Y`. With `right = +X` that forces `up = -Z`;
with `up = +Z` it forces `right = -X`. **No camera orientation over right-handed
data can show +X right and +Z up at the same time** — you would have to look at
the world from underneath. So matching the game's *map* is a chirality change,
not a framing one, and no `camera.up` tweak can achieve it.

**Caveat — this is weaker than it first looks `[unconfirmed]`.** It proves the
convention of the map UI, not the handedness of the 3D world. A right-handed
world can still ship a +Z-up map: the player arrow's rotation is computed from
world yaw, so the UI stays self-consistent either way, and the player never sees
a straight-down camera to catch the difference. What is *confirmed* is that a
top-down render of our data now matches the shipped map image. Whether that also
matches the chirality of buildings as seen in the 3D world needs a separate check
against something with known handedness in-world.

## Verified against the game's own minimap

The client ships the real thing at
`gui/ui_res_2/map/bw_all06_complete/bw_all06_complete_2048.png` (2048×2048,
`res7.npk`), and `map_config.json` entry 11 names the folder, resolution and
world rect. Correlating our building positions against the white/grey "man-made"
pixels of that image, over every axis flip:

| orientation | peak | SNR | best shift |
| --- | --- | --- | --- |
| X+ right, Z+ down | 26 | 4.38 | −2808, +4472 |
| **X+ right, Z− down (+Z up)** | **162** | **16.11** | **0, −104** |
| X− right, Z+ down | 28 | 3.84 | +4888, +3640 |
| X− right, Z− down | 26 | 3.72 | +104, +416 |

One orientation wins by 6×, at a shift of essentially zero; the others are noise.
Re-running against the *shipped* chunk data, rasterised exactly the way `app.js`
views it, gives peak 4651 / SNR 10.24 at shift **(0, 0)** — against 605 / SNR 3.54
for the pre-fix orientation.

That zero shift is also an independent re-confirmation of
[`terrain-placement.md`](terrain-placement.md): the minimap covers precisely the
heightfield rect (−27040 → +26208 on both axes), and our tiles land on it with no
correction.

## Note for anyone re-deriving the rotation work

For a pure yaw, mirroring one axis and transposing the rotation matrix are the
same operation — so this and [`building-rotation.md`](building-rotation.md) look
like the same finding, and it is easy to "fix" one twice. They are independent:

- the **transpose** was established in raw engine data space, by fitting buildings
  against the terrain LOD tiles' baked copies. No mirror involved, so it holds
  regardless of how anything is rendered.
- the **mirror** is purely an engine→viewer conversion. It flips terrain and
  buildings together, so it cannot disturb their relative fit.

Apply both. Applying only one leaves the map self-consistent but wrong.
