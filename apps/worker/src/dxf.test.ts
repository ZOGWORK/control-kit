import { describe, expect, it } from 'vitest';
import { dxfFileName, flatFaceDxf, pickFlatFace, tessellatedPoints, type BodyDetails } from '@control-kit/shared';
import { mockPlateBody, mockPlateEdges } from './mock-onshape';

/** DXF group codes and values, paired. */
const pairs = (text: string) => { const rows = text.trimEnd().split('\n'); return Array.from({ length: rows.length / 2 }, (_, index) => [rows[index * 2], rows[index * 2 + 1]] as const); };
const entities = (text: string) => {
  const list: Array<{ type: string; values: Record<string, number> }> = [];
  let inside = false;
  for (const [code, value] of pairs(text)) {
    if (code === '2' && value === 'ENTITIES') { inside = true; continue; }
    if (!inside) continue;
    if (code === '0') { if (value === 'ENDSEC') break; list.push({ type: value, values: {} }); continue; }
    if (code !== '8') list[list.length - 1].values[code] = Number(value);
  }
  return list;
};

describe('DXF of a flat face', () => {
  it('draws the largest planar face in millimetres, seen from outside, with lines, an arc, and a hole', () => {
    const picked = pickFlatFace(mockPlateBody('plate'), 'plate');
    if (!picked.ok) throw new Error(picked.error);
    expect(picked.face).toMatchObject({ faceId: 'bottom', needsTessellation: [], thicknessMm: 3 });
    const dxf = flatFaceDxf(picked.face);
    if (!dxf.ok) throw new Error(dxf.error);
    expect(dxf.text.startsWith('0\nSECTION\n2\nHEADER\n')).toBe(true);
    expect(dxf.text.endsWith('0\nEOF\n')).toBe(true);
    expect(dxf.text).toContain('$INSUNITS\n70\n4');
    expect(dxf).toMatchObject({ widthMm: 100, heightMm: 60, thicknessMm: 3, entities: 6 });
    const drawn = entities(dxf.text);
    expect(drawn.map(entity => entity.type)).toEqual(['LINE', 'LINE', 'ARC', 'LINE', 'LINE', 'CIRCLE']);
    // Seen from below, the plate's +y runs down the page: the hole at y = 30 of 60 stays in the middle, the
    // rounded corner (top right from above) is at the bottom right.
    expect(drawn[5].values).toMatchObject({ 10: 30, 20: 30, 40: 5 });
    expect(drawn[2].values).toMatchObject({ 10: 90, 20: 10, 40: 10 });
    // The arc's quarter turn from the right side to the bottom edge, counter-clockwise in DXF terms.
    expect(drawn[2].values[50]).toBeCloseTo(270);
    expect(drawn[2].values[51]).toBeCloseTo(0);
    // Every line lies inside the drawing, which starts at the origin.
    for (const entity of drawn.filter(item => item.type === 'LINE')) for (const code of ['10', '11', '20', '21']) expect(entity.values[code]).toBeGreaterThanOrEqual(0);
  });

  it('asks for tessellation only for edges that are neither lines nor circles, and draws them as segments', () => {
    const picked = pickFlatFace(mockPlateBody('plate', true), 'plate');
    if (!picked.ok) throw new Error(picked.error);
    expect(picked.face.needsTessellation).toEqual(['e4']);
    expect(flatFaceDxf(picked.face)).toEqual({ ok: false, error: 'Onshape gave no shape for a bcurve edge of the flat face' });
    const dxf = flatFaceDxf(picked.face, tessellatedPoints(mockPlateEdges(['e4'])));
    if (!dxf.ok) throw new Error(dxf.error);
    expect(entities(dxf.text).filter(entity => entity.type === 'LINE')).toHaveLength(4 + 3);
    expect(dxf.heightMm).toBeCloseTo(65);
  });

  it('reads vectors written as arrays too', () => {
    const body = JSON.parse(JSON.stringify(mockPlateBody('plate')), (_key, value) => value && typeof value === 'object' && 'x' in value && 'y' in value && 'z' in value ? [value.x, value.y, value.z] : value) as BodyDetails;
    const picked = pickFlatFace(body, 'plate');
    if (!picked.ok) throw new Error(picked.error);
    expect(flatFaceDxf(picked.face)).toMatchObject({ ok: true, widthMm: 100, heightMm: 60 });
  });

  it('explains a part it cannot draw', () => {
    const noFace = mockPlateBody('plate');
    noFace.bodies[0].faces = noFace.bodies[0].faces.filter(face => face.surface.type !== 'PLANE');
    expect(pickFlatFace(noFace, 'plate')).toEqual({ ok: false, error: 'This part has no flat face to cut from' });
    expect(pickFlatFace({ bodies: [] }, 'plate')).toEqual({ ok: false, error: 'Onshape returned no solid body for this part' });
    const two = { bodies: [mockPlateBody('a').bodies[0], mockPlateBody('b').bodies[0]] };
    expect(pickFlatFace(two, 'c')).toEqual({ ok: false, error: 'Onshape returned several bodies for this part' });
    expect(pickFlatFace(two, 'b')).toMatchObject({ ok: true });
    const missing = mockPlateBody('plate');
    missing.bodies[0].edges = missing.bodies[0].edges.filter(edge => edge.id !== 'e6');
    expect(pickFlatFace(missing, 'plate')).toEqual({ ok: false, error: 'Onshape body details name an edge they do not describe' });
  });

  it('names the DXF after its STEP file', () => {
    expect(dxfFileName('Side_Plate__JHD.step')).toBe('Side_Plate__JHD.dxf');
    expect(dxfFileName('Side_Plate__JHD_2.step')).toBe('Side_Plate__JHD_2.dxf');
  });
});
