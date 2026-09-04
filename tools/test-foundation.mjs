/** Regressions du socle indestructible, sans navigateur. */
import {
  NX, NZ, VOXEL, ORIGIN_X, ORIGIN_Y, ORIGIN_Z, FOUNDATION_LAYERS,
} from '../src/core/Config.js';
import { VoxelField } from '../src/sim/VoxelField.js';
import { Granular } from '../src/sim/Granular.js';
import { EditContext, sphere } from '../src/tools/Brush.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const SLICE = NX * NZ;
const x = NX >> 1, z = NZ >> 1;
const index = (xx, y, zz) => xx + NX * (zz + NZ * y);

console.log('\n== Fondation indestructible ==');

const field = new VoxelField();
// Simule une ancienne sauvegarde deja percee, qui ecrit directement les
// tableaux avant d'appeler rebuildAll().
for (let y = 0; y < FOUNDATION_LAYERS; y++) {
  field.density[index(x, y, z)] = 0;
}
field.rebuildAll();
check('une ancienne sauvegarde percee est rebouchee au chargement',
  Array.from({ length: FOUNDATION_LAYERS }, (_, y) => field.density[index(x, y, z)])
    .every(d => d === 255));

const directDelta = field.set(x, FOUNDATION_LAYERS - 1, z, 0);
check('une ecriture directe ne peut pas creuser le socle',
  directDelta === 0 && field.density[index(x, FOUNDATION_LAYERS - 1, z)] === 255);

const granular = new Granular(field);
const moisture = { touchBox() {} };
const ctx = new EditContext(field, granular, moisture, null, null);
const wx = ORIGIN_X + (x + 0.5) * VOXEL;
const wy = ORIGIN_Y + (FOUNDATION_LAYERS - 1 + 0.5) * VOXEL;
const wz = ORIGIN_Z + (z + 0.5) * VOXEL;
const removed = sphere(ctx, wx, wy, wz, VOXEL * 0.45, -255, { hardness: 1 });
check('la brosse de creusement s arrete sur la fondation',
  removed === 0 && field.density[index(x, FOUNDATION_LAYERS - 1, z)] === 255,
  `volume annonce ${removed}`);

// Le moteur granulaire ne doit pas dupliquer de masse en essayant de prendre
// du sable dans le socle pour le verser dans une cellule libre.
const from = index(x, FOUNDATION_LAYERS - 1, z);
const to = from + SLICE;
field.density[to] = 0;
const before = field.density[from] + field.density[to];
const moved = granular.transferTo(from, to, 64, 0.6);
check('la physique ne mobilise pas le socle',
  moved === 0 && field.density[from] + field.density[to] === before);

console.log(failures === 0 ? '\nTous les tests de fondation passent.\n' :
  `\n${failures} test(s) de fondation en echec.\n`);
process.exit(failures ? 1 : 0);
