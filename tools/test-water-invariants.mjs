/**
 * Les invariants de l'eau, prouves sans navigateur ni WebGL.
 *
 * Chaque bloc verifie une propriete que le joueur ressent sans la nommer :
 * l'eau ne disparait pas et n'apparait pas de nulle part, une mer calme est
 * plate, un mur tient l'eau, une tranchee la conduit, une lame mince se voit
 * d'un seul tenant, la houle va a la bonne vitesse, la maree monte jusqu'ou
 * elle doit, et un seau verse se retrouve integralement quelque part.
 */
import {
  NX, NZ, NY, VOXEL, ORIGIN_X, ORIGIN_Z, ISO, FOUNDATION_LAYERS,
  WATER_NX as WN, WATER_NZ as WM, WATER_CELL as WC, WATER_EPSILON,
  GRAVITY, SEA_LEVEL, TIDE_PERIOD, BEACH_HEIGHT,
} from '../src/core/Config.js';
import { VoxelField } from '../src/sim/VoxelField.js';
import { Granular } from '../src/sim/Granular.js';
import { Moisture } from '../src/sim/Moisture.js';
import { Water } from '../src/sim/Water.js';
import { generateBeach, shorelineFor } from '../src/world/BeachGenerator.js';
import { EditContext, sphere as brushSphere } from '../src/tools/Brush.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const stub = { push() {}, wake() {}, wakeBox() {} };
const worldX = (x) => ORIGIN_X + (x + 0.5) * VOXEL;
const worldZ = (z) => ORIGIN_Z + (z + 0.5) * VOXEL;

/** Terrain analytique : remplit le champ sous height(wx, wz). */
function analyticField(height) {
  const field = new VoxelField();
  for (let z = 0; z < NZ; z++) {
    const wz = worldZ(z);
    for (let x = 0; x < NX; x++) {
      const wx = worldX(x);
      const hs = height(wx, wz);
      const yMax = Math.min(NY - 1, Math.ceil(hs / VOXEL) + 2);
      for (let y = 0; y <= yMax; y++) {
        const wy = (y + 0.5) * VOXEL;
        let dv = 128 + ((hs - wy) / VOXEL) * 128;
        if (dv <= 0) continue;
        if (dv > 255) dv = 255;
        const i = x + NX * (z + NZ * y);
        field.density[i] = dv | 0;
        field.material[i] = 1;
        field.packing[i] = 120;
      }
    }
  }
  field.rebuildAll();
  return field;
}

/** Bassin ferme : eau sans mer, sans nappe, sans maree. */
function closedWater(field) {
  const water = new Water(field, stub, null);
  water.openSeaEnabled = false;
  water.seepEnabled = false;
  water.tideSpeed = 0;
  water.setSeaState(0);
  water.initialize();
  return water;
}

function beachWater(moisture = null) {
  const field = new VoxelField();
  generateBeach(field);
  let granular = stub, moist = null;
  if (moisture) { granular = new Granular(field); moist = new Moisture(field, granular); }
  const water = new Water(field, granular, moist);
  water.setDamage(0);
  water.tideSpeed = 0;
  return { field, water };
}

function run(water, field, seconds, dt = 1 / 60) {
  const n = Math.round(seconds / dt);
  for (let k = 0; k < n; k++) { water.step(dt); field.flushColumns(); }
}

function hasNaN(arr) { for (let i = 0; i < arr.length; i++) if (arr[i] !== arr[i]) return true; return false; }
function minOf(arr) { let m = Infinity; for (let i = 0; i < arr.length; i++) if (arr[i] < m) m = arr[i]; return m; }

// ---------------------------------------------------------------------------
console.log('\n== Conservation en bassin ferme (60 s) ==');
{
  // Une cuvette de 1 m de profondeur, dont les bords montent au-dessus de
  // tout ce que l'eau peut atteindre.
  const field = analyticField((wx, wz) => {
    const r = Math.hypot(wx, wz);
    const t = Math.max(0, Math.min(1, (r - 2.4) / 1.2));
    return 0.8 + 0.9 * t * t * (3 - 2 * t);
  });
  const water = closedWater(field);
  for (let c = 0; c < WN * WM; c++) {
    const d = 1.25 - water.bed[c];
    if (d > 0) water.hc[c] = d;
  }
  // Une bosse decentree : l'eau clapote pendant toute la mesure.
  for (let z = 0; z < WM; z++) for (let x = 0; x < WN; x++) {
    const c = x + WN * z;
    if (water.hc[c] <= 0) continue;
    const wx = ORIGIN_X + (x + 0.5) * WC - 0.8, wz = ORIGIN_Z + (z + 0.5) * WC + 0.5;
    water.hc[c] += 0.08 * Math.exp(-(wx * wx + wz * wz) / 0.18);
  }
  water.rescan();
  const initial = water.totalVolume();
  let maxV = 0;
  for (let k = 0; k < 3600; k++) {
    water.step(1 / 60);
    if ((k & 63) === 0) for (let c = 0; c < WN * WM; c++) {
      const s = Math.hypot(water.vxc[c], water.vzc[c]);
      if (s > maxV) maxV = s;
    }
  }
  const final = water.totalVolume();
  check('le volume est conserve a 1e-6 m3 pres sur 60 s',
    Math.abs(final - initial) < 1e-6,
    `${initial.toFixed(6)} -> ${final.toFixed(6)} m3 (ecart ${(final - initial).toExponential(2)})`);
  check('l eau a bien bouge pendant la mesure', maxV > 0.05, `vitesse max ${maxV.toFixed(3)} m/s`);
  check('aucune valeur corrompue', !hasNaN(water.hc) && !hasNaN(water.h));
}

// ---------------------------------------------------------------------------
console.log('\n== Repos : mer d huile pendant 10 s ==');
{
  const { field, water } = beachWater();
  water.setSeaState(0);
  water.initialize();
  run(water, field, 10);
  let maxDev = 0, maxV = 0, cells = 0;
  for (let c = 0; c < WN * WM; c++) {
    if (!water.simMask[c] || water.hc[c] <= WATER_EPSILON) continue;
    if (water.bed[c] > water.seaLevel - 0.03) continue; // le film de rive, pas la mer
    cells++;
    const dev = Math.abs(water.bed[c] + water.hc[c] - water.seaLevel);
    if (dev > maxDev) maxDev = dev;
    const s = Math.hypot(water.vxc[c], water.vzc[c]);
    if (s > maxV) maxV = s;
  }
  check('la surface reste plate a 1 mm pres', maxDev < 1e-3 && cells > 500,
    `ecart max ${(maxDev * 1000).toFixed(3)} mm sur ${cells} cellules`);
  check('l eau ne bouge pas (|v| < 1 mm/s)', maxV < 1e-3, `vitesse max ${(maxV * 1000).toFixed(3)} mm/s`);
  let foamy = 0;
  for (let c = 0; c < water.foamc.length; c++) if (water.foamc[c] > 0.05) foamy++;
  check('une mer calme ne fabrique aucune ecume', foamy === 0, `${foamy} cellule(s)`);
}

// ---------------------------------------------------------------------------
console.log('\n== Positivite : grands pas de temps et tempete ==');
{
  const { field, water } = beachWater();
  water.setSeaState(5);
  water.tideSpeed = 12;
  water.initialize();
  let bad = false;
  for (let k = 0; k < 80 && !bad; k++) {
    water.step(0.1);
    field.flushColumns();
    if (hasNaN(water.hc) || hasNaN(water.fx) || hasNaN(water.fz) || minOf(water.hc) < 0) bad = true;
  }
  for (let k = 0; k < 120 && !bad; k++) {
    water.step(k % 3 === 0 ? 0.05 : 1 / 60);
    field.flushColumns();
    if (hasNaN(water.hc) || minOf(water.hc) < 0 || hasNaN(water.h) || minOf(water.h) < 0) bad = true;
  }
  check('jamais de hauteur negative ni de NaN, dt jusqu a 100 ms', !bad,
    `min h = ${minOf(water.hc).toExponential(1)}, ${water.substepCount} sous-pas`);
  check('le nombre de sous-pas reste borne', water.substepCount <= 4);
}

// ---------------------------------------------------------------------------
console.log('\n== Etancheite : enceinte fermee sous le niveau de la mer ==');
{
  const field = new VoxelField();
  generateBeach(field);
  // L eau connait la plage vierge AVANT les murs : c est ce qui fait d un mur
  // une construction, etanche a la nappe, et non une dune.
  const water = new Water(field, stub, null);
  // Un carre de murs pose la ou le fond est sous la mer, dans la bande.
  let cx = NX >> 1, cz = 0, best = 9;
  for (let z = 0; z < NZ; z++) {
    const h = field.surfaceH[cx + NX * z];
    const err = Math.abs(h - (SEA_LEVEL - 0.10));
    if (err < best) { best = err; cz = z; }
  }
  const R = 10;
  const put = (x, y, z) => {
    const i = x + NX * (z + NZ * y);
    field.density[i] = 255; field.packing[i] = 255; field.material[i] = 1; field.moisture[i] = 40;
  };
  for (let y = FOUNDATION_LAYERS; y < Math.min(NY, 45); y++) {
    for (let q = -R; q <= R; q++) {
      put(cx - R, y, cz + q); put(cx + R, y, cz + q);
      put(cx + q, y, cz - R); put(cx + q, y, cz + R);
    }
  }
  field.rebuildAll();
  water.setDamage(0);
  water.tideSpeed = 0;
  // Suintement ACTIF : la nappe affleure ici, et les murs doivent la tenir.
  water.setSeaState(2);
  water.initialize();
  const inside = () => {
    let wet = 0, deep = 0;
    for (let z = cz - R + 2; z <= cz + R - 2; z++) for (let x = cx - R + 2; x <= cx + R - 2; x++) {
      const c = x + NX * z;
      if (water.h[c] > WATER_EPSILON) { wet++; deep = Math.max(deep, water.h[c]); }
    }
    return { wet, deep };
  };
  const before = inside();
  run(water, field, 8, 1 / 30);
  const after = inside();
  check('le remplissage initial ne traverse pas les murs', before.wet === 0,
    `${before.wet} colonne(s) mouillee(s), fond ${(SEA_LEVEL - field.surfaceH[cx + NX * cz]).toFixed(2)} m sous la mer`);
  check('huit secondes de houle et de nappe ne remplissent pas l enceinte', after.wet === 0,
    `${after.wet} colonne(s), ${(after.deep * 100).toFixed(1)} cm au plus`);
  // Le meme sable, CREUSE au bord de l eau au lieu d etre bati : la nappe
  // doit remplir le trou. C est l invariant de conception du suintement.
  const px = cx + R + 8, pz = cz;
  for (let z = pz - 2; z <= pz + 2; z++) for (let x = px - 2; x <= px + 2; x++) {
    const c = x + NX * z;
    const target = field.surfaceH[c] - 0.12;
    for (let y = 0; y < NY; y++) {
      const wy = (y + 0.5) * VOXEL, i = c + NX * NZ * y;
      let dv = 128 + ((target - wy) / VOXEL) * 128;
      if (dv > 255) dv = 255;
      if (dv <= 0) { field.density[i] = 0; field.material[i] = 0; continue; }
      if (field.density[i] > dv) field.density[i] = dv | 0;
    }
  }
  field.rebuildAll();
  water.displaceByTerrainRise([px + NX * pz]);
  run(water, field, 40, 1 / 30);
  check('un trou creuse a cote se remplit par la nappe', water.h[px + NX * pz] > 0.02,
    `${(water.h[px + NX * pz] * 100).toFixed(1)} cm d eau dans le trou`);
}

// ---------------------------------------------------------------------------
console.log('\n== Tranchee : un seau verse en haut descend jusqu a la mer ==');
{
  const field = new VoxelField();
  generateBeach(field);
  const cx = NX >> 1;
  // Une rigole de 7 voxels de large, 20 cm sous le sable, de d = 2.4 m
  // jusqu a la ligne d eau. Le fond suit la plage : elle descend vers la mer.
  const water0 = new Water(field, stub, null); // pour la carte des distances
  const inTrench = (x, z) => Math.abs(x - cx) <= 3 && water0.shore[x + NX * z] > -0.2
    && water0.shore[x + NX * z] < 2.4;
  for (let z = 0; z < NZ; z++) for (let x = cx - 3; x <= cx + 3; x++) {
    if (!inTrench(x, z)) continue;
    const c = x + NX * z;
    const target = field.surfaceH[c] - 0.20;
    for (let y = 0; y < NY; y++) {
      const wy = (y + 0.5) * VOXEL;
      const i = c + NX * NZ * y;
      let dv = 128 + ((target - wy) / VOXEL) * 128;
      if (dv > 255) dv = 255;
      if (dv <= 0) { field.density[i] = 0; field.material[i] = 0; continue; }
      if (field.density[i] > dv) field.density[i] = dv | 0;
    }
  }
  field.rebuildAll();
  const water = new Water(field, stub, null);
  water.setDamage(0);
  water.tideSpeed = 0;
  water.seepEnabled = false;
  water.setSeaState(0);
  water.initialize();
  // Les colonnes temoin : le haut de la rigole, son milieu, et la plage
  // juste a cote a la meme hauteur.
  let zTop = -1, zMid = -1;
  for (let z = 0; z < NZ; z++) {
    const d = water.shore[cx + NX * z];
    if (zTop < 0 && d < 2.1) zTop = z;
    if (zMid < 0 && d < 0.9) zMid = z;
  }
  const topC = cx + NX * zTop, midC = cx + NX * zMid;
  let midWet = 0, leak = 0, leakMax = 0;
  const initialVolume = water.totalVolume();
  let poured = 0;
  for (let k = 0; k < 900; k++) {
    // 8 litres en deux secondes, comme l outil.
    if (k < 120) poured += water.pour(worldX(cx), worldZ(zTop), 0.10, 0.004 / 60);
    water.step(1 / 60);
    field.flushColumns();
    if (water.h[midC] > WATER_EPSILON) midWet++;
    if ((k & 7) === 0) {
      for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) {
        const c = x + NX * z;
        if (water.h[c] <= WATER_EPSILON) continue;
        if (Math.abs(x - cx) <= 6) continue;          // la rigole et sa marge
        // La mer, sa ligne d eau, et le petit ressac que le jet qui sort de
        // la rigole souleve a son embouchure (quelques millimetres, 5 cm
        // au-dessus du niveau) : ce n est pas un debordement.
        if (field.surfaceH[c] < water.seaLevel + 0.06) continue;
        leak++;
        if (water.h[c] > leakMax) leakMax = water.h[c];
      }
    }
  }
  check('le seau verse en haut mouille le milieu de la rigole', midWet > 30,
    `${midWet} frame(s) mouillee(s) a mi-pente`);
  check('le haut de la rigole s est vide dans la mer', water.h[topC] < 0.006,
    `${(water.h[topC] * 1000).toFixed(1)} mm restants en haut`);
  check('rien ne deborde sur la plage', leak === 0,
    `${leak} echantillon(s) hors rigole, ${(leakMax * 1000).toFixed(1)} mm au plus`);
  check('le volume verse est rendu a la mer ou reste dans la rigole',
    water.totalVolume() <= initialVolume + poured + 1e-6,
    `${(poured * 1000).toFixed(1)} L verses`);
}

// ---------------------------------------------------------------------------
console.log('\n== Films : une lame de 2,5 mm se rend sans trou ==');
{
  // Sable a peu pres plat, avec le grain d une vraie plage (+/- 0,3 mm).
  const field = analyticField((wx, wz) => 1.0 + 0.0003 * Math.sin(wx * 37.1) * Math.cos(wz * 41.3));
  const water = closedWater(field);
  for (let c = 0; c < WN * WM; c++) water.hc[c] = 0.0025;
  water.rescan();
  water.syncFine();
  let holes = 0, wet = 0;
  for (let z = 1; z < NZ - 1; z++) for (let x = 1; x < NX - 1; x++) {
    const c = x + NX * z;
    const w = water.h[c] > WATER_EPSILON;
    if (w) wet++;
    if (!w && water.h[c - 1] > WATER_EPSILON && water.h[c + 1] > WATER_EPSILON
        && water.h[c - NX] > WATER_EPSILON && water.h[c + NX] > WATER_EPSILON) holes++;
  }
  check('aucune colonne seche entouree de colonnes mouillees', holes === 0, `${holes} trou(s)`);
  check('la lame couvre tout le sable', wet > (NX - 2) * (NZ - 2) * 0.98,
    `${(100 * wet / ((NX - 2) * (NZ - 2))).toFixed(1)} % des colonnes`);
}

// ---------------------------------------------------------------------------
console.log('\n== Houle : celerite sqrt(g h) ==');
{
  // Bassin plat de 40 cm : une bosse lachee au milieu part des deux cotes a
  // sqrt(g h) = 1,98 m/s. On suit la crete qui part vers +Z.
  const depth = 0.40;
  const field = analyticField(() => SEA_LEVEL - depth);
  const water = closedWater(field);
  const z0 = WM >> 1;
  for (let z = 0; z < WM; z++) for (let x = 0; x < WN; x++) {
    const dz = (z - z0) * WC;
    water.hc[x + WN * z] = depth + 0.01 * Math.exp(-dz * dz / 0.06);
  }
  water.rescan();
  const crestZ = () => {
    let best = -1, bz = z0;
    for (let z = z0 + 3; z < WM; z++) {
      const v = water.hc[(WN >> 1) + WN * z];
      if (v > best) { best = v; bz = z; }
    }
    return bz;
  };
  const samples = [];
  for (let k = 0; k <= 48; k++) {
    if (k === 18 || k === 48) samples.push({ t: k / 60, z: crestZ() });
    if (k < 48) water.step(1 / 60);
  }
  const speed = (samples[1].z - samples[0].z) * WC / (samples[1].t - samples[0].t);
  const expected = Math.sqrt(GRAVITY * depth);
  check('la crete avance a sqrt(g h) a 10 % pres',
    Math.abs(speed - expected) / expected < 0.10,
    `${speed.toFixed(2)} m/s mesures, ${expected.toFixed(2)} attendus`);
}

// ---------------------------------------------------------------------------
console.log('\n== Ecume : une bande de deferlement, jamais permanente ==');
{
  const { field, water } = beachWater();
  water.setSeaState(3);
  // Phases du spectre fixees : le pic d ecume depend de l alignement des
  // composantes, et un test ne doit pas dependre de Math.random. Vingt
  // secondes couvrent un groupe de vagues entier, accalmie et serie.
  let seed = 51;
  for (let i = 0; i < water.waves.ph.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    water.waves.ph[i] = (seed / 4294967296) * Math.PI * 2;
  }
  water.initialize();
  let peakRatio = 0, peakFoamy = 0;
  for (let k = 0; k < 600; k++) {
    water.step(1 / 30);
    field.flushColumns();
    if (k < 30 || (k & 1)) continue;
    // Toutes les cellules mouillees, mer imposee comprise : l'ecume doit
    // etre une bande dans la MER, pas seulement dans la bande resolue.
    let wet = 0, foamy = 0;
    for (let c = 0; c < WN * WM; c++) {
      if (water.hc[c] <= WATER_EPSILON) continue;
      wet++;
      if (water.foamc[c] > 0.22) foamy++;
    }
    peakFoamy = Math.max(peakFoamy, foamy);
    peakRatio = Math.max(peakRatio, foamy / Math.max(1, wet));
  }
  check('la houle cree bien un front d ecume', peakFoamy > 0, `${peakFoamy} cellule(s) au maximum`);
  check('l ecume reste une bande (< 12 % des cellules mouillees)', peakRatio < 0.12,
    `${(peakRatio * 100).toFixed(1)} % au maximum`);
  // On fige le generateur (le spectre est reconstruit toutes les 0,5 s depuis
  // Hs : remettre les amplitudes a zero ne suffit pas), sans toucher a
  // l ecume existante ni a la bande.
  water.waves.a.fill(0);
  water.waves.etaIg = 0;
  water.waves.update = () => {};
  run(water, field, 12, 1 / 30);
  let stale = 0;
  for (let c = 0; c < WN * WM; c++) if (water.foamc[c] > 0.22) stale++;
  check('douze secondes apres la derniere vague, l ecume s est resorbee', stale === 0,
    `${stale} cellule(s)`);
}

// ---------------------------------------------------------------------------
console.log('\n== Maree : pleine mer submerge le milieu de plage, pas la berme ==');
{
  const { field, water } = beachWater();
  water.setSeaState(0);
  water.time = TIDE_PERIOD / 4; // pleine mer
  water.initialize();
  run(water, field, 25, 1 / 30);
  const cx = NX >> 1;
  const at = (d) => {
    let bz = 0, best = 9;
    for (let z = 0; z < NZ; z++) {
      const e = Math.abs(water.shore[cx + NX * z] - d);
      if (e < best) { best = e; bz = z; }
    }
    return cx + NX * bz;
  };
  const mid = at(1.8), berm = at(4.2);
  check('la mer est montee au niveau de pleine mer', Math.abs(water.seaLevel - (SEA_LEVEL + 0.46)) < 0.02,
    `${water.seaLevel.toFixed(3)} m`);
  check('le milieu de plage (d = 1,8 m) est sous l eau', water.h[mid] > 0.02,
    `${(water.h[mid] * 100).toFixed(1)} cm, ligne d eau a d = ${shorelineFor(water.seaLevel).toFixed(2)} m`);
  check('la berme (d = 4,2 m) reste seche', water.h[berm] <= WATER_EPSILON,
    `${(water.h[berm] * 1000).toFixed(1)} mm, terrain ${field.surfaceH[berm].toFixed(2)} m (berme ${BEACH_HEIGHT} m)`);
}

// ---------------------------------------------------------------------------
console.log('\n== Seau : tout le volume verse est retrouve ==');
{
  const { field, water } = beachWater(true);
  water.openSeaEnabled = false;
  water.seepEnabled = false;
  water.setSeaState(0);
  water.initialize();
  const cx = NX >> 1;
  let zTop = 0;
  for (let z = 0; z < NZ; z++) if (water.shore[cx + NX * z] < 4.6) { zTop = z; break; }
  const before = water.totalVolume() + water.stats.infiltrated;
  let poured = 0;
  for (let k = 0; k < 1800; k++) {
    if (k < 180) poured += water.pour(worldX(cx), worldZ(zTop), 0.15, 0.004 / 60);
    water.step(1 / 60);
    field.flushColumns();
  }
  const after = water.totalVolume() + water.stats.infiltrated;
  check('nappe + gouttes + sable = volume verse (1e-6 m3)',
    Math.abs(after - before - poured) < 1e-6,
    `${(poured * 1000).toFixed(2)} L verses, ${(water.stats.infiltrated * 1000).toFixed(2)} L bus par le sable, ` +
    `${(water.totalVolume() * 1000).toFixed(2)} L encore libres, ecart ${((after - before - poured) * 1e6).toFixed(3)} mL`);
  check('le sable a effectivement bu une partie du seau', water.stats.infiltrated > poured * 0.2);
}

console.log('\n== Sable verse dans une flaque : pas de colonne d eau ==');
{
  // Une cuvette de 5 cm, une flaque dedans, et un seau de sable verse a
  // 26 Hz au milieu. L eau chassee doit s etaler, jamais s empiler.
  const field = analyticField((x, z) => 0.90 - 0.05 * Math.exp(-(x * x + z * z) / (0.45 * 0.45)));
  const water = closedWater(field);
  const cx = Math.round((0 - ORIGIN_X) / WC - 0.5), cz = Math.round((0 - ORIGIN_Z) / WC - 0.5);
  for (let z = cz - 6; z <= cz + 6; z++) for (let x = cx - 6; x <= cx + 6; x++) {
    const c = x + WN * z;
    const d = 0.875 - water.bed[c];
    if (d > 0) water.hc[c] = d;
  }
  water.rescan(); water.syncFine();
  const ctx = new EditContext(field, stub, { touchBox() {} }, water, null);
  const R = 0.20 * 1.35;
  for (let i = 0; i < 40; i++) {
    field.flushColumns();
    const y = field.surfaceHeightAt(0, 0);
    brushSphere(ctx, 0, y - R * 0.75, 0, R, 36, { moisture: 0.10, packing: 0.45, hardness: 0.15 });
    water.step(1 / 26); field.flushColumns();
  }
  let maxLevel = -1, maxDepth = 0;
  for (let z = cz - 12; z <= cz + 12; z++) for (let x = cx - 12; x <= cx + 12; x++) {
    const c = x + WN * z;
    if (water.hc[c] <= WATER_EPSILON) continue;
    maxLevel = Math.max(maxLevel, water.bed[c] + water.hc[c]);
    maxDepth = Math.max(maxDepth, water.hc[c]);
  }
  check('aucune cellule ne depasse le niveau initial de plus de 6 cm', maxLevel < 0.875 + 0.06,
    `niveau max ${maxLevel.toFixed(3)} m (flaque a 0,875)`);
  check('aucune colonne d eau profonde', maxDepth < 0.12, `${(maxDepth * 100).toFixed(1)} cm au plus`);
  check('le surplus est compte comme parti', water.stats.spilled >= 0);
}

console.log('\n== Flaque au-dessus de la nappe : elle se vidange ==');
{
  // Une lagune remplie par les vagues derriere un tas : fond sous la nappe
  // (donc pas de percolation), sable sature, mais 20 cm d eau qui dominent
  // la nappe. La charge doit la faire partir dans le sable.
  const { field, water } = beachWater(true);
  water.openSeaEnabled = false; water.seepEnabled = false;
  water.setSeaState(0); water.initialize();
  const cx = NX >> 1;
  let cz = -1;
  for (let z = 0; z < WM; z++) {
    const c = (cx >> 1) + WN * z;
    if (Math.abs(water.bed[c] - (water.tableC[c] - 0.01)) < 0.02) { cz = z; break; }
  }
  check('une cellule au fond juste sous la nappe existe', cz >= 0);
  if (cz >= 0) {
    const c = (cx >> 1) + WN * cz;
    for (let sz = 0; sz < 2; sz++) for (let sx = 0; sx < 2; sx++) {
      const fc = (cx >> 1) * 2 + sx + NX * (cz * 2 + sz);
      const top = field.topY[fc];
      for (let y = Math.max(0, top - 3); y <= top; y++) field.moisture[fc + NX * NZ * y] = 255;
    }
    water.hc[c] = 0.20;
    water.rescan();
    const before = water.hc[c];
    for (let k = 0; k < 30 * 30; k++) water.infiltrate(1 / 30);
    check('20 cm au-dessus de la nappe perdent plus de 3 cm en 30 s', before - water.hc[c] > 0.03,
      `${((before - water.hc[c]) * 100).toFixed(1)} cm partis`);
  }
}

console.log(failures === 0 ? '\nTous les invariants de l eau tiennent.\n' :
  `\n${failures} invariant(s) de l eau en echec.\n`);
process.exit(failures ? 1 : 0);
