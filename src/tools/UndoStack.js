/**
 * Annulation par instantanes de chunks.
 *
 * Un jeu cozy doit pouvoir revenir en arriere sans reflechir. Journaliser
 * chaque voxel modifie serait plus compact, mais ne rattraperait pas ce que la
 * physique a fait APRES le geste (avalanches, erosion) — et c'est justement ce
 * que le joueur veut annuler quand son mur s'est ecroule.
 *
 * On photographie donc les chunks entiers touches par un geste, avant qu'il
 * commence. Restaurer, c'est recopier. 128 Ko par chunk, quelques chunks par
 * geste : largement dans le budget pour une trentaine de retours en arriere.
 */

import { NX, NY, NZ, CHUNK, CX, CY, CZ, chidx } from '../core/Config.js';

const CHUNK3 = CHUNK * CHUNK * CHUNK;
const BYTES_PER_CHUNK = CHUNK3 * 4;

export class UndoStack {
  /**
   * @param {import('../sim/VoxelField.js').VoxelField} field
   * @param {number} maxBytes budget memoire total
   */
  constructor(field, maxBytes = 64 * 1024 * 1024) {
    this.field = field;
    this.maxBytes = maxBytes;
    /** @type {{label:string, chunks:Map<number,object>, bytes:number}[]} */
    this.groups = [];
    this.redoGroups = [];
    this.current = null;
    this.bytes = 0;
    this.pool = [];
  }

  get canUndo() { return this.groups.length > 0; }
  get canRedo() { return this.redoGroups.length > 0; }

  beginGroup(label = 'geste') {
    if (this.current) this.endGroup();
    this.current = { label, chunks: new Map(), bytes: 0 };
    // Un nouveau geste invalide la pile de retablissement.
    for (const g of this.redoGroups) this.recycle(g);
    this.redoGroups.length = 0;
  }

  endGroup() {
    if (!this.current) return;
    if (this.current.chunks.size === 0) { this.current = null; return; }
    this.groups.push(this.current);
    this.bytes += this.current.bytes;
    this.current = null;
    this.trim();
  }

  /** Photographie tous les chunks intersectant la boite (coordonnees voxel). */
  captureBox(x0, y0, z0, x1, y1, z1) {
    if (!this.current) this.beginGroup();
    const cx0 = Math.max(0, (x0 / CHUNK) | 0), cx1 = Math.min(CX - 1, (x1 / CHUNK) | 0);
    const cy0 = Math.max(0, (y0 / CHUNK) | 0), cy1 = Math.min(CY - 1, (y1 / CHUNK) | 0);
    const cz0 = Math.max(0, (z0 / CHUNK) | 0), cz1 = Math.min(CZ - 1, (z1 / CHUNK) | 0);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) this.captureChunk(chidx(cx, cy, cz));
      }
    }
  }

  captureChunk(ci) {
    const g = this.current;
    if (g.chunks.has(ci)) return;
    const snap = this.acquire();
    this.copyChunk(ci, snap, true);
    g.chunks.set(ci, snap);
    g.bytes += BYTES_PER_CHUNK;
  }

  /** Copie un chunk entre le champ et un instantane. */
  copyChunk(ci, snap, save) {
    const F = this.field;
    const cy = (ci / (CX * CZ)) | 0;
    const rem = ci - cy * CX * CZ;
    const cz = (rem / CX) | 0;
    const cx = rem - cz * CX;
    const ox = cx * CHUNK, oy = cy * CHUNK, oz = cz * CHUNK;

    let o = 0;
    for (let y = 0; y < CHUNK; y++) {
      for (let z = 0; z < CHUNK; z++) {
        const base = ox + NX * ((oz + z) + NZ * (oy + y));
        if (save) {
          snap.d.set(F.density.subarray(base, base + CHUNK), o);
          snap.m.set(F.moisture.subarray(base, base + CHUNK), o);
          snap.p.set(F.packing.subarray(base, base + CHUNK), o);
          snap.t.set(F.material.subarray(base, base + CHUNK), o);
        } else {
          F.density.set(snap.d.subarray(o, o + CHUNK), base);
          F.moisture.set(snap.m.subarray(o, o + CHUNK), base);
          F.packing.set(snap.p.subarray(o, o + CHUNK), base);
          F.material.set(snap.t.subarray(o, o + CHUNK), base);
        }
        o += CHUNK;
      }
    }
    return { cx, cy, cz, ox, oy, oz };
  }

  /**
   * Annule le dernier geste. On echange : l'etat courant part dans la pile de
   * retablissement, ce qui rend refaire gratuit.
   */
  undo() {
    if (this.current) this.endGroup();
    const g = this.groups.pop();
    if (!g) return null;
    this.bytes -= g.bytes;
    this.applyGroup(g);
    this.redoGroups.push(g);
    return g.label;
  }

  redo() {
    const g = this.redoGroups.pop();
    if (!g) return null;
    this.applyGroup(g);
    this.groups.push(g);
    this.bytes += g.bytes;
    return g.label;
  }

  /** Restaure l'instantane en gardant l'etat courant dans le meme objet. */
  applyGroup(g) {
    const F = this.field;
    const tmp = this.acquire();
    for (const [ci, snap] of g.chunks) {
      // sauvegarde de l'etat actuel dans tmp
      this.copyChunk(ci, tmp, true);
      // restauration
      const info = this.copyChunk(ci, snap, false);
      // l'etat actuel devient l'instantane (pour refaire)
      snap.d.set(tmp.d); snap.m.set(tmp.m); snap.p.set(tmp.p); snap.t.set(tmp.t);
      // metadonnees
      this.rebuildChunk(ci, info);
    }
    this.release(tmp);
    F.markAll();
  }

  /** Recompte les statistiques d'un chunk et invalide ses colonnes. */
  rebuildChunk(ci, info) {
    const F = this.field;
    let solid = 0, full = 0;
    for (let y = 0; y < CHUNK; y++) {
      for (let z = 0; z < CHUNK; z++) {
        const base = info.ox + NX * ((info.oz + z) + NZ * (info.oy + y));
        for (let x = 0; x < CHUNK; x++) {
          const d = F.density[base + x];
          if (d > 0) solid++;
          if (d >= 128) full++;
        }
      }
    }
    F.chunkSolid[ci] = solid;
    F.chunkFull[ci] = full;
    for (let z = 0; z < CHUNK; z++) {
      for (let x = 0; x < CHUNK; x++) F.invalidateColumn(info.ox + x, info.oz + z);
    }
  }

  acquire() {
    return this.pool.pop() || {
      d: new Uint8Array(CHUNK3),
      m: new Uint8Array(CHUNK3),
      p: new Uint8Array(CHUNK3),
      t: new Uint8Array(CHUNK3),
    };
  }

  release(s) { if (this.pool.length < 8) this.pool.push(s); }

  recycle(g) {
    for (const s of g.chunks.values()) this.release(s);
    g.chunks.clear();
  }

  /** Jette les gestes les plus anciens si le budget memoire est depasse. */
  trim() {
    while (this.bytes > this.maxBytes && this.groups.length > 1) {
      const g = this.groups.shift();
      this.bytes -= g.bytes;
      this.recycle(g);
    }
  }

  clear() {
    for (const g of this.groups) this.recycle(g);
    for (const g of this.redoGroups) this.recycle(g);
    this.groups.length = 0;
    this.redoGroups.length = 0;
    this.bytes = 0;
    this.current = null;
  }
}
