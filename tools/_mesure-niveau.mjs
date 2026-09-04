/** Profil du niveau moyen en fonction de la distance au rivage, sous "Houle". */
import { VoxelField } from '../src/sim/VoxelField.js';
import { Granular } from '../src/sim/Granular.js';
import { Moisture } from '../src/sim/Moisture.js';
import { Water } from '../src/sim/Water.js';
import { generateBeach } from '../src/world/BeachGenerator.js';
import { NX, NZ } from '../src/core/Config.js';

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

for (let i = 0; i < 60 * 30; i++) water.step(1 / 60);

// moyenne temporelle par bin de distance, sur 60 s
const BINS = 16;
const sum = new Float64Array(BINS), cnt = new Float64Array(BINS);
for (let i = 0; i < 60 * 60; i++) {
  water.step(1 / 60);
  if (i % 4) continue;
  for (let c = 0; c < COLS; c++) {
    if (water.h[c] < 0.02) continue;
    const d = water.shore[c];             // >0 cote terre
    const b = Math.floor((-d + 1) / 0.5); // bins de 0,5 m depuis d=+1 vers le large
    if (b < 0 || b >= BINS) continue;
    sum[b] += field.surfaceH[c] + water.h[c];
    cnt[b] += 1;
  }
}
console.log(`tideLevel ${water.tideLevel.toFixed(3)}  waveSetup ${water.waveSetup.toFixed(3)}  seaLevel ${water.seaLevel.toFixed(3)}`);
console.log(`bande : sGenInner ${water.waves.sGenInner.toFixed(2)} m, hGen ${water.waves.hGen.toFixed(2)}`);
for (let b = 0; b < BINS; b++) {
  if (!cnt[b]) continue;
  const d = 1 - (b + 0.5) * 0.5;
  console.log(`d=${d.toFixed(2).padStart(6)} m : niveau moyen ${(sum[b] / cnt[b]).toFixed(4)} m (${(sum[b] / cnt[b] - water.tideLevel) * 100 > 0 ? '+' : ''}${((sum[b] / cnt[b] - water.tideLevel) * 100).toFixed(1)} cm vs maree)`);
}
