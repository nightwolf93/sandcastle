/**
 * Operations de brosse sur le champ de voxels.
 *
 * Chaque outil est un VOLUME (sphere, cylindre, demi-espace) balaye le long du
 * geste, combine au champ existant avec un profil de fondu. On ne pose jamais
 * de "bloc" : on ajoute ou on retire de la densite continue, ce qui laisse le
 * mailleur produire des surfaces lisses et sculptables.
 *
 * Toutes les ecritures passent par ce module pour que trois choses arrivent
 * systematiquement :
 *   - la pile d'annulation prend un instantane des chunks concernes ;
 *   - la mecanique granulaire est reveillee sur la zone ;
 *   - les colonnes touchees sont mises en file pour le solveur d'humidite.
 */

import {
  NX, NY, NZ, ISO, VOXEL, CHUNK, ORIGIN_X, ORIGIN_Y, ORIGIN_Z,
  MAT_SAND, FOUNDATION_LAYERS, chidx, clamp, smoothstep,
} from '../core/Config.js';

const SLICE = NX * NZ;

/** Convertit une position monde en coordonnees voxel flottantes. */
export function toVoxel(wx, wy, wz) {
  return {
    x: (wx - ORIGIN_X) / VOXEL - 0.5,
    y: (wy - ORIGIN_Y) / VOXEL - 0.5,
    z: (wz - ORIGIN_Z) / VOXEL - 0.5,
  };
}

/**
 * Contexte d'edition : regroupe tout ce qu'une operation doit prevenir.
 */
export class EditContext {
  constructor(field, granular, moisture, water, undo) {
    this.field = field;
    this.granular = granular;
    this.moisture = moisture;
    this.water = water;
    this.undo = undo;
    this.minX = 0; this.minY = 0; this.minZ = 0;
    this.maxX = 0; this.maxY = 0; this.maxZ = 0;
    this.touched = false;
    /** Volume net ajoute (+) ou retire (-), en m3. */
    this.volume = 0;
    /** Colonnes dont il faut conserver le niveau d'eau si le terrain monte. */
    this.terrainColumns = [];
    this.terrainSeen = new Uint8Array(NX * NZ);
  }

  begin(x0, y0, z0, x1, y1, z1) {
    this.clearTerrainTracking();
    this.minX = Math.max(0, x0); this.minY = Math.max(0, y0); this.minZ = Math.max(0, z0);
    this.maxX = Math.min(NX - 1, x1); this.maxY = Math.min(NY - 1, y1); this.maxZ = Math.min(NZ - 1, z1);
    this.touched = this.minX <= this.maxX && this.minY <= this.maxY && this.minZ <= this.maxZ;
    this.volume = 0;
    if (this.touched && this.undo) {
      this.undo.captureBox(this.minX, this.minY, this.minZ, this.maxX, this.maxY, this.maxZ);
    }
    return this.touched;
  }

  /** Memorise une seule fois chaque colonne dont le terrain change. */
  noteTerrainColumn(x, z) {
    if (!this.water?.displaceByTerrainRise) return;
    const c = x + NX * z;
    if (this.terrainSeen[c]) return;
    this.terrainSeen[c] = 1;
    this.terrainColumns.push(c);
  }

  clearTerrainTracking() {
    for (let k = 0; k < this.terrainColumns.length; k++) {
      this.terrainSeen[this.terrainColumns[k]] = 0;
    }
    this.terrainColumns.length = 0;
  }

  end() {
    if (!this.touched) return;
    this.granular.wakeBox(this.minX, this.minY, this.minZ, this.maxX, this.maxY, this.maxZ);
    this.moisture.touchBox(this.minX, this.minZ, this.maxX, this.maxZ);
    if (this.terrainColumns.length) {
      // Les hauteurs sont normalement differees jusqu'au pas physique. Ici le
      // champ d'eau en a besoin tout de suite, avant le prochain rendu.
      this.field.flushColumns();
      this.water.displaceByTerrainRise(this.terrainColumns);
    }
    this.clearTerrainTracking();
  }
}

// ---------------------------------------------------------------------------
// PROFILS
// ---------------------------------------------------------------------------

/** Fondu doux : 1 au centre, 0 au bord. */
function falloff(d, r, hardness) {
  if (d >= r) return 0;
  const t = d / r;
  // hardness 0 = tres doux (gaussienne), 1 = franc (bord net)
  const soft = 1 - t * t;
  const hard = smoothstep(1, 1 - Math.max(0.06, 1 - hardness), t);
  return soft * (1 - hardness) + hard * hardness;
}

// ---------------------------------------------------------------------------
// OPERATIONS
// ---------------------------------------------------------------------------

/**
 * Ajoute ou retire de la matiere dans une sphere.
 * @param {EditContext} ctx
 * @param {number} amount densite ajoutee au centre (-255..255)
 * @param {{moisture?:number, packing?:number, hardness?:number}} opts
 */
export function sphere(ctx, wx, wy, wz, radius, amount, opts = {}) {
  const F = ctx.field;
  const v = toVoxel(wx, wy, wz);
  const r = radius / VOXEL;
  const hardness = opts.hardness ?? 0.35;

  if (!ctx.begin(
    Math.floor(v.x - r) - 1, Math.floor(v.y - r) - 1, Math.floor(v.z - r) - 1,
    Math.ceil(v.x + r) + 1, Math.ceil(v.y + r) + 1, Math.ceil(v.z + r) + 1
  )) return 0;

  const setMoist = opts.moisture;
  const setPack = opts.packing;
  let delta = 0;

  for (let z = ctx.minZ; z <= ctx.maxZ; z++) {
    const dz = z - v.z;
    for (let y = ctx.minY; y <= ctx.maxY; y++) {
      const dy = y - v.y;
      const row = NX * (z + NZ * y);
      for (let x = ctx.minX; x <= ctx.maxX; x++) {
        const dx = x - v.x;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const f = falloff(d, r, hardness);
        if (f <= 0) continue;
        const i = row + x;
        const old = F.density[i];
        const nv = clamp(old + amount * f, 0, 255) | 0;
        if (nv === old) continue;

        if (nv > old) {
          // Matiere ajoutee : elle prend l'humidite et la compaction demandees,
          // melangees a ce qui etait deja la.
          const add = nv - old;
          const total = old + add;
          const m = setMoist !== undefined ? setMoist * 255 : F.moisture[i];
          const p = setPack !== undefined ? setPack * 255 : F.packing[i];
          F.moisture[i] = clamp((F.moisture[i] * old + m * add) / total, 0, 255) | 0;
          F.packing[i] = clamp((F.packing[i] * old + p * add) / total, 0, 255) | 0;
          F.material[i] = MAT_SAND;
        }
        F.density[i] = nv;
        if (!writeMeta(ctx, x, y, z, i, old, nv)) continue;
        delta += nv - old;
      }
    }
  }
  ctx.volume = (delta / 255) * VOXEL * VOXEL * VOXEL;
  ctx.end();
  return ctx.volume;
}

/**
 * Entaille de plantage : une fente etroite, dans la direction (dx,dy,dz), de
 * longueur `len` et de demi-largeur `r`.
 *
 * Un outil plante qui n'a pas modifie le sable est un autocollant : on verrait
 * la lame traverser une surface intacte. La lame doit donc entailler pour de
 * bon le champ de voxels.
 *
 * On enchaine des spheres le long du segment plutot que d'ecrire un vrai champ
 * de distance de capsule : trois appels a `sphere()` coutent moins cher a
 * ecrire ET a executer qu'une nouvelle primitive, et le resultat est
 * indistinguable a 4 cm de resolution.
 */
export function slot(ctx, wx, wy, wz, dx, dy, dz, len, r) {
  const n = 3;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    total += sphere(ctx,
      wx + dx * len * t, wy + dy * len * t, wz + dz * len * t,
      r * (1 - 0.25 * t),          // la fente s'affine vers le fond
      -255, { hardness: 0.55 });
  }
  return total;
}

/**
 * Lisse la surface : c'est la main a plat qui pousse le sable des cretes vers
 * les creux. Deux etapes, dans une seule edition :
 *
 *  A. DIFFUSION DES HAUTEURS. Pour chaque colonne du disque de la brosse, on
 *     lit la hauteur exacte de sa surface (position de l'iso 128 entre la
 *     derniere cellule pleine et la cellule partielle au-dessus, celle-la
 *     meme que le mailleur interpole), puis on fait diffuser ce champ de
 *     hauteurs : chaque pas deplace du sable entre colonnes voisines au
 *     prorata de leur difference. C'est une equation de la chaleur en forme
 *     de flux, donc le volume est conserve au grain pres, et une marche de
 *     40 cm devient une pente en S — crete arrondie, talus au pied, comme du
 *     sable qu'une paume a etale. Seule la partie haute de chaque colonne
 *     est reecrite : une fenetre percee sous un mur reste une fenetre.
 *
 *  B. POLISSAGE. Un flou gaussien 3D leger du champ de densite, dans la
 *     sphere de la brosse. Il ne deplace pas les faces (une face plane a une
 *     courbure nulle) mais donne des densites intermediaires la ou le champ
 *     etait 0/255 : le mailleur (Surface Nets) place ses sommets par
 *     interpolation, et des densites graduees font une surface continue la
 *     ou un champ binaire clouait les sommets au milieu des aretes de la
 *     grille, en facettes d'escalier. Ce sont ces facettes qu'on voit sur
 *     les parois d'un trou creuse a la pelle.
 *
 * Un flou 3D seul avait ete essaye en premier : il conserve le volume et
 * arrondit les coins, mais laisse une falaise verticale exactement la ou
 * elle est, ce que le joueur lit comme « ca ne lisse pas ».
 *
 * L'intensite (0..1) regle le nombre de pas de diffusion par passage (1 a 6)
 * et la largeur du polissage. Le rayon fixe l'etendue ; l'intensite, la
 * force du geste. La brosse est un disque en (x, z) pour la diffusion, et ne
 * considere que les colonnes dont la surface est a moins de deux rayons du
 * point vise en hauteur : on lisse ce qu'on touche, pas le sommet d'un mur
 * un metre au-dessus.
 *
 * @param {number} intensity 0..1
 */
export function smooth(ctx, wx, wy, wz, radius, intensity = 0.5) {
  const F = ctx.field;
  const D = F.density;
  const v = toVoxel(wx, wy, wz);
  const r = radius / VOXEL;
  const I = clamp(intensity, 0, 1);
  const sigma = 0.7 + 0.6 * I;
  const K = Math.max(1, Math.ceil(sigma * 2));
  const ry = 2 * r + 2;
  if (!ctx.begin(
    Math.floor(v.x - r) - K, Math.floor(v.y - ry) - K, Math.floor(v.z - r) - K,
    Math.ceil(v.x + r) + K, Math.ceil(v.y + ry) + K, Math.ceil(v.z + r) + K
  )) return;

  const w = ctx.maxX - ctx.minX + 1;
  const h = ctx.maxY - ctx.minY + 1;
  const d = ctx.maxZ - ctx.minZ + 1;
  const idx = (x, y, z) => x + NX * (z + NZ * y);

  // ---- A. diffusion des hauteurs -------------------------------------------
  const cols = w * d;
  const hc = new Float32Array(cols);    // hauteur de surface, en voxels
  const hn = new Float32Array(cols);
  const fw = new Float32Array(cols);    // fondu de la brosse par colonne (0 = hors disque)
  for (let z = 0; z < d; z++) {
    const dz = ctx.minZ + z - v.z;
    for (let x = 0; x < w; x++) {
      const dx = ctx.minX + x - v.x;
      const f = falloff(Math.sqrt(dx * dx + dz * dz), r, 0.12);
      if (f <= 0) continue;
      const X = ctx.minX + x, Z = ctx.minZ + z;
      // Premiere cellule pleine en descendant. Pleine tout en haut de la
      // fenetre : la vraie surface est plus haut, hors de portee, on ignore.
      let ys = -1;
      for (let y = ctx.maxY; y >= ctx.minY; y--) {
        if (D[idx(X, y, Z)] >= ISO) { ys = y; break; }
      }
      if (ys < 0 || ys === ctx.maxY) continue;
      const ds = D[idx(X, ys, Z)], dp = D[idx(X, ys + 1, Z)];
      const c = x + w * z;
      hc[c] = ys + (ISO - ds) / (dp - ds);
      fw[c] = f;
    }
  }
  hn.set(hc);
  const iters = 1 + Math.round(5 * I);
  const lam = 0.20;
  for (let it = 0; it < iters; it++) {
    for (let z = 0; z < d; z++) {
      for (let x = 0; x < w; x++) {
        const c = x + w * z;
        const fa = fw[c];
        if (fa <= 0) continue;
        // Flux vers les deux voisines « avant » seulement : chaque paire est
        // visitee une fois, ce qui rend l'echange exactement antisymetrique.
        if (x + 1 < w && fw[c + 1] > 0) {
          const q = lam * Math.min(fa, fw[c + 1]) * (hc[c + 1] - hc[c]);
          hn[c] += q; hn[c + 1] -= q;
        }
        if (z + 1 < d && fw[c + w] > 0) {
          const q = lam * Math.min(fa, fw[c + w]) * (hc[c + w] - hc[c]);
          hn[c] += q; hn[c + w] -= q;
        }
      }
    }
    hc.set(hn);
  }
  // Reecriture des colonnes dont la surface a bouge. Forme canonique : des
  // cellules pleines jusqu'a `yf`, puis une cellule partielle, telle que
  // l'interpolation du mailleur retombe exactement sur la hauteur voulue.
  for (let z = 0; z < d; z++) {
    for (let x = 0; x < w; x++) {
      const c = x + w * z;
      if (fw[c] <= 0) continue;
      const X = ctx.minX + x, Z = ctx.minZ + z;
      let ys = -1;
      for (let y = ctx.maxY; y >= ctx.minY; y--) {
        if (D[idx(X, y, Z)] >= ISO) { ys = y; break; }
      }
      if (ys < 0) continue;
      const ds = D[idx(X, ys, Z)], dp = D[idx(X, ys + 1, Z)];
      const h0 = ys + (ISO - ds) / (dp - ds);
      const h1 = clamp(hc[c], ctx.minY + 0.5, ctx.maxY - 1.5);
      if (Math.abs(h1 - h0) < 2e-3) continue;
      const yf = Math.floor(h1);
      const u = h1 - yf;
      const yLo = Math.max(ctx.minY, Math.min(Math.floor(h0), yf));
      const yHi = Math.min(ctx.maxY, Math.max(Math.ceil(h0), yf) + 1);
      for (let y = yLo; y <= yHi; y++) {
        let target;
        if (y < yf) target = 255;
        else if (y === yf) target = u <= 0.498 ? Math.min(255, Math.round(ISO / (1 - u))) : 255;
        else if (y === yf + 1) target = u <= 0.498 ? 0 : clamp(Math.round(255 - (255 - ISO) / u), 0, ISO - 1);
        else target = 0;
        const i = idx(X, y, Z);
        const cur = D[i];
        if (target === cur) continue;
        if (cur === 0 && target > 0) inheritMeta(F, X, y, Z, i);
        D[i] = target;
        writeMeta(ctx, X, y, Z, i, cur, target);
      }
    }
  }

  // ---- B. polissage : flou gaussien 3D separable --------------------------
  const n = w * h * d;
  if (smoothBufA.length < n) {
    smoothBufA = new Float32Array(n);
    smoothBufB = new Float32Array(n);
  }
  const a = smoothBufA, b = smoothBufB;
  for (let z = 0; z < d; z++) {
    for (let y = 0; y < h; y++) {
      const row = NX * ((ctx.minZ + z) + NZ * (ctx.minY + y)) + ctx.minX;
      const o = w * (y + h * z);
      for (let x = 0; x < w; x++) a[o + x] = D[row + x];
    }
  }
  const kw = new Float32Array(2 * K + 1);
  for (let k = -K; k <= K; k++) kw[k + K] = Math.exp(-(k * k) / (2 * sigma * sigma));
  blur1D(a, b, n, 1, w, kw, K);
  blur1D(b, a, n, w, h, kw, K);
  blur1D(a, b, n, w * h, d, kw, K);

  const strength = 0.25 + 0.35 * I;
  for (let z = 0; z < d; z++) {
    const dz = ctx.minZ + z - v.z;
    for (let y = 0; y < h; y++) {
      const dy = ctx.minY + y - v.y;
      const row = NX * ((ctx.minZ + z) + NZ * (ctx.minY + y)) + ctx.minX;
      const o = w * (y + h * z);
      for (let x = 0; x < w; x++) {
        const dx = ctx.minX + x - v.x;
        const f = falloff(Math.sqrt(dx * dx + dy * dy + dz * dz), r, 0.12);
        if (f <= 0) continue;
        const i = row + x;
        const cur = D[i];
        const nv = clamp(Math.round(cur + (b[o + x] - cur) * strength * f), 0, 255);
        if (nv === cur) continue;
        if (cur === 0) inheritMeta(F, ctx.minX + x, ctx.minY + y, ctx.minZ + z, i);
        D[i] = nv;
        writeMeta(ctx, ctx.minX + x, ctx.minY + y, ctx.minZ + z, i, cur, nv);
      }
    }
  }
  ctx.end();
}

/** Tampons du polissage, reutilises d'un passage a l'autre. */
let smoothBufA = new Float32Array(0);
let smoothBufB = new Float32Array(0);

/**
 * Une passe de flou 1D sur toutes les lignes d'un bloc, le long de l'axe de
 * pas `stride` et de longueur `len`. Les prises hors bloc sont omises et les
 * poids renormalises, ce qui prolonge le champ par sa valeur de bord.
 */
function blur1D(src, dst, n, stride, len, kw, K) {
  for (let idx = 0; idx < n; idx++) {
    const pos = ((idx / stride) | 0) % len;
    const k0 = pos < K ? -pos : -K;
    const k1 = pos + K >= len ? len - 1 - pos : K;
    let acc = 0, ws = 0;
    for (let k = k0; k <= k1; k++) {
      const wgt = kw[k + K];
      acc += src[idx + k * stride] * wgt;
      ws += wgt;
    }
    dst[idx] = acc / ws;
  }
}

/** Une cellule qui nait par lissage prend les proprietes de ses voisines pleines. */
function inheritMeta(F, x, y, z, i) {
  let m = 0, p = 0, n = 0;
  const probe = (xx, yy, zz) => {
    if (xx < 0 || yy < 0 || zz < 0 || xx >= NX || yy >= NY || zz >= NZ) return;
    const j = xx + NX * (zz + NZ * yy);
    if (F.density[j] < ISO) return;
    m += F.moisture[j]; p += F.packing[j]; n++;
  };
  probe(x + 1, y, z); probe(x - 1, y, z); probe(x, y + 1, z);
  probe(x, y - 1, z); probe(x, y, z + 1); probe(x, y, z - 1);
  F.moisture[i] = n ? (m / n) | 0 : 15;
  F.packing[i] = n ? (p / n) | 0 : 60;
  F.material[i] = MAT_SAND;
}

/**
 * Tasse le sable : augmente la compaction et densifie legerement.
 * C'est le "pound-up" — le geste le plus important du metier. La compaction
 * reduit les vides, multiplie les points de contact entre grains et donc la
 * cohesion : un mur bien dame tient deux fois plus haut.
 */
export function compact(ctx, wx, wy, wz, radius, strength) {
  const F = ctx.field;
  const v = toVoxel(wx, wy, wz);
  const r = radius / VOXEL;
  if (!ctx.begin(
    Math.floor(v.x - r) - 1, Math.floor(v.y - r) - 1, Math.floor(v.z - r) - 1,
    Math.ceil(v.x + r) + 1, Math.ceil(v.y + r) + 1, Math.ceil(v.z + r) + 1
  )) return;

  for (let z = ctx.minZ; z <= ctx.maxZ; z++) {
    const dz = z - v.z;
    for (let y = ctx.minY; y <= ctx.maxY; y++) {
      const dy = y - v.y;
      const row = NX * (z + NZ * y);
      for (let x = ctx.minX; x <= ctx.maxX; x++) {
        const dx = x - v.x;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const f = falloff(dist, r, 0.25);
        if (f <= 0) continue;
        const i = row + x;
        if (F.density[i] < ISO) continue;
        // Le tassement ne marche que si le sable est un minimum humide :
        // damer du sable sec ne fait que le faire couler.
        const w = F.moisture[i] / 255;
        const eff = strength * f * smoothstep(0.005, 0.05, w);
        if (eff <= 0) continue;
        const p = F.packing[i];
        const np = clamp(p + eff * 255, 0, 255) | 0;
        if (np !== p) { F.packing[i] = np; F.touchVisual(x, y, z); }
        // Le volume diminue un peu : c'est la reduction visible de moitie que
        // decrivent les sculpteurs quand ils dament une couche.
        const dv = F.density[i];
        if (dv < 255) {
          const nv = Math.min(255, dv + eff * 60) | 0;
          if (nv !== dv) { F.density[i] = nv; writeMeta(ctx, x, y, z, i, dv, nv); }
        }
      }
    }
  }
  ctx.end();
}

/**
 * Coupe tout ce qui se trouve du cote positif d'un plan, dans un disque.
 * C'est la truelle : le seul outil capable de produire une face vraiment
 * plane, donc le seul qui rende une sculpture photogenique.
 */
export function planeCut(ctx, wx, wy, wz, nx, ny, nz, radius, depth, strength) {
  const F = ctx.field;
  const v = toVoxel(wx, wy, wz);
  const r = radius / VOXEL;
  const dd = depth / VOXEL;
  const R = r + dd + 2;
  if (!ctx.begin(
    Math.floor(v.x - R), Math.floor(v.y - R), Math.floor(v.z - R),
    Math.ceil(v.x + R), Math.ceil(v.y + R), Math.ceil(v.z + R)
  )) return;

  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;

  for (let z = ctx.minZ; z <= ctx.maxZ; z++) {
    const dz = z - v.z;
    for (let y = ctx.minY; y <= ctx.maxY; y++) {
      const dy = y - v.y;
      const row = NX * (z + NZ * y);
      for (let x = ctx.minX; x <= ctx.maxX; x++) {
        const dx = x - v.x;
        // Distance signee au plan
        const sd = dx * nx + dy * ny + dz * nz;
        if (sd < -0.5) continue;
        // Distance dans le plan
        const px = dx - sd * nx, py = dy - sd * ny, pz = dz - sd * nz;
        const rad = Math.sqrt(px * px + py * py + pz * pz);
        if (rad > r) continue;
        const edge = 1 - smoothstep(r * 0.72, r, rad);
        // Coupe franche sur un demi-voxel : c'est ce qui donne l'arete vive.
        const cut = clamp(1 - sd, 0, 1);
        const i = row + x;
        const old = F.density[i];
        const target = old * cut;
        const nv = clamp(old + (target - old) * strength * edge, 0, 255) | 0;
        if (nv === old) continue;
        F.density[i] = nv;
        writeMeta(ctx, x, y, z, i, old, nv);
      }
    }
  }
  ctx.end();
}

/**
 * Depose un tronc de cone de sable compacte : c'est le demoulage d'un seau ou
 * d'une forme. La qualite (0..1) degrade la geometrie — un demoulage rate
 * s'affaisse et laisse des bourrelets.
 */
export function stampBucket(ctx, wx, wy, wz, rBottom, rTop, height, moisture, packing, quality) {
  const F = ctx.field;
  const v = toVoxel(wx, wy, wz);
  const rb = rBottom / VOXEL;
  const rt = rTop / VOXEL;
  const hh = height / VOXEL;
  const R = Math.max(rb, rt) + 2;
  if (!ctx.begin(
    Math.floor(v.x - R), Math.floor(v.y - 2), Math.floor(v.z - R),
    Math.ceil(v.x + R), Math.ceil(v.y + hh + 2), Math.ceil(v.z + R)
  )) return 0;

  // Un demoulage moyen produit des flancs irreguliers et un sommet affaisse.
  const wob = (1 - quality) * 0.35;
  const slump = (1 - quality) * hh * 0.45;
  let delta = 0;

  for (let z = ctx.minZ; z <= ctx.maxZ; z++) {
    const dz = z - v.z;
    for (let y = ctx.minY; y <= ctx.maxY; y++) {
      const t = (y - v.y) / hh;
      if (t < -0.4 || t > 1.2) continue;
      const row = NX * (z + NZ * y);
      for (let x = ctx.minX; x <= ctx.maxX; x++) {
        const dx = x - v.x;
        const rad = Math.sqrt(dx * dx + dz * dz);
        const ang = Math.atan2(dz, dx);
        const tc = clamp(t, 0, 1);
        let rr = rb + (rt - rb) * tc;
        rr *= 1 + wob * (Math.sin(ang * 5.3 + tc * 7) * 0.5 + Math.sin(ang * 2.1 - tc * 4) * 0.5);
        rr -= slump * Math.max(0, tc - 0.6);
        if (rad > rr + 1) continue;

        // Champ de distance signee du cylindre -> densite douce
        const dSide = rr - rad;
        const dBot = (y - v.y) + 0.5;
        const dTop = hh - slump * 0.6 - (y - v.y);
        const sd = Math.min(dSide, Math.min(dBot, dTop));
        const target = clamp(128 + sd * 128, 0, 255);
        const i = row + x;
        const old = F.density[i];
        if (target <= old) continue;
        F.density[i] = target | 0;
        const add = target - old;
        const total = old + add;
        F.moisture[i] = clamp((F.moisture[i] * old + moisture * 255 * add) / total, 0, 255) | 0;
        F.packing[i] = clamp((F.packing[i] * old + packing * 255 * add) / total, 0, 255) | 0;
        F.material[i] = MAT_SAND;
        writeMeta(ctx, x, y, z, i, old, target | 0);
        delta += add;
      }
    }
  }
  ctx.volume = (delta / 255) * VOXEL * VOXEL * VOXEL;
  ctx.end();
  return ctx.volume;
}

/**
 * Pose un bloc de sable compacte, oriente autour de l'axe vertical.
 *
 * Contrairement a `sphere`, cette operation vise une densite issue d'un champ
 * de distance : les faces restent planes et les aretes ne prennent qu'un
 * demi-voxel d'antialiasing pour que Surface Nets puisse les mailler sans
 * marches d'escalier.
 */
export function stampSandBox(ctx, wx, wy, wz, width, length, height, yaw = 0,
  moisture = 0.12, packing = 0.90) {
  const F = ctx.field;
  const v = toVoxel(wx, wy, wz);
  const hx = Math.max(0.5, width * 0.5 / VOXEL);
  const hz = Math.max(0.5, length * 0.5 / VOXEL);
  const hh = Math.max(1, height / VOXEL);
  const cs = Math.cos(yaw), sn = Math.sin(yaw);
  const reach = Math.ceil(Math.hypot(hx, hz)) + 2;

  if (!ctx.begin(
    Math.floor(v.x - reach), Math.floor(v.y - 2), Math.floor(v.z - reach),
    Math.ceil(v.x + reach), Math.ceil(v.y + hh + 2), Math.ceil(v.z + reach)
  )) return 0;

  let delta = 0;
  for (let z = ctx.minZ; z <= ctx.maxZ; z++) {
    const dz = z - v.z;
    for (let y = ctx.minY; y <= ctx.maxY; y++) {
      const dy = y - v.y;
      if (dy < -1.5 || dy > hh + 1.5) continue;
      const row = NX * (z + NZ * y);
      for (let x = ctx.minX; x <= ctx.maxX; x++) {
        const dx = x - v.x;
        // Rotation inverse : monde -> repere local du bloc.
        const lx = dx * cs - dz * sn;
        const lz = dx * sn + dz * cs;
        if (Math.abs(lx) > hx + 1 || Math.abs(lz) > hz + 1) continue;
        const sd = Math.min(
          hx - Math.abs(lx), hz - Math.abs(lz),
          dy + 0.5, hh - dy
        );
        const target = clamp(128 + sd * 128, 0, 255) | 0;
        if (target <= F.density[row + x]) continue;
        delta += writeSandTarget(ctx, x, y, z, row + x, target, moisture, packing);
      }
    }
  }
  ctx.volume = (delta / 255) * VOXEL * VOXEL * VOXEL;
  ctx.end();
  return ctx.volume;
}

/**
 * Extrude un mur vertical le long d'une polyligne deja lissee.
 *
 * Chaque point porte sa propre altitude de base : une spline tracee sur une
 * plage en pente reste donc posee sur le sable, au lieu de flotter a une
 * extremite. Les crenelages sont de vrais volumes de sable alternes sur le
 * sommet ; ils restent sculptables par la truelle et la mirette.
 *
 * @param {EditContext} ctx
 * @param {Array<{x:number,y:number,z:number}>} points points monde
 * @param {number} width epaisseur du mur, en metres
 * @param {number} height hauteur du corps, en metres
 * @param {{crenels?:boolean, crenelWidth?:number, crenelHeight?:number,
 *   moisture?:number, packing?:number}} options
 */
export function stampSandWall(ctx, points, width, height, options = {}) {
  if (!points || points.length < 2) return 0;
  const F = ctx.field;
  const path = points.map((p) => toVoxel(p.x, p.y, p.z));
  const half = Math.max(0.75, width * 0.5 / VOXEL);
  const bodyH = Math.max(1, height / VOXEL);
  const crenels = options.crenels !== false;
  const crenelWm = Math.max(VOXEL * 1.5, options.crenelWidth ?? 0.16);
  const crenelH = crenels ? Math.max(1, (options.crenelHeight ?? 0.14) / VOXEL) : 0;
  const moisture = options.moisture ?? 0.12;
  const packing = options.packing ?? 0.90;

  const cumulative = new Float32Array(path.length);
  let totalLength = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    if (i > 0) {
      totalLength += Math.hypot(p.x - path[i - 1].x, p.z - path[i - 1].z);
      cumulative[i] = totalLength;
    }
  }
  if (totalLength < 0.25) return 0;

  const reach = Math.ceil(half) + 2;
  if (!ctx.begin(
    Math.floor(minX - reach), Math.floor(minY - 2), Math.floor(minZ - reach),
    Math.ceil(maxX + reach), Math.ceil(maxY + bodyH + crenelH + 2), Math.ceil(maxZ + reach)
  )) return 0;

  let delta = 0;
  for (let z = ctx.minZ; z <= ctx.maxZ; z++) {
    for (let x = ctx.minX; x <= ctx.maxX; x++) {
      // Segment de spline le plus proche dans le plan horizontal.
      let bestD2 = Infinity;
      let bestBase = 0;
      let bestAlong = 0;
      for (let i = 0; i + 1 < path.length; i++) {
        const a = path[i], b = path[i + 1];
        const sx = b.x - a.x, sz = b.z - a.z;
        const ll = sx * sx + sz * sz;
        const t = ll > 1e-8 ? clamp(((x - a.x) * sx + (z - a.z) * sz) / ll, 0, 1) : 0;
        const qx = a.x + sx * t, qz = a.z + sz * t;
        const dx = x - qx, dz = z - qz;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) {
          bestD2 = d2;
          bestBase = a.y + (b.y - a.y) * t;
          bestAlong = cumulative[i] + Math.sqrt(ll) * t;
        }
      }
      const dist = Math.sqrt(bestD2);
      if (dist > half + 1) continue;

      const alongM = bestAlong * VOXEL;
      const period = crenelWm * 2;
      const phase = ((alongM + crenelWm * 0.5) % period + period) % period;
      const inCrenel = crenels && phase < crenelWm;
      // Distance signee jusqu'aux deux bouts du petit bloc. Elle donne des
      // creneaux carres et non une alternance en dents de scie.
      const crenelEnd = inCrenel
        ? Math.min(phase, crenelWm - phase) / VOXEL
        : -1;

      const y0 = Math.max(ctx.minY, Math.floor(bestBase - 1));
      const y1 = Math.min(ctx.maxY, Math.ceil(bestBase + bodyH + crenelH + 1));
      for (let y = y0; y <= y1; y++) {
        const dy = y - bestBase;
        const side = half - dist;
        let sd = Math.min(side, dy + 0.5, bodyH - dy);
        if (inCrenel) {
          const sdTop = Math.min(side, crenelEnd, dy - bodyH + 0.5, bodyH + crenelH - dy);
          sd = Math.max(sd, sdTop);
        }
        const target = clamp(128 + sd * 128, 0, 255) | 0;
        const i = x + NX * (z + NZ * y);
        if (target <= F.density[i]) continue;
        delta += writeSandTarget(ctx, x, y, z, i, target, moisture, packing);
      }
    }
  }

  ctx.volume = (delta / 255) * VOXEL * VOXEL * VOXEL;
  ctx.end();
  return ctx.volume;
}

/**
 * Rainures paralleles : le rateau et le peigne. Sert a texturer un mur en
 * appareil de briques ou a faire un toit de tuiles.
 */
export function rake(ctx, wx, wy, wz, nx, ny, nz, radius, spacing, depth) {
  const F = ctx.field;
  const v = toVoxel(wx, wy, wz);
  const r = radius / VOXEL;
  const sp = Math.max(2, spacing / VOXEL);
  const dp = depth / VOXEL;
  if (!ctx.begin(
    Math.floor(v.x - r - dp - 1), Math.floor(v.y - r - dp - 1), Math.floor(v.z - r - dp - 1),
    Math.ceil(v.x + r + dp + 1), Math.ceil(v.y + r + dp + 1), Math.ceil(v.z + r + dp + 1)
  )) return;

  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  // Direction des rainures : horizontale, perpendiculaire a la normale.
  let tx = -nz, ty = 0, tz = nx;
  const tl = Math.hypot(tx, ty, tz);
  if (tl < 1e-3) { tx = 1; ty = 0; tz = 0; } else { tx /= tl; tz /= tl; }
  // Axe de repetition
  const ux = ny * tz - nz * ty;
  const uy = nz * tx - nx * tz;
  const uz = nx * ty - ny * tx;

  for (let z = ctx.minZ; z <= ctx.maxZ; z++) {
    const dz = z - v.z;
    for (let y = ctx.minY; y <= ctx.maxY; y++) {
      const dy = y - v.y;
      const row = NX * (z + NZ * y);
      for (let x = ctx.minX; x <= ctx.maxX; x++) {
        const dx = x - v.x;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > r) continue;
        const fade = 1 - smoothstep(r * 0.6, r, dist);
        const u = dx * ux + dy * uy + dz * uz;
        // Profil de rainure : creux etroit tous les `sp` voxels
        const phase = Math.abs(((u / sp) % 1 + 1) % 1 - 0.5) * 2; // 0 au centre
        const groove = 1 - smoothstep(0.15, 0.5, phase);
        if (groove <= 0.01) continue;
        const i = row + x;
        const old = F.density[i];
        if (old === 0) continue;
        const nv = clamp(old - groove * fade * dp * 110, 0, 255) | 0;
        if (nv === old) continue;
        F.density[i] = nv;
        writeMeta(ctx, x, y, z, i, old, nv);
      }
    }
  }
  ctx.end();
}

// ---------------------------------------------------------------------------

/** Ajoute une cible de densite et melange proprement l'etat du sable pose. */
export function writeSandTarget(ctx, x, y, z, i, target, moisture, packing) {
  const F = ctx.field;
  const old = F.density[i];
  if (target <= old) return 0;
  const add = target - old;
  F.density[i] = target;
  F.moisture[i] = clamp((F.moisture[i] * old + moisture * 255 * add) / target, 0, 255) | 0;
  F.packing[i] = clamp((F.packing[i] * old + packing * 255 * add) / target, 0, 255) | 0;
  F.material[i] = MAT_SAND;
  writeMeta(ctx, x, y, z, i, old, target);
  return add;
}

/** Mise a jour des compteurs de chunk apres une ecriture directe de densite. */
export function writeMeta(ctx, x, y, z, i, old, v) {
  const F = ctx.field;
  if (y < FOUNDATION_LAYERS && v < old) {
    F.density[i] = old;
    return false;
  }
  // `surfaceH` est encore l'ancien cache a cet instant : c'est exactement la
  // reference necessaire pour conserver la surface libre de l'eau.
  ctx.noteTerrainColumn(x, z);
  const ci = chidx((x / CHUNK) | 0, (y / CHUNK) | 0, (z / CHUNK) | 0);
  if (old > 0 && v === 0) F.chunkSolid[ci]--;
  else if (old === 0 && v > 0) F.chunkSolid[ci]++;
  if (old >= ISO && v < ISO) F.chunkFull[ci]--;
  else if (old < ISO && v >= ISO) F.chunkFull[ci]++;
  if (v === 0) {
    F.moisture[i] = 0; F.packing[i] = 0; F.material[i] = 0;
  }
  F.touch(x, y, z);
  return true;
}
