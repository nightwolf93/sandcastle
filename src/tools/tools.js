/**
 * Catalogue des outils.
 *
 * Chaque outil est un GESTE, pas un bonus de statistiques. Il decrit :
 *   - ce qu'il fait physiquement au champ (densite / humidite / compaction) ;
 *   - ce que fait le bouton secondaire (toujours l'inverse ou le complement) ;
 *   - son icone et son retour visuel.
 *
 * Convention : `apply` est appele en continu tant que le bouton est maintenu,
 * a la cadence `rate`. `down` et `up` servent aux outils a deux temps (le seau,
 * qu'on remplit puis qu'on demoule).
 */

import * as B from './Brush.js';
import * as SC from './Sculpt.js';
import { moistureCategory, bucketDemouldState } from '../sim/SandPhysics.js';
import {
  clamp, VOXEL, ORIGIN_X, ORIGIN_Z,
} from '../core/Config.js';
import { BUCKET_ASPECT, BUCKET_TAPER } from '../render/ToolGeometry.js';

/** Boite de voxels englobant une tour demoulee, pour reveiller le granulaire. */
function towerBox(wx, wy, wz, r, h) {
  const vx = (wx - ORIGIN_X) / VOXEL;
  const vy = wy / VOXEL;
  const vz = (wz - ORIGIN_Z) / VOXEL;
  const R = Math.ceil((r * 1.6) / VOXEL);
  const H = Math.ceil((h + 0.1) / VOXEL);
  return [vx - R, vy - 1, vz - R, vx + R, vy + H, vz + R];
}

// --- icones (SVG en trait, style croquis) ------------------------------------
const ICONS = {
  shovel: 'M12 2.2 L12 12.5 M9.4 12.5 L14.6 12.5 M9.4 12.5 C9.4 18.5 8.4 21.4 12 21.8 C15.6 21.4 14.6 18.5 14.6 12.5 M10.4 2.2 L13.6 2.2',
  hand: 'M8 13.5 L8 6.6 A1.3 1.3 0 0 1 10.6 6.6 L10.6 11 M10.6 10.6 L10.6 5.2 A1.3 1.3 0 0 1 13.2 5.2 L13.2 11 M13.2 10.8 L13.2 6.2 A1.3 1.3 0 0 1 15.8 6.2 L15.8 12.6 M15.8 12 L15.8 9.6 A1.3 1.3 0 0 1 18.4 9.6 L18.4 15 C18.4 19.4 15.6 21.8 12.6 21.8 C9.4 21.8 8 19.6 6.6 17 L5 14.2 A1.3 1.3 0 0 1 7.2 12.8 L8 14.2',
  can: 'M4.6 10.2 L6.2 19.4 A1.6 1.6 0 0 0 7.8 20.7 L14.4 20.7 A1.6 1.6 0 0 0 16 19.4 L17.6 10.2 Z M4.2 10.2 L18 10.2 M17.2 12.4 L21 8.2 L21 4.4 M8 10.2 L8 7.6 A3.1 3.1 0 0 1 14.2 7.6 L14.2 10.2',
  bucket: 'M5 7.6 L7 19.8 A1.7 1.7 0 0 0 8.7 21.2 L15.3 21.2 A1.7 1.7 0 0 0 17 19.8 L19 7.6 Z M4.4 7.6 L19.6 7.6 M7.6 7.6 C9 4 15 4 16.4 7.6',
  trowel: 'M12 2.4 L18.4 11.2 L12 21.4 L5.6 11.2 Z M12 2.4 L12 21.4 M8.4 8.2 L15.6 8.2',
  carve: 'M17.8 3.4 A2 2 0 0 1 20.6 6.2 L9.6 17.2 L5.2 18.8 L6.8 14.4 Z M15.4 5.8 L18.2 8.6',
  rake: 'M4 6.6 L20 6.6 M6.2 6.6 L6.2 12.4 M9.4 6.6 L9.4 12.4 M12.6 6.6 L12.6 12.4 M15.8 6.6 L15.8 12.4 M19 6.6 L19 12.4 M12 6.6 L12 2.6 M4 17 L20 17 M4 20.4 L20 20.4',
  flag: 'M6.6 21.4 L6.6 2.6 M6.6 3.6 L17.6 6.6 L6.6 10.4',
  eraser: 'M8.4 20.6 L3.6 15.8 A1.7 1.7 0 0 1 3.6 13.4 L13 4 A1.7 1.7 0 0 1 15.4 4 L20.4 9 A1.7 1.7 0 0 1 20.4 11.4 L11.2 20.6 Z M8.6 8.4 L16 15.8 M4 20.6 L21 20.6',
  water: 'M12 2.8 C12 2.8 5.4 10.6 5.4 15 A6.6 6.6 0 0 0 18.6 15 C18.6 10.6 12 2.8 12 2.8 Z M9 15.4 A3 3 0 0 0 12 18.4',
  sand: 'M3 20.5 L3 11.5 L6.5 11.5 L6.5 8 L10 8 L10 11.5 L14 11.5 L14 8 L17.5 8 L17.5 11.5 L21 11.5 L21 20.5 Z M7 20.5 L7 16.5 A2 2 0 0 1 11 16.5 L11 20.5 M15 15 L19 15',
  // Seau penche qui verse : le corps, l'anse, puis trois grains qui tombent.
  sandpour: 'M4.5 8.5 L12.5 4 L17 12 L9 16.5 Z M6 7.5 A5 4.5 0 0 1 12 3.5 M17.5 14.5 L18 17.5 M15.2 16.5 L15.6 20 M19.8 12.5 L21 15.5',
  // L'atelier : porte cintree, marches, gouge, paille, reglet.
  opening: 'M6 21 L6 11 A6 6 0 0 1 18 11 L18 21 M3 21 L21 21',
  stairs: 'M3 21 L8 21 L8 16 L13 16 L13 11 L18 11 L18 6 L22 6',
  gouge: 'M12 3 L12 10 M8 10 L8 14 A4 4 0 0 0 16 14 L16 10 Z',
  straw: 'M4 19 L18 5 M7 21 L21 7',
  measure: 'M3 17 L17 3 L21 7 L7 21 Z M8 12 L10 14 M11 9 L13 11 M14 6 L16 8',
};

export function iconPath(id) { return ICONS[id] || ICONS.shovel; }

// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ToolState
 * @property {import('./Brush.js').EditContext} ctx
 * @property {{point:{x,y,z}, normal:{x,y,z}}} hit
 * @property {number} dt
 * @property {number} radius rayon courant en metres
 * @property {number} button 0 = principal, 2 = secondaire
 * @property {boolean} shift
 * @property {boolean} ctrl
 * @property {any} game
 * @property {any} tool
 */

export const TOOLS = [
  // -------------------------------------------------------------------------
  {
    id: 'shovel',
    name: 'Pelle',
    icon: 'shovel',
    key: 'Digit1',
    hint: 'Creuse. Plus tu descends, plus le sable est humide.',
    hint2: 'Clic droit : vider la pelletee ici.',
    radius: { min: 0.06, max: 0.55, def: 0.16 },
    rate: 14,
    cursor: '#7ec8ff',
    apply(s) {
      const g = s.game;
      const p = s.hit.point;
      if (s.button === 0) {
        // Creuser : on note l'humidite et la compaction de ce qu'on retire,
        // c'est ce qui rendra le tas rejete plus ou moins utile.
        const w = g.field.averageMoisture(p.x, p.y, p.z, s.radius * 0.8);
        const pk = g.field.averagePacking(p.x, p.y, p.z, s.radius * 0.8);
        const v = B.sphere(s.ctx, p.x, p.y, p.z, s.radius, -220 * s.dt * 26, { hardness: 0.3 });
        const removed = -v;
        if (removed > 0) {
          const tot = g.carried.volume + removed;
          g.carried.moisture = (g.carried.moisture * g.carried.volume + w * removed) / tot;
          g.carried.packing = (g.carried.packing * g.carried.volume + pk * removed) / tot;
          g.carried.volume = Math.min(tot, 0.35);
          g.audio?.play('dig', { volume: 0.5 + 0.5 * Math.min(1, removed * 300), moisture: w });
          // Les grains jaillissent vers le haut : c'est la matiere qui rend le
          // geste physique, pas l'outil.
          g.particles?.burst(w > 0.08 ? 1 : 0, p.x, p.y + 0.01, p.z,
            3 + Math.round(removed * 900), { speed: 1.4, spread: 0.7, dir: [0, 1, 0] });
        }
      } else {
        // Vider la pelletee : sable en vrac, jamais tasse.
        if (g.carried.volume <= 0.0002) return;
        const want = Math.min(g.carried.volume, 0.02 * s.dt * 26);
        const added = B.sphere(s.ctx, p.x, p.y + s.radius * 0.35, p.z, s.radius, 200 * s.dt * 26, {
          moisture: g.carried.moisture,
          packing: g.carried.packing * 0.35,
          hardness: 0.15,
        });
        g.carried.volume = Math.max(0, g.carried.volume - Math.max(added, want * 0.5));
        g.audio?.play('pour', { moisture: g.carried.moisture });
        // Un filet continu, pas une bouffee : on verse, on ne jette pas.
        g.particles?.stream(g.carried.moisture > 0.08 ? 1 : 0,
          p.x, p.y + s.radius * 0.5, p.z, 120, s.dt,
          { speed: 0.5, spread: 0.3, down: true });
      }
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'hand',
    name: 'Main',
    icon: 'hand',
    key: 'Digit2',
    hint: 'Lisse et arrondit : les marches deviennent des pentes naturelles.',
    hint2: 'Clic droit : tapoter pour tasser. Le sable dame tient deux fois plus haut.',
    radius: { min: 0.03, max: 0.6, def: 0.20 },
    rate: 12,
    cursor: '#ffca7a',
    /** Intensite du lissage, 0..1 : jauge du panneau, ou Ctrl+Maj+molette. */
    intensity: 0.5,
    apply(s) {
      const g = s.game;
      const p = s.hit.point;
      if (s.button === 0) {
        // Lisser : diffusion des hauteurs (le sable descend des cretes vers
        // les pieds) puis polissage des facettes de la grille. Le rayon fixe
        // l'etendue, l'intensite le nombre de pas de diffusion par passage.
        const I = clamp(s.tool.intensity ?? 0.5, 0, 1);
        B.smooth(s.ctx, p.x, p.y, p.z, s.radius, I);
        g.audio?.play('smooth', { volume: 0.35 + 0.5 * I });
        // Quelques grains qui roulent sous la paume : le lissage deplace du
        // sable, il n'en fait pas disparaitre.
        g.particles?.stream(0, p.x, p.y + 0.01, p.z, 25 + 90 * I, s.dt,
          { speed: 0.30, spread: 0.9, down: true });
      } else {
        // Tasser : le pound-up des sculpteurs, inchange.
        B.compact(s.ctx, p.x, p.y, p.z, s.radius, 0.9 * s.dt * 9);
        const w = g.field.averageMoisture(p.x, p.y, p.z, s.radius * 0.7);
        g.audio?.play('pat', { moisture: w });
        // On dame : pas de grains qui volent, de la POUSSIERE et un anneau.
        g.particles?.ring(2, p, s.radius * 0.8, 8, 0.35);
      }
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'can',
    name: 'Arrosoir',
    icon: 'can',
    key: 'Digit3',
    hint: 'Humidifie. Vise le sable "parfait" : quelques pourcents suffisent.',
    hint2: 'Clic droit : secher (soleil et vent).',
    radius: { min: 0.08, max: 0.6, def: 0.24 },
    rate: 20,
    cursor: '#63b8ff',
    apply(s) {
      const p = s.hit.point;
      if (s.button === 0) {
        s.game.moisture.wetSphere(p.x, p.y, p.z, s.radius, 0.55 * s.dt);
        s.game.audio?.play('sprinkle');
        // La pluie part de la POMME de l'arrosoir, pas du curseur : c'est ce
        // qui relie l'objet a son effet.
        const rose = s.game.toolAvatar?.tipWorld();
        if (rose) {
          s.game.particles?.stream(3, rose.x, rose.y, rose.z, 160, s.dt,
            { speed: 0.35, spread: 0.9, down: true });
        }
      } else {
        s.game.moisture.wetSphere(p.x, p.y, p.z, s.radius, -0.45 * s.dt);
      }
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'water',
    name: 'Seau d eau',
    icon: 'water',
    key: 'Digit4',
    hint: 'Verse un vrai volume d eau : flaques, douves, canaux.',
    hint2: 'Clic droit : eponger.',
    radius: { min: 0.08, max: 0.7, def: 0.22 },
    rate: 30,
    cursor: '#3aa0e8',
    apply(s) {
      const p = s.hit.point;
      // Debit : environ 4 litres par seconde, soit un seau de plage vide en
      // deux secondes. La premiere version debitait 66 L/s — de quoi noyer une
      // douve en un clic et rendre toute gestion de l eau impossible.
      if (s.button === 0) {
        s.game.water.pour(p.x, p.z, s.radius, 0.004 * s.dt);
        s.game.audio?.play('waterPour');
        s.game.particles?.stream(3, p.x, p.y + 0.25, p.z, 200, s.dt,
          { speed: 1.1, spread: 0.18, down: true });
        if (Math.random() < 0.35) s.game.particles?.ring(4, p, s.radius * 0.5, 4, 0.9);
      } else {
        // Eponger : on retire de l eau au lieu d en ajouter.
        s.game.water.pour(p.x, p.z, s.radius, -0.0035 * s.dt);
      }
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'sandpour',
    name: 'Seau de sable',
    icon: 'sandpour',
    key: 'KeyV',
    keyLabel: 'V',
    hint: 'Verse du sable en vrac : comble un trou, monte un tas.',
    hint2: 'Clic droit : reprend du sable.',
    radius: { min: 0.08, max: 0.45, def: 0.20 },
    rate: 26,
    cursor: '#f0b060',
    apply(s) {
      const g = s.game;
      const p = s.hit.point;
      if (s.button === 0) {
        // Un seau sans fond. La pelle deplace du sable, la gomme en fait
        // disparaitre ; celui-ci en CREE — c'est l'outil « generateur » de la
        // sandbox, et le seul moyen de reboucher un trou sans aller en
        // chercher le sable ailleurs. Il sort en vrac et plutot sec (le sable
        // d'un seau qu'on a laisse au soleil), a peine plus humide si le sol
        // qu'il touche l'est : la physique granulaire le fait couler en cone,
        // un tas verse ressemble a un tas verse. Le filet de grains part de
        // la levre du seau, c'est l'avatar qui l'emet.
        // Du sable de seau, humide comme au fond d'un trou : il tient en
        // cone sans couler pendant une minute. Verse sec et lache, une
        // grosse pile avalanchait pendant quarante secondes et la physique
        // granulaire saturait son budget a chaque image : le jeu ramait tant
        // que le joueur versait. Le sol tres mouille l'humidifie davantage.
        const wLoc = g.field.averageMoisture(p.x, p.y, p.z, s.radius);
        const moisture = Math.min(0.14, Math.max(0.09, wLoc * 0.8));
        // Debit. La sphere est enfoncee aux trois quarts sous le point vise :
        // seule une calotte de 0,3 rayon depasse de la surface, et c'est elle
        // qui se remplit, a 40/255 de densite par passage. La surface monte
        // d'environ 20 cm/s sous le curseur. Une sphere centree sur le point
        // vise, elle, suivait la surface qui montait et pre-remplissait tout
        // ce qui etait au-dessus : trois metres de sable en une seconde.
        const R = s.radius * 1.35;
        B.sphere(s.ctx, p.x, p.y - R * 0.75, p.z, R, 36 * s.dt * 26, {
          moisture,
          packing: 0.45,
          hardness: 0.15,
        });
        g.audio?.play('pour', { moisture });
      } else {
        // Reprendre : le seau se recharge, autrement dit on retire — par la
        // meme calotte, inversee : la sphere est au-dessus du point vise et
        // ne mord qu'une cuvette peu profonde a chaque passage.
        const R = s.radius * 1.35;
        const v = B.sphere(s.ctx, p.x, p.y + R * 0.75, p.z, R, -45 * s.dt * 26, { hardness: 0.3 });
        if (-v > 0) {
          g.audio?.play('dig', { volume: 0.4, moisture: 0.06 });
          g.particles?.burst(0, p.x, p.y + 0.01, p.z, 3 + Math.round(-v * 600),
            { speed: 1.0, spread: 0.7, dir: [0, 1, 0] });
        }
      }
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'bucket',
    name: 'Seau',
    icon: 'bucket',
    key: 'Digit5',
    hint: 'Maintiens pour remplir, relache pour demouler la tour.',
    hint2: 'Clic droit : vider le seau ici.',
    radius: { min: 0.08, max: 0.42, def: 0.15 },
    rate: 30,
    twoStage: true,
    cursor: '#ff9d6e',

    down(s) {
      const rig = s.game.toolAvatar?.bucket;
      // Un clic pendant la sequence l'ACCELERE (x2,5). Jamais de blocage :
      // c'est la regle d'or des cinematiques courtes.
      if (rig?.busy) { rig.hurry(); return; }
      if (s.button === 2) {
        // Vider le seau ici. C'est la sortie de secours de l'echec « trop
        // sec », ou le sable est reste dans le seau.
        if ((s.tool.fill ?? 0) > 0.02) {
          const p = s.hit.point;
          B.sphere(s.ctx, p.x, p.y + s.radius * 0.3, p.z, s.radius * 0.9,
            200 * s.tool.fill, {
              moisture: s.tool.fillMoist, packing: 0.1, hardness: 0.15,
            });
          s.game.audio?.play('pour', { moisture: s.tool.fillMoist });
          s.game.particles?.burst(s.tool.fillMoist > 0.08 ? 1 : 0,
            p.x, p.y + s.radius * 0.4, p.z, 18, { speed: 0.7, spread: 0.5, dir: [0, -1, 0] });
          s.tool.fill = 0;
          s.tool.stuck = false;
          rig?.setFill(0, 0.12);
        }
        return;
      }
      if (s.tool.stuck) {
        s.game.toast('Le seau est encore plein — clic droit pour le vider.');
        return;
      }
      s.tool.fill = 0;
      s.tool.fillMoist = 0;
      s.tool.fillPack = 0;
      rig?.setFill(0, 0.12);
    },

    apply(s) {
      if (s.button !== 0 || s.tool.stuck) return;
      const rig = s.game.toolAvatar?.bucket;
      if (rig?.busy) return;
      const p = s.hit.point;
      const t = s.tool;
      if (t.fill >= 1) return;

      // Remplissage : on prend vraiment le sable sous le curseur.
      const w = s.game.field.averageMoisture(p.x, p.y, p.z, s.radius);
      const pk = s.game.field.averagePacking(p.x, p.y, p.z, s.radius);
      const v = B.sphere(s.ctx, p.x, p.y, p.z, s.radius * 0.85, -180 * s.dt * 30,
        { hardness: 0.25 });
      const got = -v;

      // Capacite EXACTE du tronc de cone DESSINE a l'ecran :
      //   V = (pi h / 3)(R^2 + R r + r^2), avec r = 0.86 R et h = ASPECT * R
      //   -> V = 0.8665 * pi * R^2 * h
      // Si cette formule et la geometrie divergent, le seau se remplit « a
      // moitie » quand il est plein a l'ecran et toute l'illusion meurt.
      const R = s.radius;
      const K = (1 + BUCKET_TAPER + BUCKET_TAPER * BUCKET_TAPER) / 3;
      const capacity = K * Math.PI * R * R * (BUCKET_ASPECT * R);

      const before = t.fill;
      t.fill = clamp(t.fill + got / capacity, 0, 1);
      const added = t.fill - before;
      if (added > 0) {
        t.fillMoist = (t.fillMoist * before + w * added) / t.fill;
        t.fillPack = (t.fillPack * before + pk * added) / t.fill;
        // Un filet de sable coule du point de creusement vers la bouche : ca
        // explique visuellement d'ou vient le sable.
        s.game.particles?.stream(w > 0.08 ? 1 : 0, p.x, p.y + 0.02, p.z, 90, s.dt,
          { speed: 0.6, spread: 0.25, down: true });
      }
      rig?.setFill(t.fill, t.fillMoist);

      if (t.fill >= 1 && !t.fullNotified) {
        t.fullNotified = true;
        s.game.audio?.play('bucketFull');
        // Debordement par-dessus le bourrelet.
        s.game.particles?.ring(0, p, s.radius, 14, 0.35);
      }
    },

    up(s) {
      const t = s.tool;
      t.fullNotified = false;
      if (s.button !== 0 || t.stuck) return;
      const rig = s.game.toolAvatar?.bucket;
      if (rig?.busy) return;
      if ((t.fill ?? 0) < 0.08) { t.fill = 0; rig?.setFill(0, 0.12); return; }

      const p = { x: s.hit.point.x, y: s.hit.point.y, z: s.hit.point.z };
      const packing = clamp(t.fillPack + 0.25, 0, 1);
      const demould = bucketDemouldState(t.fillMoist, packing);
      const q = demould.q;
      const r = s.radius;
      const h = BUCKET_ASPECT * r * t.fill;

      // --- l'issue est decidee MAINTENANT ; la sequence ne fait que la jouer.
      //   'stuck'    sable trop sec : il n'a aucune cohesion, il ne tient pas
      //              la forme du moule et retombe DANS le seau. Le seau
      //              revient plein : le seau EST le message d'erreur.
      //   'collapse' sable trop mouille : la tour sort puis s'affaisse toute
      //              seule — on ne code aucun effondrement, la simulation
      //              granulaire fait le travail.
      // L'issue tient compte de l'EGOUTTAGE reel qui a lieu quand le seau est
      // retourne et tapote. Le sable humide/trempe pris pres de la nappe perd
      // son eau libre et doit donner une tour ; seule une vraie boue presque
      // liquide s'effondre encore.
      const outcome = demould.outcome;

      // Trace du dernier demoulage : c'est ce que lisent les tests, et c'est
      // aussi ce qu'on veut sous la main dans la console.
      s.game.lastDemould = {
        outcome, q, height: h, radius: r,
        moisture: t.fillMoist, packing, fill: t.fill,
        mouldMoisture: demould.moisture,
        drained: demould.drained,
        shapeQuality: demould.shapeQuality,
        at: { x: p.x, y: p.y, z: p.z },
        stamped: false,
      };

      // On ne dame pas de la soupe : au-dela de la saturation, le tapotage ne
      // cree plus de contacts entre grains, il chasse l'air et liquefie. La
      // tour sort donc quasiment SANS compaction, ce qui effondre sa hauteur
      // critique de Culmann.
      const moist = demould.moisture;
      const stampPack = outcome === 'collapse' ? packing * 0.25 : packing;
      const base = p.y - r * 0.15;

      const stamp = (qq) => B.stampBucket(s.ctx, p.x, base, p.z,
        r, r * BUCKET_TAPER, h, moist, stampPack, qq);

      if (!rig) {                  // secours : pas de rig -> comportement direct
        if (outcome !== 'stuck') stamp(demould.shapeQuality);
        t.fill = 0;
        return;
      }

      rig._moist = t.fillMoist;
      rig.demould({ x: p.x, y: p.y - r * 0.15, z: p.z }, outcome, h);

      /** Groupe d'annulation du demoulage, pour detecter un Ctrl+Z en plein
       *  affaissement : si le groupe n'est plus le groupe courant, la tour a
       *  ete annulee et l'affaissement ne doit plus rien ecrire. */
      let demouldGroup = null;

      // Le stamp arrive APRES que ToolManager.endStroke() ait ferme le groupe
      // d'annulation du remplissage : on en rouvre un propre. Resultat, Ctrl+Z
      // annule le demoulage sans annuler le creusement — ce que le joueur
      // attend.
      rig.deps.onStamp = () => {
        // C'est ICI que la tour est ecrite : le seau est encore pose dessus et
        // la cache integralement, donc le remaillage asynchrone a le temps de
        // finir avant la levee. Le joueur ne voit jamais un chunk apparaitre,
        // il voit un seau se lever sur une tour deja la.
        s.game.lastDemould.stampedAt = s.game.time;
        s.game.lastDemould.stampPhase = rig.phaseId;
        if (outcome === 'stuck') return;
        // Le groupe d'annulation reste OUVERT jusqu'a la fin de l'affaissement
        // ci-dessous : « demouler » est une seule action pour le joueur, il ne
        // doit pas avoir a faire Ctrl+Z quatre fois.
        s.game.tools.undo.beginGroup('Demoulage');
        demouldGroup = s.game.tools.undo.current;
        // Une tour trop mouillee sort quand meme FORMEE : c'est en la
        // regardant qu'on doit comprendre qu'elle s'affaisse. Si on la moulait
        // deja ecrasee, le joueur ne verrait jamais l'echec, seulement un
        // resultat mediocre.
        stamp(demould.shapeQuality);
        s.game.lastDemould.stamped = true;
        if (outcome !== 'collapse') s.game.tools.undo.endGroup();
      };

      // --- l'affaissement d'une tour trop mouillee --------------------------
      //
      // La recherche pariait sur `granular.wakeBox` seul : reveiller la
      // simulation devait suffire a ecrouler la tour. Mesure faite, c'est
      // FAUX aux dimensions d'un seau. Le critere de Culmann implemente dans
      // `SandPhysics` est une hauteur critique, pas un angle : un bloc de
      // 40 cm de large et 27 cm de haut est stable meme a 62 % de saturation,
      // et il l'est a juste titre — une galette de sable trempe ne s'ecroule
      // pas. Seules les tours de plus de ~60 cm coulent d'elles-memes.
      //
      // On joue donc l'affaissement en 0,65 s, PENDANT que le seau remonte et
      // repart : le sommet fond, la matiere s'etale au pied, puis on rend la
      // main au simulateur qui termine le talus. Le geste reste physique — on
      // deplace vraiment de la matiere — mais on ne compte plus sur une
      // instabilite qui n'existe pas.
      let slumped = 0;
      rig.deps.onTick = (id, u, tickDt) => {
        if (outcome !== 'collapse' || slumped >= 1) return;
        if (id !== 'result' && id !== 'ret') return;
        // Ctrl+Z pendant l'affaissement : la tour vient d'etre annulee (le
        // groupe « Demoulage » n'est plus le groupe courant). On arrete tout,
        // sinon la galette d'affaissement reapparaitrait sur un terrain deja
        // restaure — et le endGroup final fermerait un groupe etranger.
        if (s.game.tools.undo.current !== demouldGroup) {
          slumped = 1;
          // On rend la main a la simulation : s'il reste de la matiere (le
          // joueur a seulement commence un autre geste), elle finira le talus.
          s.game.granular.wakeBox(...towerBox(p.x, p.y, p.z, r * 2, h));
          return;
        }
        const step = Math.min((tickDt || 0.016) / 0.65, 1 - slumped);
        if (step <= 0) return;
        slumped += step;
        const top = base + h * (1 - 0.42 * slumped);
        // Le sommet fond...
        B.sphere(s.ctx, p.x, top, p.z, r * 0.95, -300 * step, { hardness: 0.25 });
        // ...et la matiere reapparait au pied, en galette qui s'elargit.
        B.sphere(s.ctx, p.x, base + h * 0.12, p.z, r * (1.05 + 0.55 * slumped),
          230 * step, { moisture: moist, packing: 0.04, hardness: 0.2 });
        if (slumped >= 0.999) {
          s.game.granular.wakeBox(...towerBox(p.x, p.y, p.z, r * 2, h));
          s.game.tools.undo.endGroup();
        }
      };

      rig.deps.onResult = (out) => {
        if (out === 'collapse') {
          s.game.audio?.play('collapse', { moisture: moist });
          s.game.particles?.ring(1, { x: p.x, y: base, z: p.z }, r * 1.2, 20, 0.7);
        }
        s.game.audio?.play(out === 'clean' ? 'demouldGood' : 'demouldBad',
          { moisture: t.fillMoist });
        // Un jeu cozy qui commente chacun de vos gestes est un jeu qui vous
        // surveille : on ne toaste plus la reussite, elle se voit et
        // s'entend.
        if (out === 'stuck') {
          t.stuck = true;
          s.game.toast('Trop sec — le sable est reste dans le seau. Clic droit pour le vider.');
        } else {
          t.fill = 0;
          t.stuck = false;
          if (out === 'collapse') s.game.toast('Trop mouille — la tour s affaisse');
          else if (out === 'slump') s.game.toast('Demoulage correct — tasse davantage');
        }
      };
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'trowel',
    name: 'Truelle',
    icon: 'trowel',
    key: 'Digit6',
    hint: 'Coupe des faces planes. Toujours du haut vers le bas.',
    hint2: 'Maj : coupe horizontale. Clic droit : replatrer.',
    radius: { min: 0.05, max: 0.45, def: 0.16 },
    rate: 18,
    cursor: '#c9a4ff',
    apply(s) {
      const p = s.hit.point;
      if (s.button === 2) {
        B.smooth(s.ctx, p.x, p.y, p.z, s.radius, clamp(3.2 * s.dt * 18, 0, 0.95));
        return;
      }
      let nx, ny, nz;
      if (s.shift) {
        // Coupe horizontale : araser un dessus.
        nx = 0; ny = 1; nz = 0;
      } else {
        // Coupe verticale face a la camera : c est le geste naturel.
        const d = s.game.camera.getWorldDirection(s.game._tmpVec);
        nx = -d.x; ny = 0; nz = -d.z;
        const l = Math.hypot(nx, nz) || 1;
        nx /= l; nz /= l;
        // Application miroir : la coupe est symetrique de l'originale.
        if (s.mirrored) { const m = SC.mirrorVector({ x: nx, y: 0, z: nz }, s.mirrorAxis); nx = m.x; nz = m.z; }
      }
      B.planeCut(s.ctx, p.x, p.y, p.z, nx, ny, nz, s.radius, s.radius * 1.4,
        clamp(4.5 * s.dt * 18, 0, 1));
      // Quelques grains seulement : c'est un outil fin, pas une pelle.
      s.game.particles?.burst(0, p.x, p.y, p.z, 2, { speed: 0.6, spread: 0.5 });
      s.game.audio?.play('cut', {
        moisture: s.game.field.averageMoisture(p.x, p.y, p.z, s.radius * 0.6),
      });
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'carve',
    name: 'Mirette',
    icon: 'carve',
    key: 'Digit7',
    hint: 'Creuse portes, fenetres et arcs. Bord net.',
    hint2: 'Clic droit : reboucher.',
    radius: { min: 0.02, max: 0.2, def: 0.055 },
    rate: 24,
    cursor: '#ff8fb0',
    apply(s) {
      const p = s.hit.point;
      const sign = s.button === 0 ? -1 : 1;
      B.sphere(s.ctx, p.x, p.y, p.z, s.radius, sign * 255 * clamp(s.dt * 24 * 6, 0, 1), {
        hardness: 0.85,
        moisture: s.button === 0 ? undefined :
          s.game.field.averageMoisture(p.x, p.y, p.z, s.radius * 2),
        packing: s.button === 0 ? undefined : 0.6,
      });
      s.game.particles?.burst(0, p.x, p.y, p.z, 2, { speed: 0.6, spread: 0.5 });
      s.game.audio?.play('carve');
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'rake',
    name: 'Rateau',
    icon: 'rake',
    key: 'Digit8',
    hint: 'Grave des rainures : appareil de briques, tuiles, stries.',
    hint2: 'Molette : ecartement. Clic droit : effacer les rainures.',
    radius: { min: 0.05, max: 0.4, def: 0.14 },
    rate: 16,
    cursor: '#a8d68a',
    spacing: 0.05,
    apply(s) {
      const p = s.hit.point;
      const n = s.hit.normal;
      if (s.button === 2) {
        B.smooth(s.ctx, p.x, p.y, p.z, s.radius, clamp(2.5 * s.dt * 16, 0, 0.85));
        return;
      }
      B.rake(s.ctx, p.x, p.y, p.z, n.x, n.y, n.z, s.radius,
        s.tool.spacing, 0.02 + s.tool.spacing * 0.25);
      // Une petite gerbe le long du trait.
      s.game.particles?.burst(0, p.x, p.y, p.z, 4, { speed: 0.8, spread: 0.9 });
      s.game.audio?.play('rake');
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'decor',
    name: 'Decoration',
    icon: 'flag',
    key: 'Digit9',
    hint: 'Pose drapeaux, coquillages et oyats.',
    hint2: 'Clic droit : retirer. Molette : changer d objet.',
    radius: { min: 0.03, max: 0.12, def: 0.05 },
    rate: 6,
    cursor: '#ff7a6b',
    variant: 0,
    apply(s) {
      const p = s.hit.point;
      if (s.button === 0) {
        s.game.props?.place(s.tool.variant, p.x, p.y, p.z, s.hit.normal);
        s.game.audio?.play('place');
      } else {
        s.game.props?.removeNear(p.x, p.y, p.z, 0.18);
      }
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'eraser',
    name: 'Gomme',
    icon: 'eraser',
    key: 'Digit0',
    hint: 'Efface largement, sans rien garder.',
    hint2: 'Clic droit : combler avec du sable en vrac.',
    radius: { min: 0.1, max: 0.9, def: 0.32 },
    rate: 14,
    cursor: '#d8d2c6',
    apply(s) {
      const p = s.hit.point;
      const sign = s.button === 0 ? -1 : 1;
      B.sphere(s.ctx, p.x, p.y, p.z, s.radius, sign * 200 * clamp(s.dt * 14 * 5, 0, 1), {
        hardness: 0.2,
        moisture: sign > 0 ? s.game.field.averageMoisture(p.x, p.y, p.z, s.radius * 1.5) : undefined,
        packing: sign > 0 ? 0.2 : undefined,
      });
    },
  },

  // =========================================================================
  // L'ATELIER DU SCULPTEUR
  //
  // Des outils PRECIS, a parametres, avec un apercu avant le geste : ce que
  // demande un fan de chateau de sable qui veut faire une oeuvre et non un
  // tas. Chacun s'appuie sur une operation de Sculpt.js ecrite comme un champ
  // de distance, pour des aretes nettes sans marches.
  // =========================================================================
  {
    id: 'opening',
    name: 'Ouverture',
    icon: 'opening',
    key: 'KeyF',
    keyLabel: 'F',
    hint: 'Perce une porte ou une fenetre cintree dans la paroi visee.',
    hint2: 'Panneau : forme, largeur, hauteur, profondeur. Vise un mur, pas un dessus.',
    radius: { min: 0.05, max: 0.5, def: 0.12 },
    rate: 8,
    cursor: '#ffb070',
    single: true,
    mode: 'door',
    profile: 'round',
    width: 0.16,
    height: 0.30,
    depth: 0.40,
    panel: {
      groups: [
        { key: 'mode', options: [{ id: 'door', label: 'Porte' }, { id: 'window', label: 'Fenetre' }] },
        { key: 'profile', options: [
          { id: 'round', label: 'Plein cintre' }, { id: 'pointed', label: 'Ogive' },
          { id: 'flat', label: 'Surbaisse' }, { id: 'rect', label: 'Droit' },
        ] },
      ],
      ranges: [
        { key: 'width', label: 'Largeur', min: 0.04, max: 0.60, step: 0.01, format: 'cm' },
        { key: 'height', label: 'Hauteur', min: 0.06, max: 0.90, step: 0.01, format: 'cm' },
        { key: 'depth', label: 'Profondeur', min: 0.06, max: 1.50, step: 0.02, format: 'cm' },
      ],
      tip: 'Le contour s affiche sur le mur avant le clic. L ogive veut une hauteur d au moins 1,75 fois la largeur.',
    },
    /** Repere de l'ouverture au point vise : seuil, direction vers l'interieur du mur. */
    frame(s) {
      const hit = s.hit;
      if (!hit) return null;
      const n = hit.normal || { x: 0, y: 1, z: 0 };
      const hl = Math.hypot(n.x, n.z), nl = Math.hypot(n.x, n.y, n.z) || 1;
      // Un dessus (ou un dessous) n'est pas une paroi.
      if (hl < 0.35 * nl) return null;
      const inX = -n.x / hl, inZ = -n.z / hl;
      const p = hit.point;
      let y;
      if (s.tool.mode === 'door') {
        // Le seuil est au sol DEVANT le mur, jamais plus haut que le point vise.
        y = Math.min(p.y, s.game.field.surfaceHeightAt(p.x - inX * 0.08, p.z - inZ * 0.08));
      } else {
        y = p.y - s.tool.height * 0.5;
      }
      return { x: p.x, y, z: p.z, inX, inZ };
    },
    preview(s) {
      const f = this.frame(s);
      if (!f) return null;
      const t = s.tool, hw = t.width * 0.5, H = t.height;
      const ux = -f.inZ, uz = f.inX;
      const ring = (d) => {
        const pts = [{ x: f.x - ux * hw + f.inX * d, y: f.y, z: f.z - uz * hw + f.inZ * d }];
        const N = 24;
        for (let k = 0; k <= N; k++) {
          const a = -hw + (2 * hw * k) / N;
          const top = SC.openingTop(t.profile, a, hw, H);
          pts.push({ x: f.x + ux * a + f.inX * d, y: f.y + top, z: f.z + uz * a + f.inZ * d });
        }
        pts.push({ x: f.x + ux * hw + f.inX * d, y: f.y, z: f.z + uz * hw + f.inZ * d });
        if (t.mode === 'window') pts.push(pts[0]);
        return pts;
      };
      const front = ring(0), back = ring(t.depth);
      const mid = front.length >> 1;
      return { lines: [front, back, [front[0], back[0]], [front[mid], back[mid]], [front[front.length - 1], back[back.length - 1]]], color: '#ffb070' };
    },
    apply(s) {
      if (s.button !== 0 || (s.stroke && s.stroke.applied > 0)) return;
      const f = this.frame(s);
      if (!f) { if (!s.mirrored) s.game.toast('Vise une paroi verticale'); return; }
      const t = s.tool;
      SC.carveOpening(s.ctx, f.x, f.y, f.z, f.inX, f.inZ, {
        width: t.width, height: t.height, depth: t.depth, profile: t.profile, sill: t.mode === 'window',
      });
      const p = s.hit.point;
      s.game.particles?.burst(0, p.x, p.y, p.z, 10, { speed: 0.8, spread: 0.8 });
      s.game.audio?.play('carve');
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'stairs',
    name: 'Escalier',
    icon: 'stairs',
    key: 'KeyT',
    keyLabel: 'T',
    hint: 'Tire du pied vers le haut de la pente : les marches se taillent au relachement.',
    hint2: 'Panneau : largeur et hauteur de marche. Echap annule le trace.',
    radius: { min: 0.08, max: 0.8, def: 0.24 },
    rate: 8,
    cursor: '#f0d070',
    single: true,
    width: 0.24,
    riser: 0.05,
    panel: {
      ranges: [
        { key: 'width', label: 'Largeur', min: 0.08, max: 0.80, step: 0.02, format: 'cm' },
        { key: 'riser', label: 'Marche', min: 0.03, max: 0.12, step: 0.005, format: 'cm' },
      ],
      tip: 'Chaque marche est moitie taillee, moitie remblayee en sable dame : elle tient.',
    },
    apply() {},
    up(s) {
      if (!s.stroke || s.button !== 0 || !s.hit) return;
      const A = s.stroke.startPoint, B = s.hit.point;
      if (Math.hypot(B.x - A.x, B.z - A.z) < 0.06) {
        if (!s.mirrored) s.game.toast('Tire du pied vers le haut de la pente');
        return;
      }
      const r = SC.carveStairs(s.ctx, A.x, A.y, A.z, B.x, B.y, B.z,
        { width: s.tool.width, riser: s.tool.riser, moisture: 0.12, packing: 0.9 });
      if (!s.mirrored) {
        s.game.audio?.play('cut');
        s.game.toast(`${r.steps} marche${r.steps > 1 ? 's' : ''}`);
      }
    },
    preview(s) {
      if (!s.stroke || !s.hit) return null;
      const A = s.stroke.startPoint, B = s.hit.point;
      const lines = SC.stairsOutline(A.x, A.y, A.z, B.x, B.y, B.z, { width: s.tool.width, riser: s.tool.riser });
      return lines.length ? { lines, color: '#f0d070' } : null;
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'gouge',
    name: 'Gouge',
    icon: 'gouge',
    key: 'KeyU',
    keyLabel: 'U',
    hint: 'Creuse une rainure nette le long du trait : tuiles, pierres, moulures.',
    hint2: 'Ctrl+molette : largeur. Panneau : profondeur, profil en U ou en V. Clic droit : effacer.',
    radius: { min: 0.015, max: 0.08, def: 0.03 },
    rate: 20,
    cursor: '#c0a0ff',
    depth: 0.03,
    profile: 'u',
    panel: {
      groups: [{ key: 'profile', options: [{ id: 'u', label: 'Gouge (U)' }, { id: 'v', label: 'Ciseau (V)' }] }],
      ranges: [{ key: 'depth', label: 'Profondeur', min: 0.005, max: 0.08, step: 0.0025, format: 'mm' }],
      tip: 'La largeur suit le rayon de la brosse (Ctrl + molette).',
    },
    apply(s) {
      const p = s.hit.point;
      if (s.button === 2) {
        B.smooth(s.ctx, p.x, p.y, p.z, Math.max(0.04, s.radius * 3), 0.35);
        return;
      }
      const from = s.stroke && s.stroke.applied > 0 ? s.stroke.lastPoint : p;
      SC.carveGroove(s.ctx, from.x, from.y, from.z, p.x, p.y, p.z,
        { width: s.radius * 2, depth: s.tool.depth, profile: s.tool.profile });
      s.game.particles?.burst(0, p.x, p.y, p.z, 2, { speed: 0.5, spread: 0.6 });
      s.game.audio?.play('carve');
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'straw',
    name: 'Paille',
    icon: 'straw',
    key: 'KeyX',
    keyLabel: 'X',
    hint: 'Souffle les grains detaches et les miettes, sans toucher a la forme.',
    hint2: 'Le geste de finition du sculpteur : nettoie les aretes apres la mirette.',
    radius: { min: 0.03, max: 0.25, def: 0.07 },
    rate: 20,
    cursor: '#e8e2d0',
    apply(s) {
      const p = s.hit.point;
      const n = SC.blowClean(s.ctx, p.x, p.y, p.z, s.radius, 0.9);
      if (n > 0 || Math.random() < 0.3) {
        s.game.particles?.burst(2, p.x, p.y + 0.01, p.z, 1 + Math.min(6, n), { speed: 0.5, spread: 1.0 });
      }
      s.game.audio?.play('smooth', { volume: 0.25 });
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'measure',
    name: 'Regle',
    icon: 'measure',
    key: 'KeyR',
    keyLabel: 'R',
    hint: 'Clique un point, puis un second : distance, denivele et pente s affichent.',
    hint2: 'Clic droit : effacer. La mesure suit le curseur entre les deux clics.',
    radius: { min: 0.02, max: 0.02, def: 0.02 },
    rate: 8,
    cursor: '#ffe680',
    single: true,
    mirrorable: false,
    a: null,
    b: null,
    readout: '',
    down(s) {
      if (s.button === 2) { this.a = null; this.b = null; this.readout = ''; return; }
      if (this.a && !this.b) this.b = { ...s.hit.point };
      else { this.a = { ...s.hit.point }; this.b = null; }
    },
    apply() {},
    up(s) {
      if (this.a && !this.b && s.hit) {
        const p = s.hit.point;
        if (Math.hypot(p.x - this.a.x, p.y - this.a.y, p.z - this.a.z) > 0.03) this.b = { ...p };
      }
    },
    preview(s) {
      if (!this.a) { this.readout = ''; return null; }
      const p = this.b || s.hit?.point;
      if (!p) return null;
      const a = this.a;
      const dx = p.x - a.x, dz = p.z - a.z, dh = p.y - a.y;
      const flat = Math.hypot(dx, dz);
      const dist = Math.hypot(flat, dh);
      const deg = flat > 1e-4 ? Math.atan2(Math.abs(dh), flat) * 180 / Math.PI : 90;
      this.readout = `${(dist * 100).toFixed(1)} cm | a plat ${(flat * 100).toFixed(1)} cm | denivele ${(dh * 100).toFixed(1)} cm | pente ${deg.toFixed(0)} deg`;
      const corner = { x: p.x, y: a.y, z: p.z };
      return { lines: [[a, p], [a, corner, p]], color: '#ffe680' };
    },
  },

  // -------------------------------------------------------------------------
  {
    id: 'sand',
    name: 'Construction sable',
    icon: 'sand',
    key: 'KeyB',
    keyLabel: 'B',
    hint: 'Pose un bloc, ou maintiens le clic pour tracer un mur courbe.',
    hint2: 'Regle dimensions, lissage et creneaux dans le panneau.',
    radius: { min: 0.05, max: 1.0, def: 0.25 },
    cursor: '#f2b45f',
    builder: true,
    mode: 'block',

    // Bloc rectangulaire.
    blockWidth: 0.55,
    blockLength: 0.75,
    height: 0.42,
    rotation: 0,

    // Mur extrude le long de la spline.
    wallWidth: 0.22,
    wallHeight: 0.48,
    smoothness: 0.58,
    crenels: true,
    crenelWidth: 0.16,
    crenelHeight: 0.14,

    // Tour de revolution, avec ou sans toit conique.
    towerRadius: 0.14,
    towerHeight: 0.45,
    towerTaper: 0.12,
    roof: true,
    roofHeight: 0.18,

    // Dome : une demi-ellipsoide.
    domeRadius: 0.20,
    domeHeight: 0.14,

    // Sable prepare : humide et tasse, afin que la forme generee soit
    // reellement constructible puis reste sculptable par les autres outils.
    buildMoisture: 0.12,
    buildPacking: 0.97,
  },
];

export const TOOL_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.id, t]));

/** Objets posables par l outil de decoration. */
export const DECOR_VARIANTS = [
  { id: 'flagRed', name: 'Drapeau rouge' },
  { id: 'flagBlue', name: 'Drapeau bleu' },
  { id: 'shell', name: 'Coquillage' },
  { id: 'starfish', name: 'Etoile de mer' },
  { id: 'grass', name: 'Touffe d oyat' },
  { id: 'pebble', name: 'Galet' },
];

export { moistureCategory };
