/**
 * Cut files for flat parts. Onshape's Part Studio translation has no documented way to pick one face for DXF (its DXF
 * export is for sheet-metal flat patterns and drawings), so Control Kit reads the part's boundary representation from
 * the documented body details endpoint (`GET /parts/d/{did}/{wv}/{wvid}/e/{eid}/partid/{pid}/bodydetails`) and writes
 * the DXF itself: the part's largest planar face, drawn as seen from outside the part, in millimetres.
 * Lines, arcs, and circles are exact. Any other edge (spline, ellipse) is drawn from Onshape's tessellation
 * (`.../partid/{pid}/tessellatededges`), which costs one more request and is fetched only when such an edge exists.
 * The Worker only fetches and stores Onshape's JSON; the browser draws, since a plate with hundreds of holes takes
 * several milliseconds to parse and draw and the free plan gives a Worker request 10 ms of CPU.
 */

import type { ExportPart } from './step';
import { cutsFromSheet, tooThickText } from './thickness';

export type Vec3 = { x: number; y: number; z: number };
/** Onshape writes vectors as `{x, y, z}`; arrays are accepted too, so a different serialization fails nothing. */
export type RawVec = { x?: number; y?: number; z?: number } | number[] | null | undefined;
export type BodyDetailsEdge = { id?: string; curve?: { type?: string; origin?: RawVec; normal?: RawVec; radius?: number; direction?: RawVec } | null;
  geometry?: { startPoint?: RawVec; endPoint?: RawVec; midPoint?: RawVec } | null; vertices?: string[] };
export type BodyDetailsFace = { id?: string; area?: number; surface?: { type?: string; normal?: RawVec; origin?: RawVec; isOrientedWithFace?: boolean } | null;
  loops?: Array<{ isOuter?: boolean; isInner?: boolean; coedges?: Array<{ edgeId?: string }> }> };
export type BodyDetailsBody = { id?: string; type?: string; faces?: BodyDetailsFace[]; edges?: BodyDetailsEdge[]; vertices?: Array<{ id?: string; point?: RawVec }> };
/** The part of Onshape's BTExportModelBodiesResponse that a cut file needs. */
export type BodyDetails = { bodies?: BodyDetailsBody[] };
/** The part of Onshape's BTExportTessellatedEdgesResponse that a cut file needs. */
export type TessellatedEdges = { bodies?: Array<{ edges?: Array<{ id?: string; vertices?: RawVec[] }> }> };

export type FlatFace = { faceId: string; areaMm2: number; normal: Vec3; origin: Vec3; body: BodyDetailsBody; loops: Array<{ outer: boolean; edgeIds: string[] }>;
  /** Edges that are neither lines nor circles; they are drawn from Onshape's tessellation. */
  needsTessellation: string[];
  /** Distance across the part along the face normal, in mm; null when the body gives no points to measure. */
  thicknessMm: number | null };
export type DxfResult = { ok: true; text: string; widthMm: number; heightMm: number; thicknessMm: number | null; entities: number } | { ok: false; error: string };

const vec = (value: RawVec): Vec3 | null => {
  const [x, y, z] = Array.isArray(value) ? value : value ? [value.x, value.y, value.z] : [];
  return [x, y, z].every(n => typeof n === 'number' && Number.isFinite(n)) ? { x: x!, y: y!, z: z! } : null;
};
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const scale = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
/** Smallest value and range of a list, without spreading it into arguments (a long tessellation could overflow). */
const least = (values: number[]) => values.reduce((low, value) => Math.min(low, value), Infinity);
const span = (values: number[]) => values.reduce((high, value) => Math.max(high, value), -Infinity) - least(values);
const unit = (a: Vec3): Vec3 | null => { const length = Math.hypot(a.x, a.y, a.z); return length > 1e-12 ? scale(a, 1 / length) : null; };

/** Every point the body gives (vertices and edge ends), for measuring thickness. */
function bodyPoints(body: BodyDetailsBody) {
  return [...(body.vertices ?? []).map(vertex => vec(vertex.point)), ...(body.edges ?? []).flatMap(edge => [vec(edge.geometry?.startPoint), vec(edge.geometry?.endPoint), vec(edge.geometry?.midPoint)])]
    .filter((point): point is Vec3 => point !== null);
}

/**
 * The face a flat part is cut from: the largest planar face of the part's solid body. For a plate, the largest face
 * is a side of the plate; a blind pocket makes its own side smaller, so the through profile wins.
 */
export function pickFlatFace(details: BodyDetails, partId: string | null): { ok: true; face: FlatFace } | { ok: false; error: string } {
  const bodies = (details.bodies ?? []).filter(body => !body.type || body.type === 'SOLID');
  const body = bodies.find(item => partId && item.id === partId) ?? (bodies.length === 1 ? bodies[0] : undefined);
  if (!body) return { ok: false, error: bodies.length ? 'Onshape returned several bodies for this part' : 'Onshape returned no solid body for this part' };
  let best: { face: BodyDetailsFace; normal: Vec3; origin: Vec3; area: number } | null = null;
  for (const face of body.faces ?? []) {
    if (face.surface?.type !== 'PLANE') continue;
    const normal = unit(vec(face.surface.normal) ?? { x: 0, y: 0, z: 0 });
    const origin = vec(face.surface.origin);
    const area = typeof face.area === 'number' && Number.isFinite(face.area) ? face.area : 0;
    if (!normal || !origin || area <= 0 || !face.loops?.some(loop => loop.isOuter && loop.coedges?.length)) continue;
    if (!best || area > best.area * (1 + 1e-9)) best = { face, normal: face.surface.isOrientedWithFace === false ? scale(normal, -1) : normal, origin, area };
  }
  if (!best) return { ok: false, error: 'This part has no flat face to cut from' };
  const edges = new Map((body.edges ?? []).map(edge => [edge.id, edge]));
  const loops = (best.face.loops ?? []).map(loop => ({ outer: Boolean(loop.isOuter), edgeIds: (loop.coedges ?? []).flatMap(coedge => coedge.edgeId ? [coedge.edgeId] : []) })).filter(loop => loop.edgeIds.length);
  const missing = loops.flatMap(loop => loop.edgeIds).find(id => !edges.has(id));
  if (missing) return { ok: false, error: 'Onshape body details name an edge they do not describe' };
  const needsTessellation = [...new Set(loops.flatMap(loop => loop.edgeIds).filter(id => !['LINE', 'CIRCLE'].includes(edges.get(id)!.curve?.type ?? '')))];
  const through = runsThrough(body, best.face, best.normal, best.origin, loops);
  if (!through.ok) return through;
  return { ok: true, face: { faceId: best.face.id ?? '', areaMm2: best.area * 1e6, normal: best.normal, origin: best.origin, body, loops, needsTessellation, thicknessMm: through.thicknessMm } };
}

/**
 * A cut file is only right when the face is a plate's outside and every loop on it runs through to the other side.
 * The face must be at the part's extreme along its normal (a pocket floor is not), a flat face must face the other
 * way at the far extreme, and each loop's walls must connect, face to face, to that far face: a blind recess on the
 * face reaches only its own floor and walls, so it would be wrongly cut as a hole. A recess whose floor has a
 * through hole still passes; that case is left to the manifest's "check before cutting".
 */
function runsThrough(body: BodyDetailsBody, chosen: BodyDetailsFace, normal: Vec3, origin: Vec3, loops: FlatFace['loops']): { ok: true; thicknessMm: number | null } | { ok: false; error: string } {
  const tolerance = 1e-6;
  const along = bodyPoints(body).map(point => dot(sub(point, origin), normal));
  if (!along.length) return { ok: true, thicknessMm: null };
  if (along.some(value => value > tolerance)) return { ok: false, error: 'The largest flat face is inside the part (a pocket floor), so it is not a cut outline' };
  const depth = least(along);
  const faces = body.faces ?? [];
  const far = new Set(faces.filter(face => {
    if (face === chosen || face.surface?.type !== 'PLANE') return false;
    const raw = unit(vec(face.surface.normal) ?? { x: 0, y: 0, z: 0 });
    const at = vec(face.surface.origin);
    const facing = raw && (face.surface.isOrientedWithFace === false ? scale(raw, -1) : raw);
    return facing && at && dot(facing, normal) < -0.999999 && Math.abs(dot(sub(at, origin), normal) - depth) < tolerance;
  }));
  if (!far.size) return { ok: false, error: 'No flat face on the other side of the part, so it is not a plate' };
  const facesOf = new Map<string, BodyDetailsFace[]>();
  for (const face of faces) for (const loop of face.loops ?? []) for (const coedge of loop.coedges ?? []) {
    if (coedge.edgeId) facesOf.set(coedge.edgeId, [...(facesOf.get(coedge.edgeId) ?? []), face]);
  }
  const edgesOf = (face: BodyDetailsFace) => (face.loops ?? []).flatMap(loop => (loop.coedges ?? []).flatMap(coedge => coedge.edgeId ? [coedge.edgeId] : []));
  for (const loop of loops) {
    const seen = new Set<BodyDetailsFace>([chosen]);
    const queue = loop.edgeIds.flatMap(id => facesOf.get(id) ?? []).filter(face => !seen.has(face));
    let reached = false;
    while (queue.length && !reached) {
      const face = queue.shift()!;
      if (seen.has(face)) continue;
      seen.add(face);
      if (far.has(face)) { reached = true; break; }
      for (const id of edgesOf(face)) for (const next of facesOf.get(id) ?? []) if (!seen.has(next)) queue.push(next);
    }
    if (!reached) return { ok: false, error: loop.outer ? 'The outline does not run through the part, so it is not a plain plate' : 'A recess on the flat face does not run through the part, so it would be cut as a hole' };
  }
  return { ok: true, thicknessMm: Math.round(-depth * 1000 * 1000) / 1000 };
}

/** Tessellated points by edge ID, from Onshape's tessellated edges response. */
export function tessellatedPoints(response: TessellatedEdges) {
  const points = new Map<string, Vec3[]>();
  for (const body of response.bodies ?? []) for (const edge of body.edges ?? []) {
    const list = (edge.vertices ?? []).map(vec).filter((point): point is Vec3 => point !== null);
    if (edge.id && list.length >= 2) points.set(edge.id, list);
  }
  return points;
}

type Entity = { type: 'LINE'; a: [number, number]; b: [number, number] } | { type: 'CIRCLE'; c: [number, number]; r: number } | { type: 'ARC'; c: [number, number]; r: number; start: number; end: number };
const degrees = (radians: number) => ((radians * 180 / Math.PI) % 360 + 360) % 360;
/** Counter-clockwise sweep from `from` to `to`, in degrees, in [0, 360). */
const sweep = (from: number, to: number) => ((to - from) % 360 + 360) % 360;
const number = (value: number) => { const fixed = value.toFixed(6).replace(/\.?0+$/, ''); return fixed === '-0' ? '0' : fixed; };

/**
 * Draws the face's loops in the face's own plane: x along its longest straight outer edge (so a rectangular plate
 * lies square), y completing a right-handed frame seen from outside the part, origin at the lower-left corner.
 */
export function flatFaceDxf(face: FlatFace, tessellated: Map<string, Vec3[]> = new Map()): DxfResult {
  const edges = new Map((face.body.edges ?? []).map(edge => [edge.id!, edge]));
  const vertices = new Map((face.body.vertices ?? []).map(vertex => [vertex.id, vec(vertex.point)]));
  const ends = (edge: BodyDetailsEdge) => {
    const start = vec(edge.geometry?.startPoint) ?? vertices.get(edge.vertices?.[0]) ?? null;
    const end = vec(edge.geometry?.endPoint) ?? vertices.get(edge.vertices?.[edge.vertices.length - 1]) ?? null;
    return { start, end };
  };
  // X axis: the longest straight edge of the outer loop, else a world axis laid into the plane.
  let xAxis: Vec3 | null = null;
  let longest = 0;
  for (const id of face.loops.find(loop => loop.outer)?.edgeIds ?? []) {
    const edge = edges.get(id)!;
    const { start, end } = ends(edge);
    if (edge.curve?.type !== 'LINE' || !start || !end) continue;
    const along = sub(end, start);
    const flat = sub(along, scale(face.normal, dot(along, face.normal)));
    const length = Math.hypot(flat.x, flat.y, flat.z);
    if (length > longest * (1 + 1e-9)) { longest = length; xAxis = unit(flat); }
  }
  if (!xAxis) {
    const world = Math.abs(face.normal.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    xAxis = unit(sub(world, scale(face.normal, dot(world, face.normal))))!;
  }
  const yAxis = cross(face.normal, xAxis);
  const flat = (point: Vec3): [number, number] => { const offset = sub(point, face.origin); return [dot(offset, xAxis!) * 1000, dot(offset, yAxis) * 1000]; };

  const entities: Entity[] = [];
  for (const id of face.loops.flatMap(loop => loop.edgeIds)) {
    const edge = edges.get(id)!;
    const { start, end } = ends(edge);
    const type = edge.curve?.type;
    if (type === 'LINE' && start && end) { entities.push({ type: 'LINE', a: flat(start), b: flat(end) }); continue; }
    const center = vec(edge.curve?.origin);
    const radius = edge.curve?.radius;
    if (type === 'CIRCLE' && center && typeof radius === 'number' && radius > 0) {
      const c = flat(center);
      const r = radius * 1000;
      // A closed edge (no vertices, or both ends at one point) is a whole circle: a hole or a round part.
      if (!start || !end || Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z) < 1e-9) { entities.push({ type: 'CIRCLE', c, r }); continue; }
      const angle = (point: Vec3) => { const [x, y] = flat(point); return degrees(Math.atan2(y - c[1], x - c[0])); };
      const from = angle(start);
      const to = angle(end);
      const middle = vec(edge.geometry?.midPoint);
      // DXF arcs run counter-clockwise. The edge's midpoint says which way round it goes; without one, the curve
      // runs counter-clockwise about its own normal from start to end.
      const forward = middle ? sweep(from, angle(middle)) < sweep(from, to) : dot(vec(edge.curve?.normal) ?? face.normal, face.normal) >= 0;
      entities.push({ type: 'ARC', c, r, start: forward ? from : to, end: forward ? to : from });
      continue;
    }
    const points = tessellated.get(id);
    if (!points) return { ok: false, error: `Onshape gave no shape for a ${(type ?? 'unknown').toLowerCase()} edge of the flat face` };
    for (let index = 1; index < points.length; index++) entities.push({ type: 'LINE', a: flat(points[index - 1]), b: flat(points[index]) });
  }
  if (!entities.length) return { ok: false, error: 'The flat face has no edges to cut' };

  // Bounds: line ends, whole circles, and each arc's ends plus the quadrant points it passes.
  const xs: number[] = [];
  const ys: number[] = [];
  const add = ([x, y]: [number, number]) => { xs.push(x); ys.push(y); };
  for (const entity of entities) {
    if (entity.type === 'LINE') { add(entity.a); add(entity.b); continue; }
    const at = (deg: number): [number, number] => [entity.c[0] + entity.r * Math.cos(deg * Math.PI / 180), entity.c[1] + entity.r * Math.sin(deg * Math.PI / 180)];
    if (entity.type === 'CIRCLE') { [0, 90, 180, 270].forEach(deg => add(at(deg))); continue; }
    add(at(entity.start)); add(at(entity.end));
    for (const deg of [0, 90, 180, 270]) if (sweep(entity.start, deg) <= sweep(entity.start, entity.end)) add(at(deg));
  }
  const [minX, minY] = [least(xs), least(ys)];
  const shift = ([x, y]: [number, number]): [number, number] => [x - minX, y - minY];
  // Plain R12 ASCII (AC1009): the oldest form every laser, router, and CAD program reads. No TABLES section, so
  // the CUT layer is made by the first entity on it. $INSUNITS 4 tells programs that read it the units are mm.
  const out: string[] = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES'];
  const point = (code: number, [x, y]: [number, number]) => [String(code), number(x), String(code + 10), number(y), String(code + 20), '0'];
  for (const entity of entities) {
    if (entity.type === 'LINE') out.push('0', 'LINE', '8', 'CUT', ...point(10, shift(entity.a)), ...point(11, shift(entity.b)));
    else if (entity.type === 'CIRCLE') out.push('0', 'CIRCLE', '8', 'CUT', ...point(10, shift(entity.c)), '40', number(entity.r));
    else out.push('0', 'ARC', '8', 'CUT', ...point(10, shift(entity.c)), '40', number(entity.r), '50', number(entity.start), '51', number(entity.end));
  }
  out.push('0', 'ENDSEC', '0', 'EOF');
  return { ok: true, text: `${out.join('\n')}\n`, widthMm: Math.round(span(xs) * 1000) / 1000, heightMm: Math.round(span(ys) * 1000) / 1000, thicknessMm: face.thicknessMm, entities: entities.length };
}

/** The DXF beside a STEP file: same name, `.dxf` extension. */
export const dxfFileName = (stepName: string) => stepName.replace(/\.step$/i, '') + '.dxf';

/**
 * Whether body details describe a curve that is neither a line nor a circle, so the tessellated edges are needed too.
 * A text search, so the Worker can decide without parsing a large response. It may ask for edges a face does not
 * use (a spline elsewhere on the part); that costs one request, never a wrong drawing.
 */
export const needsTessellatedEdges = (bodyDetailsText: string) => /"(?:BCURVE|ELLIPSE|ICURVE)"/.test(bodyDetailsText);

/** Picks the flat face and draws it: the whole DXF step, from Onshape's two responses. */
export function drawFlatPart(details: BodyDetails, edges: TessellatedEdges | null, partId: string | null): DxfResult {
  const picked = pickFlatFace(details, partId);
  if (!picked.ok) return picked;
  if (picked.face.needsTessellation.length && !edges) return { ok: false, error: 'Onshape gave no shape for a curved edge of the flat face' };
  return flatFaceDxf(picked.face, edges ? tessellatedPoints(edges) : new Map());
}

/**
 * A part after the browser has drawn its DXF: the sizes and byte count filled in, or the drawing's reason for failing.
 * `drawn` is null when Onshape's geometry could not be downloaded. A part the geometry shows is over 3 mm thick, and
 * that no person set to 2D cut, becomes a print with a note and no DXF (the owner's thickness rule).
 */
export function withDrawnDxf<P extends ExportPart>(part: P, drawn: DxfResult | null): P {
  if (!part.dxf || part.dxf.state !== 'ready') return part;
  if (drawn?.ok && drawn.thicknessMm !== null && !cutsFromSheet(drawn.thicknessMm) && !part.manual) {
    return { ...part, disposition: 'print', dxf: undefined, note: tooThickText(drawn.thicknessMm) };
  }
  if (!drawn) return { ...part, dxf: { ...part.dxf, state: 'failed', error: 'DXF was not downloaded' } };
  if (!drawn.ok) return { ...part, dxf: { ...part.dxf, state: 'failed', error: drawn.error } };
  return { ...part, dxf: { ...part.dxf, error: null, bytes: new TextEncoder().encode(drawn.text).byteLength, widthMm: drawn.widthMm, heightMm: drawn.heightMm, thicknessMm: drawn.thicknessMm } };
}
