import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const STORAGE_KEY = "smc-loot-pins-v1";
const CHUNK_MARGIN = 1; // extra rings of chunks to keep loaded around the viewport
const CHUNK_UNLOAD_MARGIN = 3; // drop chunks further than this many rings away

const viewportEl = document.getElementById("viewport");
const statsEl = document.getElementById("stats");
const panelListEl = document.getElementById("pin-list");
const addBtn = document.getElementById("add-btn");
const fitBtn = document.getElementById("fit-btn");
const exportBtn = document.getElementById("export-btn");
const importBtn = document.getElementById("import-btn");
const importFile = document.getElementById("import-file");

let manifest = null;
let pins = loadPins();
let placing = false;
let pendingEditor = null;

// --- three.js scene setup -------------------------------------------------

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0f14);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
viewportEl.appendChild(renderer.domElement);

const VIEW_HALF = 4000; // initial half-width of the camera frustum, world units
let aspect = window.innerWidth / window.innerHeight;
const camera = new THREE.OrthographicCamera(
  -VIEW_HALF * aspect, VIEW_HALF * aspect, VIEW_HALF, -VIEW_HALF, 0.1, 100000
);
camera.position.set(0, 5000, 0);
camera.up.set(0, 0, -1);
camera.lookAt(0, 0, 0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableRotate = false;
controls.screenSpacePanning = true;
controls.mouseButtons = {
  LEFT: THREE.MOUSE.PAN,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.PAN,
};
controls.minZoom = 0.05;
controls.maxZoom = 40;
controls.target.set(0, 0, 0);

const chunkGroup = new THREE.Group();
scene.add(chunkGroup);
const pinGroup = new THREE.Group();
scene.add(pinGroup);

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

// --- chunk streaming ---------------------------------------------------

const loadedChunks = new Map(); // "cx,cz" -> { mesh, entry, lastSeen }
let frame = 0;

function chunkKey(cx, cz) {
  return cx + "," + cz;
}

function visibleChunkRange() {
  const w = (camera.right - camera.left) / camera.zoom;
  const h = (camera.top - camera.bottom) / camera.zoom;
  const cx0 = camera.position.x - w / 2;
  const cx1 = camera.position.x + w / 2;
  const cz0 = camera.position.z - h / 2;
  const cz1 = camera.position.z + h / 2;
  const cell = manifest.cell_size;
  return {
    minCx: Math.floor(cx0 / cell) - CHUNK_MARGIN,
    maxCx: Math.floor(cx1 / cell) + CHUNK_MARGIN,
    minCz: Math.floor(cz0 / cell) - CHUNK_MARGIN,
    maxCz: Math.floor(cz1 / cell) + CHUNK_MARGIN,
  };
}

async function loadChunk(entry) {
  const key = chunkKey(entry.cx, entry.cz);
  if (loadedChunks.has(key)) {
    loadedChunks.get(key).lastSeen = frame;
    return;
  }
  const placeholder = { mesh: null, entry, lastSeen: frame, loading: true };
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
  rec.loading = false;
  rec.lastSeen = frame;
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
  frame++;
  const range = visibleChunkRange();
  for (const entry of manifest.chunks) {
    if (
      entry.cx >= range.minCx - (CHUNK_UNLOAD_MARGIN - CHUNK_MARGIN) &&
      entry.cx <= range.maxCx + (CHUNK_UNLOAD_MARGIN - CHUNK_MARGIN) &&
      entry.cz >= range.minCz - (CHUNK_UNLOAD_MARGIN - CHUNK_MARGIN) &&
      entry.cz <= range.maxCz + (CHUNK_UNLOAD_MARGIN - CHUNK_MARGIN)
    ) {
      if (
        entry.cx >= range.minCx && entry.cx <= range.maxCx &&
        entry.cz >= range.minCz && entry.cz <= range.maxCz
      ) {
        loadChunk(entry);
      }
    }
  }
  for (const [key, rec] of [...loadedChunks]) {
    const dx = Math.abs(rec.entry.cx - (range.minCx + range.maxCx) / 2);
    const dz = Math.abs(rec.entry.cz - (range.minCz + range.maxCz) / 2);
    const span = Math.max(range.maxCx - range.minCx, range.maxCz - range.minCz) / 2 + CHUNK_UNLOAD_MARGIN;
    if (Math.max(dx, dz) > span) unloadChunk(key);
  }
  statsEl.textContent = `${loadedChunks.size} chunks loaded / ${manifest.chunks.length} total · ${pins.length} pins`;
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
      controls.target.set(pin.x, 0, pin.z);
      camera.position.set(pin.x, camera.position.y, pin.z);
      controls.update();
    };
    panelListEl.appendChild(row);
  }
}

function openPinEditor(worldPos, screenX, screenY) {
  closePinEditor();
  const box = document.createElement("div");
  box.id = "pin-editor";
  box.style.left = Math.min(screenX, window.innerWidth - 240) + "px";
  box.style.top = Math.min(screenY, window.innerHeight - 200) + "px";
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

// --- picking / add-pin flow ------------------------------------------------

const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

function screenToWorld(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(chunkGroup.children, false);
  if (hits.length) return hits[0].point;
  const out = new THREE.Vector3();
  raycaster.ray.intersectPlane(groundPlane, out);
  return out;
}

function setPlacing(on) {
  placing = on;
  viewportEl.classList.toggle("placing", on);
  addBtn.textContent = on ? "Click the map..." : "+ Add pin";
}

addBtn.onclick = () => setPlacing(!placing);

renderer.domElement.addEventListener("click", (e) => {
  if (!placing) return;
  const world = screenToWorld(e.clientX, e.clientY);
  setPlacing(false);
  openPinEditor(world, e.clientX, e.clientY);
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    setPlacing(false);
    closePinEditor();
  }
});

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
  aspect = window.innerWidth / window.innerHeight;
  camera.left = -VIEW_HALF * aspect;
  camera.right = VIEW_HALF * aspect;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener("resize", onResize);

function fitToMap() {
  const b = manifest.bbox;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  controls.target.set(cx, 0, cz);
  camera.position.set(cx, 5000, cz);
  const zoomX = (2 * VIEW_HALF * aspect) / (b.maxX - b.minX);
  const zoomZ = (2 * VIEW_HALF) / (b.maxZ - b.minZ);
  camera.zoom = Math.min(zoomX, zoomZ) * 0.9;
  camera.updateProjectionMatrix();
  controls.update();
}
fitBtn.onclick = fitToMap;

async function boot() {
  manifest = await fetch("data/manifest.json").then((r) => r.json());

  onResize();
  fitToMap();
  renderPinList();
  renderPinMarkers();

  renderer.setAnimationLoop(() => {
    controls.update();
    updateStreaming();
    renderer.render(scene, camera);
  });
}

boot();
