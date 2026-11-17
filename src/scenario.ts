import type { Connection, Coordinate, Floor, MapData, MapView, Space } from '@mappedin/mappedin-js';
import { bearing, metres, offset, seeded } from './geo';

/**
 * Everything in the operation is simulated and labelled as such: incidents, cameras, guard rounds
 * and staff. Only the map, the routing and the venue's spaces are real (Mappedin's demo mall).
 * In production these would come from the VMS (cameras), the guard-tour system (checkpoints),
 * radios or the staff app (guards) and the alarm panels (incidents).
 */

export type IncidentKind = 'fall' | 'door' | 'smoke';

export type Incident = {
  id: IncidentKind;
  at: Coordinate;
  floor: Floor;
  severity: 'high' | 'medium';
  /** Metres around the pin treated as affected: evacuation routes never enter it. */
  hazard: number;
  /** Seconds before the console opened that the alarm came in. */
  ago: number;
};

export type Camera = { id: string; at: Coordinate; floor: Floor; bearing: number; fov: number; range: number };
export type Checkpoint = { id: string; name: string; at: Coordinate; floor: Floor; lastScan: number; by: string };
export type Guard = { id: string; name: string; initials: string; at: Coordinate; floor: Floor; post: string };
export type Exit = { id: string; n: number; space: Space; floor: Floor; near: string };
export type Store = { name: string; space: Space; floor: Floor };

export type Scenario = {
  floors: Floor[];
  stores: Store[];
  exits: Exit[];
  incidents: Incident[];
  checkpoints: Checkpoint[];
  guards: Guard[];
  cameras: Camera[];
  elevators: Connection[];
};

/** Round interval: a checkpoint not scanned in this many minutes is overdue. */
export const ROUND_MINUTES = 45;

const NAME_FIXES: Record<string, string> = { Nordstorm: 'Nordstrom' };

export function buildScenario(mapData: MapData, mapView: MapView): Scenario {
  const floors = [...mapData.getByType('floor')].sort((a, b) => a.elevation - b.elevation);
  const lower = floors[0];
  const upper = floors[floors.length - 1];
  const spaces = mapData.getByType('space');
  const pois = mapData.getByType('point-of-interest');
  const connections = mapData.getByType('connection');

  const stores: Store[] = [];
  for (const loc of mapData.getByType('enterprise-location')) {
    if (loc.type !== 'tenant' || loc.hidden) continue;
    for (const s of loc.spaces) stores.push({ name: NAME_FIXES[loc.name] ?? loc.name, space: s, floor: s.floor });
  }
  const nearestStore = (c: Coordinate, floor: Floor) =>
    stores.filter((s) => s.floor.id === floor.id).sort((a, b) => metres(a.space.center, c) - metres(b.space.center, c))[0];

  // Exits: the venue's entrances, numbered west to east, named by the store next to them.
  const exits: Exit[] = spaces
    .filter((s) => s.name === 'Entrance')
    .sort((a, b) => a.floor.elevation - b.floor.elevation || a.center.longitude - b.center.longitude)
    .map((space, i) => ({ id: `exit-${i + 1}`, n: i + 1, space, floor: space.floor, near: nearestStore(space.center, space.floor)?.name ?? '' }));

  // Incidents: three alarms in places every mall has.
  const foodCourt = pois.find((p) => p.name === 'Food Court');
  const garage = pois.find((p) => p.name === 'Parking Garage I' && p.floor.id === lower.id);
  const upperDoor = exits.find((e) => e.floor.id === upper.id) ?? exits[exits.length - 1];
  const incidents: Incident[] = [];
  if (foodCourt) incidents.push({ id: 'fall', at: foodCourt.coordinate, floor: foodCourt.floor, severity: 'medium', hazard: 10, ago: 35 });
  if (upperDoor) {
    // The alarm is on the door leaf, a few metres inside the entrance (so the pin does not sit on the exit sign).
    const inner = stores.filter((s) => s.floor.id === upperDoor.floor.id).sort((a, b) => metres(a.space.center, upperDoor.space.center) - metres(b.space.center, upperDoor.space.center))[0];
    const [lon, lat] = inner ? offset(upperDoor.space.center, bearing(upperDoor.space.center, inner.space.center), 6) : [upperDoor.space.center.longitude, upperDoor.space.center.latitude];
    incidents.push({ id: 'door', at: mapView.createCoordinate(lat, lon, upperDoor.floor), floor: upperDoor.floor, severity: 'medium', hazard: 12, ago: 70 });
  }
  if (garage) incidents.push({ id: 'smoke', at: garage.coordinate, floor: garage.floor, severity: 'high', hazard: 22, ago: 12 });

  // Guard-tour checkpoints: entrances, lifts, restrooms, information, parking, food court.
  const rand = seeded(20261201);
  const guardNames = ['R. Quispe', 'L. Mamani', 'C. Rojas', 'J. Huamán'];
  const cps: { name: string; at: Coordinate; floor: Floor }[] = [];
  for (const e of exits) cps.push({ name: `exit:${e.n}`, at: e.space.center, floor: e.floor });
  for (const c of connections) {
    if (c.type !== 'elevator') continue;
    for (const k of c.coordinates) {
      const f = floors.find((x) => x.id === k.floorId);
      if (f) cps.push({ name: `elevator:${c.name.replace(/\D/g, '')}`, at: k, floor: f });
    }
  }
  for (const s of spaces) {
    if (/restroom/i.test(s.name)) cps.push({ name: 'restroom', at: s.center, floor: s.floor });
    else if (/information desk|guest services/i.test(s.name)) cps.push({ name: 'info', at: s.center, floor: s.floor });
    else if (/^parking lot/i.test(s.name)) cps.push({ name: `lot:${s.name.slice(-1)}`, at: s.center, floor: s.floor });
  }
  if (foodCourt) cps.push({ name: 'foodcourt', at: foodCourt.coordinate, floor: foodCourt.floor });
  if (garage) cps.push({ name: 'garage', at: garage.coordinate, floor: garage.floor });
  const checkpoints: Checkpoint[] = [];
  for (const c of cps) {
    if (checkpoints.some((x) => x.floor.id === c.floor.id && metres(x.at, c.at) < 8)) continue;
    checkpoints.push({
      id: `R-${String(checkpoints.length + 1).padStart(2, '0')}`,
      name: c.name,
      at: c.at,
      floor: c.floor,
      // Minutes since the last scan: most on time, a few overdue (that is what the console has to show).
      lastScan: Math.round(3 + rand() * 62),
      by: guardNames[Math.floor(rand() * guardNames.length)],
    });
  }

  // Guards on duty: one per zone, at a post a real security team would hold.
  const info = spaces.find((s) => s.name === 'Information Desk' && s.floor.id === lower.id);
  const west = spaces.find((s) => s.name === 'Guest Services - West Wing');
  const lotA = spaces.find((s) => s.name === 'Parking Lot A');
  const upperLift = connections.find((c) => c.type === 'elevator')?.coordinates.find((k) => k.floorId === upper.id);
  const guards: Guard[] = [];
  const add = (name: string, post: string, at: Coordinate | undefined, floor: Floor) => {
    if (!at) return;
    guards.push({ id: `g${guards.length + 1}`, name, initials: name.replace(/[^A-ZÁÉÍÓÚ]/g, '').slice(0, 2), at, floor, post });
  };
  add(guardNames[0], 'info', info?.center, lower);
  add(guardNames[1], 'upper', upperLift, upper);
  add(guardNames[2], 'west', west?.center, lower);
  add(guardNames[3], 'lotA', lotA?.center, lower);

  return {
    floors,
    stores,
    exits,
    incidents,
    checkpoints,
    guards,
    cameras: [],
    elevators: connections.filter((c) => c.type === 'elevator'),
  };

}

/**
 * Simulated CCTV: cameras every ~26 m along the corridors around each alarm point, each looking down
 * the corridor. The corridors come from the venue's own routing graph (routes between the alarm point,
 * entrances and lifts), so the cameras sit where people walk, not inside stores.
 */
export async function buildCameras(mapData: MapData, mapView: MapView, sc: Scenario): Promise<Camera[]> {
  const cams: Camera[] = [];
  // Only around the alarm points: that is where the console shows them, and it keeps loading fast.
  for (const inc of sc.incidents) {
    const floor = inc.floor;
    const nearby = (c: Coordinate) => metres(c, inc.at) < 90;
    const keys: Coordinate[] = [
      inc.at,
      ...sc.exits.filter((e) => e.floor.id === floor.id && nearby(e.space.center)).map((e) => e.space.center),
      ...mapData
        .getByType('connection')
        .flatMap((c) => c.coordinates.filter((k) => k.floorId === floor.id && nearby(k)))
        .filter((k, i, all) => all.findIndex((o) => metres(o, k) < 10) === i),
    ];
    const floorStores = sc.stores.filter((s) => s.floor.id === floor.id);
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        let d;
        try {
          d = await mapData.getDirections(keys[i], keys[j]);
        } catch {
          continue;
        }
        if (!d) continue;
        let walked = 0;
        for (let k = 1; k < d.coordinates.length; k++) {
          const a = d.coordinates[k - 1], b = d.coordinates[k];
          if (a.floorId !== floor.id || b.floorId !== floor.id) continue;
          const seg = metres(a, b);
          walked += seg;
          if (walked < 26 || seg < 0.5) continue;
          walked = 0;
          if (cams.some((c) => c.floor.id === floor.id && metres(c.at, b) < 20)) continue;
          // Not on top of the alarm point itself: a camera looks at a place from a few metres away.
          if (sc.incidents.some((x) => x.floor.id === floor.id && metres(x.at, b) < 9)) continue;
          // Indoors only: a corridor point has a storefront within ~25 m (or covers an alarm point, like the car park).
          if (!floorStores.some((s) => metres(s.space.center, b) < 25) && metres(inc.at, b) >= 45) continue;
          const look = bearing(a, b) + (cams.length % 2 ? 180 : 0);
          cams.push({ id: '', at: mapView.createCoordinate(b.latitude, b.longitude, floor), floor, bearing: look % 360, fov: 70, range: 18 });
        }
      }
    }
  }
  // Every alarm point gets at least one fixed camera on its zone, a few metres off and looking at it
  // (in a real site this is the CCTV design; a spot with no camera is a finding, not a demo bug).
  for (const inc of sc.incidents) {
    if (cams.some((c) => c.floor.id === inc.floor.id && metres(c.at, inc.at) < 25)) continue;
    const from = sc.exits
      .filter((e) => e.floor.id === inc.floor.id)
      .sort((a, b) => metres(a.space.center, inc.at) - metres(b.space.center, inc.at))[0];
    if (!from) continue;
    let d;
    try {
      d = await mapData.getDirections(from.space, inc.at);
    } catch {
      continue;
    }
    // The point ~15 m before the alarm along the walking route (interpolated: routes have few vertices).
    const pts = (d?.coordinates ?? []).filter((c) => c.floorId === inc.floor.id).reverse();
    let spot: { latitude: number; longitude: number } | undefined;
    for (let k = 1; k < pts.length && !spot; k++) {
      const a = pts[k - 1], b = pts[k];
      const da = metres(a, inc.at), db = metres(b, inc.at);
      if (db < 15) continue;
      const f = da >= 15 ? 0 : (15 - da) / Math.max(0.01, db - da);
      spot = { latitude: a.latitude + (b.latitude - a.latitude) * f, longitude: a.longitude + (b.longitude - a.longitude) * f };
    }
    if (!spot) continue;
    cams.push({ id: '', at: mapView.createCoordinate(spot.latitude, spot.longitude, inc.floor), floor: inc.floor, bearing: (bearing(spot, inc.at) + 12) % 360, fov: 70, range: 22 });
  }
  cams.forEach((c, i) => (c.id = `CAM-${String(i + 1).padStart(2, '0')}`));
  return cams;
}
