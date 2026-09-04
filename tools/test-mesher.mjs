/**
 * Test du mailleur Surface Nets sur des champs analytiques.
 *
 * On verifie trois choses qui, si elles passent, garantissent qu'il n'y a ni
 * inversion d'axes, ni couture entre chunks, ni triangle retourne :
 *   1. tous les sommets sont sur l'isosurface analytique (a la tolerance de la
 *      grille pres) ;
 *   2. les normales pointent bien vers l'exterieur ;
 *   3. la surface est etanche : chaque arete est partagee par exactement deux
 *      triangles (sinon il y a un trou entre deux chunks).
 *
 *   node tools/test-mesher.mjs
 */

import { VoxelField } from '../src/sim/VoxelField.js';
import { NetsContext, surfaceNets } from '../src/sim/meshing/SurfaceNets.js';
import {
  NX, NY, NZ, CHUNK, CHUNK_COUNT, VOXEL,
  ORIGIN_X, ORIGIN_Y, ORIGIN_Z, CX, CZ,
} from '../src/core/Config.js';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  OK   ${name}${detail ? '  ' + detail : ''}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`);
  }
}

const BLOCK = CHUNK + 12;
const BLOCK3 = BLOCK * BLOCK * BLOCK;
const bufD = new Uint8Array(BLOCK3);
const bufM = new Uint8Array(BLOCK3);
const bufP = new Uint8Array(BLOCK3);
const bufT = new Uint8Array(BLOCK3);
const ctx = new NetsContext(CHUNK);

/** Maille tout le champ et renvoie la geometrie fusionnee. */
function meshAll(field) {
  const positions = [];
  const normals = [];
  const tris = [];
  let base = 0;
  for (let ci = 0; ci < CHUNK_COUNT; ci++) {
    if (!field.chunkNeedsMesh(ci)) continue;
    const info = field.extractChunk(ci, bufD, bufM, bufP, bufT);
    const r = surfaceNets(
      ctx, bufD, bufM, bufP, bufT,
      info.ox, info.oy, info.oz,
      VOXEL, [ORIGIN_X, ORIGIN_Y, ORIGIN_Z]
    );
    if (!r) continue;
    for (let i = 0; i < r.vertexCount * 3; i++) {
      positions.push(r.positions[i]);
      normals.push(r.normals[i]);
    }
    for (let i = 0; i < r.indexCount; i++) tris.push(base + r.indices[i]);
    base += r.vertexCount;
  }
  return { positions, normals, tris };
}

/**
 * Etancheite : on soude les sommets par position (grille au 1/100 de voxel)
 * puis on compte les aretes orientees. Une surface fermee et coherente donne
 * exactement une arete (a,b) et une arete (b,a) pour chaque paire.
 */
function watertightness(positions, tris) {
  const q = VOXEL / 200;
  const key = new Map();
  const weld = new Int32Array(positions.length / 3);
  for (let v = 0; v < positions.length / 3; v++) {
    const k =
      Math.round(positions[v * 3] / q) + ':' +
      Math.round(positions[v * 3 + 1] / q) + ':' +
      Math.round(positions[v * 3 + 2] / q);
    let id = key.get(k);
    if (id === undefined) { id = key.size; key.set(k, id); }
    weld[v] = id;
  }
  const edges = new Map();
  let degenerate = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = weld[tris[t]], b = weld[tris[t + 1]], c = weld[tris[t + 2]];
    if (a === b || b === c || a === c) { degenerate++; continue; }
    for (const [p, n] of [[a, b], [b, c], [c, a]]) {
      const k = p * 100000000 + n;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  // Position d'un sommet soude (pour localiser les aretes ouvertes).
  const wpos = new Float32Array(key.size * 3);
  for (let v = 0; v < positions.length / 3; v++) {
    const id = weld[v];
    wpos[id * 3] = positions[v * 3];
    wpos[id * 3 + 1] = positions[v * 3 + 1];
    wpos[id * 3 + 2] = positions[v * 3 + 2];
  }

  let unmatched = 0;
  let unmatchedInterior = 0;
  let lowestY = Infinity, highestOpenY = -Infinity;
  for (const [k, count] of edges) {
    const p = Math.floor(k / 100000000), n = k % 100000000;
    const rev = edges.get(n * 100000000 + p) || 0;
    if (count === 1 && rev === 1) continue;
    unmatched++;
    const y = Math.min(wpos[p * 3 + 1], wpos[n * 3 + 1]);
    lowestY = Math.min(lowestY, y);
    // Le fond du bloc diorama est volontairement ouvert (il est couvert par
    // le socle) : on ne compte comme defaut que les trous ailleurs.
    if (y > ORIGIN_Y + VOXEL * 1.5) {
      unmatchedInterior++;
      highestOpenY = Math.max(highestOpenY, y);
    }
  }
  return { unmatched, unmatchedInterior, edges: edges.size, welded: key.size, degenerate, lowestY, highestOpenY };
}

// ---------------------------------------------------------------------------
console.log('\n== Sphere analytique ==');
{
  const field = new VoxelField();
  const cxw = ORIGIN_X + (NX * VOXEL) / 2;
  const cyw = ORIGIN_Y + (NY * VOXEL) / 2;
  const czw = ORIGIN_Z + (NZ * VOXEL) / 2;
  const R = 1.5; // assez petit pour ne toucher aucune paroi du domaine

  for (let y = 0; y < NY; y++) {
    for (let z = 0; z < NZ; z++) {
      for (let x = 0; x < NX; x++) {
        const wx = ORIGIN_X + (x + 0.5) * VOXEL;
        const wy = ORIGIN_Y + (y + 0.5) * VOXEL;
        const wz = ORIGIN_Z + (z + 0.5) * VOXEL;
        const d = R - Math.hypot(wx - cxw, wy - cyw, wz - czw);
        const v = Math.max(0, Math.min(255, Math.round(128 + (d / VOXEL) * 128)));
        if (v > 0) field.density[x + NX * (z + NZ * y)] = v;
      }
    }
  }
  field.rebuildAll();

  const t0 = performance.now();
  const { positions, normals, tris } = meshAll(field);
  const ms = performance.now() - t0;
  const nv = positions.length / 3;
  console.log(`  ${nv} sommets, ${tris.length / 3} triangles, ${ms.toFixed(0)} ms`);

  // 1. sommets sur la sphere
  let maxErr = 0, sumErr = 0, sphereVertices = 0;
  for (let v = 0; v < nv; v++) {
    // rebuildAll() ajoute maintenant un socle indestructible a la scene. Il
    // fait partie du maillage, mais pas de l'isosurface analytique testee ici.
    if (positions[v * 3 + 1] < ORIGIN_Y + VOXEL * 7) continue;
    const r = Math.hypot(positions[v * 3] - cxw, positions[v * 3 + 1] - cyw, positions[v * 3 + 2] - czw);
    const e = Math.abs(r - R);
    if (e > maxErr) maxErr = e;
    sumErr += e;
    sphereVertices++;
  }
  check('sommets sur l isosurface', maxErr < VOXEL * 0.85,
    `err max ${(maxErr * 1000).toFixed(1)} mm / moy ${((sumErr / sphereVertices) * 1000).toFixed(1)} mm`);

  // 2. normales sortantes
  let worstDot = 1;
  for (let v = 0; v < nv; v++) {
    if (positions[v * 3 + 1] < ORIGIN_Y + VOXEL * 7) continue;
    const dx = positions[v * 3] - cxw, dy = positions[v * 3 + 1] - cyw, dz = positions[v * 3 + 2] - czw;
    const l = Math.hypot(dx, dy, dz) || 1;
    const dot = (dx / l) * normals[v * 3] + (dy / l) * normals[v * 3 + 1] + (dz / l) * normals[v * 3 + 2];
    if (dot < worstDot) worstDot = dot;
  }
  check('normales sortantes', worstDot > 0.55, `dot min ${worstDot.toFixed(3)}`);

  // 3. orientation des triangles coherente avec la normale radiale
  let flipped = 0, sphereTriangles = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
    if (Math.max(positions[a + 1], positions[b + 1], positions[c + 1]) < ORIGIN_Y + VOXEL * 7) continue;
    sphereTriangles++;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const rx = positions[a] - cxw, ry = positions[a + 1] - cyw, rz = positions[a + 2] - czw;
    if (nx * rx + ny * ry + nz * rz < 0) flipped++;
  }
  check('triangles orientes vers l exterieur', flipped / sphereTriangles < 0.005,
    `${flipped}/${sphereTriangles} retournes`);

  // 4. etancheite
  const w = watertightness(positions, tris);
  check('surface etanche (pas de couture entre chunks)', w.unmatchedInterior === 0,
    `${w.unmatchedInterior} aretes ouvertes hors socle sur ${w.edges}, ${w.degenerate} degenerees`);
}

// ---------------------------------------------------------------------------
console.log('\n== Plan incline (verifie les axes) ==');
{
  const field = new VoxelField();
  // h(x,z) = 1.6 + 0.15*x + 0.06*z -> la normale doit valoir (-0.15, 1, -0.06)
  // normalisee. Pentes choisies pour que le plan reste dans le bloc (entre le
  // socle et le plafond du domaine) jusqu'aux coins d'un diorama de 12,8 m.
  const A = 0.15, B = 0.06, H = 1.6;
  for (let y = 0; y < NY; y++) {
    for (let z = 0; z < NZ; z++) {
      for (let x = 0; x < NX; x++) {
        const wx = ORIGIN_X + (x + 0.5) * VOXEL;
        const wy = ORIGIN_Y + (y + 0.5) * VOXEL;
        const wz = ORIGIN_Z + (z + 0.5) * VOXEL;
        const h = H + A * wx + B * wz;
        const v = Math.max(0, Math.min(255, Math.round(128 + ((h - wy) / VOXEL) * 128)));
        if (v > 0) field.density[x + NX * (z + NZ * y)] = v;
      }
    }
  }
  field.rebuildAll();
  const { positions, normals, tris } = meshAll(field);
  const nv = positions.length / 3;
  console.log(`  ${nv} sommets, ${tris.length / 3} triangles`);

  // Ne teste que les sommets loin des bords (les parois du bloc ont d'autres normales).
  const inset = 0.6;
  const nl = Math.hypot(-A, 1, -B);
  const ex = -A / nl, ey = 1 / nl, ez = -B / nl;
  let n = 0, bad = 0, maxH = 0;
  for (let v = 0; v < nv; v++) {
    const px = positions[v * 3], py = positions[v * 3 + 1], pz = positions[v * 3 + 2];
    if (px < ORIGIN_X + inset || px > -ORIGIN_X - inset) continue;
    if (pz < ORIGIN_Z + inset || pz > -ORIGIN_Z - inset) continue;
    if (py < ORIGIN_Y + VOXEL * 7) continue; // socle, pas le plan analytique
    n++;
    const h = H + A * px + B * pz;
    maxH = Math.max(maxH, Math.abs(py - h));
    const dot = normals[v * 3] * ex + normals[v * 3 + 1] * ey + normals[v * 3 + 2] * ez;
    if (dot < 0.985) bad++;
  }
  check('hauteur du plan respectee', maxH < VOXEL * 0.7, `ecart max ${(maxH * 1000).toFixed(1)} mm`);
  check('normale du plan correcte (axes non permutes)', bad / Math.max(1, n) < 0.02,
    `${bad}/${n} sommets hors tolerance`);

  const w = watertightness(positions, tris);
  check('surface etanche (hors fond du bloc, ouvert par construction)',
    w.unmatchedInterior === 0,
    `${w.unmatchedInterior} ouvertes hors socle / ${w.unmatched} au total`);
}

console.log(failures === 0 ? '\nTous les tests passent.\n' : `\n${failures} test(s) en echec.\n`);
process.exit(failures ? 1 : 0);
