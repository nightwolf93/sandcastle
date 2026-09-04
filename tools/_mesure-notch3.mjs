/** Etat du pied du mur : combien de colonnes evidees, stress, support. */
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

const report = (t) => {
  // pour chaque colonne du mur : la base (y=base..base+1) est-elle evidee ?
  let hollow = 0, partial = 0, intact = 0, sMax = 0, crest = 0;
  for (let k = 0; k < cols.length; k++) {
    const c = cols[k];
    const y0 = base[k];
    const d = field.density[c + SLICE * y0];
    if (d === 0) hollow++; else if (d < ISO) partial++; else intact++;
    for (let y = y0; y <= y0 + 6 && y < NY; y++) {
      const s = gran.stress[c + SLICE * y];
      if (s > sMax) sMax = s;
    }
    crest += Math.max(0, field.topY[c] - base[k]);
  }
  console.log(`t=${t}s pied du mur : ${hollow} evide, ${partial} partiel, ${intact} intact ` +
    `/ ${cols.length} | stress max ${sMax} | crete ${(crest / cols.length * VOXEL * 100).toFixed(1)} cm`);
};

for (let i = 0; i < 60 * 60; i++) {
  gran.step(1 / 60, 60000); field.flushColumns();
  water.step(1 / 60);
  field.flushColumns();
  if (i % 600 === 599) report((i + 1) / 60);
}
