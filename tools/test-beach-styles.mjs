/**
 * Tests des styles de plage.
 *
 * Pour chaque style : la plage a de la mer et de la terre, le profil est
 * monotone (shorelineFor l'inverse), la ligne d'eau moyenne est en d = 0,
 * la generation est deterministe (meme graine, meme plage) et l'eau
 * s'initialise dessus avec une bande simulee. Le style classique doit
 * redonner exactement l'ancien profil, pour que les vieilles sauvegardes
 * retrouvent leur mer.
 */
import { NX, NZ, SEA_LEVEL, BEACH_HEIGHT, WORLD_D, normalizeMapSize, parseMapSpec } from '../src/core/Config.js';
import { VoxelField } from '../src/sim/VoxelField.js';
import { Water } from '../src/sim/Water.js';
import {
  BEACH_STYLES, BEACH, applyBeachStyle, beachProfile, shorelineFor, generateBeach,
  seedFromText, styleProfilePoints, SHORE_C, beachParamsOf, shoreRange, CUSTOM_FIELDS, CUSTOM_FEATURES,
} from '../src/world/BeachGenerator.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const stub = { push() {}, wake() {}, wakeBox() {} };

console.log('\n== Le style classique est l ancien profil ==');
{
  applyBeachStyle('classique');
  check('la mer moyenne est en d = 0', Math.abs(beachProfile(0) - SEA_LEVEL) < 1e-9);
  check('la berme est a BEACH_HEIGHT en d = 3,6', Math.abs(beachProfile(3.6) - BEACH_HEIGHT) < 1e-9);
  check('le large est a 86 cm sous la mer', Math.abs(beachProfile(-3.2) - (SEA_LEVEL - 0.86)) < 1e-9);
  check('l arriere-plage monte a 4,5 %', Math.abs(beachProfile(5.6) - (BEACH_HEIGHT + 0.09)) < 1e-9);
  check('le rivage est en z = 0,4', SHORE_C === 0.4);
}

console.log('\n== Chaque style ==');
for (const st of BEACH_STYLES) {
  const field = new VoxelField();
  const r = generateBeach(field, 4242, st.id);
  let monotone = true, prev = -Infinity;
  for (let d = -st.foreshore - 1; d <= st.face + 4; d += 0.05) {
    const h = beachProfile(d);
    if (h < prev - 1e-9) monotone = false;
    prev = h;
  }
  const shore = shorelineFor(SEA_LEVEL);
  let minH = Infinity, maxH = -Infinity;
  for (let c = 0; c < NX * NZ; c++) { const h = r.heights[c]; if (h < minH) minH = h; if (h > maxH) maxH = h; }
  const sea = minH < SEA_LEVEL - 0.25, land = maxH > SEA_LEVEL + 0.2;
  const water = new Water(field, stub, null);
  water.setDamage(0); water.tideSpeed = 0;
  water.initialize();
  const wet = water.stats.wetCells;
  let sim = 0;
  for (let c = 0; c < water.simMask.length; c++) if (water.simMask[c] && water.hc[c] > 0.001) sim++;
  const ok = monotone && Math.abs(shore) < 0.02 && sea && land && wet > 1000 && sim > 200 && r.style === st.id;
  check(`${st.name.padEnd(20)} profil monotone, mer et terre, ${wet} cellules d eau dont ${sim} simulees`, ok,
    ok ? '' : `monotone ${monotone}, rivage ${shore.toFixed(3)}, min ${minH.toFixed(2)}, max ${maxH.toFixed(2)}`);
  check(`${' '.repeat(20)} le croquis a des points et l anse suit`, styleProfilePoints(st).length > 20 && BEACH.bay === st.bay);
}

console.log('\n== Determinisme et graine ==');
{
  const a = new VoxelField(), b = new VoxelField();
  generateBeach(a, 777, 'crique');
  generateBeach(b, 777, 'crique');
  let same = true;
  for (let i = 0; i < a.density.length; i += 97) if (a.density[i] !== b.density[i]) { same = false; break; }
  check('meme graine, meme style : meme plage', same);
  const c = new VoxelField();
  generateBeach(c, 778, 'crique');
  let diff = 0;
  for (let i = 0; i < a.density.length; i += 97) if (a.density[i] !== c.density[i]) diff++;
  check('une autre graine change la plage', diff > 50, `${diff} echantillons differents`);
  check('un nombre est sa propre graine', seedFromText(' 12345 ') === 12345);
  check('un mot donne une graine stable', seedFromText('lagon bleu') === seedFromText('lagon bleu') && seedFromText('lagon bleu') !== seedFromText('lagon vert'));
}

console.log('\n== Le banc et le recif ==');
{
  const f1 = new VoxelField();
  const r1 = generateBeach(f1, 1, 'banc');
  let emerged = 0;
  for (let c = 0; c < NX * NZ; c++) if (r1.shoreD[c] < -1.8 && r1.shoreD[c] > -2.8 && r1.heights[c] > SEA_LEVEL + 0.03) emerged++;
  check('le banc de sable emerge au large', emerged > 500, `${emerged} colonnes`);
  const f2 = new VoxelField();
  const r2 = generateBeach(f2, 1, 'recif');
  let rock = 0, above = 0;
  for (let c = 0; c < NX * NZ; c++) {
    if (r2.shoreD[c] < -3.6 && r2.shoreD[c] > -4.6) {
      if (r2.heights[c] > SEA_LEVEL) above++;
      const top = f2.topY[c];
      if (top >= 0 && f2.material[c + NX * NZ * top] === 2) rock++;
    }
  }
  check('le recif est en roche et reste sous la mer', rock > 300 && above === 0, `${rock} colonnes de roche, ${above} au-dessus`);
}

console.log('\n== Parametres libres ==');
{
  const P = beachParamsOf('lagon');
  P.shoreC = 99;                 // hors carte : doit etre ramene dans la marge
  P.foreshore = 30;              // plus long que la mer disponible : borne
  P.dune = 0.5;
  const applied = applyBeachStyle(P);
  const r = shoreRange();
  check('un rivage hors carte est ramene dans la marge', applied.shoreC === r.max && r.max === WORLD_D / 2 - 2, `${applied.shoreC}`);
  check('l avant-plage tient dans la mer disponible', applied.foreshore <= WORLD_D / 2 - applied.shoreC - 0.4 + 1e-9);
  check('un gabarit retouche garde son nom et se dit personnalise', applied.id === 'lagon' && applied.custom === true && applied.dune === 0.5);
  check('le style de depart des parametres est conserve pour la lecture', BEACH.forePow === 0.35);
  check('un gabarit intact ne se dit pas personnalise', applyBeachStyle(beachParamsOf('dunes')).custom === false);
  const field = new VoxelField();
  const g = generateBeach(field, 3, { ...beachParamsOf('classique'), shoreC: -1.5, bay: 1.2, id: 'perso' });
  check('la generation accepte des parametres libres', g.style === 'custom' && g.seed === 3);
  const water = new Water(field, stub, null);
  water.setDamage(0); water.tideSpeed = 0; water.initialize();
  check('l eau se pose sur une plage personnalisee', water.stats.wetCells > 1000, `${water.stats.wetCells}`);
  check('chaque jauge a des bornes coherentes', CUSTOM_FIELDS.every((f) => {
    const min = typeof f.min === 'function' ? f.min() : f.min, max = typeof f.max === 'function' ? f.max() : f.max;
    return max > min && f.step > 0;
  }));
  const withReef = { ...beachParamsOf('classique') };
  withReef.bar = CUSTOM_FEATURES[1].make(withReef);
  check('le recif optionnel se place dans l avant-plage', withReef.bar.rock && withReef.bar.at < 0 && withReef.bar.at > -withReef.foreshore);
  const rt = beachParamsOf(applyBeachStyle(beachParamsOf('recif')));
  check('les parametres sauvegardes se reappliquent a l identique', rt.bar && rt.bar.rock && rt.foreshore === 4.6);
}

console.log('\n== Taille de la carte ==');
{
  check('la taille se normalise en multiples de 32 dans les bornes',
    normalizeMapSize(300) === 288 && normalizeMapSize(10) === 160 && normalizeMapSize(9999) === 512 && normalizeMapSize('abc') === 320);
  const spec = parseMapSpec(' 416x224 ');
  check('« LxP » se decode', spec && spec.nx === 416 && spec.nz === 224);
  check('un texte quelconque n est pas une taille', parseMapSpec('grand') === null);
  check('la carte par defaut fait 320 x 320 en Node', NX === 320 && NZ === 320);
}

// On rend le style classique : les tests suivants s'y attendent.
applyBeachStyle('classique');

if (failures) {
  console.log(`\n${failures} test(s) de style de plage en echec.`);
  process.exit(1);
}
console.log('\nTous les tests des styles de plage passent.');
