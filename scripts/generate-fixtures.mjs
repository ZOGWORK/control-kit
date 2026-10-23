import { writeFileSync } from 'node:fs';
import { URL } from 'node:url';

let fixtureDocument = 'simple';
const part = (id, name, elementId, partId, extra = {}) => ({ id, name, type: 'Part', documentId: fixtureDocument, elementId, partId, ...extra });
const assembly = (id, name, elementId, extra = {}) => ({ id, name, type: 'Assembly', documentId: fixtureDocument, elementId, ...extra });
const save = (name, value) => writeFileSync(new URL(`../fixtures/${name}`, import.meta.url), `${JSON.stringify(value, null, 2)}\n`);

const simple = {
  rootAssembly: { name: 'Simple FTC Assembly', instances: [
    ...Array.from({ length: 4 }, (_, i) => part(`screw-${i}`, `M3 Screw <${i + 1}>`, 'screws', 'screw-m3')),
    part('print-1', 'Custom Printed Sensor Mount <1>', 'prints', 'sensor-mount'),
    part('suppressed-1', 'Spare Gear <1>', 'gears', 'spare-gear', { suppressed: true }),
    assembly('module-left', 'Left Module <1>', 'module'), assembly('module-right', 'Right Module <1>', 'module'),
  ] },
  subAssemblies: [{ documentId: 'simple', elementId: 'module', instances: [
    part('motor', 'Motor <1>', 'motors', 'motor-5203'), part('wheel', 'Wheel <1>', 'wheels', 'wheel-96'), part('bearing', 'Bearing <1>', 'bearings', 'bearing-8'),
  ] }],
  parts: [
    { documentId: 'simple', elementId: 'screws', partId: 'screw-m3', name: 'M3 Screw' },
    { documentId: 'simple', elementId: 'prints', partId: 'sensor-mount', name: 'Custom Printed Sensor Mount' },
  ],
};
save('assembly-simple.json', simple);
save('assembly-empty.json', { rootAssembly: { name: 'Empty Assembly', instances: [] }, subAssemblies: [], parts: [] });

fixtureDocument = 'robot';
const large = {
  rootAssembly: { name: 'FTC Competition Robot', instances: [
    ...Array.from({ length: 200 }, (_, i) => part(`screw-${i}`, `M3 Screw <${i + 1}>`, 'screws', 'screw-m3')),
    ...Array.from({ length: 20 }, (_, i) => part(`motor-${i}`, `5203 Motor <${i + 1}>`, 'motors', 'motor-5203')),
    ...Array.from({ length: 10 }, (_, i) => part(`print-${i}`, `Custom Printed Intake Guide <${i + 1}>`, 'prints', 'intake-guide')),
    ...Array.from({ length: 4 }, (_, i) => part(`spare-${i}`, `Spare Gear <${i + 1}>`, 'gears', 'spare-gear', { suppressed: true })),
    assembly('left-drive', 'Left Drivetrain <1>', 'drive-module'), assembly('right-drive', 'Right Drivetrain <1>', 'drive-module'),
  ] },
  subAssemblies: [{ documentId: 'robot', elementId: 'drive-module', instances: [
    ...Array.from({ length: 8 }, (_, i) => part(`wheel-${i}`, `96mm Wheel <${i + 1}>`, 'wheels', 'wheel-96')),
    ...Array.from({ length: 7 }, (_, i) => part(`bearing-${i}`, `Bearing <${i + 1}>`, 'bearings', 'bearing-8')),
  ] }],
  parts: [],
};
save('assembly-ftc-robot.json', large);
