/** notch() est-il vraiment appele ? Ou va la matiere ? */
import { VoxelField } from '../src/sim/VoxelField.js';
import { Granular } from '../src/sim/Granular.js';
import { Moisture } from '../src/sim/Moisture.js';
import { Water } from '../src/sim/Water.js';
import { generateBeach } from '../src/world/BeachGenerator.js';
import { NX, NZ, NY, VOXEL, ORIGIN_X, ORIGIN_Y, ORIGIN_Z, ISO } from '../src/core/Config.js';

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

// mur du test 7
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

let notchCalls = 0, notchGot = 0, notchZero = 0;
let wallCalls = 0, wallGot = 0;
const wallSet = new Set(cols);
const yHits = new Map();
const orig = water.notch.bind(water);
water.notch = (x, y, z, amount) => {
  notchCalls++;
  const got = orig(x, y, z, amount);
  if (got > 0) notchGot += got; else notchZero++;
  if (wallSet.has(x + NX * z)) {
    wallCalls++; wallGot += got;
    yHits.set(y, (yHits.get(y) || 0) + 1);
  }
  return got;
};

const crest = () => {
  let s = 0;
  for (let k = 0; k < cols.length; k++) s += Math.max(0, field.topY[cols[k]] - base[k]) * VOXEL;
  return s / cols.length;
};

for (let i = 0; i < 60 * 45; i++) {
  gran.step(1 / 60, 60000); field.flushColumns();
  water.step(1 / 60);
  field.flushColumns();
  if (i % 600 === 599) {
    console.log(`t=${((i + 1) / 60).toFixed(0)}s crete ${(crest() * 100).toFixed(1)} cm | ` +
      `notch: ${notchCalls} appels, ${(notchGot * 100).toFixed(1)} cm retires, ${notchZero} a vide | ` +
      `MUR: ${wallCalls} appels, ${(wallGot * 100).toFixed(1)} cm | yHits ${JSON.stringify([...yHits])}`);
  }
}

// coupe verticale du mur au milieu
const mid = cols[Math.floor(cols.length / 2)];
const mx = mid % NX, mz = (mid / NX) | 0;
console.log(`coupe du mur (colonne ${mx},${mz}), terrain base y=${base[Math.floor(cols.length / 2)]}:`);
for (let y = base[Math.floor(cols.length / 2)] + 8; y >= base[Math.floor(cols.length / 2)] - 6; y--) {
  let row = '';
  // coupe transversale : on suit la normale au rivage (dx=+1 vers la mer ?)
  for (let k = -4; k <= 4; k++) {
    const d = field.density[(mx + k) + NX * mz + SLICE * y] ?? 0;
    row += d >= ISO ? '#' : d > 0 ? '+' : '.';
  }
  console.log(`  y=${String(y).padStart(2)} ${row}`);
}
