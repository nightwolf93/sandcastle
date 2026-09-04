/**
 * Surface Nets (variante "naive", duale) pour extraire l'isosurface du sable.
 *
 * Pourquoi Surface Nets et pas Marching Cubes :
 *  - un sommet par cellule au lieu de jusqu'a 5 triangles -> maillage 2 a 3x
 *    plus leger, ideal quand on remaille en continu ;
 *  - les sommets sont "libres" dans la cellule, donc la surface reste lisse
 *    meme a 4 cm de resolution — exactement ce qu'on veut pour du sable ;
 *  - la topologie duale se recolle naturellement entre chunks tant que les
 *    cellules partagees voient les memes densites (d'ou le bord de 2 voxels).
 *
 * Le bloc d'entree est un cube (CHUNK + 2*BORDER)^3 centre sur le chunk. Les
 * aretes "possedees" par le chunk sont celles dont le coin bas tombe dans
 * [chunkOrigin, chunkOrigin+CHUNK-1] : chaque face du monde est donc emise
 * par exactement un chunk, sans trou ni doublon.
 *
 * La bordure est large (6 voxels) parce que l'occlusion ambiante est calculee
 * ici, au maillage : ses rayons vont chercher de la matiere jusqu'a 4,4 voxels
 * autour du sommet. Avec une bordure trop etroite, ces rayons seraient
 * tronques differemment de chaque cote d'une frontiere de chunk et on verrait
 * les coutures — de fines lignes claires tous les 1,28 m.
 */

const ISO = 128;

/** Marge de voxels extraite autour du chunk. Voir le commentaire ci-dessus. */
export const BORDER = 6;

/**
 * Lissage de Taubin (lambda | mu).
 *
 * Un lissage laplacien simple retracte : passe apres passe, une dune s'affaisse
 * et un mur maigrit. Taubin alterne un pas EN AVANT (lambda > 0, qui lisse) et
 * un pas EN ARRIERE legerement plus grand (mu < -lambda, qui regonfle). Le
 * produit des deux reponses frequentielles vaut ~1 pour les basses frequences
 * — la forme est conservee — et s'ecrase pour les hautes — le treillis de la
 * grille disparait. C'est la seule facon de lisser sans perdre de volume.
 *
 * Quatre demi-iterations (lambda, mu, lambda, mu) suffisent : au-dela, on
 * commence a arrondir les aretes vives d'un mur taille a la truelle.
 */
const TAUBIN_LAMBDA = 0.50;
const TAUBIN_MU = -0.53;
const TAUBIN_ITERS = 4;

// Coins d'une cellule : bit0 = x, bit1 = y, bit2 = z.
const CORNER = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];

// Les 12 aretes, en paires d'indices de coins.
const EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7], // le long de X
  [0, 2], [1, 3], [4, 6], [5, 7], // le long de Y
  [0, 4], [1, 5], [2, 6], [3, 7], // le long de Z
];

/**
 * Contexte reutilisable : evite de reallouer les gros buffers a chaque chunk.
 */
export class NetsContext {
  constructor(chunkSize) {
    this.CHUNK = chunkSize;
    this.S = chunkSize + 2 * BORDER; // taille du bloc echantillonne
    this.CELLS = this.S - 1;         // cellules par axe du bloc
    // On ne genere de sommets que dans la tranche utile : les cellules
    // [BORDER-1, BORDER+CHUNK-1], soit CHUNK+1 par axe.
    this.C0 = BORDER - 1;
    this.C1 = BORDER + chunkSize - 1;
    // Anneau supplementaire genere UNIQUEMENT pour nourrir le lissage, puis
    // jete. Il doit valoir exactement le nombre de demi-iterations de Taubin :
    // apres n demi-iterations, un sommet depend de son n-anneau initial.
    // BORDER = 6 laisse la place a 5 ; on en utilise 4.
    this.RING = TAUBIN_ITERS;
    this.G0 = Math.max(0, this.C0 - this.RING);
    this.G1 = Math.min(this.CELLS - 1, this.C1 + this.RING);
    const nc = this.CELLS * this.CELLS * this.CELLS;
    this.cellVert = new Int32Array(nc);
    // Copie lissee du bloc, utilisee UNIQUEMENT pour les normales et l'AO.
    // Le gradient d'un champ en marches d'escalier donne des normales
    // terrassees : sur une pente a 15 degres, une terrasse tous les 15 cm.
    // Un simple binome 1-2-1 separable divise l'erreur de normale par cinq,
    // et comme il ne touche pas au champ servant a placer les sommets, la
    // surface ne bouge pas d'un millimetre.
    this.smooth = new Float32Array(this.S * this.S * this.S);
    this.tmpBlur = new Float32Array(this.S * this.S * this.S);
    // Capacite genereuse : une surface plane fait ~CELLS^2 sommets, une surface
    // tres repliee (sable fraichement effondre) peut monter a 10x plus.
    const span = chunkSize + 2 * TAUBIN_ITERS + 2;
    const maxV = span * span * 12;
    this.pos = new Float32Array(maxV * 3);
    this.nrm = new Float32Array(maxV * 3);
    this.att = new Uint8Array(maxV * 4);
    this.idx = new Uint32Array(maxV * 12);
    this.maxV = maxV;
    this.maxI = maxV * 12;
    // Positions en coordonnees BLOC (unites voxel). Taubin travaille la-dedans :
    // c'est l'espace ou la grille est isotrope, donc le seul ou les poids du
    // filtre ont un sens.
    this.bpos = new Float32Array(maxV * 3);
    this.bswap = new Float32Array(maxV * 3);
    // Les six voisins de grille de chaque sommet (-1 si absent).
    this.nbr = new Int32Array(maxV * 6);
    // Cellule d'origine et masque des coins solides, relus apres le lissage.
    this.vcell = new Int32Array(maxV);
    this.vmask = new Uint8Array(maxV);
    this.vown = new Uint8Array(maxV);
  }
}

/**
 * @param {NetsContext} ctx
 * @param {Uint8Array} D densite (S^3)
 * @param {Uint8Array} M humidite
 * @param {Uint8Array} P compaction
 * @param {Uint8Array} T materiau
 * @param {number} originVX coord voxel monde du coin du chunk (pas du bloc)
 * @param {number} originVY
 * @param {number} originVZ
 * @param {number} voxelSize
 * @param {number[]} worldOrigin [ox, oy, oz] du domaine en metres
 * @returns {{positions:Float32Array,normals:Float32Array,attrs:Uint8Array,indices:Uint32Array,vertexCount:number,indexCount:number}|null}
 */
/** Flou binomial 1-2-1 separable sur le bloc. */
function blurBlock(D, out, tmp, S) {
  const S2 = S * S;
  // X
  for (let z = 0; z < S; z++) {
    for (let y = 0; y < S; y++) {
      const o = S * y + S2 * z;
      for (let x = 0; x < S; x++) {
        const a = D[o + (x > 0 ? x - 1 : x)];
        const b = D[o + x];
        const c = D[o + (x < S - 1 ? x + 1 : x)];
        tmp[o + x] = (a + 2 * b + c) * 0.25;
      }
    }
  }
  // Y
  for (let z = 0; z < S; z++) {
    for (let y = 0; y < S; y++) {
      const ym = y > 0 ? y - 1 : y, yp = y < S - 1 ? y + 1 : y;
      const o = S * y + S2 * z, om = S * ym + S2 * z, op = S * yp + S2 * z;
      for (let x = 0; x < S; x++) {
        out[o + x] = (tmp[om + x] + 2 * tmp[o + x] + tmp[op + x]) * 0.25;
      }
    }
  }
  // Z
  for (let z = 0; z < S; z++) {
    const zm = z > 0 ? z - 1 : z, zp = z < S - 1 ? z + 1 : z;
    for (let y = 0; y < S; y++) {
      const o = S * y + S2 * z, om = S * y + S2 * zm, op = S * y + S2 * zp;
      for (let x = 0; x < S; x++) {
        tmp[o + x] = (out[om + x] + 2 * out[o + x] + out[op + x]) * 0.25;
      }
    }
  }
  out.set(tmp);
}

export function surfaceNets(ctx, D, M, P, T, originVX, originVY, originVZ, voxelSize, worldOrigin) {
  const S = ctx.S;
  const S2 = S * S;
  const CELLS = ctx.CELLS;
  const C2 = CELLS * CELLS;
  const CHUNK = ctx.CHUNK;

  const cellVert = ctx.cellVert;
  cellVert.fill(-1);

  // Champ lisse pour les normales et l'occlusion ambiante.
  const SM = ctx.smooth;
  blurBlock(D, SM, ctx.tmpBlur, S);

  const pos = ctx.pos, nrm = ctx.nrm, att = ctx.att, idx = ctx.idx;
  let vCount = 0;
  let iCount = 0;

  const bx0 = originVX - BORDER;
  const by0 = originVY - BORDER;
  const bz0 = originVZ - BORDER;
  const [wox, woy, woz] = worldOrigin;

  const C0 = ctx.C0, C1 = ctx.C1;
  const G0 = ctx.G0, G1 = ctx.G1;
  const bpos = ctx.bpos, vcell = ctx.vcell, vmask = ctx.vmask, vown = ctx.vown;

  // --- passe 1 : un sommet par cellule traversee -----------------------------
  // On genere sur l'anneau ELARGI [G0, G1] : les sommets hors de [C0, C1] ne
  // seront jamais emis, ils ne servent qu'a donner au lissage un voisinage
  // complet. C'est ce qui garantit qu'un sommet partage par deux chunks est
  // lisse a l'identique des deux cotes, donc zero couture.
  const dens = new Int32Array(8);
  outer:
  for (let k = G0; k <= G1; k++) {
    for (let j = G0; j <= G1; j++) {
      for (let i = G0; i <= G1; i++) {
        const o = i + S * j + S2 * k;
        // Lecture des 8 coins
        const d0 = D[o];
        const d1 = D[o + 1];
        const d2 = D[o + S];
        const d3 = D[o + S + 1];
        const d4 = D[o + S2];
        const d5 = D[o + S2 + 1];
        const d6 = D[o + S2 + S];
        const d7 = D[o + S2 + S + 1];

        let mask = 0;
        if (d0 >= ISO) mask |= 1;
        if (d1 >= ISO) mask |= 2;
        if (d2 >= ISO) mask |= 4;
        if (d3 >= ISO) mask |= 8;
        if (d4 >= ISO) mask |= 16;
        if (d5 >= ISO) mask |= 32;
        if (d6 >= ISO) mask |= 64;
        if (d7 >= ISO) mask |= 128;
        if (mask === 0 || mask === 255) continue;

        dens[0] = d0; dens[1] = d1; dens[2] = d2; dens[3] = d3;
        dens[4] = d4; dens[5] = d5; dens[6] = d6; dens[7] = d7;

        // Moyenne des points de coupe sur les aretes traversees.
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (let e = 0; e < 12; e++) {
          const a = EDGES[e][0], b = EDGES[e][1];
          const sa = (mask >> a) & 1, sb = (mask >> b) & 1;
          if (sa === sb) continue;
          const da = dens[a], db = dens[b];
          let t = 0.5;
          if (db !== da) t = (ISO - da) / (db - da);
          if (t < 0) t = 0; else if (t > 1) t = 1;
          const ca = CORNER[a], cb = CORNER[b];
          sx += ca[0] + (cb[0] - ca[0]) * t;
          sy += ca[1] + (cb[1] - ca[1]) * t;
          sz += ca[2] + (cb[2] - ca[2]) * t;
          n++;
        }
        const inv = 1 / n;
        const lx = sx * inv, ly = sy * inv, lz = sz * inv;

        if (vCount >= ctx.maxV) break outer;

        // Position en coordonnees BLOC, centre de cellule en +0.5.
        const p3 = vCount * 3;
        bpos[p3] = i + lx + 0.5;
        bpos[p3 + 1] = j + ly + 0.5;
        bpos[p3 + 2] = k + lz + 0.5;

        vcell[vCount] = o;
        vmask[vCount] = mask;
        // Possede par ce chunk (donc emis et attribue) ou simple garniture ?
        vown[vCount] = (i >= C0 && i <= C1 && j >= C0 && j <= C1 && k >= C0 && k <= C1) ? 1 : 0;

        cellVert[i + CELLS * j + C2 * k] = vCount;
        vCount++;
      }
    }
  }

  if (vCount === 0) return null;

  // --- passe 1b : lissage de Taubin -----------------------------------------
  taubin(ctx, vCount, CELLS, C2, G0, G1);

  // --- passe 1c : monde, normales, attributs, pour les sommets possedes ------
  // Tout ce qui coute cher (l'occlusion ambiante surtout) n'est calcule QUE
  // pour les sommets reellement emis : l'anneau de garniture ne paie que le
  // lissage.
  for (let v = 0; v < vCount; v++) {
    if (!vown[v]) continue;
    const p3 = v * 3;
    const gx = bpos[p3] - 0.5, gy = bpos[p3 + 1] - 0.5, gz = bpos[p3 + 2] - 0.5;

    pos[p3] = wox + (bx0 + bpos[p3]) * voxelSize;
    pos[p3 + 1] = woy + (by0 + bpos[p3 + 1]) * voxelSize;
    pos[p3 + 2] = woz + (bz0 + bpos[p3 + 2]) * voxelSize;

    // Normale : gradient du champ LISSE, pris a la position finale du sommet.
    let nx = sampleD(SM, S, S2, gx - 1.0, gy, gz) - sampleD(SM, S, S2, gx + 1.0, gy, gz);
    let ny = sampleD(SM, S, S2, gx, gy - 1.0, gz) - sampleD(SM, S, S2, gx, gy + 1.0, gz);
    let nz = sampleD(SM, S, S2, gx, gy, gz - 1.0) - sampleD(SM, S, S2, gx, gy, gz + 1.0);
    let len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-6) { nx = 0; ny = 1; nz = 0; len = 1; }
    nx /= len; ny /= len; nz /= len;
    nrm[p3] = nx; nrm[p3 + 1] = ny; nrm[p3 + 2] = nz;

    // Attributs : moyenne des coins solides.
    const o = vcell[v], mask = vmask[v];
    let mm = 0, pp = 0, tt = 0, cnt = 0;
    for (let c = 0; c < 8; c++) {
      if (!((mask >> c) & 1)) continue;
      const co = o + CORNER[c][0] + S * CORNER[c][1] + S2 * CORNER[c][2];
      mm += M[co]; pp += P[co];
      if (T[co] > tt) tt = T[co];
      cnt++;
    }
    if (cnt === 0) cnt = 1;
    const a4 = v * 4;
    att[a4] = (mm / cnt) | 0;
    att[a4 + 1] = (pp / cnt) | 0;
    att[a4 + 2] = ambientOcclusion(SM, S, S2, gx, gy, gz, nx, ny, nz);
    att[a4 + 3] = tt;
  }

  // --- passe 2 : quads autour des aretes possedees par ce chunk --------------
  // Une arete appartient au chunk dont le coin bas est dans son emprise, soit
  // la coordonnee bloc [BORDER, BORDER+CHUNK-1]. Exception aux bords negatifs
  // du domaine : le coin -1 n'appartient a aucun chunk, on l'attribue au
  // premier, sinon la paroi exterieure du bloc diorama serait trouee.
  // En Y on garde BORDER : le fond du bloc reste volontairement ouvert (il
  // n'est jamais visible, et le fermer couterait 130 k triangles inutiles).
  const loX = originVX === 0 ? BORDER - 1 : BORDER;
  const loY = BORDER;
  const loZ = originVZ === 0 ? BORDER - 1 : BORDER;
  const hi = BORDER + CHUNK - 1;

  faces:
  for (let z = loZ; z <= hi; z++) {
    for (let y = loY; y <= hi; y++) {
      for (let x = loX; x <= hi; x++) {
        if (iCount + 18 > ctx.maxI) break faces;
        const o = x + S * y + S2 * z;
        const d = D[o] >= ISO ? 1 : 0;

        // Arete +X : cellules (x, y-1, z-1) (x, y, z-1) (x, y, z) (x, y-1, z)
        if (x + 1 < S) {
          const dn = D[o + 1] >= ISO ? 1 : 0;
          if (d !== dn) {
            const a = cellVert[x + CELLS * (y - 1) + C2 * (z - 1)];
            const b = cellVert[x + CELLS * y + C2 * (z - 1)];
            const c = cellVert[x + CELLS * y + C2 * z];
            const e = cellVert[x + CELLS * (y - 1) + C2 * z];
            if (a >= 0 && b >= 0 && c >= 0 && e >= 0) {
              iCount = quad(idx, iCount, a, b, c, e, d === 1);
            }
          }
        }
        // Arete +Y : cellules (x-1, y, z-1) (x, y, z-1) (x, y, z) (x-1, y, z)
        if (y + 1 < S) {
          const dn = D[o + S] >= ISO ? 1 : 0;
          if (d !== dn) {
            const a = cellVert[(x - 1) + CELLS * y + C2 * (z - 1)];
            const b = cellVert[x + CELLS * y + C2 * (z - 1)];
            const c = cellVert[x + CELLS * y + C2 * z];
            const e = cellVert[(x - 1) + CELLS * y + C2 * z];
            if (a >= 0 && b >= 0 && c >= 0 && e >= 0) {
              iCount = quad(idx, iCount, a, b, c, e, d !== 1);
            }
          }
        }
        // Arete +Z : cellules (x-1, y-1, z) (x, y-1, z) (x, y, z) (x-1, y, z)
        if (z + 1 < S) {
          const dn = D[o + S2] >= ISO ? 1 : 0;
          if (d !== dn) {
            const a = cellVert[(x - 1) + CELLS * (y - 1) + C2 * z];
            const b = cellVert[x + CELLS * (y - 1) + C2 * z];
            const c = cellVert[x + CELLS * y + C2 * z];
            const e = cellVert[(x - 1) + CELLS * y + C2 * z];
            if (a >= 0 && b >= 0 && c >= 0 && e >= 0) {
              iCount = quad(idx, iCount, a, b, c, e, d === 1);
            }
          }
        }
      }
    }
  }

  if (iCount === 0) return null;

  // Compaction : on ne garde que les sommets reellement references.
  return compact(pos, nrm, att, idx, vCount, iCount);
}

/**
 * Lissage de Taubin sur le maillage dual.
 *
 * Le voisinage est immediat a construire : Surface Nets pose exactement un
 * sommet par cellule, donc deux sommets sont voisins si et seulement si leurs
 * cellules le sont. Aucune table d'adjacence a extraire des triangles.
 *
 * Les sommets qui n'ont pas leurs six voisins (bord du bloc, fond ouvert) sont
 * lisses sur les voisins presents : l'operateur ombrelle reste une moyenne, il
 * ne les tire donc pas hors de la surface.
 */
function taubin(ctx, vCount, CELLS, C2, G0, G1) {
  const bpos = ctx.bpos, out = ctx.bswap, nbr = ctx.nbr, cellVert = ctx.cellVert;

  // Table d'adjacence, une fois pour toutes.
  for (let k = G0; k <= G1; k++) {
    for (let j = G0; j <= G1; j++) {
      const row = CELLS * j + C2 * k;
      for (let i = G0; i <= G1; i++) {
        const v = cellVert[i + row];
        if (v < 0) continue;
        const n6 = v * 6;
        nbr[n6] = i > G0 ? cellVert[i - 1 + row] : -1;
        nbr[n6 + 1] = i < G1 ? cellVert[i + 1 + row] : -1;
        nbr[n6 + 2] = j > G0 ? cellVert[i + row - CELLS] : -1;
        nbr[n6 + 3] = j < G1 ? cellVert[i + row + CELLS] : -1;
        nbr[n6 + 4] = k > G0 ? cellVert[i + row - C2] : -1;
        nbr[n6 + 5] = k < G1 ? cellVert[i + row + C2] : -1;
      }
    }
  }

  let src = bpos, dst = out;
  for (let it = 0; it < TAUBIN_ITERS; it++) {
    // Alternance stricte : lambda puis mu. C'est le pas en arriere qui empeche
    // la retraction.
    const w = (it & 1) === 0 ? TAUBIN_LAMBDA : TAUBIN_MU;
    for (let v = 0; v < vCount; v++) {
      const p3 = v * 3, n6 = v * 6;
      const px = src[p3], py = src[p3 + 1], pz = src[p3 + 2];
      let sx = 0, sy = 0, sz = 0, n = 0;
      for (let e = 0; e < 6; e++) {
        const u = nbr[n6 + e];
        if (u < 0) continue;
        const q3 = u * 3;
        sx += src[q3]; sy += src[q3 + 1]; sz += src[q3 + 2];
        n++;
      }
      if (n === 0) {
        dst[p3] = px; dst[p3 + 1] = py; dst[p3 + 2] = pz;
        continue;
      }
      const inv = 1 / n;
      dst[p3] = px + w * (sx * inv - px);
      dst[p3 + 1] = py + w * (sy * inv - py);
      dst[p3 + 2] = pz + w * (sz * inv - pz);
    }
    const t = src; src = dst; dst = t;
  }

  // TAUBIN_ITERS etant pair, le resultat retombe dans bpos. On le rend
  // explicite plutot que de s'y fier.
  if (src !== bpos) bpos.set(src.subarray(0, vCount * 3));
}

function quad(idx, o, a, b, c, e, flip) {
  if (flip) {
    idx[o++] = a; idx[o++] = b; idx[o++] = c;
    idx[o++] = a; idx[o++] = c; idx[o++] = e;
  } else {
    idx[o++] = a; idx[o++] = c; idx[o++] = b;
    idx[o++] = a; idx[o++] = e; idx[o++] = c;
  }
  return o;
}

/** Densite trilineaire dans le bloc, avec clamp aux bords. */
function sampleD(D, S, S2, x, y, z) {
  if (x < 0) x = 0; else if (x > S - 1.001) x = S - 1.001;
  if (y < 0) y = 0; else if (y > S - 1.001) y = S - 1.001;
  if (z < 0) z = 0; else if (z > S - 1.001) z = S - 1.001;
  const x0 = x | 0, y0 = y | 0, z0 = z | 0;
  const tx = x - x0, ty = y - y0, tz = z - z0;
  const o = x0 + S * y0 + S2 * z0;
  const c000 = D[o], c100 = D[o + 1];
  const c010 = D[o + S], c110 = D[o + S + 1];
  const c001 = D[o + S2], c101 = D[o + S2 + 1];
  const c011 = D[o + S2 + S], c111 = D[o + S2 + S + 1];
  const c00 = c000 + (c100 - c000) * tx;
  const c10 = c010 + (c110 - c010) * tx;
  const c01 = c001 + (c101 - c001) * tx;
  const c11 = c011 + (c111 - c011) * tx;
  const c0 = c00 + (c10 - c00) * ty;
  const c1 = c01 + (c11 - c01) * ty;
  return c0 + (c1 - c0) * tz;
}

/**
 * Occlusion ambiante locale, calculee au maillage (gratuite au rendu et
 * stable quand la camera bouge, contrairement a un SSAO).
 * On echantillonne la densite le long de quelques rayons dans l'hemisphere
 * de la normale : plus il y a de matiere, plus c'est sombre.
 */
/**
 * Jeu de directions SYMETRIQUE : les six axes et les huit diagonales du cube.
 *
 * L'ancien jeu etait biaise vers le haut et on retournait les directions qui
 * pointaient vers l'interieur. Sur une face VERTICALE, la moitie d'entre elles
 * se retrouvait a raser la paroi : les rayons echantillonnaient la surface
 * elle-meme, la ou la densite bascule de 0 a 255 en un voxel. D'ou un moucheté
 * sombre sur toutes les tranches du bloc — d'autant plus visible que ces faces
 * ne sont eclairees que par l'ambiante, que l'occlusion multiplie.
 *
 * Avec un jeu symetrique, on peut au contraire REJETER les directions
 * rasantes au lieu de les retourner : il en reste toujours assez, quelle que
 * soit l'orientation de la normale, et le resultat ne depend plus d'un repere
 * tangent (qui aurait introduit ses propres discontinuites).
 */
const R3 = 0.5773502691896258;
const AO_DIRS = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  [R3, R3, R3], [-R3, R3, R3], [R3, -R3, R3], [R3, R3, -R3],
  [-R3, -R3, R3], [-R3, R3, -R3], [R3, -R3, -R3], [-R3, -R3, -R3],
];
/** En deca, le rayon rase la surface et ne mesure que son propre bruit. */
const AO_MIN_DOT = 0.30;
const AO_STEPS = [1.2, 2.6, 4.4];

function ambientOcclusion(D, S, S2, x, y, z, nx, ny, nz) {
  let occ = 0;
  let total = 0;
  for (let d = 0; d < AO_DIRS.length; d++) {
    const dx = AO_DIRS[d][0], dy = AO_DIRS[d][1], dz = AO_DIRS[d][2];
    const dot = dx * nx + dy * ny + dz * nz;
    // Hemisphere de la normale, rasances exclues.
    if (dot < AO_MIN_DOT) continue;
    const w = dot;
    for (let s = 0; s < AO_STEPS.length; s++) {
      const t = AO_STEPS[s];
      const v = sampleD(D, S, S2, x + dx * t, y + dy * t, z + dz * t);
      // Attenuation avec la distance : les obstacles proches comptent plus.
      const fall = 1 / (1 + t * 0.55);
      occ += (v / 255) * w * fall;
      total += w * fall;
    }
  }
  if (total <= 0) return 255;
  const a = 1 - occ / total;
  const shaped = Math.pow(a < 0 ? 0 : a > 1 ? 1 : a, 0.75);
  return (shaped * 255) | 0;
}

/** Reindexe pour ne conserver que les sommets utilises. */
function compact(pos, nrm, att, idx, vCount, iCount) {
  const remap = new Int32Array(vCount).fill(-1);
  let nv = 0;
  for (let i = 0; i < iCount; i++) {
    const v = idx[i];
    if (remap[v] < 0) remap[v] = nv++;
  }
  const positions = new Float32Array(nv * 3);
  const normals = new Float32Array(nv * 3);
  const attrs = new Uint8Array(nv * 4);
  for (let v = 0; v < vCount; v++) {
    const r = remap[v];
    if (r < 0) continue;
    positions[r * 3] = pos[v * 3];
    positions[r * 3 + 1] = pos[v * 3 + 1];
    positions[r * 3 + 2] = pos[v * 3 + 2];
    normals[r * 3] = nrm[v * 3];
    normals[r * 3 + 1] = nrm[v * 3 + 1];
    normals[r * 3 + 2] = nrm[v * 3 + 2];
    attrs[r * 4] = att[v * 4];
    attrs[r * 4 + 1] = att[v * 4 + 1];
    attrs[r * 4 + 2] = att[v * 4 + 2];
    attrs[r * 4 + 3] = att[v * 4 + 3];
  }
  const indices = nv > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
  for (let i = 0; i < iCount; i++) indices[i] = remap[idx[i]];

  return { positions, normals, attrs, indices, vertexCount: nv, indexCount: iCount };
}
