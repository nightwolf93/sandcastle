/**
 * Gouttes balistiques.
 *
 * Tout ce qui QUITTE la nappe d'eau devient une goutte : l'eau versee par un
 * outil, la lame qui bascule d'un rebord, les embruns d'un rouleau. Une goutte
 * ne porte que son volume, sa vitesse et un peu d'ecume ; elle n'a aucune
 * pression avec ses voisines (pas de recherche de voisinage, donc un cout
 * negligeable), elle tombe, glisse sur le sable si elle le touche de biais, et
 * rend son volume EXACT a la nappe la ou elle se pose. La conservation de
 * l'eau ne depend donc jamais d'elle.
 *
 * Tableaux SoA, aucune allocation dans la boucle chaude.
 */

import {
  NX, NZ, VOXEL, ORIGIN_X, ORIGIN_Y, ORIGIN_Z, WORLD_W, WORLD_H, WORLD_D,
  GRAVITY, FOUNDATION_LAYERS, DROPLET_VOLUME, DROPLET_RADIUS, DROPLET_MAX,
  clamp,
} from '../core/Config.js';

const R = DROPLET_RADIUS;

export class Droplets {
  /** @param {import('./VoxelField.js').VoxelField} field */
  constructor(field) {
    this.field = field;
    this.capacity = DROPLET_MAX;
    this.count = 0;
    this.x = new Float32Array(DROPLET_MAX);
    this.y = new Float32Array(DROPLET_MAX);
    this.z = new Float32Array(DROPLET_MAX);
    this.vx = new Float32Array(DROPLET_MAX);
    this.vy = new Float32Array(DROPLET_MAX);
    this.vz = new Float32Array(DROPLET_MAX);
    /** Volume porte (m3). */
    this.vol = new Float32Array(DROPLET_MAX);
    /** Ecume portee, 0..1. */
    this.foam = new Float32Array(DROPLET_MAX);
    /** Visibilite rendue : une goutte nait en 40 ms, jamais d'un coup. */
    this.vis = new Float32Array(DROPLET_MAX);
    this.rngState = 0x9e3779b9;
    /** Numero d'etat lu par le renderer. */
    this.revision = 0;
  }

  rand() {
    let s = this.rngState;
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    this.rngState = s;
    return s / 4294967296;
  }

  clear() {
    this.count = 0;
    this.revision++;
  }

  /** Volume total en vol (m3). */
  volume() {
    let v = 0;
    for (let i = 0; i < this.count; i++) v += this.vol[i];
    return v;
  }

  emit(x, y, z, vx = 0, vy = 0, vz = 0, vol = DROPLET_VOLUME, foam = 0) {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.x[i] = clamp(x, ORIGIN_X + R, ORIGIN_X + WORLD_W - R);
    this.y[i] = Math.min(y, ORIGIN_Y + WORLD_H - R);
    this.z[i] = clamp(z, ORIGIN_Z + R, ORIGIN_Z + WORLD_D - R);
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.vol[i] = vol;
    this.foam[i] = foam;
    this.vis[i] = 0;
    this.revision++;
    return i;
  }

  remove(i) {
    const last = --this.count;
    if (i !== last) {
      this.x[i] = this.x[last]; this.y[i] = this.y[last]; this.z[i] = this.z[last];
      this.vx[i] = this.vx[last]; this.vy[i] = this.vy[last]; this.vz[i] = this.vz[last];
      this.vol[i] = this.vol[last];
      this.foam[i] = this.foam[last];
      this.vis[i] = this.vis[last];
    }
    this.revision++;
  }

  /** Altitude du sable sous une position monde (colonne fine). */
  groundAt(wx, wz) {
    const x = clamp(Math.floor((wx - ORIGIN_X) / VOXEL), 0, NX - 1);
    const z = clamp(Math.floor((wz - ORIGIN_Z) / VOXEL), 0, NZ - 1);
    return this.field.surfaceH[x + NX * z];
  }

  /**
   * Avance toutes les gouttes.
   *
   * @param {number} dt
   * @param {(wx:number, wz:number) => number} levelAt altitude de la surface
   *   libre de la nappe (ou -Infinity s'il n'y a pas d'eau)
   * @param {(wx:number, wz:number, vol:number, foam:number) => void} land
   *   rend le volume a la nappe
   */
  step(dt, levelAt, land) {
    if (this.count === 0) return;
    const floorY = ORIGIN_Y + FOUNDATION_LAYERS * VOXEL;
    const minX = ORIGIN_X + R, maxX = ORIGIN_X + WORLD_W - R;
    const minZ = ORIGIN_Z + R, maxZ = ORIGIN_Z + WORLD_D - R;
    const kVis = 1 - Math.exp(-dt / 0.04);
    for (let i = this.count - 1; i >= 0; i--) {
      const px = this.x[i], pz = this.z[i];
      this.vy[i] -= GRAVITY * dt;
      let x = px + this.vx[i] * dt;
      let y = this.y[i] + this.vy[i] * dt;
      let z = pz + this.vz[i] * dt;
      if (x < minX) { x = minX; this.vx[i] = 0; } else if (x > maxX) { x = maxX; this.vx[i] = 0; }
      if (z < minZ) { z = minZ; this.vz[i] = 0; } else if (z > maxZ) { z = maxZ; this.vz[i] = 0; }
      if (y < floorY + R) y = floorY + R;

      let ground = this.groundAt(x, z);
      if (y - R <= ground + 0.004) {
        // Mur ou sol ? Si la colonne d'arrivee est bien plus haute que celle
        // de depart, la goutte a frappe une paroi : elle reste de son cote et
        // glisse le long. Sinon elle se pose et rend son eau.
        const prevGround = this.groundAt(px, pz);
        if (ground - prevGround > 0.06 && y - R > prevGround + 0.004) {
          x = px; z = pz;
          this.vx[i] *= 0.15; this.vz[i] *= 0.15;
          ground = prevGround;
        }
        if (y - R <= ground + 0.004) {
          land(x, z, this.vol[i], this.foam[i]);
          this.remove(i);
          continue;
        }
      }
      // Surface libre de la nappe : une goutte qui tombe dans l'eau rejoint la
      // nappe des qu'elle passe sous sa surface.
      const level = levelAt(x, z);
      if (y <= level) {
        land(x, z, this.vol[i], this.foam[i]);
        this.remove(i);
        continue;
      }
      this.x[i] = x; this.y[i] = y; this.z[i] = z;
      this.vis[i] += (1 - this.vis[i]) * kVis;
      this.foam[i] *= 1 - dt * 0.4;
    }
    this.revision++;
  }

  serialize() {
    const n = this.count;
    return {
      count: n,
      x: this.x.slice(0, n), y: this.y.slice(0, n), z: this.z.slice(0, n),
      vx: this.vx.slice(0, n), vy: this.vy.slice(0, n), vz: this.vz.slice(0, n),
      vol: this.vol.slice(0, n), foam: this.foam.slice(0, n),
    };
  }

  deserialize(s) {
    this.clear();
    if (!s || !Number.isFinite(s.count)) return false;
    const n = Math.min(this.capacity, s.count | 0, s.x?.length || 0);
    if (n <= 0) return true;
    this.count = n;
    const copy = (dst, src, fill) => {
      if (src) dst.set(src.subarray ? src.subarray(0, n) : src.slice(0, n));
      else dst.fill(fill, 0, n);
    };
    copy(this.x, s.x, 0); copy(this.y, s.y, 0); copy(this.z, s.z, 0);
    copy(this.vx, s.vx, 0); copy(this.vy, s.vy, 0); copy(this.vz, s.vz, 0);
    copy(this.vol, s.vol, DROPLET_VOLUME); copy(this.foam, s.foam, 0);
    this.vis.fill(1, 0, n);
    this.revision++;
    return true;
  }
}
