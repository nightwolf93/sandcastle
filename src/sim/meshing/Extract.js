/**
 * Extraction du bloc de voxels d'un chunk, bordure comprise.
 *
 * Fonction PURE, sans dependance a VoxelField : c'est ce qui permet de
 * l'executer dans un worker de maillage directement sur les tableaux
 * partages (SharedArrayBuffer) du champ. Avant, le fil principal copiait
 * chaque bloc (44^3 x 4 tableaux = 340 Ko) dans des tampons transferables
 * a chaque remaillage : jusqu'a 2 Mo par image en remaillage intensif, sur
 * le fil qui doit aussi rendre. Avec la memoire partagee, le worker lit le
 * champ lui-meme et le fil principal ne fait qu'envoyer un indice.
 *
 * Coherence : le worker lit pendant que le fil principal ecrit. Un octet est
 * toujours lu entier, mais un bloc peut melanger deux etats du chunk. C'est
 * exactement le cas que couvre deja la version du chunk : si elle a change
 * entre l'envoi et le retour, le maillage est jete et le chunk remis en file.
 */

import { NX, NY, NZ, CHUNK, CX, CZ, MAT_AIR, MAT_SAND } from '../../core/Config.js';
import { BORDER } from './SurfaceNets.js';

/** Cote du bloc echantillonne. */
export const BLOCK = CHUNK + 2 * BORDER;
export const BLOCK_SIZE = BLOCK * BLOCK * BLOCK;

/**
 * Remplit les quatre tableaux de bloc (densite, humidite, compaction,
 * materiau) pour le chunk `ci`, dans la disposition attendue par
 * SurfaceNets : x le plus rapide, puis y, puis z.
 *
 * @param {Uint8Array} dens  densite du champ (NX*NY*NZ)
 * @param {Uint8Array} mois  humidite
 * @param {Uint8Array} pack  compaction
 * @param {Uint8Array} mat   materiau
 * @returns {{cx:number, cy:number, cz:number, ox:number, oy:number, oz:number}}
 */
export function extractBlock(dens, mois, pack, mat, ci, outD, outM, outP, outMat) {
  const cy = (ci / (CX * CZ)) | 0;
  const rem = ci - cy * CX * CZ;
  const cz = (rem / CX) | 0;
  const cx = rem - cz * CX;
  // Bordure large : le mesher y calcule les normales par gradient ET
  // l'occlusion ambiante, dont les rayons portent a ~4,4 voxels. Une bordure
  // trop etroite se traduit par des coutures visibles entre chunks.
  const ox = cx * CHUNK - BORDER;
  const oy = cy * CHUNK - BORDER;
  const oz = cz * CHUNK - BORDER;
  const S = BLOCK;
  const S2 = S * S;

  // La copie se fait par RANGEE CONTIGUE, pas voxel par voxel.
  const xw0 = Math.max(0, ox);                 // premier x monde couvert
  const xw1 = Math.min(NX, ox + S);            // borne exclusive
  const pre = xw0 - ox;                        // voxels hors domaine a gauche
  const len = Math.max(0, xw1 - xw0);          // longueur de la partie copiable

  for (let lz = 0; lz < S; lz++) {
    const z = oz + lz;
    const zOK = z >= 0 && z < NZ;
    const zOff = S2 * lz;
    for (let ly = 0; ly < S; ly++) {
      const y = oy + ly;
      const yOK = y >= 0 && y < NY;
      const under = y < 0;
      const o = zOff + S * ly;
      if (!yOK || !zOK) {
        // Rangee entierement hors domaine : socle plein sous le monde
        // (si z est dans le domaine), vide partout ailleurs.
        const solid = under && zOK;
        if (solid && len > 0) {
          if (pre > 0 || len < S) {
            outD.fill(0, o, o + S); outM.fill(0, o, o + S);
            outP.fill(0, o, o + S); outMat.fill(MAT_AIR, o, o + S);
          }
          outD.fill(255, o + pre, o + pre + len);
          outM.fill(255, o + pre, o + pre + len);
          outP.fill(255, o + pre, o + pre + len);
          outMat.fill(MAT_SAND, o + pre, o + pre + len);
        } else {
          outD.fill(0, o, o + S); outM.fill(0, o, o + S);
          outP.fill(0, o, o + S); outMat.fill(MAT_AIR, o, o + S);
        }
        continue;
      }
      // Cote du bloc diorama : vide, ce qui donne une paroi nette.
      if (pre > 0 || len < S) {
        outD.fill(0, o, o + S); outM.fill(0, o, o + S);
        outP.fill(0, o, o + S); outMat.fill(MAT_AIR, o, o + S);
      }
      if (len > 0) {
        // Copie sequentielle sans test de borne par element ni vue
        // intermediaire (subarray allouerait ~8 000 vues par extraction).
        let src = NX * (z + NZ * y) + xw0;
        let dst = o + pre;
        for (let k = 0; k < len; k++, src++, dst++) {
          outD[dst] = dens[src];
          outM[dst] = mois[src];
          outP[dst] = pack[src];
          outMat[dst] = mat[src];
        }
      }
    }
  }
  return { cx, cy, cz, ox: cx * CHUNK, oy: cy * CHUNK, oz: cz * CHUNK };
}

/**
 * Alloue un tableau d'octets partageable entre fils quand l'environnement
 * le permet (page isolee par COOP/COEP, ou Node), ordinaire sinon.
 */
export function allocBytes(n) {
  if (canShareMemory()) return new Uint8Array(new SharedArrayBuffer(n));
  return new Uint8Array(n);
}

export function canShareMemory() {
  if (typeof SharedArrayBuffer === 'undefined') return false;
  // Dans un navigateur, la memoire partagee n'existe que sur une page isolee.
  if (typeof crossOriginIsolated !== 'undefined') return !!crossOriginIsolated;
  return true;
}

/** Vrai si le tableau repose sur une memoire partagee. */
export function isShared(view) {
  return typeof SharedArrayBuffer !== 'undefined' && view.buffer instanceof SharedArrayBuffer;
}
