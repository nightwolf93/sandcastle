/**
 * Tests de la main : le lissage gaussien 3D (`Brush.smooth`).
 *
 * Le geste doit transformer une marche franche en pente continue, sans
 * toucher ce qui est loin de la brosse, sans creer ni perdre de sable, et
 * sans jamais entamer le socle. Un lissage qui rogne le volume finit par
 * faire fondre les dunes ; un lissage qui laisse des marches ne sert a rien.
 *
 * Node seul, sans navigateur.
 */
import { ISO, MAT_SAND, NX, NY, NZ, VOXEL, FOUNDATION_LAYERS } from '../src/core/Config.js';
import { VoxelField } from '../src/sim/VoxelField.js';
import { EditContext, smooth, toVoxel } from '../src/tools/Brush.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

/** Plage plate a `low` couches, avec une marche a `high` couches pour x >= cliffX. */
function cliffField(low, high, cliffX) {
  const field = new VoxelField();
  for (let y = 0; y < high; y++) {
    for (let z = 0; z < NZ; z++) {
      const row = NX * (z + NZ * y);
      const from = y < low ? 0 : cliffX;
      field.density.fill(255, row + from, row + NX);
      field.material.fill(MAT_SAND, row + from, row + NX);
      field.moisture.fill(30, row + from, row + NX);
      field.packing.fill(120, row + from, row + NX);
    }
  }
  field.rebuildAll();
  return field;
}

function heights(field, x0, x1, z, step = VOXEL) {
  field.flushColumns();
  const out = [];
  for (let x = x0; x <= x1 + 1e-9; x += step) out.push(field.surfaceHeightAt(x, z));
  return out;
}

function boxMass(field, x0, x1, z0, z1) {
  let m = 0;
  for (let y = 0; y < NY; y++) {
    for (let z = z0; z <= z1; z++) {
      const row = NX * (z + NZ * y);
      for (let x = x0; x <= x1; x++) m += field.density[row + x];
    }
  }
  return m;
}

const granular = { wakeBox() {} };
const moisture = { touchBox() {} };
const v0 = toVoxel(0, 0, 0);
const cliffX = Math.round(v0.x);
const cliffZ = Math.round(v0.z);

console.log('\n== Une marche de 40 cm devient une pente ==');
{
  const field = cliffField(20, 30, cliffX);
  const ctx = new EditContext(field, granular, moisture, null, null);
  const before = heights(field, -0.40, 0.40, 0);
  const massBefore = boxMass(field, cliffX - 25, cliffX + 25, cliffZ - 25, cliffZ + 25);
  const y = 1.0;
  // Douze passages de la main a intensite moyenne, soit une seconde de geste
  // a 12 Hz.
  for (let i = 0; i < 12; i++) smooth(ctx, 0, y, 0, 0.30, 0.5);
  const after = heights(field, -0.40, 0.40, 0);
  const massAfter = boxMass(field, cliffX - 25, cliffX + 25, cliffZ - 25, cliffZ + 25);

  const maxStep = (hs) => Math.max(...hs.slice(1).map((h, i) => Math.abs(h - hs[i])));
  const stepBefore = maxStep(before), stepAfter = maxStep(after);
  // Les hauteurs sont interpolees entre colonnes : une marche de 40 cm se lit
  // comme deux pas de 20 cm.
  check('la marche existait bien avant', stepBefore > 0.15, `${(stepBefore * 100).toFixed(1)} cm par voxel`);
  check('la pente maximale est divisee par trois au moins', stepAfter < stepBefore / 3,
    `${(stepAfter * 100).toFixed(1)} cm par voxel`);
  const span = after.findIndex((hh) => hh > 1.18) - after.findIndex((hh) => hh > 0.82);
  check('la pente s etale sur au moins 24 cm', span >= 6, `${span * 4} cm`);
  let monotone = true;
  for (let i = 1; i < after.length; i++) if (after[i] < after[i - 1] - 0.005) monotone = false;
  check('le profil monte sans ressaut', monotone);
  check('les deux plateaux sont conserves loin de la brosse',
    Math.abs(heights(field, -0.60, -0.60, 0)[0] - 0.80) < 0.01
    && Math.abs(heights(field, 0.60, 0.60, 0)[0] - 1.20) < 0.01);
  const rel = (massAfter - massBefore) / massBefore;
  check('le volume est conserve', Math.abs(rel) < 0.01, `${(rel * 100).toFixed(2)} %`);
  const inherited = (() => {
    const p = toVoxel(-0.05, 0.82, 0);
    const i = Math.round(p.x) + NX * (Math.round(p.z) + NZ * Math.round(p.y));
    return field.density[i] >= ISO ? { m: field.moisture[i], k: field.packing[i], mat: field.material[i] } : null;
  })();
  check('le talus comble herite de l humidite et de la compaction voisines',
    !!inherited && inherited.mat === MAT_SAND && inherited.m > 20 && inherited.k > 90,
    inherited ? `humidite ${inherited.m}, compaction ${inherited.k}` : 'pas de matiere au pied');
}

console.log('\n== Un plan reste un plan, le socle reste intact ==');
{
  const field = cliffField(20, 20, 0);
  const ctx = new EditContext(field, granular, moisture, null, null);
  const h0 = heights(field, 0, 0, 0)[0];
  for (let i = 0; i < 20; i++) smooth(ctx, 0, h0, 0, 0.40, 1.0);
  const h1 = heights(field, 0, 0, 0)[0];
  check('une surface plane ne bouge pas', Math.abs(h1 - h0) < 0.002, `${((h1 - h0) * 1000).toFixed(2)} mm`);
  // Un trou jusqu'au socle : lisser son fond ne doit pas entamer le socle.
  const thin = cliffField(FOUNDATION_LAYERS + 3, FOUNDATION_LAYERS + 3, 0);
  const ctx2 = new EditContext(thin, granular, moisture, null, null);
  const hs = heights(thin, 0, 0, 0)[0];
  for (let i = 0; i < 20; i++) smooth(ctx2, 0, hs, 0, 0.40, 1.0);
  let socle = true;
  for (let y = 0; y < FOUNDATION_LAYERS && socle; y++) {
    const row = NX * (cliffZ + NZ * y);
    for (let x = cliffX - 12; x <= cliffX + 12; x++) if (thin.density[row + x] !== 255) socle = false;
  }
  check('le socle n est pas entame', socle);
  // Une fenetre percee sous le sommet d'un mur reste une fenetre : seule la
  // partie haute d'une colonne est reecrite.
  const wall = cliffField(20, 32, cliffX);
  for (let y = 22; y <= 25; y++) for (let x = cliffX; x < cliffX + 4; x++) {
    wall.density[x + NX * (cliffZ + NZ * y)] = 0;
    wall.material[x + NX * (cliffZ + NZ * y)] = 0;
  }
  wall.rebuildAll();
  const ctx3 = new EditContext(wall, granular, moisture, null, null);
  for (let i = 0; i < 12; i++) smooth(ctx3, 0.02, 1.28, 0, 0.30, 0.5);
  let open = true;
  for (let y = 22; y <= 25; y++) for (let x = cliffX + 1; x < cliffX + 3; x++) {
    if (wall.density[x + NX * (cliffZ + NZ * y)] >= ISO) open = false;
  }
  check('une fenetre sous la crete reste ouverte', open);
}

console.log('\n== Bords du domaine et cout ==');
{
  const field = cliffField(20, 30, cliffX);
  const ctx = new EditContext(field, granular, moisture, null, null);
  let ok = true;
  try {
    const corner = toVoxel(0, 0, 0);
    const wx = -(corner.x) * VOXEL, wz = -(corner.z) * VOXEL;   // coin (0,0) du domaine
    smooth(ctx, wx, 0.8, wz, 0.5, 1.0);
    smooth(ctx, -wx, 1.2, -wz, 0.5, 1.0);
  } catch (e) { ok = false; console.log('   ', e.message); }
  check('la brosse peut deborder du domaine sans erreur', ok);
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) smooth(ctx, 0, 1.0, 0, 0.60, 1.0);
  const ms = (performance.now() - t0) / 10;
  check('un passage au rayon maximal tient sous 40 ms', ms < 40, `${ms.toFixed(1)} ms`);
}

if (failures) {
  console.log(`\n${failures} test(s) de la main en echec.`);
  process.exit(1);
}
console.log('\nTous les tests de la main passent.');
