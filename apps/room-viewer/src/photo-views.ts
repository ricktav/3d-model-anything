// Posed reference photos inside the viewer (House Capture rooms):
//  - photo camera frustums (toggle P), click one to fly to its exact pose/FOV
//  - photo overlay with a blend slider (photo vs. model); ←/→ step, Esc closes
//  - Walk mode: nearest-photo thumbnail (N toggles, F expands, G snaps to its pose)
// URL: ?photos=1 shows the cameras, ?photo=N opens photo N, &blend=0.5 sets the mix.
import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { appURL } from './asset-base';
import type { BuiltRoom, PhotoPose } from '../../../packages/room-runtime/types';

const CSS = `
#pv-overlay{position:absolute;inset:0;pointer-events:none;display:flex;align-items:center;justify-content:center;z-index:5}
#pv-overlay img{display:block;max-width:none}
#pv-bar{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);z-index:6;display:flex;gap:10px;align-items:center;
 background:rgba(17,20,19,.86);color:#e8ece9;border:1px solid #2c3430;border-radius:10px;padding:8px 12px;font:12px system-ui,sans-serif}
#pv-bar button{background:#26302b;color:#e8ece9;border:1px solid #3a4540;border-radius:6px;padding:4px 9px;cursor:pointer}
#pv-bar input[type=range]{width:140px}
#pv-near{position:absolute;right:14px;bottom:14px;z-index:6;background:rgba(17,20,19,.86);border:1px solid #2c3430;border-radius:10px;
 padding:6px;color:#e8ece9;font:11px system-ui,sans-serif;pointer-events:none}
#pv-near img{display:block;height:180px;border-radius:6px}
#pv-near p{margin:5px 2px 0}
#pv-tip{position:absolute;z-index:7;pointer-events:none;background:#111;border:1px solid #333;border-radius:6px;padding:3px;color:#ddd;font:11px system-ui}
#pv-tip img{display:block;height:110px;border-radius:4px}
.pv-section .pv-help{font-size:10px;line-height:1.9;color:#839087;margin:10px 2px 0}
.pv-section label{display:flex;gap:8px;align-items:center;font-size:12px;margin:4px 0;cursor:pointer}
`;

interface Options {
  scene: THREE.Scene; camera: THREE.PerspectiveCamera; orbit: OrbitControls;
  canvas: HTMLCanvasElement; viewport: HTMLElement; hud: HTMLElement;
  invalidate(): void; getMode(): string;
}

export function createPhotoViews(o: Options) {
  const { scene, camera, orbit, canvas, viewport, invalidate } = o;
  document.head.append(Object.assign(document.createElement('style'), { textContent: CSS }));
  const params = new URLSearchParams(location.search);
  let photos: PhotoPose[] = [];
  let blend = Math.min(1, Math.max(0, Number(params.get('blend') ?? 0.5)));
  let showCameras = params.get('photos') === '1';
  let nearestOn = params.get('nearest') !== '0';

  // --- sidebar controls
  const section = document.createElement('section');
  section.className = 'control-section pv-section';
  section.innerHTML = `<h2>Photos <span class="section-note" id="pv-count"></span></h2>
    <label><input type="checkbox" id="pv-cams"> Show photo cameras (P)</label>
    <label><input type="checkbox" id="pv-nearest"> Nearest photo in Walk (N)</label>
    <label>Photo blend <input type="range" id="pv-blend" min="0" max="1" step="0.05" style="flex:1"></label>
    <p class="pv-help">Click a camera to see the room from that photo. ←/→ next photo, Esc to close. In Walk: F enlarges the nearest photo, G jumps to its exact position.</p>`;
  (o.hud.querySelector('#navigation') ?? o.hud.lastElementChild)!.before(section);
  const camsBox = section.querySelector<HTMLInputElement>('#pv-cams')!;
  const nearBox = section.querySelector<HTMLInputElement>('#pv-nearest')!;
  const blendSide = section.querySelector<HTMLInputElement>('#pv-blend')!;
  camsBox.checked = showCameras; nearBox.checked = nearestOn; blendSide.value = String(blend);

  // --- viewport overlay, bar, nearest thumbnail, hover tip
  const overlay = document.createElement('div'); overlay.id = 'pv-overlay'; overlay.hidden = true;
  const overlayImg = document.createElement('img'); overlay.append(overlayImg);
  const bar = document.createElement('div'); bar.id = 'pv-bar'; bar.hidden = true;
  bar.innerHTML = `<button data-pv="prev" title="Previous (←)">‹</button><span id="pv-label"></span><button data-pv="next" title="Next (→)">›</button>
    <span>Model</span><input type="range" id="pv-blend2" min="0" max="1" step="0.05"><span>Photo</span><button data-pv="close" title="Esc">Close</button>`;
  const near = document.createElement('div'); near.id = 'pv-near'; near.hidden = true;
  near.innerHTML = '<img alt="nearest photo"><p></p>';
  const tip = document.createElement('div'); tip.id = 'pv-tip'; tip.hidden = true; tip.innerHTML = '<img alt=""><div></div>';
  viewport.append(overlay, bar, near, tip);
  const blendBar = bar.querySelector<HTMLInputElement>('#pv-blend2')!;
  blendBar.value = String(blend);
  const setBlend = (v: number) => { blend = v; blendBar.value = blendSide.value = String(v); overlayImg.style.opacity = String(v); };
  blendBar.addEventListener('input', () => setBlend(Number(blendBar.value)));
  blendSide.addEventListener('input', () => setBlend(Number(blendSide.value)));
  setBlend(blend);

  // --- 3D camera markers
  const markers = new THREE.Group(); markers.name = 'photo-cameras'; markers.visible = false; scene.add(markers);
  let points: THREE.Points | undefined;
  const highlight = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#ffd400', depthTest: false, transparent: true }));
  highlight.renderOrder = 11; markers.add(highlight);
  const frustum = (p: PhotoPose, d: number) => {
    const pos = new THREE.Vector3(...p.position as [number, number, number]);
    const f = new THREE.Vector3(...p.forward as [number, number, number]).normalize();
    const up = new THREE.Vector3(...p.up as [number, number, number]).normalize();
    const right = f.clone().cross(up).normalize();
    const h = d * Math.tan(THREE.MathUtils.degToRad(p.fovY) / 2), w = h * p.aspect;
    const c = pos.clone().addScaledVector(f, d);
    const k = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => c.clone().addScaledVector(right, a * w).addScaledVector(up, b * h));
    const out: number[] = [];
    const seg = (a: THREE.Vector3, b: THREE.Vector3) => out.push(...a.toArray(), ...b.toArray());
    k.forEach((q, i) => { seg(pos, q); seg(q, k[(i + 1) % 4]); });
    seg(c.clone().addScaledVector(up, h), c.clone().addScaledVector(up, h * 1.35)); // "up" tick
    return out;
  };
  function buildMarkers() {
    for (const c of [...markers.children]) if (c !== highlight) { markers.remove(c); (c as THREE.Mesh).geometry?.dispose(); }
    if (!photos.length) return;
    const lines: number[] = [];
    photos.forEach(p => lines.push(...frustum(p, 0.12)));
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    const seg = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: '#ff5fa2', transparent: true, opacity: 0.7, depthTest: false }));
    seg.renderOrder = 10;
    const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.Float32BufferAttribute(photos.flatMap(p => p.position), 3));
    points = new THREE.Points(pg, new THREE.PointsMaterial({ color: '#ff5fa2', size: 7, sizeAttenuation: false, depthTest: false, transparent: true }));
    points.renderOrder = 10;
    markers.add(seg, points);
  }
  function setHighlight(i: number | undefined) {
    highlight.geometry.dispose();
    highlight.geometry = new THREE.BufferGeometry();
    if (i !== undefined) highlight.geometry.setAttribute('position', new THREE.Float32BufferAttribute(frustum(photos[i], 0.22), 3));
    invalidate();
  }
  const updateMarkers = () => { markers.visible = showCameras && o.getMode() === 'orbit' && photos.length > 0; invalidate(); };
  camsBox.addEventListener('change', () => { showCameras = camsBox.checked; updateMarkers(); });
  nearBox.addEventListener('change', () => { nearestOn = nearBox.checked; lastNearest = -1; near.hidden = true; invalidate(); });

  // --- picking
  const ray = new THREE.Raycaster(); ray.params.Points = { threshold: 0.07 };
  const ndc = new THREE.Vector2();
  function pick(e: PointerEvent | MouseEvent) {
    if (!markers.visible || !points) return undefined;
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObject(points);
    return hits.length ? hits.sort((a, b) => (a.distanceToRay ?? 0) - (b.distanceToRay ?? 0))[0].index : undefined;
  }
  let down: [number, number] | undefined;
  canvas.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', e => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    const i = pick(e); if (i !== undefined) open(i);
  });
  canvas.addEventListener('pointermove', e => {
    if (current !== undefined || !markers.visible) { tip.hidden = true; return; }
    const i = pick(e);
    if (i === undefined) { if (!tip.hidden) { tip.hidden = true; setHighlight(undefined); } canvas.style.cursor = ''; return; }
    canvas.style.cursor = 'pointer';
    const r = viewport.getBoundingClientRect();
    tip.style.left = `${e.clientX - r.left + 14}px`; tip.style.top = `${e.clientY - r.top + 14}px`;
    if (tip.dataset.i !== String(i)) {
      tip.dataset.i = String(i); tip.querySelector('img')!.src = appURL(photos[i].url);
      tip.querySelector('div')!.textContent = `Photo ${i}`; setHighlight(i);
    }
    tip.hidden = false;
  });

  // --- photo view: camera at the exact pose, photo overlaid
  let current: number | undefined;
  let saved: { pos: THREE.Vector3; target: THREE.Vector3; fov: number } | undefined;
  let fly: { start: number; fromP: THREE.Vector3; fromQ: THREE.Quaternion; fromFov: number; toP: THREE.Vector3; toQ: THREE.Quaternion; toFov: number } | undefined;
  /** vertical FOV for the viewport so the photo's frame fills the fitted image exactly */
  function fit(p: PhotoPose) {
    const W = viewport.clientWidth, H = viewport.clientHeight;
    const imgH = Math.min(H, W / p.aspect);
    overlayImg.style.height = `${imgH}px`; overlayImg.style.width = `${imgH * p.aspect}px`;
    return THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(p.fovY) / 2) * H / imgH));
  }
  function poseOf(p: PhotoPose) {
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3(...p.position as [number, number, number]);
    m.lookAt(pos, pos.clone().add(new THREE.Vector3(...p.forward as [number, number, number])), new THREE.Vector3(...p.up as [number, number, number]));
    return { pos, quat: new THREE.Quaternion().setFromRotationMatrix(m) };
  }
  function open(i: number, animate = true) {
    if (!photos.length) return;
    i = (i + photos.length) % photos.length;
    const p = photos[i];
    if (current === undefined) saved = { pos: camera.position.clone(), target: orbit.target.clone(), fov: camera.fov };
    current = i;
    orbit.enabled = false;
    const { pos, quat } = poseOf(p);
    const toFov = fit(p);
    fly = { start: performance.now(), fromP: camera.position.clone(), fromQ: camera.quaternion.clone(), fromFov: camera.fov, toP: pos, toQ: quat, toFov };
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) fly.start = -1e9;
    overlay.hidden = true; // shown when the flight lands
    overlayImg.src = appURL(p.url);
    bar.hidden = false; tip.hidden = true;
    bar.querySelector('#pv-label')!.textContent = `Photo ${i} / ${photos.length - 1}`;
    setHighlight(i);
    const url = new URL(location.href); url.searchParams.set('photo', String(i)); url.searchParams.set('blend', String(blend));
    history.replaceState(null, '', url);
    invalidate();
  }
  /** leave the photo view; `restore` returns to the camera from before it opened */
  function close(restore = true) {
    if (current === undefined) return;
    current = undefined; fly = undefined;
    overlay.hidden = true; bar.hidden = true; setHighlight(undefined);
    camera.up.set(0, 1, 0);
    if (!restore) camera.fov = saved?.fov ?? camera.fov;
    if (saved && restore) { camera.position.copy(saved.pos); orbit.target.copy(saved.target); camera.fov = saved.fov; camera.updateProjectionMatrix(); }
    orbit.enabled = true; orbit.update();
    const url = new URL(location.href); url.searchParams.delete('photo'); history.replaceState(null, '', url);
    invalidate();
  }
  bar.addEventListener('click', e => {
    const a = (e.target as HTMLElement).dataset.pv;
    if (a === 'prev' && current !== undefined) open(current - 1);
    if (a === 'next' && current !== undefined) open(current + 1);
    if (a === 'close') close();
  });

  // --- walk mode: nearest photo
  let lastNearest = -1, expanded = false, snapped: THREE.Vector3 | undefined, walkFov = 0;
  const fwd = new THREE.Vector3();
  function nearest() {
    camera.getWorldDirection(fwd);
    let best = -1, bestScore = Infinity, bestAngle = 0, bestDist = 0;
    photos.forEach((p, i) => {
      const f = new THREE.Vector3(...p.forward as [number, number, number]).normalize();
      const angle = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(f.dot(fwd), -1, 1)));
      const dist = camera.position.distanceTo(new THREE.Vector3(...p.position as [number, number, number]));
      const score = angle / 25 + dist / 0.6;
      if (score < bestScore) { bestScore = score; best = i; bestAngle = angle; bestDist = dist; }
    });
    return { best, bestAngle, bestDist };
  }
  function showNearest() {
    if (!nearestOn || o.getMode() !== 'walk' || !photos.length) { near.hidden = true; if (expanded && o.getMode() !== 'walk') collapse(); return; }
    const { best, bestAngle, bestDist } = nearest();
    near.hidden = false;
    if (best !== lastNearest) { lastNearest = best; near.querySelector('img')!.src = appURL(photos[best].url); if (expanded) overlayImg.src = appURL(photos[best].url); }
    near.querySelector('p')!.textContent = `Photo ${best} · ${bestDist.toFixed(2)} m · ${bestAngle.toFixed(0)}° off · F enlarge · G jump`;
  }
  function collapse() {
    expanded = false; overlay.hidden = true;
    if (walkFov) { camera.fov = walkFov; camera.updateProjectionMatrix(); walkFov = 0; }
    snapped = undefined; invalidate();
  }
  function expand() {
    if (lastNearest < 0) return;
    expanded = true; overlayImg.src = appURL(photos[lastNearest].url); fit(photos[lastNearest]); overlay.hidden = false;
    overlayImg.style.opacity = String(blend); invalidate();
  }
  function snap() {
    if (lastNearest < 0) return;
    const p = photos[lastNearest]; const { pos, quat } = poseOf(p);
    camera.position.copy(pos); camera.quaternion.copy(quat);
    if (!walkFov) walkFov = camera.fov;
    camera.fov = fit(p); camera.updateProjectionMatrix();
    snapped = pos.clone(); expand();
  }

  window.addEventListener('keydown', e => {
    if (e.target instanceof HTMLElement && e.target.matches('input, select, textarea')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const mode = o.getMode();
    if (e.code === 'KeyP' && mode === 'orbit') { showCameras = camsBox.checked = !showCameras; updateMarkers(); }
    if (e.code === 'KeyN') { nearestOn = nearBox.checked = !nearestOn; lastNearest = -1; showNearest(); if (!nearestOn) collapse(); }
    if (current !== undefined) {
      if (e.code === 'Escape') { e.preventDefault(); close(); }
      if (e.code === 'ArrowRight') { e.preventDefault(); open(current + 1); }
      if (e.code === 'ArrowLeft') { e.preventDefault(); open(current - 1); }
    }
    if (e.code === 'BracketLeft') setBlend(Math.max(0, +(blend - .1).toFixed(2)));
    if (e.code === 'BracketRight') setBlend(Math.min(1, +(blend + .1).toFixed(2)));
    if (mode === 'walk' && nearestOn) {
      if (e.code === 'KeyF') { if (expanded) collapse(); else expand(); }
      if (e.code === 'KeyG') snap();
    }
  });

  return {
    setRoom(room: BuiltRoom) {
      // A new room positions its own camera; don't restore the previous room's view.
      close(false); collapse();
      photos = room.photos ?? [];
      section.hidden = photos.length === 0;
      section.querySelector('#pv-count')!.textContent = photos.length ? `${photos.length} posed` : '';
      buildMarkers(); updateMarkers();
      const want = params.get('photo');
      if (want !== null && photos.length && o.getMode() === 'orbit') { params.delete('photo'); open(Number(want), false); }
    },
    /** true while the photo view owns the camera (skip orbit updates) */
    update(time: number) {
      if (current === undefined) {
        if (o.getMode() === 'walk') {
          if (snapped && camera.position.distanceToSquared(snapped) > 1e-6) collapse();
          showNearest();
        }
        return false;
      }
      if (fly) {
        const t = Math.min(1, (time - fly.start) / 600), e = 1 - Math.pow(1 - t, 3);
        camera.position.lerpVectors(fly.fromP, fly.toP, e);
        camera.quaternion.slerpQuaternions(fly.fromQ, fly.toQ, e);
        camera.fov = THREE.MathUtils.lerp(fly.fromFov, fly.toFov, e); camera.updateProjectionMatrix();
        if (t >= 1) { fly = undefined; overlay.hidden = false; overlayImg.style.opacity = String(blend); }
        else requestAnimationFrame(() => invalidate());
      }
      return true;
    },
    beforeModeChange(next: string) { if (current !== undefined) close(); if (next !== 'walk') { collapse(); near.hidden = true; } },
    afterModeChange() { updateMarkers(); lastNearest = -1; },
    resize() {
      if (current !== undefined && !fly) { camera.fov = fit(photos[current]); camera.updateProjectionMatrix(); }
      if (expanded && lastNearest >= 0) { const f = fit(photos[lastNearest]); if (snapped) { camera.fov = f; camera.updateProjectionMatrix(); } }
    },
  };
}
