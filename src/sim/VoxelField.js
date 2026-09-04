/**
 * VoxelField — le "terrain" du jeu.
 *
 * Un champ de densite scalaire 8 bits sur une grille reguliere, plus des
 * champs annexes (humidite, compaction, materiau). La surface visible est
 * l'isosurface density == ISO, extraite par Surface Nets chunk par chunk.
 *
 * Le champ est dense (25 Mo de typed arrays) plutot que sparse : a cette
 * taille c'est plus simple, plus rapide, et sans allocation pendant le jeu.
 * La "sparsite" est geree par des compteurs par chunk : un chunk vide ou
 * plein est detecte en O(1) et n'est jamais remaille.
 */

import { BORDER as MESH_BORDER } from './meshing/SurfaceNets.js';
import { extractBlock, allocBytes, isShared } from './meshing/Extract.js';
import {
  NX, NY, NZ, CHUNK, CX, CY, CZ, CHUNK_COUNT,
  VOXEL, ORIGIN_X, ORIGIN_Y, ORIGIN_Z, ISO, FOUNDATION_LAYERS,
  MAT_AIR, MAT_SAND, MAT_ROCK,
  vidx, cidx, chidx, clamp,
} from '../core/Config.js';

const SLICE = NX * NZ; // pas d'une couche Y
const COLS = NX * NZ;

export class VoxelField {
  constructor() {
    const n = NX * NY * NZ;

    // Les quatre champs vivent en memoire PARTAGEE quand la page est isolee
    // (COOP/COEP) : les workers de maillage y lisent leurs blocs eux-memes,
    // sans copie sur le fil principal. Voir meshing/Extract.js.
    /** Densite 0..255. ISO=128 est la surface. */
    this.density = allocBytes(n);
    /** Saturation en eau des pores, 0..255 -> 0..1. */
    this.moisture = allocBytes(n);
    /** Compaction / "pound-up", 0..255 -> 0..1. */
    this.packing = allocBytes(n);
    /** Materiau (sable, rocher, coquillage...). */
    this.material = allocBytes(n);
    /** Vrai si les champs sont partageables avec les workers. */
    this.shared = isShared(this.density);

    // --- caches par colonne -------------------------------------------------
    /** Plus haut voxel solide (density >= ISO) de la colonne, -1 si aucun. */
    this.topY = new Int16Array(COLS).fill(-1);
    /** Hauteur de surface interpolee, en metres monde. */
    this.surfaceH = new Float32Array(COLS);
    /** Plus bas voxel solide (pour la nappe / le fond du trou). */
    this.floorY = new Int16Array(COLS).fill(-1);

    // --- metadonnees par chunk ---------------------------------------------
    /** 0 = a jour, 1 = a remailler. */
    this.chunkDirty = new Uint8Array(CHUNK_COUNT);
    /** Nombre de voxels avec density > 0. */
    this.chunkSolid = new Uint32Array(CHUNK_COUNT);
    /** Nombre de voxels avec density >= ISO (pour detecter les chunks pleins). */
    this.chunkFull = new Uint32Array(CHUNK_COUNT);
    /** Incremente a chaque modification : invalide les maillages en vol. */
    this.chunkVersion = new Uint32Array(CHUNK_COUNT);

    /** File des chunks a remailler (indices uniques). */
    this.dirtyChunks = [];
    /** Colonnes dont topY / surfaceH sont a recalculer (une fois par frame). */
    this.colDirty = new Uint8Array(COLS);
    this.dirtyColumns = [];
    /** Colonnes dont la surface a change depuis le dernier fond d'eau (Water.refreshBed). */
    this.bedDirty = [];
    this.bedDirtyFlag = new Uint8Array(COLS);
    /** Incremente a chaque lot de colonnes recalculees : le GPU recharge le terrain fin. */
    this.surfaceVersion = 0;

    /** Bounding box des modifications de la frame, en voxels. */
    this.editMin = [NX, NY, NZ];
    this.editMax = [-1, -1, -1];

    /** Compteur global de modifications (pour les autres systemes). */
    this.revision = 0;
  }

  // -------------------------------------------------------------------------
  // ACCES
  // -------------------------------------------------------------------------

  /** @returns {number} densite 0..255, 0 hors bornes laterales, 255 sous le sol. */
  get(x, y, z) {
    if (x < 0 || z < 0 || x >= NX || z >= NZ || y >= NY) return 0;
    if (y < 0) return 255; // socle infini : on ne peut pas creuser sous le monde
    return this.density[x + NX * (z + NZ * y)];
  }

  getMoisture(x, y, z) {
    if (x < 0 || y < 0 || z < 0 || x >= NX || y >= NY || z >= NZ) return 0;
    return this.moisture[x + NX * (z + NZ * y)];
  }

  getPacking(x, y, z) {
    if (x < 0 || y < 0 || z < 0 || x >= NX || y >= NY || z >= NZ) return 0;
    return this.packing[x + NX * (z + NZ * y)];
  }

  getMaterial(x, y, z) {
    if (x < 0 || y < 0 || z < 0 || x >= NX || y >= NY || z >= NZ) return MAT_AIR;
    return this.material[x + NX * (z + NZ * y)];
  }

  isSolid(x, y, z) {
    return this.get(x, y, z) >= ISO;
  }

  // -------------------------------------------------------------------------
  // ECRITURE
  // -------------------------------------------------------------------------

  /**
   * Ecrit une densite. Met a jour les compteurs de chunk, les caches de
   * colonne et marque les chunks voisins concernes.
   * @returns {number} le delta reellement applique (-255..255)
   */
  set(x, y, z, value) {
    if (x < 0 || y < 0 || z < 0 || x >= NX || y >= NY || z >= NZ) return 0;
    const i = x + NX * (z + NZ * y);
    const old = this.density[i];
    let v = value < 0 ? 0 : value > 255 ? 255 : value | 0;
    if (y < FOUNDATION_LAYERS && v < 255) v = 255;
    if (v === old) return 0;

    this.density[i] = v;

    const ci = chidx((x / CHUNK) | 0, (y / CHUNK) | 0, (z / CHUNK) | 0);
    if (old > 0 && v === 0) this.chunkSolid[ci]--;
    else if (old === 0 && v > 0) this.chunkSolid[ci]++;
    if (old >= ISO && v < ISO) this.chunkFull[ci]--;
    else if (old < ISO && v >= ISO) this.chunkFull[ci]++;

    if (v === 0) {
      this.moisture[i] = 0;
      this.packing[i] = 0;
      this.material[i] = MAT_AIR;
    } else if (old === 0) {
      this.material[i] = MAT_SAND;
    }

    this.touch(x, y, z);
    return v - old;
  }

  /** Ajoute (ou retire) de la densite. @returns delta applique */
  add(x, y, z, delta) {
    if (x < 0 || y < 0 || z < 0 || x >= NX || y >= NY || z >= NZ) return 0;
    const i = x + NX * (z + NZ * y);
    return this.set(x, y, z, this.density[i] + delta);
  }

  setMoisture(x, y, z, m) {
    if (x < 0 || y < 0 || z < 0 || x >= NX || y >= NY || z >= NZ) return;
    const i = x + NX * (z + NZ * y);
    if (this.density[i] === 0) return;
    const v = m < 0 ? 0 : m > 255 ? 255 : m | 0;
    if (v === this.moisture[i]) return;
    this.moisture[i] = v;
    this.touchVisual(x, y, z); // l'humidite change la couleur -> remaillage
  }

  setPacking(x, y, z, p) {
    if (x < 0 || y < 0 || z < 0 || x >= NX || y >= NY || z >= NZ) return;
    const i = x + NX * (z + NZ * y);
    if (this.density[i] === 0) return;
    this.packing[i] = p < 0 ? 0 : p > 255 ? 255 : p | 0;
  }

  setMaterial(x, y, z, m) {
    if (x < 0 || y < 0 || z < 0 || x >= NX || y >= NY || z >= NZ) return;
    this.material[x + NX * (z + NZ * y)] = m;
  }

  // -------------------------------------------------------------------------
  // INVALIDATION
  // -------------------------------------------------------------------------

  /** Marque un chunk (et ses voisins si on est sur un bord) comme sale. */
  touch(x, y, z) {
    this.revision++;
    if (x < this.editMin[0]) this.editMin[0] = x;
    if (y < this.editMin[1]) this.editMin[1] = y;
    if (z < this.editMin[2]) this.editMin[2] = z;
    if (x > this.editMax[0]) this.editMax[0] = x;
    if (y > this.editMax[1]) this.editMax[1] = y;
    if (z > this.editMax[2]) this.editMax[2] = z;

    this.invalidateColumn(x, z);
    this.touchVisual(x, y, z);
  }

  /** Comme touch() mais sans invalider les caches de colonne. */
  touchVisual(x, y, z) {
    const cx = (x / CHUNK) | 0;
    const cy = (y / CHUNK) | 0;
    const cz = (z / CHUNK) | 0;
    this.markChunk(cx, cy, cz);
    // Un voxel sur un bord de chunk influence le maillage du chunk voisin.
    const lx = x - cx * CHUNK, ly = y - cy * CHUNK, lz = z - cz * CHUNK;
    if (lx <= 1) this.markChunk(cx - 1, cy, cz);
    if (ly <= 1) this.markChunk(cx, cy - 1, cz);
    if (lz <= 1) this.markChunk(cx, cy, cz - 1);
    if (lx >= CHUNK - 2) this.markChunk(cx + 1, cy, cz);
    if (ly >= CHUNK - 2) this.markChunk(cx, cy + 1, cz);
    if (lz >= CHUNK - 2) this.markChunk(cx, cy, cz + 1);
  }

  markChunk(cx, cy, cz) {
    if (cx < 0 || cy < 0 || cz < 0 || cx >= CX || cy >= CY || cz >= CZ) return;
    const ci = chidx(cx, cy, cz);
    this.chunkVersion[ci]++;
    if (!this.chunkDirty[ci]) {
      this.chunkDirty[ci] = 1;
      this.dirtyChunks.push(ci);
    }
  }

  /** Marque tous les chunks pour un remaillage complet. */
  markAll() {
    for (let i = 0; i < CHUNK_COUNT; i++) {
      this.chunkVersion[i]++;
      if (!this.chunkDirty[i]) {
        this.chunkDirty[i] = 1;
        this.dirtyChunks.push(i);
      }
    }
  }

  clearEditBounds() {
    this.editMin[0] = NX; this.editMin[1] = NY; this.editMin[2] = NZ;
    this.editMax[0] = -1; this.editMax[1] = -1; this.editMax[2] = -1;
  }

  // -------------------------------------------------------------------------
  // CACHES DE COLONNE
  // -------------------------------------------------------------------------

  /**
   * Marque une colonne comme a recalculer. Le recalcul lui-meme est differe a
   * flushColumns(), une fois par frame : recalculer une colonne de 96 voxels a
   * chaque ecriture couterait bien plus cher que la simulation elle-meme.
   */
  invalidateColumn(x, z) {
    const c = x + NX * z;
    if (this.colDirty[c]) return;
    this.colDirty[c] = 1;
    this.dirtyColumns.push(c);
  }

  /** Recalcule les colonnes marquees. A appeler une fois par frame. */
  flushColumns() {
    const list = this.dirtyColumns;
    if (list.length === 0) return 0;
    const bedList = this.bedDirty, bedFlag = this.bedDirtyFlag;
    for (let k = 0; k < list.length; k++) {
      const c = list[k];
      this.colDirty[c] = 0;
      this.recomputeColumn(c % NX, (c / NX) | 0);
      if (!bedFlag[c]) { bedFlag[c] = 1; bedList.push(c); }
    }
    const n = list.length;
    list.length = 0;
    this.surfaceVersion++;
    return n;
  }

  /**
   * Recalcule topY, floorY et surfaceH pour une colonne.
   * surfaceH est interpolee lineairement entre le dernier voxel plein et le
   * premier voxel vide : ca donne une hauteur continue pour la simu d'eau.
   */
  recomputeColumn(x, z) {
    const c = x + NX * z;
    const base = x + NX * z;
    let top = -1;
    for (let y = NY - 1; y >= 0; y--) {
      if (this.density[base + SLICE * y] >= ISO) { top = y; break; }
    }
    this.topY[c] = top;
    if (top < 0) {
      this.surfaceH[c] = ORIGIN_Y;
      this.floorY[c] = -1;
      return;
    }
    // Interpolation sous-voxel avec le voxel du dessus.
    const dTop = this.density[base + SLICE * top];
    const dAbove = top + 1 < NY ? this.density[base + SLICE * (top + 1)] : 0;
    let frac = 0.5;
    if (dTop !== dAbove) frac = clamp((dTop - ISO) / (dTop - dAbove), 0, 1);
    this.surfaceH[c] = ORIGIN_Y + (top + 0.5 + frac) * VOXEL;

    let floor = 0;
    for (let y = 0; y <= top; y++) {
      if (this.density[base + SLICE * y] >= ISO) { floor = y; break; }
    }
    this.floorY[c] = floor;
  }

  /**
   * Recalcule toutes les metadonnees a partir des tableaux bruts.
   * A appeler apres une generation ou un chargement qui ecrit directement
   * dans `density` sans passer par set().
   */
  rebuildAll() {
    this.surfaceVersion++;
    // Migration comprise : referme aussi les anciennes sauvegardes qui avaient
    // deja ete percees jusqu'au dessous du champ voxel.
    for (let y = 0; y < FOUNDATION_LAYERS; y++) {
      const a = y * SLICE, b = a + SLICE;
      this.density.fill(255, a, b);
      this.packing.fill(255, a, b);
      this.material.fill(MAT_SAND, a, b);
    }
    this.chunkSolid.fill(0);
    this.chunkFull.fill(0);
    const dens = this.density;
    for (let y = 0; y < NY; y++) {
      const cy = (y / CHUNK) | 0;
      for (let z = 0; z < NZ; z++) {
        const cz = (z / CHUNK) | 0;
        const row = NX * (z + NZ * y);
        for (let x = 0; x < NX; x++) {
          const d = dens[row + x];
          if (d === 0) continue;
          const ci = chidx((x / CHUNK) | 0, cy, cz);
          this.chunkSolid[ci]++;
          if (d >= ISO) this.chunkFull[ci]++;
        }
      }
    }
    this.recomputeAllColumns();
    this.markAll();
  }

  recomputeAllColumns() {
    for (let z = 0; z < NZ; z++) {
      for (let x = 0; x < NX; x++) this.recomputeColumn(x, z);
    }
  }

  /** Hauteur de surface (metres) a une position monde, avec interpolation bilineaire. */
  surfaceHeightAt(wx, wz) {
    const fx = clamp((wx - ORIGIN_X) / VOXEL - 0.5, 0, NX - 1.001);
    const fz = clamp((wz - ORIGIN_Z) / VOXEL - 0.5, 0, NZ - 1.001);
    const x0 = fx | 0, z0 = fz | 0;
    const tx = fx - x0, tz = fz - z0;
    const h = this.surfaceH;
    const h00 = h[x0 + NX * z0];
    const h10 = h[x0 + 1 + NX * z0];
    const h01 = h[x0 + NX * (z0 + 1)];
    const h11 = h[x0 + 1 + NX * (z0 + 1)];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  // -------------------------------------------------------------------------
  // ECHANTILLONNAGE CONTINU
  // -------------------------------------------------------------------------

  /**
   * Densite trilineaire en coordonnees voxel (les entiers = centres de voxel).
   */
  sample(vx, vy, vz) {
    const x0 = Math.floor(vx), y0 = Math.floor(vy), z0 = Math.floor(vz);
    const tx = vx - x0, ty = vy - y0, tz = vz - z0;
    const g = (x, y, z) => this.get(x, y, z);
    const c000 = g(x0, y0, z0), c100 = g(x0 + 1, y0, z0);
    const c010 = g(x0, y0 + 1, z0), c110 = g(x0 + 1, y0 + 1, z0);
    const c001 = g(x0, y0, z0 + 1), c101 = g(x0 + 1, y0, z0 + 1);
    const c011 = g(x0, y0 + 1, z0 + 1), c111 = g(x0 + 1, y0 + 1, z0 + 1);
    const c00 = c000 + (c100 - c000) * tx;
    const c10 = c010 + (c110 - c010) * tx;
    const c01 = c001 + (c101 - c001) * tx;
    const c11 = c011 + (c111 - c011) * tx;
    const c0 = c00 + (c10 - c00) * ty;
    const c1 = c01 + (c11 - c01) * ty;
    return c0 + (c1 - c0) * tz;
  }

  /** Gradient de densite (normale non normalisee, pointe vers l'exterieur). */
  gradient(vx, vy, vz, out = { x: 0, y: 0, z: 0 }) {
    const e = 0.75;
    out.x = this.sample(vx - e, vy, vz) - this.sample(vx + e, vy, vz);
    out.y = this.sample(vx, vy - e, vz) - this.sample(vx, vy + e, vz);
    out.z = this.sample(vx, vy, vz - e) - this.sample(vx, vy, vz + e);
    const l = Math.hypot(out.x, out.y, out.z) || 1;
    out.x /= l; out.y /= l; out.z /= l;
    return out;
  }

  /** Humidite moyenne dans une sphere (rayon en metres) autour d'un point monde. */
  averageMoisture(wx, wy, wz, radius = 0.12) {
    const r = Math.max(1, Math.round(radius / VOXEL));
    const cxv = Math.round((wx - ORIGIN_X) / VOXEL - 0.5);
    const cyv = Math.round((wy - ORIGIN_Y) / VOXEL - 0.5);
    const czv = Math.round((wz - ORIGIN_Z) / VOXEL - 0.5);
    let sum = 0, n = 0;
    for (let dz = -r; dz <= r; dz++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy + dz * dz > r * r) continue;
          const x = cxv + dx, y = cyv + dy, z = czv + dz;
          if (x < 0 || y < 0 || z < 0 || x >= NX || y >= NY || z >= NZ) continue;
          const i = x + NX * (z + NZ * y);
          if (this.density[i] < ISO) continue;
          sum += this.moisture[i];
          n++;
        }
      }
    }
    return n ? sum / n / 255 : 0;
  }

  /** Compaction moyenne dans une sphere. */
  averagePacking(wx, wy, wz, radius = 0.12) {
    const r = Math.max(1, Math.round(radius / VOXEL));
    const cxv = Math.round((wx - ORIGIN_X) / VOXEL - 0.5);
    const cyv = Math.round((wy - ORIGIN_Y) / VOXEL - 0.5);
    const czv = Math.round((wz - ORIGIN_Z) / VOXEL - 0.5);
    let sum = 0, n = 0;
    for (let dz = -r; dz <= r; dz++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = cxv + dx, y = cyv + dy, z = czv + dz;
          if (x < 0 || y < 0 || z < 0 || x >= NX || y >= NY || z >= NZ) continue;
          const i = x + NX * (z + NZ * y);
          if (this.density[i] < ISO) continue;
          sum += this.packing[i];
          n++;
        }
      }
    }
    return n ? sum / n / 255 : 0;
  }

  // -------------------------------------------------------------------------
  // RAYCAST
  // -------------------------------------------------------------------------

  /**
   * Lance un rayon (coordonnees monde) et renvoie le premier point de la
   * surface touche, ou null. DDA voxel + raffinement dichotomique sur la
   * densite interpolee, pour un point de contact lisse (pas en escalier).
   *
   * @param {{x:number,y:number,z:number}} o origine monde
   * @param {{x:number,y:number,z:number}} d direction normalisee
   * @param {number} maxDist distance max en metres
   */
  raycast(o, d, maxDist = 40) {
    // -> espace voxel (centres aux entiers)
    let px = (o.x - ORIGIN_X) / VOXEL - 0.5;
    let py = (o.y - ORIGIN_Y) / VOXEL - 0.5;
    let pz = (o.z - ORIGIN_Z) / VOXEL - 0.5;

    const maxSteps = Math.min(2048, Math.ceil(maxDist / VOXEL) + 2);
    const step = 0.85; // pas en voxels : < 1 pour ne rien rater
    let t = 0;
    let prev = this.sample(px, py, pz);
    if (prev >= ISO) {
      // On demarre dans la matiere : on remonte jusqu'a sortir.
      return null;
    }
    const dx = d.x * step, dy = d.y * step, dz = d.z * step;

    for (let i = 0; i < maxSteps; i++) {
      const nx = px + dx, ny = py + dy, nz = pz + dz;
      // Sortie de boite (avec marge verticale genereuse)
      if (nx < -2 || nz < -2 || nx > NX + 2 || nz > NZ + 2 || ny < -2 || ny > NY + 4) {
        if (ny > NY + 4 && dy > 0) return null;
        if ((nx < -2 && dx <= 0) || (nx > NX + 2 && dx >= 0)) return null;
        if ((nz < -2 && dz <= 0) || (nz > NZ + 2 && dz >= 0)) return null;
        if (ny < -2) return null;
      }
      const cur = this.sample(nx, ny, nz);
      if (cur >= ISO) {
        // Dichotomie entre (px,py,pz) et (nx,ny,nz)
        let a = 0, b = 1;
        for (let k = 0; k < 12; k++) {
          const m = (a + b) * 0.5;
          const s = this.sample(px + dx * m, py + dy * m, pz + dz * m);
          if (s >= ISO) b = m; else a = m;
        }
        const hx = px + dx * b, hy = py + dy * b, hz = pz + dz * b;
        const n = this.gradient(hx, hy, hz);
        return {
          point: {
            x: ORIGIN_X + (hx + 0.5) * VOXEL,
            y: ORIGIN_Y + (hy + 0.5) * VOXEL,
            z: ORIGIN_Z + (hz + 0.5) * VOXEL,
          },
          voxel: { x: Math.round(hx), y: Math.round(hy), z: Math.round(hz) },
          normal: n,
          distance: (t + step * b) * VOXEL,
        };
      }
      px = nx; py = ny; pz = nz; prev = cur;
      t += step;
      if (t * VOXEL > maxDist) return null;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // EXTRACTION POUR LE MAILLAGE
  // -------------------------------------------------------------------------

  /**
   * Copie un bloc (CHUNK+2)^3 couvrant [-1, CHUNK] autour du chunk demande,
   * dans les buffers fournis. Le bord de 1 voxel garantit des maillages
   * jointifs entre chunks.
   */
  extractChunk(ci, outD, outM, outP, outMat) {
    // Le corps vit dans meshing/Extract.js : les workers de maillage
    // l'executent eux-memes sur la memoire partagee du champ.
    return extractBlock(this.density, this.moisture, this.packing, this.material,
      ci, outD, outM, outP, outMat);
  }

  /** Le chunk peut-il produire une geometrie ? (ni totalement vide ni totalement plein) */
  chunkNeedsMesh(ci) {
    const total = CHUNK * CHUNK * CHUNK;
    if (this.chunkSolid[ci] === 0) {
      // Vide : sauf si un chunk voisin dessous est plein (surface au bord).
      return false;
    }
    if (this.chunkFull[ci] === total) {
      // Chunk plein : il ne produit de geometrie que si un voisin laisse
      // passer la surface. Attention aux bords du domaine : lateralement
      // l'exterieur est du vide (c'est la paroi du bloc diorama), donc un
      // chunk plein colle au bord DOIT etre maille.
      const cy = (ci / (CX * CZ)) | 0;
      const rem = ci - cy * CX * CZ;
      const cz = (rem / CX) | 0;
      const cx = rem - cz * CX;
      const nb = [
        [cx - 1, cy, cz], [cx + 1, cy, cz],
        [cx, cy - 1, cz], [cx, cy + 1, cz],
        [cx, cy, cz - 1], [cx, cy, cz + 1],
      ];
      for (const [a, b, c] of nb) {
        if (b < 0) continue; // sous le monde : matiere pleine, pas de surface
        if (a < 0 || c < 0 || a >= CX || c >= CZ || b >= CY) return true; // vide dehors
        const j = chidx(a, b, c);
        if (this.chunkFull[j] !== total) return true;
      }
      return false;
    }
    return true;
  }
}
