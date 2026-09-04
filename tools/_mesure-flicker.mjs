/**
 * Mesure AVANT correction :
 *  A. clignotement de l'ecume : basculements 0<->1 par cellule sur 120 frames
 *  B. fosse au bord de l'eau : niveau du plan d'eau, variance sur 5 s
 *  C. dilatation du niveau de rendu : nappe fantome au-dessus des parois
 */
import { VoxelField } from '../src/sim/VoxelField.js';
import { Granular } from '../src/sim/Granular.js';
import { Moisture } from '../src/sim/Moisture.js';
import { Water } from '../src/sim/Water.js';
import { generateBeach } from '../src/world/BeachGenerator.js';
import { NX, NZ, VOXEL } from '../src/core/Config.js';

const COLS = NX * NZ;

// ---------- A. flicker d'ecume sous "Houle" --------------------------------
{
  const field = new VoxelField();
  generateBeach(field);
  const gran = new Granular(field);
  const mois = new Moisture(field, gran);
  const water = new Water(field, gran, mois);
  water.tideSpeed = 0;
  water.erosionEnabled = false;
  for (let i = 0; i < 200; i++) { water.applyBoundaries(1 / 30); water.flux(1 / 60); water.integrate(1 / 60); }
  water.setSeaState(3); water.setAgitation(1);
  for (let i = 0; i < 60 * 20; i++) water.step(1 / 60);   // regime etabli

  const prev = new Uint8Array(COLS);
  const toggles = new Uint16Array(COLS);
  for (let c = 0; c < COLS; c++) prev[c] = water.foam[c] > 0.15 ? 1 : 0;
  for (let f = 0; f < 120; f++) {
    water.step(1 / 60);
    for (let c = 0; c < COLS; c++) {
      const b = water.foam[c] > 0.15 ? 1 : 0;
      if (b !== prev[c]) { toggles[c]++; prev[c] = b; }
    }
  }
  let max = 0, over4 = 0, over8 = 0, any = 0;
  for (let c = 0; c < COLS; c++) {
    if (toggles[c] > max) max = toggles[c];
    if (toggles[c] > 4) over4++;
    if (toggles[c] > 8) over8++;
    if (toggles[c] > 0) any++;
  }
  console.log(`A. foam toggles/120f : max=${max}  cellules>4=${over4}  >8=${over8}  actives=${any}`);

  // idem sur brk
  const prevB = new Uint8Array(COLS), togB = new Uint16Array(COLS);
  for (let c = 0; c < COLS; c++) prevB[c] = water.brk[c] > 0.5 ? 1 : 0;
  for (let f = 0; f < 120; f++) {
    water.step(1 / 60);
    for (let c = 0; c < COLS; c++) {
      const b = water.brk[c] > 0.5 ? 1 : 0;
      if (b !== prevB[c]) { togB[c]++; prevB[c] = b; }
    }
  }
  let maxB = 0, overB = 0;
  for (let c = 0; c < COLS; c++) { if (togB[c] > maxB) maxB = togB[c]; if (togB[c] > 8) overB++; }
  console.log(`A. brk  toggles/120f : max=${maxB}  cellules>8=${overB}`);
}

// ---------- B. fosse au bord de l'eau, mer d'huile -------------------------
{
  const field = new VoxelField();
  generateBeach(field);
  const gran = new Granular(field);
  const mois = new Moisture(field, gran);
  const water = new Water(field, gran, mois);
  water.tideSpeed = 0;
  water.erosionEnabled = false;
  for (let i = 0; i < 200; i++) { water.applyBoundaries(1 / 30); water.flux(1 / 60); water.integrate(1 / 60); }
  water.setSeaState(0);

  // fosse a ~1,2 m du rivage
  let bestC = -1, bestE = 9;
  for (let z = 30; z < NZ - 30; z++) for (let x = 30; x < NX - 30; x++) {
    const c = x + NX * z;
    const e = Math.abs(water.shore[c] - 1.2);
    if (e < bestE) { bestE = e; bestC = c; }
  }
  const cx = bestC % NX, cz = (bestC / NX) | 0;
  const pitCells = [];
  for (let dz = -8; dz <= 8; dz++) for (let dx = -8; dx <= 8; dx++) {
    if (dx * dx + dz * dz > 64) continue;
    const x = cx + dx, z = cz + dz;
    const col = x + NX * z;
    let y = field.topY[col];
    for (let k = 0; k < 15 && y >= 0; k++, y--) field.set(x, y, z, 0); // 60 cm
    if (dx * dx + dz * dz <= 25) pitCells.push(col);
  }
  field.flushColumns();
  console.log(`B. fosse: terrain apres creusement ${field.surfaceH[bestC].toFixed(3)} m, ` +
    `nappe locale ${water.tableH[bestC].toFixed(3)} m, mer ${water.seaLevel.toFixed(3)} m`);

  const levels = [];
  const foamMax = [];
  for (let i = 0; i < 60 * 35; i++) {
    water.step(1 / 60);
    if (i >= 60 * 30) {
      let lvl = -9, fm = 0, wet = 0;
      for (const c of pitCells) {
        if (water.h[c] > 0.004) { wet++; const l = field.surfaceH[c] + water.h[c]; if (l > lvl) lvl = l; }
        if (water.foam[c] > fm) fm = water.foam[c];
      }
      levels.push(lvl); foamMax.push(fm);
    }
    if (i === 60 * 5 - 1 || i === 60 * 15 - 1 || i === 60 * 30 - 1) {
      let lvl = -9;
      for (const c of pitCells) if (water.h[c] > 0.004) { const l = field.surfaceH[c] + water.h[c]; if (l > lvl) lvl = l; }
      console.log(`B. t=${((i + 1) / 60).toFixed(0)}s niveau fosse = ${lvl.toFixed(3)} m`);
    }
  }
  const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
  const varc = levels.reduce((a, b) => a + (b - mean) * (b - mean), 0) / levels.length;
  console.log(`B. 5 dernieres s : niveau moyen ${mean.toFixed(4)} m (nappe ${water.tableH[bestC].toFixed(3)}), ` +
    `ecart-type ${(Math.sqrt(varc) * 1000).toFixed(2)} mm, foam max ${Math.max(...foamMax).toFixed(3)}`);

  // C. dilatation : simule buildRenderLevel (max) et compte les cellules seches
  // dont le niveau dilate depasse leur PROPRE terrain (nappe fantome).
  const lvl = new Float32Array(COLS), tmp = new Float32Array(COLS);
  for (let c = 0; c < COLS; c++) lvl[c] = water.h[c] > 0.0015 ? field.surfaceH[c] + water.h[c] : -1e9;
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
  let ghost = 0, ghostPit = 0;
  for (let c = 0; c < COLS; c++) {
    if (water.h[c] > 0.0015 || lvl[c] < -1e8) continue;
    if (lvl[c] > field.surfaceH[c] + 0.02) {
      ghost++;
      const x = c % NX, z = (c / NX) | 0;
      if (Math.abs(x - cx) <= 12 && Math.abs(z - cz) <= 12) ghostPit++;
    }
  }
  console.log(`C. nappe fantome (niveau dilate > terrain+2cm sur cellule seche) : ${ghost} cellules, dont ${ghostPit} autour de la fosse`);
}
