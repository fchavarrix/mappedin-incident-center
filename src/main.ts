import {
  getMapData,
  show3dMap,
  type Coordinate,
  type Directions,
  type Floor,
  type MapData,
  type MapView,
  type Marker,
  type Path,
  type Shape,
} from '@mappedin/mappedin-js';
import '@mappedin/mappedin-js/lib/index.css';
import './style.css';
import { detectLang, dict, saveLang, type Lang } from './i18n';
import { angleDiff, bearing, circle, cone, metres } from './geo';
import { buildCameras, buildScenario, ROUND_MINUTES, type Camera, type Exit, type Guard, type Incident, type IncidentKind, type Scenario } from './scenario';

// Mappedin's public demo venue and key (developer docs). They only work with demo maps; a real venue
// swaps them through env vars, nothing else in the app is venue-specific.
const MAP_OPTIONS = {
  key: import.meta.env.VITE_MAPPEDIN_KEY ?? '5eab30aa91b055001a68e996',
  secret: import.meta.env.VITE_MAPPEDIN_SECRET ?? 'RJyRXKcryCMy4erZqqCbuB1NbR66QTGNXVE0x3Pg6oCIlUR1',
  mapId: import.meta.env.VITE_MAPPEDIN_MAP_ID ?? 'mappedin-demo-mall',
};

const COLORS = { incident: '#ff5a3c', guard: '#1a73e8', evac: '#12a150', evacAcc: '#7b3fe4', cone: '#4c6fff', coneOn: '#ff5a3c' };
/** Guards walk briskly to an incident; a floor change (stairs, escalator or lift) adds a fixed delay. */
const WALK_MS = 1.5;
const FLOOR_CHANGE_S = 25;
const SPEEDUP = 8;
/** What counts as "nearby" around a pin. */
const NEAR_CAMS = 40;
const NEAR_ROUNDS = 70;
const NEAR_STORES = 45;

const lang: Lang = detectLang();
const t = dict[lang];
document.documentElement.lang = lang;
const params = new URLSearchParams(location.search);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

let mapData: MapData;
let mapView: MapView;
let sc: Scenario;

// ---------- simulated clock: real time, except while a guard walks (×8 so the demo does not wait) ----------
let sim = Date.now();
let lastFrame = performance.now();
const fmtClock = (ms: number) => new Date(ms).toLocaleTimeString(lang === 'es' ? 'es-PE' : 'en-GB', { hour12: false });
const fmtDur = (s: number) => {
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60);
  return m ? `${m} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`;
};

// ---------- incident state ----------
type Who = 'system' | 'operator' | string;
type Entry = { at: number; who: Who; text: () => string };
type State = {
  status: 'new' | 'active' | 'closed';
  detectedAt: number;
  log: Entry[];
  opened: boolean;
  guard?: string;
  dispatchAt?: number;
  arriveAt?: number;
  evac: boolean;
  accessible: boolean;
  etas?: { guard: Guard; seconds: number; directions: Directions }[];
};
const states = new Map<IncidentKind, State>();
let selected: Incident | undefined;

// ---------- guards on the map ----------
type GuardLive = { guard: Guard; at: Coordinate; floorId: string; status: 'idle' | 'enroute' | 'onscene'; incident?: IncidentKind; marker?: Marker };
const live = new Map<string, GuardLive>();
type Walk = { g: GuardLive; startSim: number; points: { s: number; c: Coordinate }[]; onArrive: () => void };
const walks: Walk[] = [];

// ---------- layers for the selected incident ----------
const incidentMarkers = new Map<IncidentKind, Marker>();
let layerMarkers: Marker[] = [];
let layerShapes: Shape[] = [];
let evacPaths: Path[] = [];
let evacMarkers: Marker[] = [];
let evacInfo: { summary: string; blocked: Exit[]; usesLift: boolean; exits: Coordinate[] } | undefined;

const floorName = (f: Floor | string | undefined) => {
  const floor = typeof f === 'string' ? sc.floors.find((x) => x.id === f) : f;
  return floor ? (t.floors[floor.elevation] ?? floor.name) : '';
};

function addLog(kind: IncidentKind, who: Who, text: () => string, at = sim) {
  const st = states.get(kind)!;
  st.log.push({ at, who, text });
  st.log.sort((a, b) => a.at - b.at);
}

// ---------- map helpers ----------
function marker(c: Coordinate, html: string, rank: 'always-visible' | 'high' | 'medium' = 'high', interactive = false) {
  return mapView.Markers.add(c, html, { rank, interactive });
}

function clearLayers() {
  for (const m of layerMarkers) mapView.Markers.remove(m);
  for (const s of layerShapes) mapView.Shapes.remove(s);
  layerMarkers = [];
  layerShapes = [];
  clearEvac();
  mapView.Navigation.clear();
}

function clearEvac() {
  for (const p of evacPaths) mapView.Paths.remove(p);
  for (const m of evacMarkers) mapView.Markers.remove(m);
  evacPaths = [];
  evacMarkers = [];
  evacInfo = undefined;
}

function shape(feature: ReturnType<typeof cone>, color: string, opacity: number, floor: Floor) {
  const s = mapView.Shapes.add({ type: 'FeatureCollection', features: [feature] }, { color, opacity, height: 0.12, altitude: 0.4 }, floor);
  layerShapes.push(s);
  return s;
}

function incidentHtml(inc: Incident) {
  const st = states.get(inc.id)!;
  return `<div class="inc-pin sev-${inc.severity} st-${st.status}${selected?.id === inc.id ? ' sel' : ''}" data-inc="${inc.id}">
    <span class="pulse"></span><span class="ico">${t.kinds[inc.id].icon}</span></div>`;
}

function paintIncidents() {
  for (const inc of sc.incidents) {
    const m = incidentMarkers.get(inc.id);
    if (m) mapView.Markers.remove(m);
    incidentMarkers.set(inc.id, marker(inc.at, incidentHtml(inc), 'always-visible', true));
  }
}

function guardHtml(g: GuardLive) {
  return `<div class="guard g-${g.status}" title="${esc(g.guard.name)}"><span>${esc(g.guard.initials)}</span></div>`;
}

function paintGuard(g: GuardLive) {
  if (g.marker) mapView.Markers.remove(g.marker);
  g.marker = marker(g.at, guardHtml(g), 'always-visible');
}

// ---------- cameras, rounds ----------
type CamView = { cam: Camera; dist: number; inView: boolean; ptz: boolean };

function camerasNear(inc: Incident): CamView[] {
  const near = sc.cameras
    .filter((c) => c.floor.id === inc.floor.id && metres(c.at, inc.at) < NEAR_CAMS)
    .map((cam) => {
      const dist = metres(cam.at, inc.at);
      const toward = bearing(cam.at, inc.at);
      return { cam, dist, inView: dist <= cam.range && angleDiff(cam.bearing, toward) <= cam.fov / 2, ptz: false };
    })
    .sort((a, b) => a.dist - b.dist);
  // The closest camera is a PTZ dome: the operator turns it to the incident (a preset per area in real life).
  if (near[0] && !near[0].inView && near[0].dist <= 30) {
    near[0].ptz = true;
    near[0].inView = true;
  }
  return near.slice(0, 5);
}

const roundsNear = (inc: Incident) =>
  sc.checkpoints
    .filter((c) => c.floor.id === inc.floor.id && metres(c.at, inc.at) < NEAR_ROUNDS)
    .sort((a, b) => metres(a.at, inc.at) - metres(b.at, inc.at))
    .slice(0, 4);

function showSurroundings(inc: Incident) {
  // Affected area (cordon), cameras with their field of view, nearby checkpoints.
  shape(circle(inc.at, inc.hazard), COLORS.incident, 0.18, inc.floor);
  for (const v of camerasNear(inc)) {
    const look = v.ptz ? bearing(v.cam.at, inc.at) : v.cam.bearing;
    shape(cone(v.cam.at, look, v.cam.fov, v.cam.range), v.inView ? COLORS.coneOn : COLORS.cone, v.inView ? 0.3 : 0.16, inc.floor);
    layerMarkers.push(
      marker(v.cam.at, `<div class="cam${v.inView ? ' on' : ''}"><svg viewBox="0 0 24 24" width="12" height="12"><path d="M3 7h12v10H3zM15 10l6-3v10l-6-3z" fill="currentColor"/></svg><b>${v.cam.id}</b></div>`, 'high'),
    );
  }
  for (const cp of roundsNear(inc)) {
    const late = cp.lastScan > ROUND_MINUTES;
    layerMarkers.push(marker(cp.at, `<div class="cp${late ? ' late' : ''}"><b>${cp.id}</b><span>${cp.lastScan} min</span></div>`, 'high'));
  }
}

// ---------- dispatch ----------
async function computeEtas(inc: Incident) {
  const st = states.get(inc.id)!;
  const out: NonNullable<State['etas']> = [];
  for (const g of live.values()) {
    if (g.status !== 'idle') continue;
    try {
      const d = await mapData.getDirections(g.at, inc.at);
      if (!d) continue;
      out.push({ guard: g.guard, seconds: timeline(d.coordinates).at(-1)!.s, directions: d });
    } catch (e) {
      console.warn('No route for', g.guard.name, e);
    }
  }
  st.etas = out.sort((a, b) => a.seconds - b.seconds);
}

/** Seconds from the start of the route to each point: walking speed plus a fixed delay per floor change. */
function timeline(coords: Coordinate[]) {
  const pts: { s: number; c: Coordinate }[] = [];
  let s = 0;
  coords.forEach((c, i) => {
    if (i) {
      const prev = coords[i - 1];
      s += prev.floorId !== c.floorId ? FLOOR_CHANGE_S : metres(prev, c) / WALK_MS;
    }
    pts.push({ s, c });
  });
  return pts;
}

function drawGuardRoute(d: Directions, inc?: Incident) {
  const drawn = mapView.Navigation.draw(d, {
    pathOptions: { color: COLORS.guard, width: 1, displayArrowsOnPath: true, animateArrowsOnPath: true },
    markerOptions: { departureColor: COLORS.guard, destinationColor: COLORS.incident },
    setMapToDeparture: false,
  });
  // Navigation frames its own route; the console keeps the incident and its surroundings in view instead.
  if (inc) void drawn.then(() => selected?.id === inc.id && frame(inc, [...d.coordinates.filter((c) => c.floorId === inc.floor.id), ...(evacInfo?.exits ?? [])]));
}

function dispatch(inc: Incident, guardId: string) {
  const st = states.get(inc.id)!;
  const eta = st.etas?.find((e) => e.guard.id === guardId);
  const g = live.get(guardId);
  if (!eta || !g || g.status !== 'idle') return;
  st.status = 'active';
  st.guard = guardId;
  st.dispatchAt = sim;
  g.status = 'enroute';
  g.incident = inc.id;
  const name = g.guard.name;
  const etaText = fmtDur(eta.seconds);
  addLog(inc.id, 'operator', () => t.logDispatch(name, etaText));
  addLog(inc.id, name, () => t.logAck, sim + 6000);
  drawGuardRoute(eta.directions, inc);
  walks.push({
    g,
    startSim: sim,
    points: timeline(eta.directions.coordinates),
    onArrive: () => {
      g.status = 'onscene';
      st.arriveAt = sim;
      addLog(inc.id, name, () => t.logArrived);
      if (selected?.id === inc.id) mapView.Navigation.clear();
      paintGuard(g);
      render();
    },
  });
  // Other incidents can no longer count on this guard.
  for (const [k, s] of states) if (k !== inc.id && !s.guard) s.etas = s.etas?.filter((e) => e.guard.id !== guardId);
  paintGuard(g);
  paintIncidents();
  render();
}

function stepWalks() {
  for (const w of [...walks]) {
    const elapsed = (sim - w.startSim) / 1000;
    const pts = w.points;
    const last = pts[pts.length - 1];
    let pos: Coordinate;
    if (elapsed >= last.s) pos = last.c;
    else {
      const i = Math.max(1, pts.findIndex((p) => p.s > elapsed));
      const a = pts[i - 1], b = pts[i];
      const k = b.s === a.s ? 1 : (elapsed - a.s) / (b.s - a.s);
      const floor = sc.floors.find((f) => f.id === a.c.floorId);
      pos = a.c.floorId !== b.c.floorId ? a.c : mapView.createCoordinate(a.c.latitude + (b.c.latitude - a.c.latitude) * k, a.c.longitude + (b.c.longitude - a.c.longitude) * k, floor);
    }
    const floorChanged = (pos.floorId ?? w.g.floorId) !== w.g.floorId;
    w.g.at = pos;
    w.g.floorId = pos.floorId ?? w.g.floorId;
    if (!w.g.marker || floorChanged) paintGuard(w.g);
    else mapView.Markers.setPosition(w.g.marker, pos);
    if (elapsed >= last.s) {
      walks.splice(walks.indexOf(w), 1);
      w.onArrive();
    }
  }
}

// ---------- evacuation ----------
async function drawEvac(inc: Incident) {
  clearEvac();
  const st = states.get(inc.id)!;
  const zone = { geometry: circle(inc.at, inc.hazard), cost: Infinity, costAccumulation: 'per-zone-entry' as const, floor: inc.floor };
  const blocked = sc.exits.filter((e) => e.floor.id === inc.floor.id && metres(e.space.center, inc.at) <= inc.hazard + 3);
  const open = sc.exits.filter((e) => !blocked.includes(e));
  // People to move: the stores around the incident (inside the affected area too: they leave it first).
  const seen = new Set<string>();
  const origins = sc.stores
    .filter((s) => s.floor.id === inc.floor.id && metres(s.space.center, inc.at) < NEAR_STORES)
    .sort((a, b) => metres(a.space.center, inc.at) - metres(b.space.center, inc.at))
    .filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)))
    .slice(0, 8);
  // Standard evacuation: no lifts. Accessible: the SDK's step-free routing (lifts and ramps).
  const options = st.accessible ? { accessible: true, zones: [zone] } : { zones: [zone], excludedConnections: sc.elevators };
  const byExit = new Map<Exit, number>();
  let usesLift = false;
  const color = st.accessible ? COLORS.evacAcc : COLORS.evac;
  for (const o of origins) {
    let best: { d: Directions; exit: Exit } | undefined;
    for (const exit of open) {
      try {
        const d = await mapData.getDirections(o.space, exit.space, options);
        if (d && (!best || d.distance < best.d.distance)) best = { d, exit };
      } catch {
        // No route under these constraints: that exit is not an option for this store.
      }
    }
    if (!best) continue;
    byExit.set(best.exit, (byExit.get(best.exit) ?? 0) + 1);
    if (st.accessible && best.d.coordinates.some((c, i, all) => i > 0 && c.floorId !== all[i - 1].floorId)) usesLift = true;
    evacPaths.push(mapView.Paths.add(best.d.coordinates, { color, width: 0.7, displayArrowsOnPath: true, animateArrowsOnPath: true }));
  }
  for (const [exit, n] of byExit) {
    evacMarkers.push(marker(exit.space.center, `<div class="exit ok${st.accessible ? ' acc' : ''}"><b>${esc(t.exit(exit.n))}</b><span>${esc(t.exitCount(n))}</span></div>`, 'always-visible'));
  }
  for (const exit of blocked) {
    evacMarkers.push(marker(exit.space.center, `<div class="exit blocked"><b>${esc(t.exit(exit.n))}</b><span>✕ ${esc(t.blocked)}</span></div>`, 'always-visible'));
  }
  const exitsText = [...byExit.keys()].sort((a, b) => a.n - b.n).map((e) => t.exit(e.n) + (e.floor.id !== inc.floor.id ? ` (${floorName(e.floor)})` : '')).join(', ');
  const total = [...byExit.values()].reduce((a, b) => a + b, 0);
  evacInfo = { summary: t.evacSummary(total, exitsText), blocked, usesLift, exits: [...byExit.keys(), ...blocked].map((e) => e.space.center) };
}

// ---------- panel ----------
function render() {
  const body = $('panel-body');
  const scroll = body.scrollTop;
  body.innerHTML = selected ? renderDetail(selected) : renderList();
  body.scrollTop = scroll;
}

function renderList() {
  const items = sc.incidents
    .map((inc) => {
      const st = states.get(inc.id)!;
      const k = t.kinds[inc.id];
      const ago = Math.round((sim - st.detectedAt) / 1000);
      return `<li><button type="button" class="inc-card st-${st.status}" data-open="${inc.id}">
        <span class="inc-ico sev-${inc.severity}">${k.icon}</span>
        <span class="inc-main"><b>${esc(k.title)}</b><small>${esc(k.place)} · ${esc(floorName(inc.floor))}</small>
        <small class="muted">${esc(k.source)}</small></span>
        <span class="inc-side"><span class="badge st-${st.status}">${esc(t.status[st.status])}</span><small>${esc(t.ago(ago))}</small></span>
      </button></li>`;
    })
    .join('');
  return `<div class="head"><h1>${esc(t.title)}</h1><span class="sim">${esc(t.simBadge)}</span></div>
    <p class="tagline">${esc(t.tagline)}</p>
    <p class="lead">${esc(t.listLead)}</p>
    <ul class="incidents">${items}</ul>`;
}

function renderDetail(inc: Incident) {
  const st = states.get(inc.id)!;
  const k = t.kinds[inc.id];
  const cams = camerasNear(inc);
  const rounds = roundsNear(inc);
  const closed = st.status === 'closed';

  const camList = cams.length
    ? cams
        .map(
          (v) => `<li class="${v.inView ? 'on' : ''}"><span class="tag cam-tag">${v.cam.id}</span>
          <span>${Math.round(v.dist)} m${v.inView ? ` · <b>${esc(v.ptz ? t.camPtz : t.camInView)}</b>` : ''}</span></li>`,
        )
        .join('')
    : `<li class="muted">${esc(t.camNone)}</li>`;
  const roundList = rounds.length
    ? rounds
        .map((cp) => {
          const late = cp.lastScan > ROUND_MINUTES;
          return `<li class="${late ? 'late' : ''}"><span class="tag">${cp.id}</span><span><b>${esc(t.checkpoint(cp.name))}</b><small>${esc(t.roundScan(cp.lastScan, cp.by))}${late ? ` · <em>${esc(t.roundLate)}</em>` : ''}</small></span></li>`;
        })
        .join('')
    : `<li class="muted">${esc(t.roundNone)}</li>`;

  const guardRows = [...live.values()]
    .map((g) => {
      const eta = st.etas?.find((e) => e.guard.id === g.guard.id);
      const mine = st.guard === g.guard.id;
      let right = '';
      if (mine) right = `<span class="badge ${g.status === 'onscene' ? 'ok' : 'go'}">${esc(g.status === 'onscene' ? t.onScene : t.dispatched)}</span>`;
      else if (g.status !== 'idle') right = `<span class="badge muted">${esc(t.busy)}</span>`;
      else if (eta && !st.guard && !closed) right = `<button type="button" class="small" data-dispatch="${g.guard.id}">${esc(t.dispatch)}</button>`;
      const where = g.status === 'idle' ? `${t.post[g.guard.post] ?? ''} · ${t.staffFloor(floorName(g.floorId))}` : t.staffFloor(floorName(g.floorId));
      return `<li class="${mine ? 'mine' : ''}"><span class="guard-dot g-${g.status}">${esc(g.guard.initials)}</span>
        <span><b>${esc(g.guard.name)}</b><small>${esc(where)}${eta && g.status === 'idle' && !st.guard ? ` · ${esc(t.eta(fmtDur(eta.seconds)))}` : ''}</small></span>${right}</li>`;
    })
    .join('');
  const nearest = st.etas?.find((e) => live.get(e.guard.id)?.status === 'idle');
  const dispatchBtn =
    !st.guard && !closed && nearest
      ? `<button type="button" class="primary" data-dispatch="${nearest.guard.id}">${esc(t.dispatchNearest(nearest.guard.name, fmtDur(nearest.seconds)))}</button>`
      : '';

  const evac = closed
    ? ''
    : `<section><h3>${esc(t.evac)}</h3><p class="hint">${esc(t.evacLead)}</p>
      <label class="check"><input type="checkbox" id="evac-acc" ${st.accessible ? 'checked' : ''}/> <span>♿ ${esc(t.evacAccessible)}</span></label>
      <button type="button" class="${st.evac ? 'ghost' : 'warn'}" id="evac-btn">${esc(st.evac ? t.evacOff : t.evacOn)}</button>
      ${
        st.evac && evacInfo
          ? `<p class="evac-sum${st.accessible ? ' acc' : ''}">${esc(evacInfo.summary)}</p>${evacInfo.blocked.map((e) => `<p class="hint bad">${esc(t.evacBlocked(t.exitNear(e.n, e.near)))}</p>`).join('')}${evacInfo.usesLift ? `<p class="hint">${esc(t.evacLift)}</p>` : ''}`
          : ''
      }
    </section>`;

  const who = (w: Who) => (w === 'system' || w === 'operator' ? t.logWho[w] : w);
  const log = st.log
    .filter((e) => e.at <= sim)
    .map((e) => `<li><time>${fmtClock(e.at)}</time><span>${esc(e.text())}<small>${esc(who(e.who))}</small></span></li>`)
    .join('');

  const tiles: [string, string][] = [];
  if (st.dispatchAt) tiles.push([t.tDispatch, fmtDur((st.dispatchAt - st.detectedAt) / 1000)]);
  if (st.dispatchAt && st.arriveAt) tiles.push([t.tTravel, fmtDur((st.arriveAt - st.dispatchAt) / 1000)]);
  if (st.arriveAt) tiles.push([t.tTotal, fmtDur((st.arriveAt - st.detectedAt) / 1000)]);
  const times = tiles.length
    ? `<section><h3>${esc(t.times)}</h3><div class="tiles">${tiles.map(([l, v]) => `<div class="tile"><small>${esc(l)}</small><b>${esc(v)}</b></div>`).join('')}</div><p class="hint">${esc(t.timesNote)}</p></section>`
    : '';

  return `<button type="button" class="back" data-back>${esc(t.back)}</button>
    <div class="detail-head"><span class="inc-ico big sev-${inc.severity}">${k.icon}</span>
      <div><h2>${esc(k.title)}</h2><p class="meta">${esc(k.place)} · ${esc(floorName(inc.floor))} · <span class="badge st-${st.status}">${esc(t.status[st.status])}</span></p>
      <p class="meta muted">${esc(k.source)} · ${esc(t.severity[inc.severity])}</p></div></div>
    ${dispatchBtn}
    ${times}
    <section><h3>${esc(t.staff)}</h3><ul class="rows">${guardRows}</ul></section>
    <section><h3>${esc(t.cameras)}</h3><ul class="rows">${camList}</ul></section>
    <section><h3>${esc(t.rounds)}</h3><ul class="rows">${roundList}</ul></section>
    ${evac}
    <section><h3>${esc(t.log)}</h3><ol class="log">${log}</ol></section>
    ${!closed && st.arriveAt ? `<button type="button" class="primary" id="close-btn">${esc(t.close)}</button>` : ''}
    ${closed ? `<p class="closed">✓ ${esc(t.closed)}</p>` : ''}`;
}

let frameSeq = 0;
/** The whole floor's alarms and guards in view (the list view). */
function overview(duration: number) {
  const fid = mapView.currentFloor.id;
  const pts = [...sc.incidents.filter((i) => i.floor.id === fid).map((i) => i.at), ...[...live.values()].filter((g) => g.floorId === fid).map((g) => g.at)];
  const my = ++frameSeq;
  void mapView.Camera.focusOn(pts.length ? pts : mapView.currentFloor, { screenOffsets: offsets(), maxZoomLevel: 18.5, duration }).then(() => {
    if (my === frameSeq && pts.length) mapView.Camera.set({ zoomLevel: mapView.Camera.zoomLevel - 0.4 });
  });
}
/** Frame the pin and what surrounds it (cameras, checkpoints), clear of the panel. */
function frame(inc: Incident, extra: Coordinate[] = []) {
  const around = [inc.at, ...camerasNear(inc).map((v) => v.cam.at), ...roundsNear(inc).slice(0, 2).map((c) => c.at), ...extra];
  const my = ++frameSeq;
  // The fit is to points; markers have a size and the view is pitched, so step back a little after it.
  // ?shot=1 (screenshots from headless Chrome) skips the animations; ?zoomOut= adjusts the step back.
  const shot = params.has('shot');
  const back = Number(params.get('zoomOut') ?? 0.45);
  void mapView.Camera.focusOn(around, { screenOffsets: offsets(), maxZoomLevel: 19, duration: shot ? 0 : 700 }).then(() => {
    if (my !== frameSeq) return;
    if (shot) mapView.Camera.set({ zoomLevel: mapView.Camera.zoomLevel - back });
    else void mapView.Camera.animateTo({ zoomLevel: mapView.Camera.zoomLevel - back }, { duration: 250 });
  });
}

/**
 * The outdoor basemap has a body of water that overlaps Parking Lot B in the demo venue (the venue is
 * placed on a real site). Same fix as the other demos: hide the water layers.
 */
function hideOutdoorWater() {
  type StyleMap = { getStyle(): { layers: { id: string; 'source-layer'?: string }[] }; setLayoutProperty(id: string, k: string, v: string): void; on(e: string, f: () => void): void };
  const map = (mapView.Outdoor as unknown as { map?: StyleMap }).map;
  if (!map) return;
  const apply = () => {
    try {
      for (const l of map.getStyle().layers) if (l['source-layer'] === 'water' || l['source-layer'] === 'water_name') map.setLayoutProperty(l.id, 'visibility', 'none');
    } catch {
      // Style not loaded yet: 'styledata' runs it again.
    }
  };
  apply();
  map.on('styledata', apply);
}

// ---------- selecting an incident ----------
async function open(inc: Incident) {
  selected = inc;
  clearLayers();
  const st = states.get(inc.id)!;
  if (st.status === 'new') st.status = 'active';
  if (!st.opened) {
    st.opened = true;
    addLog(inc.id, 'operator', () => t.logOpened);
    const cams = camerasNear(inc);
    const inView = cams.filter((c) => c.inView).length;
    addLog(inc.id, 'system', () => t.logCams(cams.length, inView));
    for (const cp of roundsNear(inc).filter((c) => c.lastScan > ROUND_MINUTES)) {
      const name = cp.id;
      const m = cp.lastScan;
      addLog(inc.id, 'system', () => t.logLate(name, m));
    }
  }
  if (mapView.currentFloor.id !== inc.floor.id) mapView.setFloor(inc.floor);
  showSurroundings(inc);
  paintIncidents();
  setSnap('half');
  render();
  frame(inc);
  if (st.status !== 'closed') {
    if (!st.guard) {
      if (!st.etas) await computeEtas(inc);
      if (selected?.id === inc.id) render();
    } else {
      const g = live.get(st.guard);
      const eta = st.etas?.find((e) => e.guard.id === st.guard);
      if (g?.status === 'enroute' && eta) drawGuardRoute(eta.directions, inc);
    }
    if (st.evac && selected?.id === inc.id) {
      await drawEvac(inc);
      render();
    }
  }
}

function backToList() {
  selected = undefined;
  clearLayers();
  paintIncidents();
  render();
  overview(600);
}

async function toggleEvac(inc: Incident, on: boolean) {
  const st = states.get(inc.id)!;
  st.evac = on;
  if (on) {
    await drawEvac(inc);
    const s = evacInfo?.summary ?? '';
    const acc = st.accessible;
    addLog(inc.id, 'operator', () => t.logEvac(s) + (acc ? t.logEvacAcc : ''));
    if (selected?.id === inc.id) frame(inc, evacInfo?.exits);
  } else {
    clearEvac();
    addLog(inc.id, 'operator', () => t.logEvacOff);
  }
  render();
}

function closeIncident(inc: Incident) {
  const st = states.get(inc.id)!;
  st.status = 'closed';
  st.evac = false;
  addLog(inc.id, 'operator', () => t.logClosed);
  const g = st.guard ? live.get(st.guard) : undefined;
  if (g) {
    g.status = 'idle';
    g.incident = undefined;
    paintGuard(g);
  }
  // A guard is free again: the other open incidents recompute who is nearest.
  for (const s of states.values()) if (!s.guard) s.etas = undefined;
  clearLayers();
  showSurroundings(inc);
  paintIncidents();
  render();
}

// ---------- bottom sheet on phones ----------
type Snap = 'peek' | 'half' | 'full';
const narrow = () => innerWidth < 900;
function setSnap(snap: Snap) {
  const p = $('panel');
  if (narrow()) p.dataset.snap = snap;
  else delete p.dataset.snap;
  requestAnimationFrame(updateOffsets);
}
function setupSheet() {
  const p = $('panel');
  const grab = $('grabber');
  let y0 = 0, h0 = 0, moved = false, drag = false;
  grab.addEventListener('pointerdown', (e) => {
    if (!narrow()) return;
    drag = true;
    moved = false;
    y0 = e.clientY;
    h0 = p.getBoundingClientRect().height;
    p.classList.add('dragging');
    grab.setPointerCapture(e.pointerId);
  });
  grab.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = e.clientY - y0;
    if (Math.abs(dy) > 4) moved = true;
    const h = Math.min(innerHeight * 0.88, Math.max(96, h0 - dy));
    p.style.height = p.style.maxHeight = `${h}px`;
  });
  const end = () => {
    if (!drag) return;
    drag = false;
    p.classList.remove('dragging');
    const h = p.getBoundingClientRect().height / innerHeight;
    p.style.height = p.style.maxHeight = '';
    const cur = (p.dataset.snap as Snap) ?? 'half';
    if (!moved) setSnap(cur === 'half' ? 'peek' : 'half');
    else setSnap(h < 0.25 ? 'peek' : h < 0.62 ? 'half' : 'full');
  };
  grab.addEventListener('pointerup', end);
  grab.addEventListener('pointercancel', end);
  addEventListener('resize', () => setSnap((p.dataset.snap as Snap) ?? 'half'));
}
function offsets() {
  const r = $('panel').getBoundingClientRect();
  const wide = !narrow();
  return { top: 76, left: wide ? r.right + 16 : 16, right: 16, bottom: wide ? 16 : Math.max(16, innerHeight - r.top + 16) };
}
function updateOffsets() {
  if (mapView) mapView.Camera.setScreenOffsets(offsets());
}

// ---------- wiring ----------
function bind() {
  document.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!b) return;
    if (b.dataset.open) {
      const inc = sc.incidents.find((i) => i.id === b.dataset.open);
      if (inc) void open(inc);
    } else if (b.dataset.back !== undefined) backToList();
    else if (b.dataset.dispatch && selected) dispatch(selected, b.dataset.dispatch);
    else if (b.id === 'evac-btn' && selected) void toggleEvac(selected, !states.get(selected.id)!.evac);
    else if (b.id === 'close-btn' && selected) closeIncident(selected);
  });
  document.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.id === 'evac-acc' && selected) {
      const st = states.get(selected.id)!;
      st.accessible = el.checked;
      if (st.evac) void toggleEvac(selected, true);
    }
  });
  mapView.on('click', (e) => {
    const m = e.markers?.[0];
    const id = m && [...incidentMarkers.entries()].find(([, x]) => x.id === m.id)?.[0];
    const inc = id ? sc.incidents.find((i) => i.id === id) : undefined;
    if (inc) void open(inc);
  });
  const floorSel = $<HTMLSelectElement>('floor');
  floorSel.addEventListener('change', () => {
    const f = sc.floors.find((x) => x.id === floorSel.value);
    if (f) {
      mapView.setFloor(f);
      void mapView.Camera.focusOn(f, { duration: 500 });
    }
  });
  mapView.on('floor-change', (e) => (floorSel.value = e.floor.id));
  $('lang').addEventListener('click', () => {
    const next: Lang = lang === 'es' ? 'en' : 'es';
    saveLang(next);
    const q = new URLSearchParams(location.search);
    q.set('lang', next);
    if (selected) q.set('incident', selected.id);
    else q.delete('incident');
    location.search = q.toString();
  });
  addEventListener('resize', updateOffsets);
  new ResizeObserver(updateOffsets).observe($('panel'));
  setupSheet();
}

function tick(now: number) {
  const dt = now - lastFrame;
  lastFrame = now;
  const speed = walks.length ? SPEEDUP : 1;
  const before = sim;
  sim += dt * speed;
  $('speed').hidden = !walks.length;
  if (walks.length) stepWalks();
  $('clock').textContent = fmtClock(sim);
  // The log and the "x min ago" move with the clock: re-render once per simulated second.
  if (Math.floor(sim / 1000) !== Math.floor(before / 1000) && !document.querySelector('.panel.dragging') && !(document.activeElement instanceof HTMLInputElement)) render();
  requestAnimationFrame(tick);
}

function staticText() {
  document.title = `${t.title} · Demo`;
  $('t-title').textContent = t.title;
  $('t-subtitle').textContent = t.subtitle;
  $('credit').textContent = t.credit;
  $('speed').textContent = `⏩ ${t.speed}`;
  const lb = $('lang');
  lb.textContent = t.langBtn;
  lb.setAttribute('aria-label', t.langLabel);
  lb.title = t.langLabel;
  $('loading').textContent = t.loading;
}

async function init() {
  staticText();
  // Brand names stay as the venue publishes them (the venue's own translations turned "Banana Republic" into a literal translation).
  mapData = await getMapData({ ...MAP_OPTIONS, fallbackToNavigatorLanguage: false });
  const lower = [...mapData.getByType('floor')].sort((a, b) => a.elevation - b.elevation)[0];
  mapView = await show3dMap($('map'), mapData, { initialFloor: lower });
  hideOutdoorWater();
  sc = buildScenario(mapData, mapView);
  $('loading').textContent = t.loadingCams;
  const t0 = performance.now();
  sc.cameras = await buildCameras(mapData, mapView, sc);
  if (import.meta.env.DEV) console.info(`cameras: ${sc.cameras.length} in ${Math.round(performance.now() - t0)} ms`);

  // Store names, small, so the operator can say "by Sbarro" on the radio.
  for (const s of sc.stores) mapView.Labels.add(s.space, s.name, { rank: 'low', appearance: { textSize: 10 } });
  for (const e of sc.exits) mapView.Labels.add(e.space.center, t.exit(e.n), { rank: 'medium', appearance: { textSize: 11, color: COLORS.evac } });

  const start = sim;
  for (const inc of sc.incidents) {
    const st: State = { status: 'new', detectedAt: start - inc.ago * 1000, log: [], opened: false, evac: false, accessible: false };
    states.set(inc.id, st);
    const src = t.kinds[inc.id].source;
    addLog(inc.id, 'system', () => t.logDetected(src), st.detectedAt);
  }
  for (const g of sc.guards) {
    const gl: GuardLive = { guard: g, at: g.at, floorId: g.floor.id, status: 'idle' };
    live.set(g.id, gl);
    paintGuard(gl);
  }
  paintIncidents();

  const floorSel = $<HTMLSelectElement>('floor');
  floorSel.innerHTML = sc.floors.map((f) => `<option value="${f.id}">${esc(floorName(f))}</option>`).join('');
  floorSel.value = mapView.currentFloor.id;
  if (import.meta.env.DEV) Object.assign(window, { mapData, mapView, sc, states, live });
  $('loading').remove();
  bind();
  setSnap('half');
  render();
  lastFrame = performance.now();
  requestAnimationFrame(tick);

  // Deep links for rehearsals and screenshots: ?incident=smoke&evac=1&accessible=1&dispatch=1
  const want = sc.incidents.find((i) => i.id === params.get('incident'));
  if (want) {
    const st = states.get(want.id)!;
    st.accessible = params.get('accessible') === '1';
    await open(want);
    if (params.get('evac') === '1') await toggleEvac(want, true);
    if (params.get('dispatch') === '1' && st.etas?.[0]) dispatch(want, st.etas[0].guard.id);
  } else {
    overview(0);
  }
}

void init();
