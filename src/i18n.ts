export type Lang = 'es' | 'en';

const KEY = 'incident-center.lang';

/** `?lang=` first, then what the visitor chose before, then Spanish (the browser pane is in English, so no auto-detect). */
export function detectLang(): Lang {
  const q = new URLSearchParams(location.search).get('lang');
  if (q === 'en' || q === 'es') {
    try {
      localStorage.setItem(KEY, q);
    } catch {}
    return q;
  }
  try {
    const s = localStorage.getItem(KEY);
    if (s === 'en' || s === 'es') return s;
  } catch {}
  return 'es';
}

export function saveLang(l: Lang) {
  try {
    localStorage.setItem(KEY, l);
  } catch {}
}

const es = {
  title: 'Centro de incidentes',
  subtitle: 'Consola de seguridad · demo',
  simBadge: 'Datos simulados',
  loading: 'Cargando el mapa del mall…',
  loadingCams: 'Ubicando cámaras simuladas en los pasillos…',
  floors: { 0: 'Nivel 1', 1: 'Nivel 2' } as Record<number, string>,
  tagline: 'Cada incidente es un lugar, no una llamada.',
  listLead: 'Tres alarmas simuladas acaban de entrar. Toca una para verla en el mapa.',
  kinds: {
    fall: { title: 'Caída de una persona', place: 'Patio de comidas', source: 'Aviso por radio · personal de limpieza', icon: '🚑' },
    door: { title: 'Puerta forzada', place: 'Acceso del nivel 2', source: 'Sensor de puerta · control de acceso', icon: '🚪' },
    smoke: { title: 'Humo en el estacionamiento', place: 'Estacionamiento techado', source: 'Detector de humo HD-P1-04', icon: '🔥' },
  },
  severity: { high: 'Alta', medium: 'Media' },
  status: { new: 'Nuevo', active: 'En curso', closed: 'Cerrado' },
  ago: (s: number) => (s < 60 ? `hace ${s} s` : `hace ${Math.floor(s / 60)} min`),
  back: '← Incidentes',
  cameras: 'Cámaras cercanas',
  camInView: 've el lugar',
  camPtz: 'domo PTZ girado al incidente',
  camNone: 'Ninguna cámara cubre este punto: es un hallazgo para el plan de CCTV.',
  camOpen: 'Ver',
  camFeed: 'Vista simulada de',
  rounds: 'Puntos de ronda cercanos',
  roundScan: (m: number, by: string) => `último escaneo hace ${m} min · ${by}`,
  roundLate: 'ronda vencida',
  roundNone: 'No hay puntos de ronda cerca.',
  staff: 'Personal de seguridad',
  staffFloor: (f: string) => `en ${f}`,
  eta: (s: string) => `llega en ${s}`,
  dispatch: 'Despachar',
  dispatchNearest: (n: string, eta: string) => `Despachar a ${n} · ${eta}`,
  dispatched: 'En camino',
  onScene: 'En el lugar',
  busy: 'Ocupado',
  evac: 'Evacuación',
  evacLead: 'Rutas desde los locales cercanos a las salidas más cercanas, sin pasar por la zona afectada.',
  evacOn: 'Trazar rutas de evacuación',
  evacOff: 'Quitar rutas',
  evacAccessible: 'Ruta accesible (ascensor o rampa, sin escaleras)',
  evacSummary: (n: number, exits: string) => `${n} locales hacia ${exits}`,
  evacBlocked: (e: string) => `${e} queda dentro de la zona afectada: bloqueada.`,
  evacLift: 'La ruta accesible usa el ascensor: en una evacuación real, solo con personal y si el plan del edificio lo permite.',
  exit: (n: number) => `Salida ${n}`,
  exitNear: (n: number, near: string) => `Salida ${n} · junto a ${near}`,
  exitCount: (n: number) => `${n} local${n === 1 ? '' : 'es'}`,
  blocked: 'bloqueada',
  log: 'Bitácora',
  logWho: { system: 'Sistema', operator: 'Operador (tú)' },
  logDetected: (src: string) => `Alarma recibida: ${src}`,
  logOpened: 'Incidente abierto en la consola, ubicado en el mapa',
  logCams: (n: number, inView: number) => `${n} cámara${n === 1 ? '' : 's'} cercana${n === 1 ? '' : 's'}, ${inView} con vista del lugar`,
  logLate: (cp: string, m: number) => `Ronda vencida en ${cp} (${m} min sin escaneo)`,
  logDispatch: (n: string, eta: string) => `Despachado ${n} · tiempo estimado ${eta}`,
  logAck: 'Confirma por radio, en camino',
  logArrived: 'Llegó al lugar',
  logEvac: (s: string) => `Evacuación parcial: ${s}`,
  logEvacAcc: ' (ruta accesible)',
  logEvacOff: 'Rutas de evacuación retiradas',
  logClosed: 'Incidente cerrado',
  times: 'Tiempos de respuesta',
  tDispatch: 'Alarma → despacho',
  tTravel: 'Despacho → en el lugar',
  tTotal: 'Alarma → en el lugar',
  timesNote: 'Medidos sobre el reloj simulado. Para hablar de «menos tiempo de respuesta», compáralos con tu línea base de hoy (radio y cuaderno).',
  close: 'Cerrar incidente',
  closed: 'Incidente cerrado',
  speed: 'Recorrido simulado ×8',
  credit:
    'Demo de Atlas Kinetix LAC sobre el mapa demo y el SDK de Mappedin. Incidentes, cámaras, rondas y personal son simulados. Las marcas del mapa son ilustrativas: sus dueños no participan ni respaldan esta demo.',
  checkpoint: (name: string) => {
    const [k, v] = name.split(':');
    return (
      ({ exit: `Salida ${v}`, elevator: `Ascensor ${v}`, restroom: 'Servicios higiénicos', info: 'Módulo de información', lot: `Estacionamiento ${v}`, foodcourt: 'Patio de comidas', garage: 'Estacionamiento techado' } as Record<string, string>)[k] ?? name
    );
  },
  post: { info: 'Módulo de información', upper: 'Ascensor, nivel 2', west: 'Atención al cliente, ala oeste', lotA: 'Estacionamiento A' } as Record<string, string>,
  langBtn: 'EN',
  langLabel: 'Switch to English',
};

type Dict = typeof es;

const en: Dict = {
  title: 'Incident center',
  subtitle: 'Security console · demo',
  simBadge: 'Simulated data',
  loading: 'Loading the mall map…',
  loadingCams: 'Placing simulated cameras along the corridors…',
  floors: { 0: 'Level 1', 1: 'Level 2' },
  tagline: 'Every incident is a place, not a call.',
  listLead: 'Three simulated alarms just came in. Tap one to see it on the map.',
  kinds: {
    fall: { title: 'Person down', place: 'Food court', source: 'Radio call · cleaning staff', icon: '🚑' },
    door: { title: 'Forced door', place: 'Level 2 entrance', source: 'Door sensor · access control', icon: '🚪' },
    smoke: { title: 'Smoke in the car park', place: 'Covered car park', source: 'Smoke detector HD-P1-04', icon: '🔥' },
  },
  severity: { high: 'High', medium: 'Medium' },
  status: { new: 'New', active: 'In progress', closed: 'Closed' },
  ago: (s) => (s < 60 ? `${s} s ago` : `${Math.floor(s / 60)} min ago`),
  back: '← Incidents',
  cameras: 'Nearby cameras',
  camInView: 'sees the spot',
  camPtz: 'PTZ dome turned to the incident',
  camNone: 'No camera covers this spot: a finding for the CCTV plan.',
  camOpen: 'View',
  camFeed: 'Simulated view from',
  rounds: 'Nearby guard-tour checkpoints',
  roundScan: (m, by) => `last scan ${m} min ago · ${by}`,
  roundLate: 'round overdue',
  roundNone: 'No checkpoints nearby.',
  staff: 'Security staff',
  staffFloor: (f) => `on ${f}`,
  eta: (s) => `arrives in ${s}`,
  dispatch: 'Dispatch',
  dispatchNearest: (n, eta) => `Dispatch ${n} · ${eta}`,
  dispatched: 'On the way',
  onScene: 'On scene',
  busy: 'Busy',
  evac: 'Evacuation',
  evacLead: 'Routes from the nearby stores to the closest exits, never through the affected area.',
  evacOn: 'Draw evacuation routes',
  evacOff: 'Clear routes',
  evacAccessible: 'Accessible route (lift or ramp, no stairs)',
  evacSummary: (n, exits) => `${n} stores to ${exits}`,
  evacBlocked: (e) => `${e} is inside the affected area: blocked.`,
  evacLift: 'The accessible route uses the lift: in a real evacuation, only with staff and if the building plan allows it.',
  exit: (n) => `Exit ${n}`,
  exitNear: (n, near) => `Exit ${n} · by ${near}`,
  exitCount: (n) => `${n} store${n === 1 ? '' : 's'}`,
  blocked: 'blocked',
  log: 'Incident log',
  logWho: { system: 'System', operator: 'Operator (you)' },
  logDetected: (src) => `Alarm received: ${src}`,
  logOpened: 'Incident opened in the console, located on the map',
  logCams: (n, inView) => `${n} nearby camera${n === 1 ? '' : 's'}, ${inView} with a view of the spot`,
  logLate: (cp, m) => `Round overdue at ${cp} (${m} min without a scan)`,
  logDispatch: (n, eta) => `Dispatched ${n} · estimated ${eta}`,
  logAck: 'Confirms by radio, on the way',
  logArrived: 'On scene',
  logEvac: (s) => `Partial evacuation: ${s}`,
  logEvacAcc: ' (accessible route)',
  logEvacOff: 'Evacuation routes cleared',
  logClosed: 'Incident closed',
  times: 'Response times',
  tDispatch: 'Alarm → dispatch',
  tTravel: 'Dispatch → on scene',
  tTotal: 'Alarm → on scene',
  timesNote: 'Measured on the simulated clock. To claim a faster response, compare them with your current baseline (radio and logbook).',
  close: 'Close incident',
  closed: 'Incident closed',
  speed: 'Simulated walk ×8',
  credit:
    'Demo by Atlas Kinetix LAC on the Mappedin demo map and SDK. Incidents, cameras, rounds and staff are simulated. Brands on the map are illustrative: their owners do not take part in or endorse this demo.',
  checkpoint: (name) => {
    const [k, v] = name.split(':');
    return (
      ({ exit: `Exit ${v}`, elevator: `Lift ${v}`, restroom: 'Restrooms', info: 'Information desk', lot: `Parking lot ${v}`, foodcourt: 'Food court', garage: 'Covered car park' } as Record<string, string>)[k] ?? name
    );
  },
  post: { info: 'Information desk', upper: 'Lift, level 2', west: 'Guest services, west wing', lotA: 'Parking lot A' },
  langBtn: 'ES',
  langLabel: 'Cambiar a español',
};

export const dict: Record<Lang, Dict> = { es, en };
