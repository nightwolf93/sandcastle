/** Regressions du generateur de blocs, splines et crenelages, sans navigateur. */
import * as THREE from 'three';
import { ISO, MAT_SAND, NX, NZ } from '../src/core/Config.js';
import { VoxelField } from '../src/sim/VoxelField.js';
import { EditContext, stampSandBox, stampSandWall, toVoxel } from '../src/tools/Brush.js';
import { SandBuilderPreview, smoothSandPath, sandPathLength } from '../src/tools/SandBuilder.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

function flatField(layers = 6) {
  const field = new VoxelField();
  for (let y = 0; y < layers; y++) {
    for (let z = 0; z < NZ; z++) {
      const row = NX * (z + NZ * y);
      field.density.fill(255, row, row + NX);
      field.material.fill(MAT_SAND, row, row + NX);
    }
  }
  field.rebuildAll();
  return field;
}

function voxelAt(field, wx, wy, wz) {
  const v = toVoxel(wx, wy, wz);
  const x = Math.round(v.x), y = Math.round(v.y), z = Math.round(v.z);
  const i = x + NX * (z + NZ * y);
  return { density: field.density[i] ?? 0, moisture: field.moisture[i] ?? 0,
    packing: field.packing[i] ?? 0, material: field.material[i] ?? 0 };
}

const granular = { wakeBox() {} };
const moisture = { touchBox() {} };

console.log('\n== Bloc parametrique ==');
{
  const field = flatField();
  const ctx = new EditContext(field, granular, moisture, null, null);
  const base = field.surfaceHeightAt(0, 0);
  const volume = stampSandBox(ctx, 0, base, 0, 0.40, 0.72, 0.36, Math.PI / 6, 0.12, 0.92);
  const core = voxelAt(field, 0, base + 0.18, 0);
  const outside = voxelAt(field, 0.55, base + 0.18, 0.55);
  check('le bloc ajoute un vrai volume', volume > 0.06, `${(volume * 1000).toFixed(1)} L`);
  check('le centre du bloc est solide et en sable', core.density >= ISO && core.material === MAT_SAND);
  check('le sable genere est humide et tasse', core.moisture > 20 && core.packing > 200,
    `humidite ${core.moisture}, compaction ${core.packing}`);
  check('le bloc ne remplit pas sa boite englobante', outside.density < ISO);
}

console.log('\n== Mur spline et creneaux ==');
{
  const field = flatField();
  const ctx = new EditContext(field, granular, moisture, null, null);
  const base = field.surfaceHeightAt(0, 0);
  const raw = [
    { x: -0.80, y: base, z: 0 },
    { x: 0.00, y: base, z: 0.34 },
    { x: 0.80, y: base, z: 0 },
  ];
  const curved = smoothSandPath(raw, 0.60);
  check('le trace est converti en spline echantillonnee', curved.length > raw.length,
    `${curved.length} points`);
  check('la spline conserve ses deux extremites',
    Math.abs(curved[0].x + 0.8) < 1e-6 && Math.abs(curved.at(-1).x - 0.8) < 1e-6);
  check('la longueur de spline est mesurable', sandPathLength(curved) > 1.5);

  const volume = stampSandWall(ctx, curved, 0.20, 0.34, {
    crenels: true, crenelWidth: 0.16, crenelHeight: 0.12,
    moisture: 0.12, packing: 0.92,
  });
  const body = voxelAt(field, 0, base + 0.17, 0.31);
  check('le mur suit la courbe sur toute sa hauteur', volume > 0.07 && body.density >= ISO,
    `${(volume * 1000).toFixed(1)} L`);

  // Mur droit separe : positions connues du motif bloc/vide de 16 cm.
  const straightField = flatField();
  const straightCtx = new EditContext(straightField, granular, moisture, null, null);
  const straightBase = straightField.surfaceHeightAt(0, 0);
  stampSandWall(straightCtx, [
    { x: -0.80, y: straightBase, z: 0 },
    { x: 0.80, y: straightBase, z: 0 },
  ], 0.20, 0.32, { crenels: true, crenelWidth: 0.16, crenelHeight: 0.14 });
  const merlon = voxelAt(straightField, -0.78, straightBase + 0.39, 0);
  const gap = voxelAt(straightField, -0.64, straightBase + 0.39, 0);
  check('les petits blocs du sommet sont pleins', merlon.density >= ISO, `densite ${merlon.density}`);
  check('les espaces entre les creneaux restent vides', gap.density < ISO, `densite ${gap.density}`);
}

console.log('\n== Apercu 3D ==');
{
  const scene = new THREE.Scene();
  const preview = new SandBuilderPreview(scene);
  const tool = {
    mode: 'block', blockWidth: 0.5, blockLength: 0.8, height: 0.4, rotation: 0,
    wallWidth: 0.2, wallHeight: 0.4, smoothness: 0.5,
    crenels: true, crenelWidth: 0.16, crenelHeight: 0.12,
  };
  preview.update(tool, { x: 0, y: 0.3, z: 0 }, []);
  check('le bloc a un apercu volumique', preview.root.visible && preview.mesh.geometry.index.count === 36);
  tool.mode = 'wall';
  preview.update(tool, { x: 0.5, y: 0.3, z: 0 }, [
    { x: -0.5, y: 0.3, z: 0 }, { x: 0, y: 0.3, z: 0.2 }, { x: 0.5, y: 0.3, z: 0 },
  ]);
  check('le mur et ses creneaux ont un apercu', preview.mesh.geometry.index.count > 72,
    `${preview.mesh.geometry.index.count / 3} triangles`);
  preview.dispose();
  check('l apercu se libere proprement', scene.children.length === 0);
}

console.log(failures === 0 ? '\nTous les tests du generateur de sable passent.\n' :
  `\n${failures} test(s) du generateur de sable en echec.\n`);
process.exit(failures ? 1 : 0);
