/**
 * Operations de sculpture fine : ce qui manquait au sculpteur.
 *
 * Toutes ces operations ecrivent une DENSITE CIBLE issue d'un champ de
 * distance signee, comme `stampSandBox` : la surface a un demi-voxel
 * d'antialiasing, jamais plus, pour que Surface Nets la maille nette et sans
 * marches. Elles passent par `writeMeta` (compteurs, socle, colonnes pour
 * l'eau) et `writeSandTarget` (matiere ajoutee) de Brush.js, donc par
 * l'annulation et le reveil de la mecanique comme tout le reste.
 *
 *  - carveOpening : porte ou fenetre percee dans une paroi, profil au choix
 *    (plein cintre, ogive, surbaissee, droite), profondeur reglee.
 *  - carveStairs : marches taillees ET remblayees entre deux points d'une
 *    pente, hauteur de marche reglee.
 *  - carveGroove : rainure a profil en U ou en V le long d'un trait.
 *  - blowClean : la paille du sculpteur, qui chasse les grains detaches sans
 *    toucher a la forme.
 *  - stampRevolution : tour, cone, dome, par profil de revolution.
 *  - mirrorPoint / mirrorVector : le mode miroir.
 */

import { NX, NY, NZ, VOXEL, ISO, clamp, smoothstep } from '../core/Config.js';
import { toVoxel, writeMeta, writeSandTarget } from './Brush.js';

const SLICE = NX * NZ;

// ---------------------------------------------------------------------------
// OUVERTURES
// ---------------------------------------------------------------------------

/**
 * Hauteur du bord superieur de l'ouverture a l'abscisse laterale `a`
 * (en unites quelconques, coherentes avec `hw` et `H`).
 * @param {'round'|'pointed'|'flat'|'rect'} profile
 * @param {number} a  abscisse depuis l'axe (signee)
 * @param {number} hw demi-largeur
 * @param {number} H  hauteur totale
 */
export function openingTop(profile, a, hw, H) {
  const x = Math.abs(a);
  switch (profile) {
    case 'round': {
      // Plein cintre : un demi-cercle de rayon hw pose sur les jambages.
      const ys = H - hw;
      return Math.min(H, ys + Math.sqrt(Math.max(0, hw * hw - x * x)));
    }
    case 'pointed': {
      // Ogive equilaterale : chaque arc est centre sur le jambage oppose,
      // rayon = largeur. La pointe culmine a hw*sqrt(3) au-dessus des naissances.
      const ys = Math.max(0, H - hw * Math.SQRT2 * 1.2247);   // hw * sqrt(3)
      const R = 2 * hw, d = x + hw;
      return Math.min(H, ys + Math.sqrt(Math.max(0, R * R - d * d)));
    }
    case 'flat': {
      // Arc surbaisse : une demi-ellipse basse.
      const rise = hw * 0.45;
      const ys = H - rise;
      return ys + rise * Math.sqrt(Math.max(0, 1 - (x / hw) * (x / hw)));
    }
    default:
      return H;
  }
}

/**
 * Perce une ouverture dans une paroi.
 *
 * @param {import('./Brush.js').EditContext} ctx
 * @param {number} wx,wy,wz  point du BAS de l'ouverture, au nu de la paroi
 * @param {number} inX,inZ   direction horizontale vers l'INTERIEUR du mur
 * @param {{width:number, height:number, depth:number, profile:string, sill?:boolean}} o
 * @returns {number} volume retire (m3)
 */
export function carveOpening(ctx, wx, wy, wz, inX, inZ, o) {
  const F = ctx.field, D = F.density;
  const v = toVoxel(wx, wy, wz);
  const l = Math.hypot(inX, inZ) || 1;
  const nx = inX / l, nz = inZ / l;
  const ux = -nz, uz = nx;
  const hw = Math.max(0.5, o.width * 0.5 / VOXEL);
  const H = Math.max(1, o.height / VOXEL);
  const depth = Math.max(1, o.depth / VOXEL);
  // On entame aussi la peau exterieure : la face reste propre au nu du mur.
  const skin = 0.06 / VOXEL;
  const sill = !!o.sill;
  const reach = Math.ceil(Math.max(hw, depth) + skin) + 2;
  if (!ctx.begin(
    Math.floor(v.x - reach), Math.floor(v.y - 2), Math.floor(v.z - reach),
    Math.ceil(v.x + reach), Math.ceil(v.y + H + 2), Math.ceil(v.z + reach)
  )) return 0;

  let removed = 0;
  for (let z = ctx.minZ; z <= ctx.maxZ; z++) {
    const dz = z - v.z;
    for (let y = ctx.minY; y <= ctx.maxY; y++) {
      const b = y - v.y;
      if (b < -1.5 || b > H + 1.5) continue;
      const row = NX * (z + NZ * y);
      for (let x = ctx.minX; x <= ctx.maxX; x++) {
        const dx = x - v.x;
        const a = dx * ux + dz * uz;
        const w = dx * nx + dz * nz;
        const dLat = hw - Math.abs(a);
        if (dLat < -1) continue;
        const dTop = openingTop(o.profile, a, hw, H) - b;
        const dBot = sill ? b : b + 1e3;
        const dIn = Math.min(w + skin, depth - w);
        const sd = Math.min(dLat, dTop, dBot, dIn);
        const cov = clamp(sd + 0.5, 0, 1);
        if (cov <= 0) continue;
        const i = row + x;
        const old = D[i];
        const nv = Math.round(old * (1 - cov));
        if (nv >= old) continue;
        D[i] = nv;
        if (writeMeta(ctx, x, y, z, i, old, nv)) removed += old - nv;
      }
    }
  }
  ctx.volume = -(removed / 255) * VOXEL * VOXEL * VOXEL;
  ctx.end();
  return -ctx.volume;
}

// ---------------------------------------------------------------------------
// ESCALIER
// ---------------------------------------------------------------------------

/**
 * Taille un escalier droit entre A (pied) et B (haut).
 *
 * Les marches sont des plans horizontaux a hauteurs regulieres ; ce qui
 * depasse au-dessus d'une marche est retire, ce qui manque en dessous est
 * remblaye en sable damé. Sur une pente reguliere, chaque marche est donc
 * moitie taillee, moitie remblayee, comme le fait un sculpteur.
 *
 * @param {{width:number, riser:number, moisture?:number, packing?:number}} o
 * @returns {{steps:number, cut:number, fill:number}}
 */
export function carveStairs(ctx, ax, ay, az, bx, by, bz, o) {
  const F = ctx.field, D = F.density;
  const A = toVoxel(ax, ay, az), B = toVoxel(bx, by, bz);
  let dx = B.x - A.x, dz = B.z - A.z;
  const L = Math.hypot(dx, dz);
  if (L < 1) return { steps: 0, cut: 0, fill: 0 };
  dx /= L; dz /= L;
  const rise = B.y - A.y;
  const riserV = Math.max(0.5, o.riser / VOXEL);
  const n = Math.max(1, Math.round(Math.abs(rise) / riserV));
  const stepH = rise / n;
  const tread = L / n;
  const hw = Math.max(0.5, o.width * 0.5 / VOXEL);
  const moisture = o.moisture ?? 0.12, packing = o.packing ?? 0.9;

  const reach = Math.ceil(hw) + 2;
  const yLo = Math.min(A.y, B.y) - Math.ceil(Math.abs(stepH)) - 3;
  const yHi = Math.max(A.y, B.y) + Math.ceil(Math.abs(stepH)) + 3;
  if (!ctx.begin(
    Math.floor(Math.min(A.x, B.x) - reach), Math.floor(yLo), Math.floor(Math.min(A.z, B.z) - reach),
    Math.ceil(Math.max(A.x, B.x) + reach), Math.ceil(yHi), Math.ceil(Math.max(A.z, B.z) + reach)
  )) return { steps: 0, cut: 0, fill: 0 };

  let cut = 0, fill = 0;
  for (let z = ctx.minZ; z <= ctx.maxZ; z++) {
    const pz = z - A.z;
    for (let x = ctx.minX; x <= ctx.maxX; x++) {
      const px = x - A.x;
      const along = px * dx + pz * dz;
      const across = Math.abs(-px * dz + pz * dx);
      if (along < -1 || along > L + 1 || across > hw + 1) continue;
      const i = clamp(Math.floor(along / tread), 0, n - 1);
      const h = A.y + stepH * (i + 1);
      const dLat = hw - across;
      const dEnd = Math.min(along + 0.5, L + 0.5 - along);
      const edge = clamp(Math.min(dLat, dEnd) + 0.5, 0, 1);
      if (edge <= 0) continue;
      for (let y = ctx.minY; y <= ctx.maxY; y++) {
        const sd = h - y;
        // Bien en dessous du plan de la marche, le sable existant reste ;
        // au-dessus, tout ce qui depasse est retire (cible 0).
        if (sd > 1.5) continue;
        const target = clamp(128 + sd * 128, 0, 255) | 0;
        const idx = x + NX * (z + NZ * y);
        const old = D[idx];
        const nv = Math.round(old + (target - old) * edge);
        if (nv === old) continue;
        if (nv > old) {
          fill += writeSandTarget(ctx, x, y, z, idx, nv, moisture, packing);
        } else {
          D[idx] = nv;
          if (writeMeta(ctx, x, y, z, idx, old, nv)) cut += old - nv;
        }
      }
    }
  }
  ctx.end();
  return { steps: n, cut: (cut / 255) * VOXEL ** 3, fill: (fill / 255) * VOXEL ** 3 };
}

/**
 * Contour des marches, pour l'apercu : une liste de polylignes monde.
 * Meme decoupage que carveStairs.
 */
export function stairsOutline(ax, ay, az, bx, by, bz, o) {
  let dx = bx - ax, dz = bz - az;
  const L = Math.hypot(dx, dz);
  if (L < VOXEL) return [];
  dx /= L; dz /= L;
  const n = Math.max(1, Math.round(Math.abs(by - ay) / Math.max(0.02, o.riser)));
  const stepH = (by - ay) / n, tread = L / n;
  const hw = o.width * 0.5;
  const ux = -dz, uz = dx;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const h = ay + stepH * (i + 1);
    const s0 = i * tread, s1 = (i + 1) * tread;
    const P = (s, side) => ({ x: ax + dx * s + ux * hw * side, y: h, z: az + dz * s + uz * hw * side });
    lines.push([P(s0, -1), P(s1, -1), P(s1, 1), P(s0, 1), P(s0, -1)]);
    // La contremarche : de la marche precedente a celle-ci.
    const hp = ay + stepH * i;
    lines.push([{ x: ax + dx * s0 - ux * hw, y: hp, z: az + dz * s0 - uz * hw }, P(s0, -1)]);
    lines.push([{ x: ax + dx * s0 + ux * hw, y: hp, z: az + dz * s0 + uz * hw }, P(s0, 1)]);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// GOUGE
// ---------------------------------------------------------------------------

/**
 * Rainure le long du segment P0-P1 (points monde, sur la surface), de
 * largeur et de profondeur donnees, a profil en U (gouge) ou en V (ciseau).
 * @param {{width:number, depth:number, profile:'u'|'v'}} o
 * @returns {number} volume retire (m3)
 */
export function carveGroove(ctx, x0, y0, z0, x1, y1, z1, o) {
  const F = ctx.field, D = F.density;
  const P0 = toVoxel(x0, y0, z0), P1 = toVoxel(x1, y1, z1);
  const ex = P1.x - P0.x, ey = P1.y - P0.y, ez = P1.z - P0.z;
  const len2 = ex * ex + ey * ey + ez * ez;
  const hw = Math.max(0.35, o.width * 0.5 / VOXEL);
  const dep = Math.max(0.35, o.depth / VOXEL);
  const reach = Math.ceil(hw + dep) + 2;
  if (!ctx.begin(
    Math.floor(Math.min(P0.x, P1.x) - reach), Math.floor(Math.min(P0.y, P1.y) - reach), Math.floor(Math.min(P0.z, P1.z) - reach),
    Math.ceil(Math.max(P0.x, P1.x) + reach), Math.ceil(Math.max(P0.y, P1.y) + reach), Math.ceil(Math.max(P0.z, P1.z) + reach)
  )) return 0;
  // Direction horizontale du trait, pour mesurer l'ecart lateral.
  const hl = Math.hypot(ex, ez);
  const hx = hl > 1e-6 ? ex / hl : 1, hz = hl > 1e-6 ? ez / hl : 0;
  const isV = o.profile === 'v';
  const yc = -dep + hw;                       // centre du U, sous la surface
  const cosV = dep / Math.hypot(dep, hw);     // pente des flancs du V

  let removed = 0;
  for (let z = ctx.minZ; z <= ctx.maxZ; z++) {
    for (let y = ctx.minY; y <= ctx.maxY; y++) {
      const row = NX * (z + NZ * y);
      for (let x = ctx.minX; x <= ctx.maxX; x++) {
        const rx = x - P0.x, ry = y - P0.y, rz = z - P0.z;
        const t = len2 > 1e-9 ? clamp((rx * ex + ry * ey + rz * ez) / len2, 0, 1) : 0;
        const qx = P0.x + ex * t, qy = P0.y + ey * t, qz = P0.z + ez * t;
        const a = Math.abs(-(x - qx) * hz + (z - qz) * hx);   // ecart lateral
        const b = y - qy;                                     // hauteur / surface
        if (b > 1.5 || a > hw + 1) continue;
        let sd;
        if (isV) {
          // Le V : demi-largeur nulle au fond (-dep), hw a la surface.
          const half = hw * clamp((b + dep) / dep, 0, 1e9);
          sd = (half - a) * cosV;
          if (b < -dep) sd = Math.min(sd, (b + dep));
        } else {
          sd = b >= yc ? hw - a : hw - Math.hypot(a, b - yc);
        }
        // Au-dessus de la surface, la rainure ne va pas chercher plus haut
        // qu'un voxel : c'est une entaille, pas une tranchee en l'air.
        sd = Math.min(sd, 1.0 - b);
        const cov = clamp(sd + 0.5, 0, 1);
        if (cov <= 0) continue;
        const i = row + x;
        const old = D[i];
        const nv = Math.round(old * (1 - cov));
        if (nv >= old) continue;
        D[i] = nv;
        if (writeMeta(ctx, x, y, z, i, old, nv)) removed += old - nv;
      }
    }
  }
  ctx.volume = -(removed / 255) * VOXEL ** 3;
  ctx.end();
  return -ctx.volume;
}

// ---------------------------------------------------------------------------
// PAILLE
// ---------------------------------------------------------------------------

/** Nombre de voisins pleins (6-connexite) d'un voxel. */
function solidNeighbours(D, x, y, z, i) {
  let n = 0;
  if (x > 0 && D[i - 1] >= ISO) n++;
  if (x + 1 < NX && D[i + 1] >= ISO) n++;
  if (z > 0 && D[i - NX] >= ISO) n++;
  if (z + 1 < NZ && D[i + NX] >= ISO) n++;
  if (y > 0 && D[i - SLICE] >= ISO) n++;
  if (y + 1 < NY && D[i + SLICE] >= ISO) n++;
  return n;
}

/**
 * La paille du sculpteur : souffle les grains detaches.
 *
 * Un voxel, partiel ou plein, sans AUCUN voisin plein est une miette ou un
 * grain en l'air : il part. Un partiel tres tenu (sous 16 %) est le halo que
 * laissent lissage et erosion : il part aussi, ce qui ne deplace la surface
 * que de quelques millimetres. La peau des pentes et des parois (partiels
 * adosses a du plein) n'est pas touchee : la forme reste.
 * @returns {number} voxels nettoyes
 */
export function blowClean(ctx, wx, wy, wz, radius, strength = 1) {
  const F = ctx.field, D = F.density;
  const v = toVoxel(wx, wy, wz);
  const r = radius / VOXEL;
  if (!ctx.begin(
    Math.floor(v.x - r) - 1, Math.floor(v.y - r) - 1, Math.floor(v.z - r) - 1,
    Math.ceil(v.x + r) + 1, Math.ceil(v.y + r) + 1, Math.ceil(v.z + r) + 1
  )) return 0;
  let cleaned = 0;
  for (let z = ctx.minZ; z <= ctx.maxZ; z++) {
    const dz = z - v.z;
    for (let y = ctx.minY; y <= ctx.maxY; y++) {
      const dy = y - v.y;
      const row = NX * (z + NZ * y);
      for (let x = ctx.minX; x <= ctx.maxX; x++) {
        const dx = x - v.x;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > r) continue;
        const i = row + x;
        const old = D[i];
        if (old === 0) continue;
        const nb = solidNeighbours(D, x, y, z, i);
        const crumb = nb === 0 || old < 40;
        if (!crumb) continue;
        const f = 1 - smoothstep(r * 0.6, r, d);
        const nv = Math.round(old * (1 - strength * f));
        if (nv >= old) continue;
        D[i] = nv;
        writeMeta(ctx, x, y, z, i, old, nv);
        cleaned++;
      }
    }
  }
  ctx.end();
  return cleaned;
}

// ---------------------------------------------------------------------------
// FORMES DE REVOLUTION
// ---------------------------------------------------------------------------

/**
 * Depose un solide de revolution d'axe vertical, base en (wx, wy, wz).
 * @param {(t:number)=>number} radiusAt rayon (m) en fonction de t = hauteur relative 0..1
 * @returns {number} volume ajoute (m3)
 */
export function stampRevolution(ctx, wx, wy, wz, height, radiusAt, moisture = 0.12, packing = 0.9) {
  const F = ctx.field;
  const v = toVoxel(wx, wy, wz);
  const hh = Math.max(1, height / VOXEL);
  let rmax = 0;
  for (let k = 0; k <= 16; k++) rmax = Math.max(rmax, radiusAt(k / 16));
  const R = Math.ceil(rmax / VOXEL) + 2;
  if (!ctx.begin(
    Math.floor(v.x - R), Math.floor(v.y - 2), Math.floor(v.z - R),
    Math.ceil(v.x + R), Math.ceil(v.y + hh + 2), Math.ceil(v.z + R)
  )) return 0;
  let delta = 0;
  for (let z = ctx.minZ; z <= ctx.maxZ; z++) {
    const dz = z - v.z;
    for (let y = ctx.minY; y <= ctx.maxY; y++) {
      const dy = y - v.y;
      if (dy < -1.5 || dy > hh + 1.5) continue;
      const t = clamp(dy / hh, 0, 1);
      const rr = radiusAt(t) / VOXEL;
      // Pente locale du profil : la distance au flanc est raccourcie d'autant.
      const r2 = radiusAt(clamp(t + 0.02, 0, 1)) / VOXEL, r1 = radiusAt(clamp(t - 0.02, 0, 1)) / VOXEL;
      const slope = (r2 - r1) / (0.04 * hh);
      const k = 1 / Math.sqrt(1 + slope * slope);
      const row = NX * (z + NZ * y);
      for (let x = ctx.minX; x <= ctx.maxX; x++) {
        const dx = x - v.x;
        const rad = Math.sqrt(dx * dx + dz * dz);
        if (rad > rr + 1.5) continue;
        const sd = Math.min((rr - rad) * k, dy + 0.5, hh - dy);
        const target = clamp(128 + sd * 128, 0, 255) | 0;
        const i = row + x;
        if (target <= F.density[i]) continue;
        delta += writeSandTarget(ctx, x, y, z, i, target, moisture, packing);
      }
    }
  }
  ctx.volume = (delta / 255) * VOXEL ** 3;
  ctx.end();
  return ctx.volume;
}

/** Profils usuels. */
export const cylinderProfile = (R, taper = 0) => (t) => R * (1 - taper * t);
export const coneProfile = (R) => (t) => R * (1 - t);
export const domeProfile = (R) => (t) => R * Math.sqrt(Math.max(0, 1 - t * t));

// ---------------------------------------------------------------------------
// MIROIR
// ---------------------------------------------------------------------------

/** Symetrique d'un point par rapport au plan x = pos (axe 'x') ou z = pos (axe 'z'). */
export function mirrorPoint(p, axis, pos) {
  return axis === 'x'
    ? { x: 2 * pos - p.x, y: p.y, z: p.z }
    : { x: p.x, y: p.y, z: 2 * pos - p.z };
}

/** Symetrique d'un vecteur (composante normale a l'axe inversee). */
export function mirrorVector(v, axis) {
  return axis === 'x' ? { x: -v.x, y: v.y, z: v.z } : { x: v.x, y: v.y, z: -v.z };
}
