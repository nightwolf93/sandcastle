/**
 * Meteo : ce que le ciel et le vent font a la mer.
 *
 * Cinq modes, du calme plat a la tempete. Chacun fixe d'un coup la hauteur
 * des vagues, leur puissance (leur periode : des vagues longues deferlent en
 * plongeant et courent loin sur le sable), l'agitation, le vent, la
 * couverture du ciel et la pluie. Le joueur peut ensuite retoucher chaque
 * jauge : le mode devient « personnalise ».
 *
 * Le vent et le ciel changent EN DOUCEUR (quelques secondes) : une tempete
 * arrive, elle ne s'allume pas. La mer, elle, repond tout de suite au reglage
 * — c'est l'entree du generateur de houle, et la rampe est deja dans la
 * surcote (Water.waveSetup).
 *
 * La pluie est faite des memes gouttes que l'arrosoir : une sur huit mouille
 * vraiment le sable, donc une averse assombrit la plage et la rend
 * sculptable, comme la vraie.
 */

import { ORIGIN_X, ORIGIN_Z, WORLD_W, WORLD_D, clamp } from './Config.js';

export const WEATHER = [
  { key: 'calm', label: 'Calme', sub: 'Mer d\'huile, grand soleil. Pour construire tranquillement.',
    hs: 0.00, power: 0.20, agit: 0, wind: 0.05, overcast: 0.00, rain: 0 },
  { key: 'breeze', label: 'Brise', sub: 'Petites vagues sous un ciel clair.',
    hs: 0.09, power: 0.25, agit: 1, wind: 0.25, overcast: 0.08, rain: 0 },
  { key: 'swell', label: 'Houle', sub: 'De vraies vagues, longues, qui deferlent et courent sur le sable.',
    hs: 0.18, power: 0.55, agit: 1, wind: 0.40, overcast: 0.30, rain: 0 },
  { key: 'gale', label: 'Grosse houle', sub: 'Ca tape. Ciel charge, premieres gouttes.',
    hs: 0.30, power: 0.70, agit: 2, wind: 0.65, overcast: 0.60, rain: 0.25 },
  { key: 'storm', label: 'Tempete', sub: 'Pluie, vent, embruns : la mer reprend tout.',
    hs: 0.55, power: 0.92, agit: 3, wind: 1.00, overcast: 0.92, rain: 1 },
];

export class Weather {
  /** @param {import('./Game.js').Game} game */
  constructor(game) {
    this.game = game;
    /** Mode courant, ou -1 quand une jauge a ete retouchee. */
    this.index = 2;
    this.wind = 0.25;
    this.overcast = 0;
    this.rain = 0;
    this._targetWind = 0.25;
    this._targetOvercast = 0;
    this._targetRain = 0;
    this._rainCarry = 0;
  }

  /** Applique un mode. La mer change tout de suite, le ciel en douceur. */
  apply(i) {
    i = clamp(i | 0, 0, WEATHER.length - 1);
    const w = WEATHER[i];
    this.index = i;
    const water = this.game.water;
    water.setWaveHeight(w.hs);
    water.setWavePower(w.power);
    water.setAgitation(w.agit);
    this._targetWind = w.wind;
    this._targetOvercast = w.overcast;
    this._targetRain = w.rain;
    return w;
  }

  /** Une jauge a ete retouchee a la main : plus aucun mode ne correspond. */
  markCustom() {
    this.index = -1;
  }

  update(dt) {
    const k = 1 - Math.exp(-dt / 3.0);
    this.wind += (this._targetWind - this.wind) * k;
    this.overcast += (this._targetOvercast - this.overcast) * k;
    this.rain += (this._targetRain - this.rain) * k;
    const g = this.game;
    if (g.moisture) g.moisture.wind = this.wind;
    if (g.sky) g.sky.overcast = this.overcast;

    // Pluie : des gouttes autour de ce que le joueur regarde, poussees par le
    // vent. Le budget de particules est partage avec les outils : on reste
    // sous 400 gouttes par seconde meme en tempete.
    if (this.rain > 0.02 && g.particles) {
      this._rainCarry += this.rain * 400 * dt;
      let n = Math.floor(this._rainCarry);
      this._rainCarry -= n;
      const t = g.controls?.target;
      const cx = t ? t.x : 0, cz = t ? t.z : 0;
      const R = 3.2;
      for (; n > 0; n--) {
        const x = clamp(cx + (Math.random() * 2 - 1) * R, ORIGIN_X, ORIGIN_X + WORLD_W);
        const z = clamp(cz + (Math.random() * 2 - 1) * R, ORIGIN_Z, ORIGIN_Z + WORLD_D);
        const y = (t ? t.y : 1.2) + 2.2 + Math.random() * 0.8;
        g.particles.spawn(3, x, y, z, this.wind * 1.4 + (Math.random() - 0.5) * 0.4,
          -3.2 - Math.random() * 0.8, (Math.random() - 0.5) * 0.4);
      }
    }
  }

  serialize() {
    return { index: this.index };
  }
}
