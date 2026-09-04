/** Vue en plan du tunnel de sapement + evenements granulaires. */
import { VoxelField } from '../src/sim/VoxelField.js';
import { Granular } from '../src/sim/Granular.js';
import { Moisture } from '../src/sim/Moisture.js';
import { Water } from '../src/sim/Water.js';
import { generateBeach } from '../src/world/BeachGenerator.js';
import { NX, NZ, NY, VOXEL, ORIGIN_X, ORIGIN_Z, ISO } from '../src/core/Config.js';

const SLICE = NX * NZ;
const field = new VoxelField();
generateBeach(field);
const gran = new Granular(field);
const mois = new Moisture(field, gran);
const water = new Water(field, gran, mois);
water.tideSpeed = 0;
water.erosionEnabled = false;
for (let i = 0; i < 200; i++) { water.applyBoundaries(1 / 30); water.flux(1 / 60); water.integrate(1 / 60); }
water.setSeaState(3); water.setAgitation(1);
water.erosionEnabled = true;

const cols = [], base = [];
{
  const mB = Math.round(0.12 * 255), pB = Math.round(0.85 * 255);
  for (let z = 0; z < NZ; z++) {
    for (let x = 0; x < NX; x++) {
      const c = x + NX * z;
      if (Math.abs(water.shore[c] - 0.15) > 0.10) continue;
      const along = -0.8944 * (ORIGIN_X + (x + 0.5) * VOXEL)
                  + 0.4472 * (ORIGIN_Z + (z + 0.5) * VOXEL);
      if (Math.abs(along) > 0.8) continue;
      const yTop = field.topY[c];
      cols.push(c); base.push(yTop);
      const yEnd = Math.min(NY - 1, yTop + Math.round(0.24 / VOXEL));
      for (let y = 0; y <= yEnd; y++) {
        const i = c + SLICE * y;
        if (field.density[i] < 255) field.density[i] = 255;
        field.moisture[i] = mB;
        field.packing[i] = pB;
        field.material[i] = 1;
      }
    }
  }
  field.rebuildAll();
}
for (let i = 0; i < 60; i++) { gran.step(1 / 60, 60000); field.flushColumns(); }

let collapses = 0, slides = 0;
for (let i = 0; i < 60 * 45; i++) {
  gran.step(1 / 60, 60000); field.flushColumns();
  for (const e of gran.events) { if (e.type === 'collapse') collapses++; else slides++; }
  water.step(1 / 60);
  field.flushColumns();
}
console.log(`granular: ${collapses} collapses, ${slides} autres evenements`);

// crete par colonne (profil le long du mur)
let sum = 0; let n0 = 0;
const prof = [];
for (let k = 0; k < cols.length; k++) {
  const h = Math.max(0, field.topY[cols[k]] - base[k]);
  sum += h; if (h === 0) n0++;
  prof.push(h);
}
console.log(`crete moyenne ${(sum / cols.length * VOXEL * 100).toFixed(1)} cm, colonnes rasees ${n0}/${cols.length}`);
console.log('profil (voxels au-dessus de la base): ' + prof.join(''));

// plan a y=27 : etat de la matiere autour du mur
const mid = cols[Math.floor(cols.length / 2)];
const mx = mid % NX, mz = (mid / NX) | 0;
for (const y of [26, 27, 28, 29]) {
  console.log(`plan y=${y} (fenetre 24x24 autour du milieu du mur, .=vide +=partiel #=plein)`);
  for (let dz = -8; dz <= 8; dz++) {
    let row = '  ';
    for (let dx = -12; dx <= 12; dx++) {
      const d = field.density[(mx + dx) + NX * (mz + dz) + SLICE * y];
      row += d >= ISO ? '#' : d > 0 ? '+' : '.';
    }
    console.log(row);
  }
}
