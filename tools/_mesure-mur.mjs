/** Cinetique du mur du test 7 avec le nouveau UNDERCUT_RATE. */
import { VoxelField } from '../src/sim/VoxelField.js';
import { Granular } from '../src/sim/Granular.js';
import { Moisture } from '../src/sim/Moisture.js';
import { Water } from '../src/sim/Water.js';
import { generateBeach } from '../src/world/BeachGenerator.js';
import { NX, NZ, NY, VOXEL, ORIGIN_X, ORIGIN_Z } from '../src/core/Config.js';

const SLICE = NX * NZ;

function makeBeach(state, agit) {
  const field = new VoxelField();
  generateBeach(field);
  const gran = new Granular(field);
  const mois = new Moisture(field, gran);
  const water = new Water(field, gran, mois);
  water.tideSpeed = 0;
  water.erosionEnabled = false;
  for (let i = 0; i < 200; i++) { water.applyBoundaries(1 / 30); water.flux(1 / 60); water.integrate(1 / 60); }
  water.setSeaState(state);
  water.setAgitation(agit);
  water.erosionEnabled = true;
  return { field, gran, mois, water };
}

function buildWall(field, water, dist, height, w, p) {
  const cols = [], base = [];
  const mB = Math.round(w * 255), pB = Math.round(p * 255);
  for (let z = 0; z < NZ; z++) {
    for (let x = 0; x < NX; x++) {
      const c = x + NX * z;
      if (Math.abs(water.shore[c] - dist) > 0.10) continue;
      const along = -0.8944 * (ORIGIN_X + (x + 0.5) * VOXEL)
                  + 0.4472 * (ORIGIN_Z + (z + 0.5) * VOXEL);
      if (Math.abs(along) > 0.8) continue;
      const yTop = field.topY[c];
      cols.push(c); base.push(yTop);
      const yEnd = Math.min(NY - 1, yTop + Math.round(height / VOXEL));
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
  return { cols, base };
}

function crest(field, cols, base) {
  let s = 0;
  for (let k = 0; k < cols.length; k++) s += Math.max(0, field.topY[cols[k]] - base[k]) * VOXEL;
  return s / cols.length;
}

for (const state of [1, 3]) {
  const sim = makeBeach(state, 1);
  const { field, water, gran } = sim;
  const { cols, base } = buildWall(field, water, 0.15, 0.24, 0.12, 0.85);
  for (let i = 0; i < 60; i++) { gran.step(1 / 60, 60000); field.flushColumns(); }
  const c0 = crest(field, cols, base);
  const tp = water.waves.tp;
  process.stdout.write(`etat ${state} (tp=${tp}s), crete initiale ${(c0 * 100).toFixed(0)} cm : `);
  let breach = -1;
  for (let i = 0; i < 60 * 90; i++) {
    gran.step(1 / 60, 60000); field.flushColumns();
    water.step(1 / 60);
    field.flushColumns();
    if (i % 300 === 299) process.stdout.write(`${(crest(field, cols, base) * 100).toFixed(0)} `);
    if (i % 30 === 0 && breach < 0 && crest(field, cols, base) < c0 * 0.5) breach = (i / 60) / tp;
  }
  const c1 = crest(field, cols, base);
  console.log(`\n  -> crete finale ${(c1 * 100).toFixed(1)} cm (${(c1 / c0 * 100).toFixed(0)} %)` +
    (breach > 0 ? `, entame de moitie a la vague ${breach.toFixed(0)}` : ', jamais entame de moitie'));
}
