/**
 * Tests de l'atelier du sculpteur (Sculpt.js).
 *
 * Chaque operation est verifiee sur un champ synthetique : une ouverture
 * traverse bien la paroi et epargne ce qui l'entoure, un escalier a le bon
 * nombre de marches aux bonnes hauteurs, une gouge a la profondeur demandee,
 * la paille ne retire que les miettes, une tour a le volume d'un cylindre,
 * et le miroir est une involution.
 */
import { NX, NY, NZ, VOXEL, ISO, MAT_SAND } from '../src/core/Config.js';
import { VoxelField } from '../src/sim/VoxelField.js';
import { EditContext, toVoxel, stampSandBox } from '../src/tools/Brush.js';
import {
  carveOpening, openingTop, carveStairs, stairsOutline, carveGroove, blowClean,
  stampRevolution, cylinderProfile, coneProfile, domeProfile, mirrorPoint, mirrorVector,
} from '../src/tools/Sculpt.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}
const stub = { wakeBox() {} };
const moistStub = { touchBox() {} };

/** Plateau plat de `layers` couches. */
function flatField(layers = 20) {
  const field = new VoxelField();
  for (let y = 0; y < layers; y++) {
    for (let z = 0; z < NZ; z++) {
      const row = NX * (z + NZ * y);
      field.density.fill(255, row, row + NX);
      field.material.fill(MAT_SAND, row, row + NX);
      field.moisture.fill(30, row, row + NX);
      field.packing.fill(200, row, row + NX);
    }
  }
  field.rebuildAll();
  return field;
}
const solidAt = (field, wx, wy, wz) => {
  const v = toVoxel(wx, wy, wz);
  const i = Math.round(v.x) + NX * (Math.round(v.z) + NZ * Math.round(v.y));
  return field.density[i] >= ISO;
};
const H = (field, x, z) => { field.flushColumns(); return field.surfaceHeightAt(x, z); };

console.log('\n== Ouverture cintree dans un mur ==');
{
  const field = flatField(20);
  const ctx = new EditContext(field, stub, moistStub, null, null);
  const ground = H(field, 0, 0);
  // Un mur de 40 cm d'epaisseur (le long de x), 60 cm de haut, face en z = -0.20.
  stampSandBox(ctx, 0, ground, 0, 1.6, 0.40, 0.60, 0, 0.12, 0.95);
  const faceZ = -0.20;
  // Porte plein cintre de 16 x 30 cm, percee vers +z sur 30 cm.
  carveOpening(ctx, 0, ground, faceZ, 0, 1, { width: 0.16, height: 0.30, depth: 0.30, profile: 'round' });
  check('le centre de la porte est vide au nu du mur', !solidAt(field, 0, ground + 0.10, faceZ + 0.02));
  check('la porte traverse jusqu a la profondeur demandee', !solidAt(field, 0, ground + 0.10, faceZ + 0.26));
  check('au-dela de la profondeur, le mur est intact', solidAt(field, 0, ground + 0.10, faceZ + 0.36));
  check('le linteau au-dessus de l arc est intact', solidAt(field, 0, ground + 0.36, faceZ + 0.10));
  check('les jambages sont intacts', solidAt(field, 0.14, ground + 0.10, faceZ + 0.10) && solidAt(field, -0.14, ground + 0.10, faceZ + 0.10));
  // Le cintre : a mi-largeur, le plein cintre est plus bas qu'au centre.
  const hw = 0.08, top0 = openingTop('round', 0, hw, 0.30), top1 = openingTop('round', 0.06, hw, 0.30);
  check('le plein cintre redescend vers les jambages', top0 > top1 && Math.abs(top0 - 0.30) < 1e-9, `${top0.toFixed(3)} > ${top1.toFixed(3)}`);
  check('l ogive culmine plus haut que ses naissances', openingTop('pointed', 0, hw, 0.30) > openingTop('pointed', 0.079, hw, 0.30));
  check('un profil droit est plat', openingTop('rect', 0.05, hw, 0.30) === 0.30);
  // Une fenetre garde son appui.
  carveOpening(ctx, 0.50, ground + 0.20, faceZ, 0, 1, { width: 0.10, height: 0.14, depth: 0.30, profile: 'flat', sill: true });
  check('sous l appui de la fenetre, le mur est intact', solidAt(field, 0.50, ground + 0.12, faceZ + 0.10));
  check('la fenetre est ouverte', !solidAt(field, 0.50, ground + 0.26, faceZ + 0.10));
}

console.log('\n== Escalier dans une pente ==');
{
  // Une rampe : 20 couches en x < 0, montee lineaire de 40 cm sur 80 cm.
  const field = new VoxelField();
  const v0 = toVoxel(0, 0, 0);
  const x0 = Math.round(v0.x);
  for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) {
    const t = Math.min(1, Math.max(0, (x - x0) / 20));   // 20 voxels = 80 cm
    const h = 20 + 10 * t;                                // 0,80 m -> 1,20 m
    for (let y = 0; y < NY; y++) {
      const d = h - y;
      const i = x + NX * (z + NZ * y);
      const dv = Math.round(Math.min(255, Math.max(0, 128 + d * 128)));
      if (dv <= 0) break;
      field.density[i] = dv; field.material[i] = MAT_SAND; field.moisture[i] = 30; field.packing[i] = 200;
    }
  }
  field.rebuildAll();
  const ctx = new EditContext(field, stub, moistStub, null, null);
  const ay = H(field, 0, 0), by = H(field, 0.80, 0);
  check('la rampe monte de 40 cm', Math.abs(by - ay - 0.40) < 0.03, `${((by - ay) * 100).toFixed(1)} cm`);
  const r = carveStairs(ctx, 0, ay, 0, 0.80, by, 0, { width: 0.30, riser: 0.05 });
  check('huit marches de 5 cm', r.steps === 8, `${r.steps}`);
  // Chaque marche : plate au milieu, a la bonne hauteur.
  let flat = true, heightsOk = true, detail = '';
  const tread = 0.80 / r.steps, stepH = (by - ay) / r.steps;
  for (let i = 0; i < r.steps; i++) {
    const sx = (i + 0.5) * tread;
    const expected = ay + (i + 1) * stepH;
    // Deux sondes a 1,5 cm du milieu de la marche : l'interpolation entre
    // colonnes ne doit pas aller chercher la contremarche voisine.
    const hA = H(field, sx - tread * 0.15, 0.02), hB = H(field, sx + tread * 0.15, -0.02);
    if (Math.abs(hA - hB) > 0.012) { flat = false; detail = `marche ${i} : ${(hA * 100).toFixed(1)} / ${(hB * 100).toFixed(1)} cm`; }
    if (Math.abs(hA - expected) > 0.02) { heightsOk = false; detail = `marche ${i} : ${(hA * 100).toFixed(1)} cm attendu ${(expected * 100).toFixed(1)}`; }
  }
  check('chaque marche est plate', flat, detail);
  check('chaque marche est a sa hauteur', heightsOk, detail);
  check('la pente hors emprise est intacte', Math.abs(H(field, 0.40, 0.40) - (ay + 0.20)) < 0.03);
  check('le remblai est en sable, humide et dame', r.fill > 0 && (() => {
    const v = toVoxel(0.05, ay + 0.03, 0);
    const i = Math.round(v.x) + NX * (Math.round(v.z) + NZ * Math.round(v.y));
    return field.material[i] === MAT_SAND && field.packing[i] > 150;
  })());
  const outline = stairsOutline(0, ay, 0, 0.80, by, 0, { width: 0.30, riser: 0.05 });
  check('l apercu dessine autant de marches que la taille', outline.length === r.steps * 3, `${outline.length} traits`);
}

console.log('\n== Gouge et paille ==');
{
  const field = flatField(20);
  const ctx = new EditContext(field, stub, moistStub, null, null);
  const ground = H(field, 0, 0);
  // Le trait passe par le centre d'une ligne de voxels (z = -0,02), la ou la
  // sonde de hauteur lit une colonne entiere.
  const zc = -0.02;
  carveGroove(ctx, -0.20, ground, zc, 0.20, ground, zc, { width: 0.06, depth: 0.03, profile: 'u' });
  const dCentre = ground - H(field, 0, zc), dSide = ground - H(field, 0, zc + 0.10);
  check('la gouge en U creuse a la profondeur demandee', Math.abs(dCentre - 0.03) < 0.012, `${(dCentre * 100).toFixed(1)} cm`);
  check('a 10 cm du trait, rien ne bouge', Math.abs(dSide) < 0.004, `${(dSide * 1000).toFixed(1)} mm`);
  const zv = zc + 0.40;
  carveGroove(ctx, -0.20, ground, zv, 0.20, ground, zv, { width: 0.08, depth: 0.04, profile: 'v' });
  const dV = ground - H(field, 0, zv), dVedge = ground - H(field, 0, zv + 0.03);
  check('le ciseau en V est plus profond au centre qu au bord', dV > 0.025 && dVedge < dV * 0.5, `${(dV * 100).toFixed(1)} / ${(dVedge * 100).toFixed(1)} cm`);

  // Des miettes : voxels partiels isoles au-dessus du sol, un grain en l'air,
  // et la peau d'une pente (partiel pose sur du plein) qui doit rester.
  const put = (wx, wy, wz, d) => { const v = toVoxel(wx, wy, wz); field.density[Math.round(v.x) + NX * (Math.round(v.z) + NZ * Math.round(v.y))] = d; };
  put(0.5, ground + 0.10, 0.5, 60);      // miette en l'air
  put(0.5, ground + 0.20, 0.5, 255);     // grain en l'air
  put(0.6, ground + 0.02, 0.6, 90);      // peau posee sur le sol (voisin plein dessous)
  const cleaned = blowClean(ctx, 0.55, ground + 0.10, 0.55, 0.30, 1);
  const get = (wx, wy, wz) => { const v = toVoxel(wx, wy, wz); return field.density[Math.round(v.x) + NX * (Math.round(v.z) + NZ * Math.round(v.y))]; };
  check('la paille souffle la miette et le grain en l air', get(0.5, ground + 0.10, 0.5) === 0 && get(0.5, ground + 0.20, 0.5) === 0, `${cleaned} nettoyes`);
  check('la peau adossee au plein reste', get(0.6, ground + 0.02, 0.6) === 90);
  check('le sol sous la paille est intact', Math.abs(H(field, 0.55, 0.55) - ground) < 0.005);
}

console.log('\n== Tours et domes ==');
{
  const field = flatField(20);
  const ctx = new EditContext(field, stub, moistStub, null, null);
  const ground = H(field, 0, 0);
  const R = 0.15, Ht = 0.40;
  const vol = stampRevolution(ctx, 0, ground, 0, Ht, cylinderProfile(R, 0), 0.12, 0.95);
  const expected = Math.PI * R * R * Ht;
  check('une tour droite a le volume du cylindre (5 %)', Math.abs(vol - expected) / expected < 0.06, `${(vol * 1000).toFixed(2)} L pour ${(expected * 1000).toFixed(2)} L`);
  check('la tour culmine a la bonne hauteur', Math.abs(H(field, 0, 0) - (ground + Ht)) < 0.025, `${((H(field, 0, 0) - ground) * 100).toFixed(1)} cm`);
  check('le flanc est vertical', solidAt(field, R - 0.03, ground + 0.30, 0) && !solidAt(field, R + 0.03, ground + 0.30, 0));
  const roof = stampRevolution(ctx, 0, ground + Ht, 0, 0.20, coneProfile(R), 0.12, 0.95);
  check('le toit conique ajoute un tiers du cylindre', Math.abs(roof - Math.PI * R * R * 0.20 / 3) / (Math.PI * R * R * 0.20 / 3) < 0.12, `${(roof * 1000).toFixed(2)} L`);
  const dome = stampRevolution(ctx, 1.0, ground, 1.0, 0.14, domeProfile(0.20), 0.12, 0.95);
  const domeExpected = (2 / 3) * Math.PI * 0.20 * 0.20 * 0.14;
  check('un dome a le volume d une demi-ellipsoide (8 %)', Math.abs(dome - domeExpected) / domeExpected < 0.09, `${(dome * 1000).toFixed(2)} L pour ${(domeExpected * 1000).toFixed(2)} L`);
}

console.log('\n== Miroir ==');
{
  const p = { x: 1.2, y: 0.5, z: -0.7 };
  const m = mirrorPoint(p, 'x', 0.3);
  check('le symetrique par x = 0,3 est a la meme distance du plan', Math.abs((0.3 - p.x) - (m.x - 0.3)) < 1e-12 && m.z === p.z && m.y === p.y);
  const back = mirrorPoint(m, 'x', 0.3);
  check('le miroir est une involution', Math.abs(back.x - p.x) < 1e-12);
  const v = mirrorVector({ x: 0.6, y: 0.2, z: -0.8 }, 'z');
  check('la normale a l axe s inverse, le reste non', v.x === 0.6 && v.y === 0.2 && v.z === 0.8);
}

if (failures) {
  console.log(`\n${failures} test(s) de l atelier en echec.`);
  process.exit(1);
}
console.log('\nTous les tests de l atelier passent.');
