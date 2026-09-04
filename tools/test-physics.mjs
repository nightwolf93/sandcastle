/**
 * Tests de non-regression physique de la simulation granulaire.
 *
 * Ce sont les tests qui comptent : si un tas de sable sec ne forme pas un cone
 * a 34 degres et qu'un mur de sable parfait ne tient pas debout, le jeu est
 * faux, quelle que soit la beaute du rendu.
 *
 *   node tools/test-physics.mjs
 */

import { VoxelField } from '../src/sim/VoxelField.js';
import { Granular } from '../src/sim/Granular.js';
import {
  NX, NY, NZ, VOXEL, ISO, ORIGIN_X, ORIGIN_Y, ORIGIN_Z,
} from '../src/core/Config.js';
import {
  thetaMax, criticalWallHeight, cohesion, maxTowerHeight, bucketDemouldState,
} from '../src/sim/SandPhysics.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

const SLICE = NX * NZ;
const CX = NX >> 1, CZ = NZ >> 1;

/** Plage plate de hauteur `h` voxels, avec humidite et compaction uniformes. */
function makeFlat(field, hVox, w, p) {
  field.density.fill(0);
  field.moisture.fill(0);
  field.packing.fill(0);
  field.material.fill(0);
  const m = Math.round(w * 255), pk = Math.round(p * 255);
  for (let y = 0; y < hVox; y++) {
    for (let z = 0; z < NZ; z++) {
      const row = NX * (z + NZ * y);
      for (let x = 0; x < NX; x++) {
        field.density[row + x] = 255;
        field.moisture[row + x] = m;
        field.packing[row + x] = pk;
        field.material[row + x] = 1;
      }
    }
  }
  field.rebuildAll();
}

function setVox(field, x, y, z, d, w, p) {
  const i = x + NX * (z + NZ * y);
  field.density[i] = d;
  field.moisture[i] = Math.round(w * 255);
  field.packing[i] = Math.round(p * 255);
  field.material[i] = 1;
}

function totalMass(field) {
  let s = 0;
  const d = field.density;
  for (let i = 0; i < d.length; i++) s += d[i];
  return s;
}

/** Hauteur de surface (voxels) d'une colonne. */
function colTop(field, x, z) {
  const col = x + NX * z;
  for (let y = NY - 1; y >= 0; y--) {
    if (field.density[col + SLICE * y] >= ISO) return y;
  }
  return -1;
}

function run(field, gran, steps, budget = 400000) {
  for (let s = 0; s < steps; s++) {
    gran.step(1 / 60, budget);
    field.flushColumns();
  }
}

// ---------------------------------------------------------------------------
console.log('\n== Modele materiau ==');
{
  const vals = [0, 0.02, 0.05, 0.1, 0.15, 0.3, 0.5, 0.8, 1.0];
  console.log('  theta_max(w) a p=0.6 : ' +
    vals.map((w) => `${w}->${thetaMax(w, 0.6).toFixed(0)}`).join('  '));
  check('sable sec = angle de repos ~34 deg', Math.abs(thetaMax(0, 0.6) - 34) < 0.5,
    `${thetaMax(0, 0.6).toFixed(1)} deg`);
  check('sable parfait tient quasi vertical', thetaMax(0.12, 0.85) > 84,
    `${thetaMax(0.12, 0.85).toFixed(1)} deg`);
  check('sable sature se liquefie', thetaMax(1.0, 0.5) < 25,
    `${thetaMax(1.0, 0.5).toFixed(1)} deg`);
  check('le tassement ameliore la tenue',
    thetaMax(0.12, 1.0) - thetaMax(0.12, 0.0) > 12,
    `${thetaMax(0.12, 0).toFixed(1)} -> ${thetaMax(0.12, 1).toFixed(1)} deg`);
  const hc = criticalWallHeight(0.12, 0.9);
  check('hauteur critique d un mur vertical realiste (0.7 a 1.6 m)',
    hc > 0.7 && hc < 1.6, `${hc.toFixed(2)} m (Culmann)`);
  const t1 = maxTowerHeight(0.12, 0.12, 0.9);
  const t2 = maxTowerHeight(0.24, 0.12, 0.9);
  check('loi d echelle H ~ R^(2/3) : doubler R donne ~1.59x la hauteur',
    Math.abs(t2 / t1 - Math.pow(2, 2 / 3)) < 0.02,
    `${t1.toFixed(2)} m -> ${t2.toFixed(2)} m`);
}

// ---------------------------------------------------------------------------
console.log('\n== Tas de sable sec : angle de repos ==');
{
  const field = new VoxelField();
  makeFlat(field, 6, 0.0, 0.3);
  const gran = new Granular(field);

  // Une colonne haute et fine de sable sec, posee au centre.
  const H = 30, R = 3;
  for (let y = 6; y < 6 + H; y++) {
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dz * dz > R * R) continue;
        setVox(field, CX + dx, y, CZ + dz, 255, 0.0, 0.2);
      }
    }
  }
  field.rebuildAll();
  const m0 = totalMass(field);
  gran.wakeBox(CX - R - 2, 5, CZ - R - 2, CX + R + 2, 6 + H + 1, CZ + R + 2);

  run(field, gran, 1200);

  const m1 = totalMass(field);
  check('masse conservee', Math.abs(m1 - m0) / m0 < 1e-9,
    `${m0} -> ${m1} (${(((m1 - m0) / m0) * 100).toFixed(6)} %)`);

  // Profil radial du tas
  const top = colTop(field, CX, CZ);
  const base = 5;
  let radius = 0;
  for (let r = 1; r < 60; r++) {
    if (colTop(field, CX + r, CZ) <= base) { radius = r; break; }
  }
  const height = top - base;
  const angle = (Math.atan2(height, radius) * 180) / Math.PI;
  check('la colonne s est effondree en cone', height < H * 0.6 && radius > R + 3,
    `h=${height} vox, r=${radius} vox`);
  check('angle de repos du sable sec proche de 34 deg',
    angle > 26 && angle < 42, `${angle.toFixed(1)} deg`);
}

// ---------------------------------------------------------------------------
console.log('\n== Mur de sable parfait : il doit tenir ==');
{
  const field = new VoxelField();
  makeFlat(field, 6, 0.12, 0.85);
  const gran = new Granular(field);

  // Mur vertical de 20 voxels (80 cm) et 3 voxels d'epaisseur.
  const H = 20;
  for (let y = 6; y < 6 + H; y++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let x = CX - 12; x <= CX + 12; x++) {
        setVox(field, x, y, CZ + dz, 255, 0.12, 0.85);
      }
    }
  }
  field.rebuildAll();
  gran.wakeBox(CX - 15, 5, CZ - 4, CX + 15, 6 + H + 2, CZ + 4);
  run(field, gran, 600);

  const top = colTop(field, CX, CZ);
  check('le mur de sable parfait tient debout', top >= 6 + H - 2,
    `sommet a ${top} (attendu ${6 + H - 1})`);
  // Il ne doit pas non plus s'etaler lateralement
  const spread = colTop(field, CX, CZ + 4);
  check('pas d etalement lateral', spread <= 6, `colonne a 4 voxels : ${spread}`);
}

// ---------------------------------------------------------------------------
console.log('\n== Meme mur, mais en sable sec : il doit s effondrer ==');
{
  const field = new VoxelField();
  makeFlat(field, 6, 0.0, 0.2);
  const gran = new Granular(field);
  const H = 20;
  for (let y = 6; y < 6 + H; y++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let x = CX - 12; x <= CX + 12; x++) {
        setVox(field, x, y, CZ + dz, 255, 0.0, 0.2);
      }
    }
  }
  field.rebuildAll();
  gran.wakeBox(CX - 15, 5, CZ - 4, CX + 15, 6 + H + 2, CZ + 4);
  run(field, gran, 600);
  const top = colTop(field, CX, CZ);
  const spread = colTop(field, CX, CZ + 5);
  check('le mur de sable sec s est effondre', top < 6 + H * 0.55,
    `sommet a ${top} au lieu de ${6 + H - 1}`);
  check('le sable sec s est etale', spread > 6, `colonne a 5 voxels : ${spread}`);
}

// ---------------------------------------------------------------------------
console.log('\n== Sable sature : il doit couler presque a plat ==');
{
  const field = new VoxelField();
  makeFlat(field, 6, 0.95, 0.3);
  const gran = new Granular(field);
  const H = 22, R = 3;
  for (let y = 6; y < 6 + H; y++) {
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dz * dz > R * R) continue;
        setVox(field, CX + dx, y, CZ + dz, 255, 0.95, 0.3);
      }
    }
  }
  field.rebuildAll();
  gran.wakeBox(CX - R - 2, 5, CZ - R - 2, CX + R + 2, 6 + H + 1, CZ + R + 2);
  run(field, gran, 900);
  const top = colTop(field, CX, CZ);
  let radius = 0;
  for (let r = 1; r < 80; r++) {
    if (colTop(field, CX + r, CZ) <= 6) { radius = r; break; }
  }
  const angle = (Math.atan2(top - 6, radius) * 180) / Math.PI;
  check('le sable sature s etale largement', angle < 30, `${angle.toFixed(1)} deg`);
}

// ---------------------------------------------------------------------------
console.log('\n== Surplomb : court tient, long casse ==');
{
  const field = new VoxelField();
  makeFlat(field, 6, 0.14, 0.9);
  const gran = new Granular(field);
  // Un pilier + une dalle en porte-a-faux de 3 voxels (12 cm)
  const yTop = 14;
  for (let y = 6; y <= yTop; y++) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) setVox(field, CX + dx, y, CZ + dz, 255, 0.14, 0.9);
    }
  }
  for (let dx = 3; dx <= 5; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      setVox(field, CX + dx, yTop, CZ + dz, 255, 0.14, 0.9);
      setVox(field, CX + dx, yTop - 1, CZ + dz, 255, 0.14, 0.9);
    }
  }
  // Et un porte-a-faux beaucoup plus long de l'autre cote (12 voxels = 48 cm)
  for (let dx = -14; dx <= -3; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      setVox(field, CX + dx, yTop, CZ + dz, 255, 0.14, 0.9);
      setVox(field, CX + dx, yTop - 1, CZ + dz, 255, 0.14, 0.9);
    }
  }
  field.rebuildAll();
  gran.wakeBox(CX - 18, 5, CZ - 4, CX + 9, yTop + 2, CZ + 4);
  run(field, gran, 700);

  const shortEnd = colTop(field, CX + 5, CZ);
  const longEnd = colTop(field, CX - 14, CZ);
  check('un surplomb court tient', shortEnd >= yTop - 1, `sommet ${shortEnd} / ${yTop}`);
  check('un surplomb trop long a cede', longEnd < yTop - 3, `sommet ${longEnd} / ${yTop}`);
}

// ---------------------------------------------------------------------------
console.log('\n== Pied aiguille : aucun bloc ne reste suspendu ==');
{
  const field = new VoxelField();
  makeFlat(field, 6, 0.12, 0.95);
  const gran = new Granular(field);
  // Un filament de 4 cm sur 40 cm, surmonte d'un bloc de 28 cm : ce n'est pas
  // une tour, c'est le residu impossible que laissait parfois le sapement.
  for (let y = 6; y <= 15; y++) setVox(field, CX, y, CZ, 255, 0.12, 0.95);
  for (let y = 15; y <= 17; y++) {
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) setVox(field, CX + dx, y, CZ + dz, 255, 0.12, 0.95);
    }
  }
  field.rebuildAll();
  const mass = totalMass(field);
  gran.wakeBox(CX - 5, 5, CZ - 5, CX + 5, 20, CZ + 5);
  run(field, gran, 600);
  const top = colTop(field, CX, CZ);
  const stemProfile = [];
  const stressProfile = [];
  const spillProfile = [];
  for (let y = 6; y <= 17; y++) stemProfile.push(field.density[CX + NX * (CZ + NZ * y)]);
  for (let y = 6; y <= 17; y++) stressProfile.push(gran.stress[CX + NX * (CZ + NZ * y)]);
  for (let y = 6; y <= 17; y++) spillProfile.push(field.density[CX + 1 + NX * (CZ + NZ * y)]);
  check('le filament flambe et le chapeau redescend', top <= 14,
    `sommet ${top}, densite ${stemProfile.join('/')}, contrainte ${stressProfile.join('/')}, depot ${spillProfile.join('/')}`);
  check('le flambement conserve la masse', totalMass(field) === mass);
}

// ---------------------------------------------------------------------------
console.log('\n== Construction : ce que doit permettre un chateau de sable ==');
{
  // Ces trois tests encodent la promesse du jeu. Un seau demoule doit RESTER
  // DEBOUT, on doit pouvoir y creuser une fenetre sans tout faire tomber, et
  // il doit quand meme exister une limite — sinon il n'y a plus de jeu.
  const hc = (w, p) => criticalWallHeight(w, p);

  // Le seau retourne s'egoutte avant de liberer la tour. Le sable pris juste
  // au-dessus de la nappe est tres mouille, mais ce n'est pas une boue : il
  // doit perdre son eau libre et conserver la forme du moule.
  const shoreBucket = bucketDemouldState(0.42, 0.65);
  const soakedBucket = bucketDemouldState(0.70, 0.65);
  const slurryBucket = bucketDemouldState(0.95, 0.65);
  const dryBucket = bucketDemouldState(0.035, 0.65);
  check('le sable de nappe s egoutte et demoule une tour nette',
    shoreBucket.outcome === 'clean' && shoreBucket.shapeQuality >= 0.94,
    `w ${(shoreBucket.moisture * 100).toFixed(1)} %, q ${shoreBucket.q.toFixed(2)}, ${shoreBucket.outcome}`);
  check('le sable tres mouille reste reconnaissable apres demoulage',
    soakedBucket.outcome === 'slump' && soakedBucket.shapeQuality >= 0.72,
    `q ${soakedBucket.q.toFixed(2)}, forme ${soakedBucket.shapeQuality.toFixed(2)}`);
  check('seule une vraie boue s effondre', slurryBucket.outcome === 'collapse', slurryBucket.outcome);
  check('le sable jamais mouille reste dans le seau', dryBucket.outcome === 'stuck', dryBucket.outcome);

  console.log('  hauteur critique d un mur vertical :');
  for (const [w, p, label] of [
    [0.005, 0.30, 'sable a peine humide, en vrac'],
    [0.035, 0.60, 'sable de plage ramasse a la pelle'],
    [0.080, 0.75, 'sable arrose'],
    [0.140, 0.90, 'sable parfait, pound-up'],
    [0.600, 0.50, 'sable trempe'],
  ]) {
    console.log(`    ${label.padEnd(34)} ${(hc(w, p) * 100).toFixed(0)} cm`);
  }

  // --- 1. un seau demoule tient debout ------------------------------------
  {
    const field = new VoxelField();
    makeFlat(field, 6, 0.035, 0.5);
    const gran = new Granular(field);
    // Le seau : rayon 4 voxels (16 cm), hauteur 8 voxels (32 cm).
    // Humidite 3,5 % : c'est le sable qu'on ramasse a la pelle sans arroser.
    const R = 4, H = 8;
    for (let y = 6; y < 6 + H; y++) {
      for (let dz = -R; dz <= R; dz++) {
        for (let dx = -R; dx <= R; dx++) {
          if (dx * dx + dz * dz > R * R) continue;
          setVox(field, CX + dx, y, CZ + dz, 255, 0.035, 0.6);
        }
      }
    }
    field.rebuildAll();
    gran.wakeBox(CX - R - 2, 5, CZ - R - 2, CX + R + 2, 6 + H + 2, CZ + R + 2);
    run(field, gran, 900);
    const top = colTop(field, CX, CZ);
    const rim = colTop(field, CX + R - 1, CZ);
    check('un seau demoule en sable a peine humide reste debout',
      top >= 6 + H - 2, `sommet ${top} / ${6 + H - 1}`);
    check('ses flancs ne s affaissent pas', rim >= 6 + H - 3,
      `bord a ${rim} / ${6 + H - 1}`);
  }

  // --- 2. on peut creuser une fenetre dans une tour ------------------------
  {
    const field = new VoxelField();
    makeFlat(field, 6, 0.13, 0.85);
    const gran = new Granular(field);
    const R = 5, H = 14;
    for (let y = 6; y < 6 + H; y++) {
      for (let dz = -R; dz <= R; dz++) {
        for (let dx = -R; dx <= R; dx++) {
          if (dx * dx + dz * dz > R * R) continue;
          setVox(field, CX + dx, y, CZ + dz, 255, 0.13, 0.9);
        }
      }
    }
    field.rebuildAll();
    gran.wakeBox(CX - R - 2, 5, CZ - R - 2, CX + R + 2, 6 + H + 2, CZ + R + 2);
    run(field, gran, 400);
    const before = colTop(field, CX, CZ);

    // La mirette : une fenetre de 3 voxels de large sur 4 de haut, traversante.
    for (let y = 10; y < 14; y++) {
      for (let dz = -R - 1; dz <= R + 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          field.set(CX + dx, y, CZ + dz, 0);
        }
      }
    }
    field.flushColumns();
    gran.wakeBox(CX - R - 2, 8, CZ - R - 2, CX + R + 2, 6 + H + 2, CZ + R + 2);
    run(field, gran, 900);

    const after = colTop(field, CX, CZ);
    // Le linteau : la matiere juste au-dessus de la fenetre doit tenir.
    const lintel = field.density[(CX) + NX * ((CZ) + NZ * 14)];
    check('creuser une fenetre ne fait pas tomber la tour',
      after >= before - 1, `sommet ${before} -> ${after}`);
    check('le linteau au-dessus de la fenetre tient', lintel >= 128,
      `densite ${lintel}`);
  }

  // --- 3. mais un mur trop haut cede quand meme ---------------------------
  {
    // On prend un MUR et pas une tour : toute sa crete a un voisin expose,
    // donc la rupture se voit tout de suite. Sur une tour, seul le pourtour
    // s'erode et le centre met beaucoup plus longtemps a descendre.
    const field = new VoxelField();
    makeFlat(field, 6, 0.035, 0.5);
    const gran = new Granular(field);
    const H = 30; // 1,20 m, soit trois fois la hauteur critique (42 cm)
    for (let y = 6; y < 6 + H; y++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let x = CX - 14; x <= CX + 14; x++) {
          setVox(field, x, y, CZ + dz, 255, 0.035, 0.6);
        }
      }
    }
    field.rebuildAll();
    gran.wakeBox(CX - 17, 5, CZ - 4, CX + 17, 6 + H + 2, CZ + 4);
    run(field, gran, 2500);
    const top = colTop(field, CX, CZ);
    const hLeft = (top - 5) * VOXEL;
    console.log(`  mur de 1,20 m en sable a peine humide -> ${(hLeft * 100).toFixed(0)} cm`);
    check('un mur bien trop haut finit par ceder', top < 6 + H - 6,
      `sommet ${top} au lieu de ${6 + H - 1}`);
    check('il s arrete pres de sa hauteur critique', hLeft < 0.85,
      `${(hLeft * 100).toFixed(0)} cm restants`);
  }
}

console.log(failures === 0 ? '\nTous les tests physiques passent.\n' : `\n${failures} test(s) en echec.\n`);
process.exit(failures ? 1 : 0);
