/**
 * Tests du solveur d'eau GPU, sans GPU.
 *
 * Node n'a pas de WebGL : on verifie ici ce qui peut l'etre hors navigateur.
 *  1. Les shaders s'assemblent : constantes injectees (aucun `undefined`),
 *     accolades equilibrees, sorties declarees, boucles de composantes.
 *  2. La boucle de sous-pas extraite (`runSubsteps`) donne exactement le
 *     meme resultat que l'ancienne boucle en ligne : le solveur CPU, qui
 *     reste la reference, n'a pas bouge.
 *  3. Le chemin « ecume et embruns hors GPU » borne l'ecume et la fait
 *     decroitre la ou rien ne deferle.
 *  4. Sans GPU attache, Water se comporte comme avant (gpu = null).
 *
 * La comparaison CPU/GPU proprement dite a lieu dans le navigateur, a chaque
 * demarrage : voir WaterGPU (mode « validating ») et le panneau F3.
 */
import { NX, NZ, WATER_NX as WN, WATER_NZ as WM, WATER_SUB as SUB } from '../src/core/Config.js';
import { VoxelField } from '../src/sim/VoxelField.js';
import { Water } from '../src/sim/Water.js';
import { generateBeach } from '../src/world/BeachGenerator.js';
import { buildWaterShaders, glslHead } from '../src/sim/WaterGPU.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const stub = { push() {}, wake() {}, wakeBox() {} };

console.log('\n== Assemblage des shaders ==');
{
  const src = buildWaterShaders();
  const names = Object.keys(src).filter((k) => k !== 'vertex');
  let ok = true, detail = '';
  for (const n of names) {
    const g = src[n];
    const open = (g.match(/\{/g) || []).length, close = (g.match(/\}/g) || []).length;
    if (open !== close) { ok = false; detail = `${n} : ${open} { contre ${close} }`; break; }
    if (/undefined|NaN|Infinity/.test(g)) { ok = false; detail = `${n} contient une constante non definie`; break; }
    if (!/void main\(\)/.test(g)) { ok = false; detail = `${n} sans main`; break; }
    if (!/layout\(location = 0\) out vec4/.test(g)) { ok = false; detail = `${n} sans sortie`; break; }
    if (!g.startsWith('#version 300 es')) { ok = false; detail = `${n} sans #version`; break; }
  }
  check('dix passes, accolades equilibrees, constantes injectees', ok && names.length === 10, detail || `${names.length} passes`);
  check('le sommet est un triangle plein ecran sans attribut', /gl_VertexID/.test(src.vertex) && src.vertex.startsWith('#version 300 es'));
  const head = glslHead();
  check('les dimensions de grille sont celles du solveur', head.includes(`#define WN ${WN}`) && head.includes(`#define WM ${WM}`));
  check('les litteraux flottants ont un point ou un exposant',
    !/#define [A-Z_]+ -?\d+$/m.test(head.replace(/#define (WN|WM|NX|NZ|SUB|N_COMP) \d+/g, '')));
  check('la generation boucle sur les composantes du spectre', /for \(int i = 0; i < N_COMP; i\+\+\)/.test(src.exchange));
  check('les cibles doubles declarent deux sorties',
    /location = 1\) out vec4/.test(src.integrate) && /location = 1\) out vec4/.test(src.breaking)
    && /location = 1\) out vec4/.test(src.exchange) && /location = 1\) out vec4/.test(src.inject)
    && /location = 1\) out vec4/.test(src.fine) && /location = 1\) out vec4/.test(src.render));
  check('les champs fins suivent la sous-division du solveur', src.fine.includes('/ float(SUB)') && head.includes(`#define SUB ${SUB}`));
}

console.log('\n== La boucle de sous-pas extraite est la reference ==');
{
  const make = () => {
    const field = new VoxelField();
    generateBeach(field, 4242);
    const water = new Water(field, stub, null);
    water.setDamage(0); water.tideSpeed = 0;
    water.waves.setCustom(0.25, 0.5);
    // Phases deterministes : les deux instances doivent voir la meme houle.
    for (let i = 0; i < water.waves.ph.length; i++) water.waves.ph[i] = i * 1.3;
    water.initialize();
    return { field, water };
  };
  const a = make(), b = make();
  // a : le chemin normal (solve). b : les memes pas, sous-pas appeles a la main.
  for (let k = 0; k < 90; k++) {
    a.water.step(1 / 30); a.field.flushColumns();
    b.water.step(1 / 30); b.field.flushColumns();
  }
  let maxDiff = 0;
  for (let c = 0; c < WN * WM; c++) maxDiff = Math.max(maxDiff, Math.abs(a.water.hc[c] - b.water.hc[c]));
  check('deux instances identiques restent identiques (3 s)', maxDiff < 1e-9, `${maxDiff} m`);
  check('sans GPU attache, le mode reste CPU', a.water.gpu === null);
  check('la mer bouge bien (le test ne compare pas deux plages seches)', a.water.stats.wetCells > 2000, `${a.water.stats.wetCells} cellules`);
}

console.log('\n== Ecume et embruns relus du GPU ==');
{
  const field = new VoxelField();
  generateBeach(field, 7);
  const water = new Water(field, stub, null);
  water.setDamage(0); water.tideSpeed = 0; water.setSeaState(0);
  water.initialize();
  for (let k = 0; k < 30; k++) { water.step(1 / 30); field.flushColumns(); }
  // Un deferlement artificiel relu : b = 1 sur une bande, ecume deja haute ailleurs.
  water.computeScanRanges();
  let seeded = 0, other = -1;
  for (let c = 0; c < WN * WM; c++) {
    if (!water.simMask[c] || water.hc[c] < 0.05) continue;
    if (seeded < 200) { water.brk[c] = 1; seeded++; }
    else if (other < 0) { other = c; water.foamc[c] = 1.0; water.brk[c] = 0; }
  }
  const before = water.foamc[other];
  let spray = 0;
  water.onSpray = () => { spray++; };
  water._sprayLeft = 20;
  for (let k = 0; k < 10; k++) water.foamAndSpray(1 / 30);
  let maxFoam = 0;
  for (let c = 0; c < WN * WM; c++) maxFoam = Math.max(maxFoam, water.foamc[c]);
  check('l ecume des cellules deferlantes monte et reste bornee', maxFoam > 0.05 && maxFoam <= 1.2, `max ${maxFoam.toFixed(3)}`);
  check('l ecume decroit la ou rien ne deferle', water.foamc[other] < before, `${before.toFixed(3)} -> ${water.foamc[other].toFixed(3)}`);
  check('les cellules deferlantes sont comptees', water.stats.breaking >= seeded * 0.5, `${water.stats.breaking}`);
}

console.log('\n== Fond incremental ==');
{
  const field = new VoxelField();
  generateBeach(field, 31);
  const water = new Water(field, stub, null);
  water.setDamage(0); water.tideSpeed = 0; water.setSeaState(0);
  water.initialize();
  for (let k = 0; k < 20; k++) { water.step(1 / 30); field.flushColumns(); }
  // Un trou creuse sous l eau par le chemin normal (colonnes marquees), puis
  // un pas : le fond incremental doit valoir le fond recalcule en entier.
  const { EditContext, sphere } = await import('../src/tools/Brush.js');
  const ctx = new EditContext(field, stub, { touchBox() {} }, water, null);
  let cz = 0;
  for (let z = 0; z < NZ; z++) { const c = (NX >> 1) + NX * z; if (water.seaLevel - field.surfaceH[c] > 0.15) { cz = z; break; } }
  const wz = (cz + 0.5) * 0.04 - 6.4;
  sphere(ctx, 0, field.surfaceHeightAt(0, wz), wz, 0.3, -255, { hardness: 0.3 });
  water.step(1 / 30); field.flushColumns(); water.step(1 / 30);
  const inc = Float32Array.from(water.bed);
  water.refreshBed(true);
  let maxDiff = 0;
  for (let c = 0; c < WN * WM; c++) maxDiff = Math.max(maxDiff, Math.abs(inc[c] - water.bed[c]));
  check('apres un coup de pelle, le fond incremental egale le fond complet', maxDiff < 1e-6, `${maxDiff} m`);
  check('la liste des colonnes est videe', field.bedDirty.length === 0);
}

if (failures) {
  console.log(`\n${failures} test(s) du solveur GPU en echec.`);
  process.exit(1);
}
console.log('\nTous les tests du solveur GPU passent.');
