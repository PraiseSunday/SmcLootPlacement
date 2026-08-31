import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";

const STORAGE_KEY = "smc-loot-pins-v1";
const LOAD_RADIUS = 4500; // load chunks whose center is within this many world units of the camera
const UNLOAD_RADIUS = 9000; // drop chunks further than this

const BASE_SPEED = 1400; // world units / second
const SPRINT_MULT = 3;

const viewportEl = document.getElementById("viewport");
const statsEl = document.getElementById("stats");
const panelListEl = document.getElementById("pin-list");
const addBtn = document.getElementById("add-btn");
const fitBtn = document.getElementById("fit-btn");
const exportBtn = document.getElementById("export-btn");
const importBtn = document.getElementById("import-btn");
const importFile = document.getElementById("import-file");
const lockHintEl = document.getElementById("lock-hint");
const crosshairEl = document.getElementById("crosshair");
const escTagEl = document.getElementById("esc-tag");

let manifest = null;
let pins = loadPins();
let placing = false;
let pendingEditor = null;

// --- three.js scene setup -------------------------------------------------

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0f14);
scene.fog = new THREE.Fog(0x0d0f14, 3000, 9000);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
viewportEl.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 1, 20000);
camera.position.set(0, 1500, 0);

const controls = new PointerLockControls(camera, renderer.domElement);

const chunkGroup = new THREE.Group();
scene.add(chunkGroup);
const pinGroup = new THREE.Group();
scene.add(pinGroup);

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x30281c, 0.9));

// Height is normalized PER BUILDING (baked into a "heightT" vertex attribute at
// chunk-load time, see loadChunk) rather than against the whole-map Y range —
// one tall tower elsewhere on the map would otherwise crush every ordinary
// building into the bottom of the ramp. Lighting uses computed vertex normals
// so walls/roofs read as distinct facets instead of flat height-tinted blobs.
const heightMaterial = new THREE.ShaderMaterial({
  vertexShader: `
    attribute float heightT;
    varying float vT;
    varying vec3 vNormal;
    void main() {
      vT = heightT;
      vNormal = normalize(normalMatrix * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    varying float vT;
    varying vec3 vNormal;
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
      gl_FragColor = vec4(base * diffuse, 1.0);
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
  const res = await fetch("data/" + entry.file);
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

  const mesh = new THREE.Mesh(geom, heightMaterial);
  chunkGroup.add(mesh);
  const rec = loadedChunks.get(key);
  if (!rec) { // was unloaded while fetching
    geom.dispose();
    return;
  }
  rec.mesh = mesh;
}

function unloadChunk(key) {
  const rec = loadedChunks.get(key);
  if (!rec) return;
  if (rec.mesh) {
    chunkGroup.remove(rec.mesh);
    rec.mesh.geometry.dispose();
  }
  loadedChunks.delete(key);
}

function updateStreaming() {
  const cell = manifest.cell_size;
  const px = camera.position.x, pz = camera.position.z;
  for (const entry of manifest.chunks) {
    const ecx = entry.cx * cell + cell / 2;
    const ecz = entry.cz * cell + cell / 2;
    const d = Math.hypot(ecx - px, ecz - pz);
    if (d <= LOAD_RADIUS) loadChunk(entry);
  }
  for (const [key, rec] of [...loadedChunks]) {
    const ecx = rec.entry.cx * cell + cell / 2;
    const ecz = rec.entry.cz * cell + cell / 2;
    const d = Math.hypot(ecx - px, ecz - pz);
    if (d > UNLOAD_RADIUS) unloadChunk(key);
  }
  statsEl.textContent =
    `${loadedChunks.size} chunks loaded / ${manifest.chunks.length} total · ${pins.length} pins · ` +
    `pos ${px.toFixed(0)}, ${camera.position.y.toFixed(0)}, ${pz.toFixed(0)}`;
}

// --- pins -----------------------------------------------------------------

function loadPins() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function savePins() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(pins));
  renderPinList();
  renderPinMarkers();
}

function makePinId() {
  return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function renderPinMarkers() {
  pinGroup.clear();
  for (const pin of pins) {
    const geom = new THREE.ConeGeometry(60, 160, 12);
    geom.rotateX(Math.PI);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff5a5a });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(pin.x, pin.y + 100, pin.z);
    mesh.userData.pinId = pin.id;
    pinGroup.add(mesh);
  }
}

function renderPinList() {
  panelListEl.innerHTML = "";
  for (const pin of pins) {
    const row = document.createElement("div");
    row.className = "pin-row";
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = pin.label || "unlabeled";
    const votes = document.createElement("div");
    votes.className = "votes";
    votes.textContent = pin.votes ?? 0;
    const up = document.createElement("button");
    up.textContent = "⬆";
    up.onclick = (e) => { e.stopPropagation(); pin.votes = (pin.votes || 0) + 1; savePins(); };
    const down = document.createElement("button");
    down.textContent = "⬇";
    down.onclick = (e) => { e.stopPropagation(); pin.votes = (pin.votes || 0) - 1; savePins(); };
    const del = document.createElement("button");
    del.textContent = "✕";
    del.onclick = (e) => {
      e.stopPropagation();
      pins = pins.filter((p) => p.id !== pin.id);
      savePins();
    };
    row.append(label, votes, up, down, del);
    row.onclick = () => {
      controls.unlock();
      const dir = new THREE.Vector3(0.4, -0.15, 0.4).normalize();
      camera.position.set(pin.x - dir.x * 500, pin.y + 250, pin.z - dir.z * 500);
      camera.lookAt(pin.x, pin.y, pin.z);
    };
    panelListEl.appendChild(row);
  }
}

function openPinEditor(worldPos) {
  closePinEditor();
  const box = document.createElement("div");
  box.id = "pin-editor";
  box.style.left = "50%";
  box.style.top = "50%";
  box.style.transform = "translate(-50%, -50%)";
  box.innerHTML = `
    <input id="pe-label" placeholder="Loot type (e.g. rifle crate)" autofocus>
    <textarea id="pe-note" placeholder="Notes (floor, room, landmark...)"></textarea>
    <div class="row">
      <button id="pe-save" class="primary">Save</button>
      <button id="pe-cancel">Cancel</button>
    </div>
  `;
  document.body.appendChild(box);
  pendingEditor = box;
  box.querySelector("#pe-save").onclick = () => {
    const label = box.querySelector("#pe-label").value.trim();
    const note = box.querySelector("#pe-note").value.trim();
    pins.push({
      id: makePinId(),
      x: worldPos.x, y: worldPos.y, z: worldPos.z,
      label: label || "unlabeled",
      note,
      votes: 0,
      createdAt: Date.now(),
    });
    savePins();
    closePinEditor();
  };
  box.querySelector("#pe-cancel").onclick = closePinEditor;
  box.querySelector("#pe-label").focus();
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

function pickAtCrosshair() {
  raycaster.setFromCamera(CENTER_NDC, camera);
  const hits = raycaster.intersectObjects(chunkGroup.children, false);
  if (hits.length) return hits[0].point;
  const out = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(groundPlane, out)) return out;
  return raycaster.ray.at(3000, out);
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

renderer.domElement.addEventListener("click", () => {
  if (placing) {
    if (!controls.isLocked) return; // first click just requests the lock
    const world = pickAtCrosshair();
    controls.unlock();
    setPlacing(false);
    openPinEditor(world);
    return;
  }
  if (!controls.isLocked && !pendingEditor) controls.lock();
});

controls.addEventListener("lock", () => {
  lockHintEl.classList.add("hidden");
  crosshairEl.classList.add("visible");
  escTagEl.classList.add("visible");
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
  const blob = new Blob([JSON.stringify(pins, null, 2)], { type: "application/json" });
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
    const byId = new Map(pins.map((p) => [p.id, p]));
    for (const p of incoming) {
      if (p && p.id) byId.set(p.id, p);
    }
    pins = [...byId.values()];
    savePins();
  } catch (err) {
    alert("Could not read that file: " + err.message);
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

function flyToOverview() {
  controls.unlock();
  const b = manifest.bbox;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  // Angled 3/4 aerial shot, not a straight-down look: a perfectly vertical
  // camera makes "forward" horizontally ambiguous (PointerLockControls derives
  // move direction from the camera's local axes), so WASD would do nothing
  // useful until the user first moved the mouse. This angle keeps movement
  // meaningful from the very first frame.
  camera.position.set(cx - 9000, 8000, cz - 9000);
  camera.lookAt(cx, 0, cz);
}

async function boot() {
  manifest = await fetch("data/manifest.json").then((r) => r.json());

  onResize();
  flyToOverview();
  renderPinList();
  renderPinMarkers();

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const delta = Math.min(clock.getDelta(), 0.1);
    applyMovement(delta);
    updateStreaming();
    renderer.render(scene, camera);
  });
}

boot();
