/**
 * Tests de l'historique des sauvegardes : les cles, leur tri et l'elagage.
 *
 * IndexedDB n'existe pas dans Node : on teste la logique pure qui decide
 * quelle entree est la plus recente et lesquelles partent quand le plafond
 * est atteint. C'est elle qui garantit que la reprise au demarrage retrouve
 * le bon etat et que l'historique ne grossit pas sans fin.
 */
import { parseSaveKey, sortSaveEntries, saveKeysToPrune, HISTORY_KEEP } from '../src/core/Save.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

console.log('\n== Cles de l historique ==');
{
  const a = parseSaveKey('auto:1725000000000');
  const m = parseSaveKey('manual:1725000005000');
  check('une cle automatique se decode', a && a.kind === 'auto' && a.date === 1725000000000);
  check('une cle manuelle se decode', m && m.kind === 'manual' && m.date === 1725000005000);
  check('l ancien emplacement unique est reconnu comme ancien', parseSaveKey('auto')?.legacy === true);
  check('une cle inconnue est ignoree', parseSaveKey('truc') === null && parseSaveKey(42) === null);
}

console.log('\n== Tri : la plus recente d abord ==');
{
  const keys = ['auto:100', 'manual:300', 'auto:200', 'garbage', 'auto'];
  const sorted = sortSaveEntries(keys).map((e) => e.key);
  check('ordre decroissant, tous types confondus', sorted.join(',') === 'manual:300,auto:200,auto:100,auto',
    sorted.join(','));
}

console.log('\n== Elagage par type ==');
{
  const keys = [];
  for (let i = 0; i < HISTORY_KEEP.auto + 3; i++) keys.push(`auto:${1000 + i}`);
  for (let i = 0; i < HISTORY_KEEP.manual + 2; i++) keys.push(`manual:${5000 + i}`);
  const drop = saveKeysToPrune(keys);
  const autos = drop.filter((k) => k.startsWith('auto:'));
  const manuals = drop.filter((k) => k.startsWith('manual:'));
  check('trois automatiques de trop partent', autos.length === 3, autos.join(','));
  check('ce sont les plus anciennes', autos.join(',') === 'auto:1002,auto:1001,auto:1000', autos.join(','));
  check('deux manuelles de trop partent', manuals.length === 2, manuals.join(','));
  check('les plus recentes restent', !drop.includes(`auto:${1000 + HISTORY_KEEP.auto + 2}`)
    && !drop.includes(`manual:${5000 + HISTORY_KEEP.manual + 1}`));
  check('sous le plafond, rien ne part', saveKeysToPrune(['auto:1', 'manual:2']).length === 0);
}

if (failures) {
  console.log(`\n${failures} test(s) de sauvegarde en echec.`);
  process.exit(1);
}
console.log('\nTous les tests de sauvegarde passent.');
