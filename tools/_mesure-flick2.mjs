/** Quel mecanisme fait clignoter brk/foam ? */
import { VoxelField } from '../src/sim/VoxelField.js';
import { Granular } from '../src/sim/Granular.js';
import { Moisture } from '../src/sim/Moisture.js';
import { Water } from '../src/sim/Water.js';
import { generateBeach } from '../src/world/BeachGenerator.js';
import { NX, NZ, GRAVITY, WATER_EPSILON } from '../src/core/Config.js';

const COLS = NX * NZ;
const field = new VoxelField();
generateBeach(field);
const gran = new Granular(field);
const mois = new Moisture(field, gran);
const water = new Water(field, gran, mois);
water.tideSpeed = 0;
water.erosionEnabled = false;
for (let i = 0; i < 200; i++) { water.applyBoundaries(1 / 30); water.flux(1 / 60); water.integrate(1 / 60); }
water.setSeaState(3); water.setAgitation(1);
for (let i = 0; i < 60 * 20; i++) water.step(1 / 60);

const prev = new Uint8Array(COLS);
const tog = new Uint16Array(COLS);
const wetTog = new Uint16Array(COLS);   // franchissements de WATER_EPSILON
const prevWet = new Uint8Array(COLS);
const frOn = new Uint16Array(COLS);     // frames ou Froude > 1 (calcule a posteriori)
const minH = new Float32Array(COLS).fill(9);
const maxH = new Float32Array(COLS);
for (let c = 0; c < COLS; c++) { prev[c] = water.brk[c] > 0.5 ? 1 : 0; prevWet[c] = water.h[c] > WATER_EPSILON ? 1 : 0; }

for (let f = 0; f < 120; f++) {
  water.step(1 / 60);
  for (let c = 0; c < COLS; c++) {
    const b = water.brk[c] > 0.5 ? 1 : 0;
    if (b !== prev[c]) { tog[c]++; prev[c] = b; }
    const w = water.h[c] > WATER_EPSILON ? 1 : 0;
    if (w !== prevWet[c]) { wetTog[c]++; prevWet[c] = w; }
    const hw = water.h[c];
    if (hw < minH[c]) minH[c] = hw;
    if (hw > maxH[c]) maxH[c] = hw;
    if (hw > WATER_EPSILON) {
      const sp = Math.hypot(water.vx[c], water.vz[c]);
      const cel = Math.sqrt(GRAVITY * hw);
      if (sp / (cel > 0.04 ? cel : 0.04) > 1) frOn[c]++;
    }
  }
}

// classe les cellules a fort basculement
let flick = 0, flickWetDry = 0, flickWetFroude = 0, flickOther = 0;
const hist = [];
for (let c = 0; c < COLS; c++) {
  if (tog[c] <= 8) continue;
  flick++;
  if (wetTog[c] > 4) flickWetDry++;
  else if (frOn[c] > 20) flickWetFroude++;
  else flickOther++;
  if (hist.length < 12) hist.push({ c, tog: tog[c], wetTog: wetTog[c], frOn: frOn[c], minH: +minH[c].toFixed(4), maxH: +maxH[c].toFixed(4), shore: +water.shore[c].toFixed(2) });
}
console.log(`brk>8 basculements : ${flick} cellules | sec/mouille ${flickWetDry} | Froude(mouille) ${flickWetFroude} | autre ${flickOther}`);
console.log(hist.map((h) => JSON.stringify(h)).join('\n'));
