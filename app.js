import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { createClient } from "@supabase/supabase-js";

// Anon/publishable key -- meant to be public client-side, RLS policies (see
// db/schema.sql) are what actually enforce who can insert/vote/delete.
const SUPABASE_URL = "https://ogcvmjrlamxjnkhuoupw.supabase.co";
const SUPABASE_KEY = "sb_publishable_xHVhPIiRHm9ClnvCQcw63Q_jtgBZyZW";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Horizontal (X/Z) only, deliberately -- altitude shouldn't affect what's
// streamed in, since flying up over a spot doesn't make its surroundings any
// less relevant. Generous gap between the two (vs. the unload radius) so
// buildings don't visibly pop in/out right around where you're standing.
const LOAD_RADIUS = 7000;
const UNLOAD_RADIUS = 13000;
const OVERVIEW_FOG_FAR = 45000; // wide enough that the whole map clears the fog from overview height
const FADE_MS = 400; // chunks fade in over this long instead of snapping into view

const BASE_SPEED = 1400; // world units / second
const SPRINT_MULT = 3;
const WHEEL_SPEED = 2.5; // world units of altitude per raw wheel deltaY unit
const VICINITY_RADIUS = 1000; // only list pins within this many units of the camera

const viewportEl = document.getElementById("viewport");
const statsEl = document.getElementById("stats");
const panelListEl = document.getElementById("pin-list");
const addBtn = document.getElementById("add-btn");
const fitBtn = document.getElementById("fit-btn");
const nearestBtn = document.getElementById("nearest-btn");
const collapseBtn = document.getElementById("collapse-btn");
const panelEl = document.getElementById("panel");
const exportBtn = document.getElementById("export-btn");
const importBtn = document.getElementById("import-btn");
const importFile = document.getElementById("import-file");
const lockHintEl = document.getElementById("lock-hint");
const crosshairEl = document.getElementById("crosshair");
const escTagEl = document.getElementById("esc-tag");
const minimapToggle = document.getElementById("minimap-toggle");
const minimapPanel = document.getElementById("minimap-panel");
const minimapCanvas = document.getElementById("minimap");
const adminBtn = document.getElementById("admin-btn");
const adminForm = document.getElementById("admin-form");
const adminEmailEl = document.getElementById("admin-email");
const adminPasswordEl = document.getElementById("admin-password");
const adminSigninBtn = document.getElementById("admin-signin");
const adminCancelBtn = document.getElementById("admin-cancel");
const adminErrorEl = document.getElementById("admin-error");

let manifest = null;
let terrainManifest = null;
let pins = [];
let placing = false;
let pendingEditor = null;
let isAdmin = false;
let overviewMode = false;

// --- three.js scene setup -------------------------------------------------

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0f14);
// Fades to background right around the unload radius, so chunks dropping out
// of range disappear into the haze instead of visibly popping away.
scene.fog = new THREE.Fog(0x0d0f14, 5000, UNLOAD_RADIUS);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
viewportEl.appendChild(renderer.domElement);

// far=50000 (not just UNLOAD_RADIUS) so the whole-map overview -- which sits
// well above the normal flight streaming bubble -- doesn't get near-clipped.
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 1, 50000);
camera.position.set(0, 1500, 0);

const controls = new PointerLockControls(camera, renderer.domElement);

// Chunk/tile filenames are grid indices, so a rebuild can reuse a name for a
// DIFFERENT set of buildings. Neither python -m http.server nor GitHub Pages
// sends Cache-Control or ETag on these, which lets a browser serve them from
// heuristic freshness without revalidating -- a stale mix of old buildings on
// new terrain reads as buildings scattered off their footprints. Revalidate
// every data fetch (still a cheap 304 when nothing changed).
const NO_STALE = { cache: "no-cache" };

const chunkGroup = new THREE.Group();
scene.add(chunkGroup);
const terrainGroup = new THREE.Group();
scene.add(terrainGroup);
const pinGroup = new THREE.Group();
scene.add(pinGroup);

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x30281c, 0.9));

// Height is normalized PER BUILDING (baked into a "heightT" vertex attribute at
// chunk-load time, see loadChunk) rather than against the whole-map Y range —
// one tall tower elsewhere on the map would otherwise crush every ordinary
// building into the bottom of the ramp. Lighting uses computed vertex normals
// so walls/roofs read as distinct facets instead of flat height-tinted blobs.
// This is a template: every chunk mesh gets its own clone() (see loadChunk) so
// each can fade in independently via the "fade" uniform without touching a
// shared material. Distance fog is done manually here too (mixing toward
// uBgColor by distance to `cameraPosition`, a uniform three.js always injects)
// since a raw ShaderMaterial doesn't pick up scene.fog automatically.
const BG_COLOR = new THREE.Color(0x0d0f14);
const heightMaterial = new THREE.ShaderMaterial({
  uniforms: {
    fade: { value: 1 },
    uBgColor: { value: BG_COLOR },
    fogNear: { value: scene.fog.near },
    fogFar: { value: scene.fog.far },
  },
  vertexShader: `
    attribute float heightT;
    varying float vT;
    varying vec3 vNormal;
    varying vec3 vWorldPos;
    void main() {
      vT = heightT;
      vNormal = normalize(normalMatrix * normal);
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vWorldPos = worldPos.xyz;
      gl_Position = projectionMatrix * viewMatrix * worldPos;
    }
  `,
  fragmentShader: `
    uniform float fade;
    uniform vec3 uBgColor;
    uniform float fogNear;
    uniform float fogFar;
    varying float vT;
    varying vec3 vNormal;
    varying vec3 vWorldPos;
    vec3 ramp(float t) {
      vec3 low = vec3(0.35, 0.55, 0.60);
      vec3 mid = vec3(0.45, 0.70, 0.65);
      vec3 high = vec3(0.90, 0.85, 0.60);
      if (t < 0.5) return mix(low, mid, t * 2.0);
      return mix(mid, high, (t - 0.5) * 2.0);
    }
    void main() {
      vec3 base = ramp(clamp(vT, 0.0, 1.0));
      vec3 lightDir = normalize(vec3(0.4, 1.0, 0.3));
      vec3 n = normalize(vNormal);
      if (!gl_FrontFacing) n = -n;
      float diffuse = 0.55 + 0.45 * max(dot(n, lightDir), 0.0);
      vec3 shaded = base * diffuse;
      float fogT = clamp((distance(vWorldPos.xz, cameraPosition.xz) - fogNear) / (fogFar - fogNear), 0.0, 1.0);
      vec3 withFog = mix(shaded, uBgColor, fogT);
      gl_FragColor = vec4(mix(uBgColor, withFog, fade), 1.0);
    }
  `,
  side: THREE.DoubleSide,
});

// Same shader as heightMaterial, muted/desaturated ramp so the ground (roads,
// bridges, bare terrain) reads as backdrop rather than competing with the
// buildings for attention.
const terrainMaterial = new THREE.ShaderMaterial({
  uniforms: {
    fade: { value: 1 },
    uBgColor: { value: BG_COLOR },
    fogNear: { value: scene.fog.near },
    fogFar: { value: scene.fog.far },
  },
  vertexShader: heightMaterial.vertexShader,
  fragmentShader: `
    uniform float fade;
    uniform vec3 uBgColor;
    uniform float fogNear;
    uniform float fogFar;
    varying float vT;
    varying vec3 vNormal;
    varying vec3 vWorldPos;
    vec3 ramp(float t) {
      vec3 low = vec3(0.16, 0.20, 0.19);
      vec3 high = vec3(0.30, 0.32, 0.27);
      return mix(low, high, clamp(t, 0.0, 1.0));
    }
    void main() {
      vec3 base = ramp(vT);
      vec3 lightDir = normalize(vec3(0.4, 1.0, 0.3));
      vec3 n = normalize(vNormal);
      if (!gl_FrontFacing) n = -n;
      float diffuse = 0.55 + 0.45 * max(dot(n, lightDir), 0.0);
      vec3 shaded = base * diffuse;
      float fogT = clamp((distance(vWorldPos.xz, cameraPosition.xz) - fogNear) / (fogFar - fogNear), 0.0, 1.0);
      vec3 withFog = mix(shaded, uBgColor, fogT);
      gl_FragColor = vec4(mix(uBgColor, withFog, fade), 1.0);
    }
  `,
  side: THREE.DoubleSide,
});

// --- chunk streaming (radius around the camera, since there's no fixed
// top-down frustum anymore) -------------------------------------------------

const loadedChunks = new Map(); // "cx,cz" -> { mesh, entry }

function chunkKey(cx, cz) {
  return cx + "," + cz;
}

async function loadChunk(entry) {
  const key = chunkKey(entry.cx, entry.cz);
  if (loadedChunks.has(key)) return;
  const placeholder = { mesh: null, entry };
  loadedChunks.set(key, placeholder);
  const res = await fetch("data/" + entry.file, NO_STALE);
  if (!res.ok) {
    console.error("chunk fetch failed", entry.file, res.status);
    return;
  }
  const buf = await res.arrayBuffer();
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "SLPC") return;
  const vcount = dv.getUint32(4, true);
  const fcount = dv.getUint32(8, true);
  const positions = new Float32Array(buf, 12, vcount * 3);
  const indexOffset = 12 + vcount * 3 * 4;
  const rawIndex = new Uint32Array(buf, indexOffset, fcount * 3);

  let minY = Infinity, maxY = -Infinity;
  for (let i = 1; i < positions.length; i += 3) {
    const y = positions[i];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const span = Math.max(maxY - minY, 1);
  const heightT = new Float32Array(vcount);
  for (let i = 0; i < vcount; i++) {
    heightT[i] = (positions[i * 3 + 1] - minY) / span;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("heightT", new THREE.BufferAttribute(heightT, 1));
  geom.setIndex(new THREE.BufferAttribute(rawIndex, 1));
  geom.computeVertexNormals();

  const material = heightMaterial.clone();
  material.uniforms.fade.value = 0;
  const mesh = new THREE.Mesh(geom, material);
  chunkGroup.add(mesh);
  const rec = loadedChunks.get(key);
  if (!rec) { // was unloaded while fetching
    geom.dispose();
    material.dispose();
    return;
  }
  rec.mesh = mesh;
  rec.loadedAt = performance.now();
}

function unloadChunk(key) {
  const rec = loadedChunks.get(key);
  if (!rec) return;
  if (rec.mesh) {
    chunkGroup.remove(rec.mesh);
    rec.mesh.geometry.dispose();
    rec.mesh.material.dispose();
  }
  loadedChunks.delete(key);
}

function updateChunkFades() {
  const now = performance.now();
  for (const rec of loadedChunks.values()) {
    if (!rec.mesh) continue;
    const u = rec.mesh.material.uniforms.fade;
    if (u.value >= 1) continue;
    u.value = Math.min(1, (now - rec.loadedAt) / FADE_MS);
  }
}

function updateStreaming() {
  const cell = manifest.cell_size;
  const px = camera.position.x, pz = camera.position.z;
  for (const entry of manifest.chunks) {
    // Overview wants the whole map visible at once, not just what's within
    // the normal flight streaming bubble -- load everything and skip the
    // unload pass below until the player actually starts flying again.
    if (overviewMode) { loadChunk(entry); continue; }
    const ecx = entry.cx * cell + cell / 2;
    const ecz = entry.cz * cell + cell / 2;
    const d = Math.hypot(ecx - px, ecz - pz);
    if (d <= LOAD_RADIUS) loadChunk(entry);
  }
  if (!overviewMode) {
    for (const [key, rec] of [...loadedChunks]) {
      const ecx = rec.entry.cx * cell + cell / 2;
      const ecz = rec.entry.cz * cell + cell / 2;
      const d = Math.hypot(ecx - px, ecz - pz);
      if (d > UNLOAD_RADIUS) unloadChunk(key);
    }
  }
  statsEl.textContent =
    `${loadedChunks.size} chunks loaded / ${manifest.chunks.length} total · ${pins.length} pins · ` +
    `pos ${px.toFixed(0)}, ${camera.position.y.toFixed(0)}, ${(-pz).toFixed(0)}`;  // shown in game coords
}

// --- terrain streaming (ground/roads/bridges -- a separate layer from the
// building chunks above since tiles are much bigger than a building grid
// cell; see tools/build_terrain.py for how tile world placement was solved)
// -----------------------------------------------------------------------

const loadedTerrain = new Map(); // "xi,yi" -> { mesh, entry }

function terrainKey(xi, yi) {
  return xi + "," + yi;
}

// There can be 700+ terrain tiles in flight at once (overview force-loads all
// of them) -- fetching that many simultaneously exhausts the browser's
// per-origin connection pool (net::ERR_INSUFFICIENT_RESOURCES). This caps how
// many terrain fetches run concurrently; the rest just wait their turn.
const TERRAIN_FETCH_CONCURRENCY = 8;
let terrainFetchInFlight = 0;
const terrainFetchQueue = [];

function scheduleTerrainFetch(url) {
  return new Promise((resolve, reject) => {
    const run = () => {
      terrainFetchInFlight++;
      fetch(url, NO_STALE).then(resolve, reject).finally(() => {
        terrainFetchInFlight--;
        const next = terrainFetchQueue.shift();
        if (next) next();
      });
    };
    if (terrainFetchInFlight < TERRAIN_FETCH_CONCURRENCY) run();
    else terrainFetchQueue.push(run);
  });
}

async function loadTerrainTile(entry) {
  const key = terrainKey(entry.xi, entry.yi);
  if (loadedTerrain.has(key)) return;
  const placeholder = { mesh: null, entry };
  loadedTerrain.set(key, placeholder);
  const res = await scheduleTerrainFetch("data/" + entry.file);
  if (!res.ok) {
    console.error("terrain tile fetch failed", entry.file, res.status);
    return;
  }
  const buf = await res.arrayBuffer();
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "SLPC") return;
  const vcount = dv.getUint32(4, true);
  const fcount = dv.getUint32(8, true);
  const positions = new Float32Array(buf, 12, vcount * 3);
  const indexOffset = 12 + vcount * 3 * 4;
  const rawIndex = new Uint32Array(buf, indexOffset, fcount * 3);

  let minY = Infinity, maxY = -Infinity;
  for (let i = 1; i < positions.length; i += 3) {
    const y = positions[i];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const span = Math.max(maxY - minY, 1);
  const heightT = new Float32Array(vcount);
  for (let i = 0; i < vcount; i++) {
    heightT[i] = (positions[i * 3 + 1] - minY) / span;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("heightT", new THREE.BufferAttribute(heightT, 1));
  geom.setIndex(new THREE.BufferAttribute(rawIndex, 1));
  geom.computeVertexNormals();

  const material = terrainMaterial.clone();
  material.uniforms.fade.value = 0;
  const mesh = new THREE.Mesh(geom, material);
  terrainGroup.add(mesh);
  const rec = loadedTerrain.get(key);
  if (!rec) {
    geom.dispose();
    material.dispose();
    return;
  }
  rec.mesh = mesh;
  rec.loadedAt = performance.now();
}

function unloadTerrainTile(key) {
  const rec = loadedTerrain.get(key);
  if (!rec) return;
  if (rec.mesh) {
    terrainGroup.remove(rec.mesh);
    rec.mesh.geometry.dispose();
    rec.mesh.material.dispose();
  }
  loadedTerrain.delete(key);
}

function updateTerrainFades() {
  const now = performance.now();
  for (const rec of loadedTerrain.values()) {
    if (!rec.mesh) continue;
    const u = rec.mesh.material.uniforms.fade;
    if (u.value >= 1) continue;
    u.value = Math.min(1, (now - rec.loadedAt) / FADE_MS);
  }
}

function updateTerrainStreaming() {
  if (!terrainManifest) return;
  // Overview force-loads every terrain tile too (like the building chunks)
  // so the default landing view isn't buildings floating over empty void.
  // Safe now that fetches are queued through scheduleTerrainFetch above --
  // that's what used to exhaust the browser's per-origin connection pool
  // when all 763 tiles were requested at once.
  const px = camera.position.x, pz = camera.position.z;
  for (const entry of terrainManifest.tiles) {
    if (overviewMode) { loadTerrainTile(entry); continue; }
    const ecx = (entry.minX + entry.maxX) / 2;
    const ecz = (entry.minZ + entry.maxZ) / 2;
    const d = Math.hypot(ecx - px, ecz - pz);
    if (d <= LOAD_RADIUS) loadTerrainTile(entry);
  }
  if (!overviewMode) {
    for (const [key, rec] of [...loadedTerrain]) {
      const ecx = (rec.entry.minX + rec.entry.maxX) / 2;
      const ecz = (rec.entry.minZ + rec.entry.maxZ) / 2;
      const d = Math.hypot(ecx - px, ecz - pz);
      if (d > UNLOAD_RADIUS) unloadTerrainTile(key);
    }
  }
}

// --- pins (live, shared via Supabase -- see db/schema.sql) ----------------

function refreshUI() {
  renderPinList();
  renderPinMarkers();
}

// The scene is mirrored in Z relative to the game (NeoX is left-handed, three.js
// is not -- see tools/build_terrain.py and docs/handedness.md), so everything
// inside the viewer lives in mirrored space. The database stores TRUE game
// coordinates, so pins flip as they cross that boundary, in both directions.
const flipZ = (p) => ({ ...p, z: -p.z });
const toViewer = flipZ;
const toGame = flipZ;

async function fetchPins() {
  const { data, error } = await supabase.from("pins").select("*");
  if (error) {
    console.error("failed to load pins", error);
    return;
  }
  pins = data.map(toViewer);
  refreshUI();
}

// Anyone can add pins and vote (see the DB's RLS policies); votes route
// through the increment_vote() RPC rather than a direct table UPDATE so a
// visitor can't sneak in an edit to someone else's pin position/tier/note
// alongside the vote. Delete stays admin-only, enforced by RLS regardless of
// what the client sends -- the UI just also hides the button for non-admins.
function subscribeToPinChanges() {
  supabase
    .channel("pins-changes")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "pins" }, (payload) => {
      if (!pins.some((p) => p.id === payload.new.id)) pins.push(toViewer(payload.new));
      refreshUI();
    })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "pins" }, (payload) => {
      const i = pins.findIndex((p) => p.id === payload.new.id);
      if (i >= 0) pins[i] = toViewer(payload.new);
      refreshUI();
    })
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "pins" }, (payload) => {
      pins = pins.filter((p) => p.id !== payload.old.id);
      refreshUI();
    })
    .subscribe();
}

async function voteOnPin(pin, delta) {
  pin.votes = (pin.votes || 0) + delta; // optimistic; realtime reconciles the real value
  refreshUI();
  const { error } = await supabase.rpc("increment_vote", { pin_id: pin.id, delta });
  if (error) console.error("vote failed", error);
}

async function deletePin(pin) {
  const { error } = await supabase.from("pins").delete().eq("id", pin.id);
  if (error) console.error("delete failed (admin sign-in required)", error);
}

// A cone/sphere blob's centroid doesn't tell you where its exact anchor
// point is -- useless for lining a marker up against real geometry (a
// building corner, another marker) with any precision. This is a proper
// needle instead: a thin shaft tapering to a true point, with the group's
// local origin AT that point (so `.position.set(x, y, z)` puts the point
// exactly there, no offset fudging) and a small ball up top purely so it's
// visible from a distance -- the ball is not the anchor, the tip is.
function makeNeedleMarker(color, opts = {}) {
  const height = opts.height ?? 220;
  const mat = new THREE.MeshBasicMaterial({ color, transparent: !!opts.transparent, opacity: opts.opacity ?? 1 });
  const shaftGeom = new THREE.CylinderGeometry(1.5, 0, height, 10);
  shaftGeom.translate(0, height / 2, 0); // origin at the point, not the shaft's center
  const shaft = new THREE.Mesh(shaftGeom, mat);
  const head = new THREE.Mesh(new THREE.SphereGeometry(18, 12, 12), mat);
  head.position.set(0, height, 0);
  const group = new THREE.Group();
  group.add(shaft, head);
  group.userData.material = mat; // single shared material -- one place to recolor both parts
  return group;
}

function renderPinMarkers() {
  pinGroup.clear();
  for (const pin of pins) {
    const marker = makeNeedleMarker(TIER_COLORS[pin.tier] || TIER_COLORS[1]);
    marker.position.set(pin.x, pin.y, pin.z);
    marker.userData.pinId = pin.id;
    pinGroup.add(marker);
  }
}

function warpToPin(pin) {
  controls.unlock();
  const dir = new THREE.Vector3(0.4, -0.15, 0.4).normalize();
  camera.position.set(pin.x - dir.x * 500, pin.y + 250, pin.z - dir.z * 500);
  camera.lookAt(pin.x, pin.y, pin.z);
}

function nearestPin() {
  let best = null, bestD = Infinity;
  for (const p of pins) {
    const d = Math.hypot(p.x - camera.position.x, p.z - camera.position.z);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

// Only the pins near where the camera currently is -- with a lot of pins on
// the map, listing every single one makes the panel useless. Sorted nearest
// first; "Warp to nearest chest" jumps regardless of the current filter.
function renderPinList() {
  panelListEl.innerHTML = "";
  const nearby = pins
    .map((p) => ({ p, d: Math.hypot(p.x - camera.position.x, p.z - camera.position.z) }))
    .filter((e) => e.d <= VICINITY_RADIUS)
    .sort((a, b) => a.d - b.d);

  if (!nearby.length) {
    const msg = document.createElement("div");
    msg.className = "empty-hint";
    msg.textContent = pins.length
      ? `No chests within ${Math.round(VICINITY_RADIUS / 1000)}km — ${pins.length} marked on the map. Fly closer, or use "Nearest chest".`
      : "No chests marked yet.";
    panelListEl.appendChild(msg);
    return;
  }

  for (const { p: pin, d } of nearby) {
    const row = document.createElement("div");
    row.className = "pin-row";
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = `Chest · Tier ${pin.tier || 1} · ${Math.round(d)}m`;
    const votes = document.createElement("div");
    votes.className = "votes";
    votes.textContent = pin.votes ?? 0;
    const up = document.createElement("button");
    up.textContent = "⬆";
    up.onclick = (e) => { e.stopPropagation(); voteOnPin(pin, 1); };
    const down = document.createElement("button");
    down.textContent = "⬇";
    down.onclick = (e) => { e.stopPropagation(); voteOnPin(pin, -1); };
    row.append(label, votes, up, down);
    if (isAdmin) {
      const del = document.createElement("button");
      del.textContent = "✕";
      del.title = "Delete (admin)";
      del.onclick = (e) => { e.stopPropagation(); deletePin(pin); };
      row.append(del);
    }
    row.onclick = () => warpToPin(pin);
    panelListEl.appendChild(row);
  }
}

const TIER_COLORS = { 1: 0x7fe89a, 2: 0x5ab0ff, 3: 0xffcf4f };

minimapToggle.onclick = () => minimapPanel.classList.toggle("hidden");

// A real live top-down render of the SAME scene/geometry the main view uses
// (actual building rooftops, actual pin markers) rather than an abstract dot
// map -- a second renderer+camera pointed at the same `scene`, hovering
// above the player and following them. Only shows whatever's currently
// streamed in around the player (same chunks the main view has loaded), which
// reads as "the area around me" rather than the whole map -- that's the
// tradeoff for it actually looking like the game instead of a schematic.
const minimapRenderer = new THREE.WebGLRenderer({ canvas: minimapCanvas, antialias: true });
minimapRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
minimapRenderer.setSize(minimapCanvas.width, minimapCanvas.height, false);

const MINIMAP_HALF = 9000; // half-width of the area shown, world units
const minimapCamera = new THREE.OrthographicCamera(
  -MINIMAP_HALF, MINIMAP_HALF, MINIMAP_HALF, -MINIMAP_HALF, 1, 30000
);
minimapCamera.up.set(0, 0, -1);
minimapCamera.layers.enable(1); // sees the player-facing marker too, main camera doesn't

const playerMarkerGeom = new THREE.ConeGeometry(140, 320, 3);
playerMarkerGeom.rotateX(Math.PI / 2);
const playerMarker = new THREE.Mesh(playerMarkerGeom, new THREE.MeshBasicMaterial({ color: 0xff5a5a }));
playerMarker.layers.set(1);
scene.add(playerMarker);

function updateMinimap() {
  if (minimapPanel.classList.contains("hidden")) return;
  const px = camera.position.x, pz = camera.position.z;
  minimapCamera.position.set(px, camera.position.y + 9000, pz);
  minimapCamera.lookAt(px, 0, pz);

  playerMarker.position.set(px, camera.position.y + 60, pz);
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  playerMarker.rotation.y = Math.atan2(dir.x, dir.z);

  minimapRenderer.render(scene, minimapCamera);
}

function openPinEditor(worldPos) {
  closePinEditor();
  let tier = 1;
  const box = document.createElement("div");
  box.id = "pin-editor";
  box.style.left = "50%";
  box.style.top = "50%";
  box.style.transform = "translate(-50%, -50%)";
  box.innerHTML = `
    <div>Chest tier (odds of better loot)</div>
    <div class="row" id="pe-tiers">
      <button type="button" data-tier="1" class="tier-btn selected">1</button>
      <button type="button" data-tier="2" class="tier-btn">2</button>
      <button type="button" data-tier="3" class="tier-btn">3</button>
    </div>
    <textarea id="pe-note" placeholder="Notes (floor, room, landmark...)" autofocus></textarea>
    <div class="row">
      <button id="pe-save" class="primary">Save</button>
      <button id="pe-cancel">Cancel</button>
    </div>
  `;
  document.body.appendChild(box);
  pendingEditor = box;
  box.querySelectorAll(".tier-btn").forEach((btn) => {
    btn.onclick = () => {
      tier = Number(btn.dataset.tier);
      box.querySelectorAll(".tier-btn").forEach((b) => b.classList.toggle("selected", b === btn));
    };
  });
  box.querySelector("#pe-save").onclick = async () => {
    const note = box.querySelector("#pe-note").value.trim();
    const saveBtn = box.querySelector("#pe-save");
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";
    const { data, error } = await supabase
      .from("pins")
      .insert({ ...toGame({ x: worldPos.x, y: worldPos.y, z: worldPos.z }), tier, note })
      .select()
      .single();
    if (error) {
      console.error("failed to save pin", error);
      saveBtn.disabled = false;
      saveBtn.textContent = "Save";
      return;
    }
    // Guarded the same way as the realtime INSERT handler below -- the
    // realtime echo of this exact insert can arrive before or after this
    // line resolves, so both paths need to be safe against seeing the row
    // twice (observed as a transient double-counted pin during testing).
    if (!pins.some((p) => p.id === data.id)) pins.push(toViewer(data));
    refreshUI();
    closePinEditor();
  };
  box.querySelector("#pe-cancel").onclick = closePinEditor;
  box.querySelector("#pe-note").focus();
}

function closePinEditor() {
  if (pendingEditor) {
    pendingEditor.remove();
    pendingEditor = null;
  }
}

// --- picking / add-pin flow (crosshair-based: pointer is locked & hidden
// while flying, so raycasts always come from screen center, not the cursor) --

const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const CENTER_NDC = new THREE.Vector2(0, 0);

// hit=true means the crosshair ray actually landed on loaded building geometry;
// hit=false means it fell back to a guessed ground-plane point (nothing there,
// or you're aiming past the edge of what's loaded) -- surfaced to the user via
// the preview marker's color so it's never ambiguous whether they're really
// touching a wall/floor or just flying near it.
function pickAtCrosshair() {
  raycaster.setFromCamera(CENTER_NDC, camera);
  const hits = raycaster.intersectObjects([...chunkGroup.children, ...terrainGroup.children], false);
  if (hits.length) return { point: hits[0].point, hit: true };
  const out = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(groundPlane, out)) return { point: out, hit: false };
  raycaster.ray.at(3000, out);
  return { point: out, hit: false };
}

const previewMarker = makeNeedleMarker(0x5aff8a, { transparent: true, opacity: 0.85 });
previewMarker.visible = false;
scene.add(previewMarker);

function updatePreview() {
  if (!placing || !controls.isLocked) {
    previewMarker.visible = false;
    return;
  }
  const { point, hit } = pickAtCrosshair();
  previewMarker.position.copy(point);
  previewMarker.userData.material.color.setHex(hit ? 0x5aff8a : 0xffa64f);
  previewMarker.visible = true;
}

function setPlacing(on) {
  placing = on;
  addBtn.textContent = on ? "Click to drop pin..." : "+ Add pin";
  crosshairEl.classList.toggle("placing", on);
  crosshairEl.classList.toggle("visible", on || controls.isLocked);
  if (on) controls.lock();
}

addBtn.onclick = () => setPlacing(!placing);
fitBtn.onclick = () => flyToOverview();
nearestBtn.onclick = () => {
  const n = nearestPin();
  if (n) warpToPin(n);
};
collapseBtn.onclick = () => {
  const collapsed = panelEl.classList.toggle("collapsed");
  collapseBtn.textContent = collapsed ? "+" : "–";
};

function setAdminState(on) {
  isAdmin = on;
  adminBtn.textContent = on ? "Admin (signed in) — sign out" : "Admin sign-in";
  adminBtn.classList.toggle("signed-in", on);
  renderPinList();
}

adminBtn.onclick = async () => {
  if (isAdmin) {
    await supabase.auth.signOut();
    return;
  }
  adminErrorEl.textContent = "";
  adminForm.classList.remove("hidden");
  adminEmailEl.focus();
};

adminCancelBtn.onclick = () => {
  adminForm.classList.add("hidden");
  adminEmailEl.value = "";
  adminPasswordEl.value = "";
  adminErrorEl.textContent = "";
};

adminSigninBtn.onclick = async () => {
  const email = adminEmailEl.value.trim();
  const password = adminPasswordEl.value;
  adminErrorEl.textContent = "";
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    adminErrorEl.textContent = error.message;
    return;
  }
  adminForm.classList.add("hidden");
  adminEmailEl.value = "";
  adminPasswordEl.value = "";
};

renderer.domElement.addEventListener("click", () => {
  if (placing) {
    if (!controls.isLocked) return; // first click just requests the lock
    const { point } = pickAtCrosshair();
    controls.unlock();
    setPlacing(false);
    openPinEditor(point);
    return;
  }
  if (!controls.isLocked && !pendingEditor) controls.lock();
});

controls.addEventListener("lock", () => {
  lockHintEl.classList.add("hidden");
  crosshairEl.classList.add("visible");
  escTagEl.classList.add("visible");
  overviewMode = false;
  setFogFar(UNLOAD_RADIUS);
});
controls.addEventListener("unlock", () => {
  lockHintEl.classList.remove("hidden");
  escTagEl.classList.remove("visible");
  if (!placing) crosshairEl.classList.remove("visible");
});

window.addEventListener("keydown", (e) => {
  if (e.code in keys) keys[e.code] = true;
  if (e.key === "Escape") {
    setPlacing(false);
    closePinEditor();
  }
});
window.addEventListener("keyup", (e) => {
  if (e.code in keys) keys[e.code] = false;
});

// Scroll wheel controls altitude while flying -- feels more natural than
// Space/Ctrl for fine vertical adjustment (they still work too).
renderer.domElement.addEventListener("wheel", (e) => {
  if (!controls.isLocked) return;
  e.preventDefault();
  camera.position.y -= e.deltaY * WHEEL_SPEED;
}, { passive: false });

const keys = {
  KeyW: false, KeyA: false, KeyS: false, KeyD: false,
  ArrowUp: false, ArrowLeft: false, ArrowDown: false, ArrowRight: false,
  Space: false, ControlLeft: false, ControlRight: false,
  ShiftLeft: false, ShiftRight: false,
};

function applyMovement(delta) {
  if (!controls.isLocked) return;
  const sprint = keys.ShiftLeft || keys.ShiftRight;
  const speed = (sprint ? BASE_SPEED * SPRINT_MULT : BASE_SPEED) * delta;
  const forward = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
  const strafe = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
  if (forward) controls.moveForward(forward * speed);
  if (strafe) controls.moveRight(strafe * speed);
  const vertical = (keys.Space ? 1 : 0) - (keys.ControlLeft || keys.ControlRight ? 1 : 0);
  if (vertical) camera.position.y += vertical * speed;
}

// --- export / import --------------------------------------------------

exportBtn.onclick = () => {
  // exported/imported files carry TRUE game coordinates, like the database
  const blob = new Blob([JSON.stringify(pins.map(toGame), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "smc-loot-pins.json";
  a.click();
  URL.revokeObjectURL(url);
};

importBtn.onclick = () => importFile.click();

importFile.onchange = async () => {
  const file = importFile.files[0];
  if (!file) return;
  try {
    const incoming = JSON.parse(await file.text());
    // Always inserted as NEW rows -- votes/id aren't taken from the file, so
    // importing can't be used to smuggle in fake vote counts. Falls back to
    // the old "label" field for files exported before the tier system.
    const rows = incoming
      .filter((p) => p && typeof p.x === "number" && typeof p.y === "number" && typeof p.z === "number")
      .map((p) => ({
        x: p.x, y: p.y, z: p.z,
        tier: [1, 2, 3].includes(p.tier) ? p.tier : 1,
        note: p.note || p.label || "",
      }));
    if (!rows.length) {
      alert("No valid pins found in that file.");
      return;
    }
    const { error } = await supabase.from("pins").insert(rows);
    if (error) throw error;
    await fetchPins();
  } catch (err) {
    alert("Could not import that file: " + err.message);
  }
  importFile.value = "";
};

// --- boot -----------------------------------------------------------------

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener("resize", onResize);

// A raw ShaderMaterial's uniforms are a snapshot taken when the material is
// constructed -- they don't auto-track scene.fog like a built-in material
// would. heightMaterial/terrainMaterial capture fogFar once at page load, and
// every chunk clone (loadChunk/loadTerrainTile) copies THAT frozen value, so
// just setting scene.fog.far does nothing to what's actually rendered. This
// pushes the new value onto the templates (so future clones pick it up) and
// every already-loaded clone (so what's on screen right now updates too).
function setFogFar(value) {
  scene.fog.far = value;
  heightMaterial.uniforms.fogFar.value = value;
  terrainMaterial.uniforms.fogFar.value = value;
  for (const rec of loadedChunks.values()) {
    if (rec.mesh) rec.mesh.material.uniforms.fogFar.value = value;
  }
  for (const rec of loadedTerrain.values()) {
    if (rec.mesh) rec.mesh.material.uniforms.fogFar.value = value;
  }
}

function flyToOverview() {
  controls.unlock();
  const b = manifest.bbox;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  // A true whole-map bird's-eye. Individual buildings read as small blocks
  // from this height, but that's the point -- see the whole layout at once.
  // overviewMode (cleared the moment the player locks the pointer to fly)
  // force-loads every chunk and pushes fog.far out so nothing at the map's
  // edges gets lost to the normal flight streaming bubble or fog falloff.
  // Near-vertical, not perfectly so: a tiny horizontal offset keeps the
  // camera's local axes well-defined for PointerLockControls (a perfectly
  // vertical look makes "forward" ambiguous).
  overviewMode = true;
  setFogFar(OVERVIEW_FOG_FAR);
  const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
  camera.position.set(cx - 300, span * 0.62, cz - 300);
  camera.lookAt(cx, 0, cz);
}

async function boot() {
  manifest = await fetch("data/manifest.json", NO_STALE).then((r) => r.json());
  terrainManifest = await fetch("data/terrain_manifest.json", NO_STALE).then((r) => r.json());

  onResize();
  flyToOverview();

  const { data: { session } } = await supabase.auth.getSession();
  setAdminState(!!session);
  supabase.auth.onAuthStateChange((_event, session2) => setAdminState(!!session2));

  await fetchPins();
  subscribeToPinChanges();

  const clock = new THREE.Clock();
  let lastListRefresh = 0;
  let lastMinimapRefresh = 0;
  renderer.setAnimationLoop(() => {
    const delta = Math.min(clock.getDelta(), 0.1);
    applyMovement(delta);
    updateStreaming();
    updateChunkFades();
    updateTerrainStreaming();
    updateTerrainFades();
    updatePreview();
    const now = performance.now();
    if (now - lastListRefresh > 500 && !panelEl.classList.contains("collapsed")) {
      lastListRefresh = now;
      renderPinList();
    }
    if (now - lastMinimapRefresh > 150) {
      lastMinimapRefresh = now;
      updateMinimap();
    }
    renderer.render(scene, camera);
  });
}

boot();
