/**
 * Pool de workers de maillage.
 *
 * Boucle : on prend les chunks marques sales, on envoie au premier worker
 * libre. Quand la geometrie revient, on verifie que le chunk n'a pas ete
 * re-modifie entre temps (comparaison de version) ; si c'est le cas on le
 * remet en file.
 *
 * Deux modes d'entree :
 *  - MEMOIRE PARTAGEE (page isolee par COOP/COEP) : les workers recoivent une
 *    fois pour toutes les quatre tableaux du champ et extraient eux-memes le
 *    bloc du chunk demande. Le fil principal n'envoie qu'un indice et une
 *    version : zero copie, zero transfert.
 *  - COPIE (repli) : le fil principal extrait le bloc (CHUNK+12)^3 dans des
 *    tampons recycles et les transfere au worker, qui les renvoie.
 */

import { CHUNK, CHUNK_COUNT, MESH_WORKERS, VOXEL, ORIGIN_X, ORIGIN_Y, ORIGIN_Z, CX, CZ, NX, NZ } from '../../core/Config.js';
import { BORDER } from './SurfaceNets.js';

const BLOCK = CHUNK + 2 * BORDER;
const BLOCK_SIZE = BLOCK * BLOCK * BLOCK;

// --- PERF (cadence de remaillage, debut) -----------------------------------
/**
 * Un chunk LOIN du point de travail ne peut pas etre remaille plus souvent
 * que toutes les COOL_MS millisecondes.
 *
 * Sans ce frein, le ressac re-salissait en continu la totalite des chunks de
 * l'estran : ~260 remaillages/s en regime permanent, soit plusieurs ms
 * d'extraction sur le fil principal PAR FRAME, des workers satures et un
 * re-upload GPU massif — pour re-dessiner a 60 Hz une teinte d'humidite qui
 * evolue en secondes. A ~3 Hz, l'oeil ne voit pas la difference.
 *
 * Pres du curseur (FOCUS_R), aucune limite : le sable que le joueur sculpte
 * doit continuer a couler a la cadence de la boucle.
 */
const COOL_MS = 600;
const FOCUS_R2 = 1.8 * 1.8; // m^2
// --- PERF (cadence de remaillage, fin) --------------------------------------

export class MesherPool {
  /**
   * @param {import('../VoxelField.js').VoxelField} field
   * @param {(ci:number, geo:object|null)=>void} onMesh
   */
  constructor(field, onMesh) {
    this.field = field;
    this.onMesh = onMesh;
    this.workers = [];
    this.idle = [];
    this.pending = new Map(); // ci -> version envoyee
    this.queue = [];
    this.queued = new Set();
    this.bufferPool = [];
    this.ready = false;
    this.readyCount = 0;
    this.stats = { meshed: 0, lastMs: 0, avgMs: 0 };

    // --- PERF (cadence de remaillage, debut) --------------------------------
    /** Date du dernier envoi au worker, par chunk. */
    this.lastDispatch = new Float64Array(CHUNK_COUNT);
    /** Chunks sales mis en attente de refroidissement. */
    this.cooling = [];
    this.coolingFlag = new Uint8Array(CHUNK_COUNT);
    /** Point de travail du joueur (mis a jour par prioritize). */
    this.focusX = 0;
    this.focusZ = 0;
    /** Delai de refroidissement effectif (0 = comportement d'origine). */
    this.coolMs = COOL_MS;
    // --- PERF (cadence de remaillage, fin) ----------------------------------

    /** Les workers lisent le champ directement (memoire partagee). */
    this.shared = !!field.shared;
    for (let i = 0; i < MESH_WORKERS; i++) {
      // Le nom du worker porte la taille de la carte : Config.js le lit avant
      // tout, un worker n'ayant ni localStorage ni parametre d'URL.
      const w = new Worker(new URL('./MeshWorker.js', import.meta.url), { type: 'module', name: `map:${NX}x${NZ}` });
      w.onmessage = (ev) => this.handle(w, ev.data);
      const init = { type: 'init', chunkSize: CHUNK };
      if (this.shared) {
        init.shared = {
          D: field.density.buffer, M: field.moisture.buffer,
          P: field.packing.buffer, T: field.material.buffer,
        };
      }
      w.postMessage(init);
      this.workers.push(w);
    }
  }

  handle(w, m) {
    if (m.type === 'ready') {
      this.readyCount++;
      this.idle.push(w);
      if (this.readyCount === this.workers.length) this.ready = true;
      this.pump();
      return;
    }
    if (m.type !== 'mesh') return;

    // Recycle les buffers d'entree (mode copie seulement).
    if (m.D) this.bufferPool.push({ D: m.D, M: m.M, P: m.P, T: m.T });

    const ci = m.ci;
    this.pending.delete(ci);
    this.stats.meshed++;
    this.stats.lastMs = m.ms;
    this.stats.avgMs = this.stats.avgMs * 0.9 + m.ms * 0.1;

    // Le chunk a-t-il bouge depuis l'envoi ?
    const stale = this.field.chunkVersion[ci] !== m.version;

    if (!stale) {
      this.onMesh(ci, m.empty ? null : {
        positions: new Float32Array(m.positions),
        normals: new Float32Array(m.normals),
        attrs: new Uint8Array(m.attrs),
        indices: m.indexType === 2 ? new Uint16Array(m.indices) : new Uint32Array(m.indices),
        indexCount: m.indexCount,
        vertexCount: m.vertexCount,
      });
    } else {
      this.enqueue(ci);
    }

    this.idle.push(w);
    this.pump();
  }

  enqueue(ci) {
    if (this.queued.has(ci) || this.pending.has(ci)) return;
    this.queued.add(ci);
    this.queue.push(ci);
  }

  // --- PERF (cadence de remaillage, debut) ----------------------------------
  /** Delai minimal avant le prochain remaillage de ce chunk (ms). */
  cooldownFor(ci) {
    if (this.coolMs <= 0) return 0;
    return dist(ci, this.focusX, this.focusZ, CHUNK * VOXEL) < FOCUS_R2 ? 0 : this.coolMs;
  }
  // --- PERF (cadence de remaillage, fin) ------------------------------------

  /** Vide la file de chunks sales du champ dans la file du pool. */
  collect(maxPerFrame = 64) {
    // PERF : reinjecte les chunks dont le refroidissement est termine.
    if (this.cooling.length) {
      const now = performance.now();
      let w = 0;
      for (let k = 0; k < this.cooling.length; k++) {
        const ci = this.cooling[k];
        if (now - this.lastDispatch[ci] >= this.cooldownFor(ci)) {
          this.coolingFlag[ci] = 0;
          this.enqueue(ci);
        } else {
          this.cooling[w++] = ci;
        }
      }
      this.cooling.length = w;
    }
    const dc = this.field.dirtyChunks;
    let n = 0;
    while (dc.length && n < maxPerFrame) {
      const ci = dc.shift();
      this.field.chunkDirty[ci] = 0;
      this.enqueue(ci);
      n++;
    }
    this.pump();
  }

  /**
   * Trie la file par distance a un point (le curseur / la camera) pour que
   * ce que le joueur regarde soit remaille en premier.
   */
  prioritize(px, pz) {
    this.focusX = px; // PERF : sert aussi de reference a cooldownFor
    this.focusZ = pz;
    if (this.queue.length < 3) return;
    const cs = CHUNK * VOXEL;
    this.queue.sort((a, b) => dist(a, px, pz, cs) - dist(b, px, pz, cs));
  }

  pump() {
    const now = performance.now(); // PERF
    while (this.idle.length && this.queue.length) {
      const ci = this.queue.shift();
      this.queued.delete(ci);
      if (!this.field.chunkNeedsMesh(ci)) {
        this.onMesh(ci, null);
        continue;
      }
      // PERF : un chunk remaille trop recemment attend son refroidissement
      // dans `cooling` ; collect() le reinjectera. Voir COOL_MS.
      if (now - this.lastDispatch[ci] < this.cooldownFor(ci)) {
        if (!this.coolingFlag[ci]) {
          this.coolingFlag[ci] = 1;
          this.cooling.push(ci);
        }
        continue;
      }
      const w = this.idle.pop();
      this.lastDispatch[ci] = now;
      this.dispatch(w, ci);
    }
  }

  dispatch(w, ci) {
    const version = this.field.chunkVersion[ci];
    this.pending.set(ci, version);
    if (this.shared) {
      // Le worker extrait lui-meme le bloc dans la memoire partagee.
      w.postMessage({
        type: 'mesh', ci, version,
        voxelSize: VOXEL,
        worldOrigin: [ORIGIN_X, ORIGIN_Y, ORIGIN_Z],
      });
      return;
    }
    let buf = this.bufferPool.pop();
    if (!buf) {
      buf = {
        D: new ArrayBuffer(BLOCK_SIZE),
        M: new ArrayBuffer(BLOCK_SIZE),
        P: new ArrayBuffer(BLOCK_SIZE),
        T: new ArrayBuffer(BLOCK_SIZE),
      };
    }
    const D = new Uint8Array(buf.D);
    const M = new Uint8Array(buf.M);
    const P = new Uint8Array(buf.P);
    const T = new Uint8Array(buf.T);
    const info = this.field.extractChunk(ci, D, M, P, T);

    w.postMessage({
      type: 'mesh',
      ci,
      version,
      ox: info.ox, oy: info.oy, oz: info.oz,
      voxelSize: VOXEL,
      worldOrigin: [ORIGIN_X, ORIGIN_Y, ORIGIN_Z],
      D: buf.D, M: buf.M, P: buf.P, T: buf.T,
    }, [buf.D, buf.M, buf.P, buf.T]);
  }

  get busy() {
    return this.pending.size + this.queue.length;
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
  }
}

function dist(ci, px, pz, cs) {
  const cy = (ci / (CX * CZ)) | 0;
  const rem = ci - cy * CX * CZ;
  const cz = (rem / CX) | 0;
  const cx = rem - cz * CX;
  const wx = ORIGIN_X + (cx + 0.5) * cs;
  const wz = ORIGIN_Z + (cz + 0.5) * cs;
  return (wx - px) * (wx - px) + (wz - pz) * (wz - pz);
}
