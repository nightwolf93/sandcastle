/**
 * Instrumentation du sapement : pourquoi undermine() ne mord-il pas ?
 * + nappe fantome de buildRenderLevel avec houle active et fosse creusee.
 */
import { VoxelField } from '../src/sim/VoxelField.js';
import { Granular } from '../src/sim/Granular.js';
import { Moisture } from '../src/sim/Moisture.js';
import { Water } from '../src/sim/Water.js';
import { generateBeach } from '../src/world/BeachGenerator.js';
import {
  NX, NZ, NY, VOXEL, ISO, GRAVITY, ORIGIN_X, ORIGIN_Y, ORIGIN_Z,
  TAU_CRIT_DRY, COHESION_RESIST, UNDERCUT_RISE, UNDERCUT_V, SCOUR_GAIN,
  BREAK_TAU, FW_UPRUSH, clamp,
} from '../src/core/Config.js';
import { cohesionFactor, packFactor } from '../src/sim/SandPhysics.js';

const COLS = NX * NZ, SLICE = NX * NZ;

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

// --- mur identique au test 7 ------------------------------------------------
const sim = makeBeach(3, 1);
const { field, gran, mois, water } = sim;
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
console.log(`mur : ${cols.length} colonnes`);
const wallSet = new Set(cols);

// stats par condition de rejet, mesurees en re-executant la logique d'undermine
const rej = { dryOrThin: 0, slow: 0, notToward: 0, noRise: 0, dug: 0, weak: 0, hit: 0 };
let tauMax = 0, spMax = 0, etaMax = -9;

for (let i = 0; i < 60 * 30; i++) {
  gran.step(1 / 60, 60000); field.flushColumns();
  water.step(1 / 60);
  field.flushColumns();
  if (i % 2) continue;
  const h = water.h, vx = water.vx, vz = water.vz, surf = field.surfaceH, brk = water.brk;
  for (let z = 1; z < NZ - 1; z++) {
    for (let x = 1; x < NX - 1; x++) {
      const c = x + NX * z;
      // uniquement les cellules ADJACENTES au mur
      let touching = false, dxw = 0, dzw = 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (wallSet.has((x + dx) + NX * (z + dz))) { touching = true; dxw = dx; dzw = dz; break; }
      }
      if (!touching) continue;
      const hw = h[c];
      if (hw < 0.004) { rej.dryOrThin++; continue; }
      const ux = vx[c], uz = vz[c];
      const sp = Math.sqrt(ux * ux + uz * uz);
      if (sp > spMax) spMax = sp;
      if (sp < UNDERCUT_V) { rej.slow++; continue; }
      const eta = surf[c] + hw;
      if (eta > etaMax) etaMax = eta;
      const n = (x + dxw) + NX * (z + dzw);
      if (ux * dxw + uz * dzw < UNDERCUT_V) { rej.notToward++; continue; }
      if (surf[n] - eta < UNDERCUT_RISE) { rej.noRise++; continue; }
      const yHit = clamp(Math.round((eta - ORIGIN_Y) / VOXEL - 0.5), 0, NY - 1);
      const iv = n + SLICE * yHit;
      if (field.density[iv] < ISO) { rej.dug++; continue; }
      const cel = Math.sqrt(GRAVITY * hw);
      const fr = Math.min(sp / (cel > 0.05 ? cel : 0.05), 1.8);
      const K = 1 + SCOUR_GAIN * fr;
      const tau = 500 * FW_UPRUSH * sp * sp * K * (1 + BREAK_TAU * brk[c]);
      if (tau > tauMax) tauMax = tau;
      const w = field.moisture[iv] / 255, pk = field.packing[iv] / 255;
      const tauCrit = TAU_CRIT_DRY * (1 + COHESION_RESIST * cohesionFactor(w) * packFactor(pk));
      if (tau <= tauCrit) { rej.weak++; continue; }
      rej.hit++;
    }
  }
}
let crest = 0;
for (let k = 0; k < cols.length; k++) crest += Math.max(0, field.topY[cols[k]] - base[k]) * VOXEL;
crest /= cols.length;
console.log('rejets undermine (cellules adjacentes au mur, 30 s):', JSON.stringify(rej));
console.log(`sp max ${spMax.toFixed(2)} m/s, tau max ${tauMax.toFixed(0)} Pa, eta max ${etaMax.toFixed(2)} m`);
console.log(`crete apres 30 s : ${(crest * 100).toFixed(1)} cm (depart 24)`);
console.log(`stats.eroded total : ${water.stats.eroded.toFixed(4)}`);

// --- nappe fantome avec houle + fosse --------------------------------------
{
  const sim2 = makeBeach(3, 1);
  const f2 = sim2.field, w2 = sim2.water;
  let bestC = -1, bestE = 9;
  for (let z = 30; z < NZ - 30; z++) for (let x = 30; x < NX - 30; x++) {
    const c = x + NX * z;
    const e = Math.abs(w2.shore[c] - 1.0);
    if (e < bestE) { bestE = e; bestC = c; }
  }
  const cx = bestC % NX, cz = (bestC / NX) | 0;
  for (let dz = -8; dz <= 8; dz++) for (let dx = -8; dx <= 8; dx++) {
    if (dx * dx + dz * dz > 64) continue;
    const x = cx + dx, z = cz + dz;
    const col = x + NX * z;
    let y = f2.topY[col];
    for (let k = 0; k < 15 && y >= 0; k++, y--) f2.set(x, y, z, 0);
  }
  f2.flushColumns();
  // 20 s de houle
  for (let i = 0; i < 60 * 20; i++) { w2.step(1 / 60); f2.flushColumns(); }
  // dilatation max (comme buildRenderLevel actuel), sur 60 frames : compte les
  // nappes fantomes et le va-et-vient du niveau dilate autour de la fosse
  const lvl = new Float32Array(COLS), tmp = new Float32Array(COLS);
  let ghostFrames = 0, ghostMax = 0;
  for (let fme = 0; fme < 60; fme++) {
    w2.step(1 / 60); f2.flushColumns();
    for (let c = 0; c < COLS; c++) lvl[c] = w2.h[c] > 0.0015 ? f2.surfaceH[c] + w2.h[c] : -1e9;
    for (let p = 0; p < 2; p++) {
      tmp.set(lvl);
      for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) {
        const c = x + NX * z;
        if (tmp[c] > -1e8) continue;
        let best = -1e9;
        if (x > 0 && tmp[c - 1] > best) best = tmp[c - 1];
        if (x + 1 < NX && tmp[c + 1] > best) best = tmp[c + 1];
        if (z > 0 && tmp[c - NX] > best) best = tmp[c - NX];
        if (z + 1 < NZ && tmp[c + NX] > best) best = tmp[c + NX];
        if (best > -1e8) lvl[c] = best;
      }
    }
    let ghost = 0;
    for (let dz = -12; dz <= 12; dz++) for (let dx = -12; dx <= 12; dx++) {
      const x = cx + dx, z = cz + dz;
      if (x < 0 || z < 0 || x >= NX || z >= NZ) continue;
      const c = x + NX * z;
      if (w2.h[c] > 0.0015 || lvl[c] < -1e8) continue;
      if (lvl[c] > f2.surfaceH[c] + 0.02) ghost++;
    }
    if (ghost > 0) ghostFrames++;
    if (ghost > ghostMax) ghostMax = ghost;
  }
  console.log(`fosse+houle : nappe fantome sur ${ghostFrames}/60 frames, max ${ghostMax} cellules`);
  // ecume dans la fosse
  let fm = 0;
  for (let dz = -6; dz <= 6; dz++) for (let dx = -6; dx <= 6; dx++) {
    const c = (cx + dx) + NX * (cz + dz);
    if (w2.foam[c] > fm) fm = w2.foam[c];
  }
  console.log(`ecume max dans la fosse : ${fm.toFixed(3)}`);
}
