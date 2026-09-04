/**
 * Tests de l'extraction de bloc partagee entre le champ et les workers.
 *
 * `extractBlock` doit produire exactement le bloc qu'une lecture naive,
 * voxel par voxel avec test de bornes, produirait : c'est ce que les
 * workers de maillage lisent dans la memoire partagee, et une erreur d'un
 * octet y ferait une couture ou un trou dans le sable.
 */
import { NX, NY, NZ, CHUNK, CX, CY, CZ, CHUNK_COUNT, MAT_AIR, MAT_SAND } from '../src/core/Config.js';
import { VoxelField } from '../src/sim/VoxelField.js';
import { extractBlock, BLOCK, BLOCK_SIZE, canShareMemory, isShared } from '../src/sim/meshing/Extract.js';
import { BORDER } from '../src/sim/meshing/SurfaceNets.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

/** Reference lente : un voxel a la fois, avec la regle de bord du diorama. */
function naive(field, ci, outD, outM, outP, outMat) {
  const cy = (ci / (CX * CZ)) | 0;
  const rem = ci - cy * CX * CZ;
  const cz = (rem / CX) | 0;
  const cx = rem - cz * CX;
  const ox = cx * CHUNK - BORDER, oy = cy * CHUNK - BORDER, oz = cz * CHUNK - BORDER;
  const S = BLOCK;
  for (let lz = 0; lz < S; lz++) for (let ly = 0; ly < S; ly++) for (let lx = 0; lx < S; lx++) {
    const x = ox + lx, y = oy + ly, z = oz + lz;
    const o = lx + S * (ly + S * lz);
    const inXZ = x >= 0 && x < NX && z >= 0 && z < NZ;
    if (inXZ && y >= 0 && y < NY) {
      const i = x + NX * (z + NZ * y);
      outD[o] = field.density[i]; outM[o] = field.moisture[i];
      outP[o] = field.packing[i]; outMat[o] = field.material[i];
    } else if (y < 0 && z >= 0 && z < NZ && x >= 0 && x < NX) {
      outD[o] = 255; outM[o] = 255; outP[o] = 255; outMat[o] = MAT_SAND;
    } else {
      outD[o] = 0; outM[o] = 0; outP[o] = 0; outMat[o] = MAT_AIR;
    }
  }
}

console.log('\n== Extraction de bloc ==');
{
  const field = new VoxelField();
  // Un champ pseudo-aleatoire, plein en bas, troue en haut.
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let y = 0; y < NY; y++) for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) {
    const i = x + NX * (z + NZ * y);
    const h = 20 + 10 * Math.sin(x * 0.07) * Math.cos(z * 0.05);
    const d = y < h ? 255 : (rnd() < 0.02 ? 200 : 0);
    field.density[i] = d;
    field.moisture[i] = d ? (rnd() * 255) | 0 : 0;
    field.packing[i] = d ? (rnd() * 255) | 0 : 0;
    field.material[i] = d ? MAT_SAND : MAT_AIR;
  }
  const A = [new Uint8Array(BLOCK_SIZE), new Uint8Array(BLOCK_SIZE), new Uint8Array(BLOCK_SIZE), new Uint8Array(BLOCK_SIZE)];
  const B = [new Uint8Array(BLOCK_SIZE), new Uint8Array(BLOCK_SIZE), new Uint8Array(BLOCK_SIZE), new Uint8Array(BLOCK_SIZE)];
  // Coins et bords du domaine, un chunk du milieu, la couche haute.
  const cases = [0, CX - 1, CX * (CZ - 1), CX * CZ - 1, (CX >> 1) + CX * (CZ >> 1), CX * CZ * (CY - 1) + 3, CHUNK_COUNT - 1];
  let allSame = true, detail = '';
  for (const ci of cases) {
    // Tampons volontairement sales : l'extraction doit tout ecrire.
    for (const arr of A) arr.fill(77);
    const info = extractBlock(field.density, field.moisture, field.packing, field.material, ci, ...A);
    naive(field, ci, ...B);
    for (let k = 0; k < 4 && allSame; k++) {
      for (let o = 0; o < BLOCK_SIZE; o++) {
        if (A[k][o] !== B[k][o]) { allSame = false; detail = `chunk ${ci}, tableau ${k}, offset ${o}: ${A[k][o]} vs ${B[k][o]}`; break; }
      }
    }
    const cy = (ci / (CX * CZ)) | 0;
    if (info.oy !== cy * CHUNK) { allSame = false; detail = `origine y fausse pour ${ci}`; }
  }
  check('le bloc rapide est identique a la reference naive sur 7 chunks', allSame, detail);
  check('la delegation du champ donne le meme bloc', (() => {
    for (const arr of A) arr.fill(0);
    field.extractChunk(cases[4], ...A);
    naive(field, cases[4], ...B);
    for (let o = 0; o < BLOCK_SIZE; o++) if (A[0][o] !== B[0][o]) return false;
    return true;
  })());
}

console.log('\n== Memoire partagee ==');
{
  const field = new VoxelField();
  if (canShareMemory()) {
    check('les champs vivent dans un SharedArrayBuffer', field.shared && isShared(field.density) && isShared(field.material));
    // Une copie (slice) reste ordinaire : c'est ce que la sauvegarde envoie au Blob.
    const copy = field.density.slice(0, 16);
    check('une copie du champ n est plus partagee', !isShared(copy));
  } else {
    check('sans memoire partagee, le champ reste ordinaire', !field.shared);
  }
}

if (failures) {
  console.log(`\n${failures} test(s) d extraction en echec.`);
  process.exit(1);
}
console.log('\nTous les tests d extraction passent.');
