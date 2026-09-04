/**
 * Worker de maillage. Recoit un chunk a mailler, renvoie des BufferAttributes
 * prets a etre uploades.
 *
 * En memoire partagee, le worker a recu a l'initialisation les quatre
 * tableaux du champ : il extrait lui-meme le bloc du chunk dans ses propres
 * tampons (aucun echange de donnees d'entree). En mode copie, les buffers
 * d'entree lui sont transferes et il les renvoie pour recyclage.
 */

import { NetsContext, surfaceNets } from './SurfaceNets.js';
import { extractBlock, BLOCK_SIZE } from './Extract.js';

let ctx = null;
/** Champ partage (mode memoire partagee), sinon null. */
let field = null;
/** Tampons de bloc du worker, alloues une fois. */
let blk = null;

self.onmessage = (ev) => {
  const m = ev.data;

  if (m.type === 'init') {
    ctx = new NetsContext(m.chunkSize);
    if (m.shared) {
      field = {
        D: new Uint8Array(m.shared.D), M: new Uint8Array(m.shared.M),
        P: new Uint8Array(m.shared.P), T: new Uint8Array(m.shared.T),
      };
      blk = {
        D: new Uint8Array(BLOCK_SIZE), M: new Uint8Array(BLOCK_SIZE),
        P: new Uint8Array(BLOCK_SIZE), T: new Uint8Array(BLOCK_SIZE),
      };
    }
    self.postMessage({ type: 'ready' });
    return;
  }

  if (m.type === 'mesh') {
    let D, M, P, T, ox, oy, oz;
    const t0 = performance.now();
    if (field && !m.D) {
      const info = extractBlock(field.D, field.M, field.P, field.T, m.ci, blk.D, blk.M, blk.P, blk.T);
      D = blk.D; M = blk.M; P = blk.P; T = blk.T;
      ox = info.ox; oy = info.oy; oz = info.oz;
    } else {
      D = new Uint8Array(m.D); M = new Uint8Array(m.M);
      P = new Uint8Array(m.P); T = new Uint8Array(m.T);
      ox = m.ox; oy = m.oy; oz = m.oz;
    }

    const r = surfaceNets(
      ctx, D, M, P, T,
      ox, oy, oz,
      m.voxelSize, m.worldOrigin
    );
    const dt = performance.now() - t0;

    const transfer = m.D ? [m.D, m.M, m.P, m.T] : [];
    const out = {
      type: 'mesh',
      ci: m.ci,
      version: m.version,
      ms: dt,
      empty: !r,
    };
    if (m.D) { out.D = m.D; out.M = m.M; out.P = m.P; out.T = m.T; }
    if (r) {
      out.positions = r.positions.buffer;
      out.normals = r.normals.buffer;
      out.attrs = r.attrs.buffer;
      out.indices = r.indices.buffer;
      out.indexType = r.indices.BYTES_PER_ELEMENT;
      out.vertexCount = r.vertexCount;
      out.indexCount = r.indexCount;
      transfer.push(r.positions.buffer, r.normals.buffer, r.attrs.buffer, r.indices.buffer);
    }
    self.postMessage(out, transfer);
  }
};
