/**
 * L'outil visible.
 *
 * On ne modelise ni main, ni bras, ni avatar : a la distance de travail du
 * diorama (15,5 m, FOV 32 deg), une main de 18 cm ferait 22 pixels de haut,
 * soit trois pixels par doigt. Une patate rose. Un seau de 15 cm, lui, fait
 * 18 pixels et se lit parfaitement, parce que sa silhouette trapezoidale
 * tranche sur le beige.
 *
 * L'outil FLOTTE donc — mais il ne flotte pas n'importe comment. Quatre regles
 * font qu'un outil flottant se lit comme TENU :
 *
 *   1. il n'est jamais aligne sur les axes (orientation derivee de l'azimut
 *      camera, plus une inclinaison de prise de ~15 deg) ;
 *   2. il n'est jamais parfaitement immobile (respiration de +-4 mm a 0,55 Hz,
 *      micro-lacet de +-0,02 rad a 0,31 Hz — deux periodes incommensurables,
 *      le motif ne se repete jamais) ;
 *   3. il traine derriere le curseur (ressort amorti, et il s'alourdit avec ce
 *      qu'il porte : 3,5 Hz a vide, 2,1 Hz plein) ;
 *   4. il anticipe et il accompagne (recul, frappe, depassement).
 *
 * Ce n'est pas la main qui rend l'objet tenu, c'est l'INERTIE.
 *
 * Ce fichier ne connait AUCUNE regle de jeu : il est pilote par tools.js et
 * ToolManager.js.
 */

import * as THREE from 'three';
import * as TG from './ToolGeometry.js';
import { Ease, Spring3, damp } from './Ease.js';
import { BucketRig } from './BucketRig.js';
import { PlantAnim, DropAnim } from './PlantAnim.js';
import * as Brush from '../tools/Brush.js';
import { VOXEL, ORIGIN_X, ORIGIN_Z } from '../core/Config.js';

const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const IDENTITY_Q = new THREE.Quaternion();
const smooth01 = (t) => { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

/**
 * Descripteur par outil.
 *
 *   tip     point de travail, en coordonnees LOCALES. Le rig place l'outil de
 *           facon que ce point coincide avec le point vise : ce qu'on VOIT
 *           toucher le sable est ce qui MODIFIE le sable. Des que l'outil
 *           visible et la brosse invisible divergent, tout l'effort est perdu.
 *   f       ressort de suivi [vide, plein] en Hz
 *   sizeK   part du rayon de brosse reportee sur la taille de l'outil
 *           (0 = taille fixe, 1 = proportionnel — les seaux seuls sont a 1)
 *   plant   'stab' (plante), 'lay' (pose), null (rien a poser)
 *   depth   enfoncement de la pointe, en metres
 *   slotR   demi-largeur de l'entaille reellement creusee dans le sable
 *   tilt    [inclinaison de base, jitter] du plantage
 *   layA    inclinaison finale quand on POSE : PI/2 pour un outil a manche
 *           qu'on couche, 0 pour un seau qu'on depose droit
 *   layY    hauteur de l'origine du mesh une fois pose, en unites locales
 */
const RIGS = {
  shovel: {
    tip: [0, -0.085, 0.05], f: [3.8, 2.8], zeta: 0.80, sizeK: 0.25,
    // 6 cm : assez pour que la lame morde vraiment, assez peu pour qu'il en
    // depasse un lisere rouge au ras du sable — c'est lui qui dit « pelle ».
    plant: 'stab', depth: 0.060, slotR: 0.035, tilt: [0.26, 0.14],
    layA: Math.PI * 0.5, layY: 0.016,
  },
  hand: {
    tip: [0, -0.008, 0], f: [4.2, 4.2], zeta: 0.85, sizeK: 0.35,
    plant: 'lay', depth: 0.006, slotR: 0, tilt: [0.00, 0.05],
    layA: 0, layY: 0.006,
  },
  can: {
    tip: [0, 0.192, 0.116], f: [3.0, 2.6], zeta: 0.86, sizeK: 0.20,
    plant: 'lay', depth: 0.010, slotR: 0, tilt: [0.00, 0.08],
    layA: 0, layY: 0,
  },
  water: {
    tip: [0, 0, 0], f: [3.2, 2.1], zeta: 0.88, sizeK: 1.00,
    plant: 'lay', depth: 0.008, slotR: 0, tilt: [0.00, 0.06],
    layA: 0, layY: 0,
  },
  bucket: {
    tip: [0, 0, 0], f: [3.5, 2.1], zeta: 0.88, sizeK: 1.00,
    plant: 'lay', depth: 0.008, slotR: 0, tilt: [0.00, 0.06],
    layA: 0, layY: 0,
  },
  // Seau de sable : pose au sol comme les autres seaux quand on ne verse
  // pas ; le versement (levee puis bascule) est pilote par `_updatePour`.
  sandpour: {
    tip: [0, 0, 0], f: [3.2, 2.1], zeta: 0.88, sizeK: 1.00,
    plant: 'lay', depth: 0.008, slotR: 0, tilt: [0.00, 0.06],
    layA: 0, layY: 0,
  },
  // L'atelier du sculpteur.
  opening: {
    tip: [0, 0, 0.12], f: [5.0, 5.0], zeta: 0.90, sizeK: 0.20,
    plant: 'stab', depth: 0.030, slotR: 0.012, tilt: [0.25, 0.10],
    layA: Math.PI * 0.5, layY: 0.012,
  },
  stairs: {
    tip: [0, 0, 0.045], f: [4.5, 4.5], zeta: 0.85, sizeK: 0.30,
    plant: 'lay', depth: 0.006, slotR: 0, tilt: [0.00, 0.05],
    layA: 0, layY: 0,
  },
  gouge: {
    tip: [0, -0.078, 0.024], f: [5.2, 5.2], zeta: 0.90, sizeK: 0.45,
    plant: 'stab', depth: 0.030, slotR: 0.012, tilt: [0.20, 0.14],
    layA: Math.PI * 0.5, layY: 0.010,
  },
  straw: {
    tip: [0, 0, 0.10], f: [5.5, 5.5], zeta: 0.90, sizeK: 0.10,
    plant: 'stab', depth: 0.020, slotR: 0.004, tilt: [0.55, 0.10],
    layA: Math.PI * 0.5, layY: 0.004,
  },
  measure: {
    tip: [0, 0, 0], f: [4.0, 4.0], zeta: 0.85, sizeK: 0.20,
    plant: 'lay', depth: 0.004, slotR: 0, tilt: [0.00, 0.03],
    layA: 0, layY: 0.003,
  },
  trowel: {
    tip: [0, 0, 0.09], f: [5.2, 5.2], zeta: 0.90, sizeK: 0.30,
    plant: 'stab', depth: 0.045, slotR: 0.020, tilt: [0.18, 0.12],
    layA: Math.PI * 0.5, layY: 0.012,
  },
  carve: {
    tip: [0, -0.078, 0.024], f: [5.2, 5.2], zeta: 0.90, sizeK: 0.45,
    plant: 'stab', depth: 0.030, slotR: 0.012, tilt: [0.20, 0.14],
    layA: Math.PI * 0.5, layY: 0.010,
  },
  rake: {
    tip: [0, -0.056, 0], f: [4.0, 4.0], zeta: 0.82, sizeK: 0.60,
    plant: 'stab', depth: 0.050, slotR: 0.045, tilt: [0.30, 0.16],
    layA: Math.PI * 0.5, layY: 0.018,
  },
  // Decoration et gomme : pas d'objet. La gomme est un outil « meta » sans
  // equivalent physique — l'anneau du shader seul dit « ceci est une
  // commande, pas un geste ».
  decor: null,
  eraser: null,
};

/** Cache de geometries : partagees entre l'outil tenu et les outils au sol. */
const GEO_CACHE = {};

/**
 * Pieces d'un outil : [geometrie, nom de materiau].
 * La coupure blanc/couleur est le code visuel du jouet de plage, et c'est
 * elle qui rend l'objet lisible a 18 px.
 */
function partsFor(id, spacing = 0.05) {
  const key = id === 'rake' ? `rake${spacing.toFixed(3)}` : id;
  if (GEO_CACHE[key]) return GEO_CACHE[key];
  let parts;
  switch (id) {
    case 'shovel': {
      const g = TG.makeShovelGeometry();
      parts = [[g.red, 'redThin'], [g.white, 'handle']];
      break;
    }
    case 'hand': {
      const g = TG.makeTamperGeometry();
      parts = [[g.white, 'handle'], [g.red, 'red']];
      break;
    }
    case 'trowel': {
      const g = TG.makeTrowelGeometry();
      parts = [[g.green, 'green'], [g.white, 'handle']];
      break;
    }
    case 'carve': {
      const g = TG.makeCarveGeometry();
      parts = [[g.metal, 'metal'], [g.red, 'red']];
      break;
    }
    case 'rake': {
      const g = TG.makeRakeGeometry(spacing);
      parts = [[g.red, 'red'], [g.white, 'handle']];
      break;
    }
    case 'can': {
      const g = TG.makeWateringCanGeometry();
      parts = [[g.body, 'blue'], [g.rest, 'metal']];
      break;
    }
    case 'bucket':
    case 'water': {
      const g = TG.makeBucketGeometry();
      parts = [[g.shell, id === 'water' ? 'blue' : 'yellow'], [g.handle, 'metal']];
      break;
    }
    case 'sandpour': {
      // Rouge : la troisieme couleur de seau. Bleu = eau, jaune = moule,
      // rouge = sable — la couleur dit la fonction, comme pour la pelle.
      const g = TG.makeBucketGeometry();
      GEO_CACHE.bucketDims = g;
      parts = [[g.shell, 'red'], [g.handle, 'metal']];
      break;
    }
    case 'opening': {
      const g = TG.makeKnifeGeometry();
      parts = [[g.metal, 'metal'], [g.handle, 'wood']];
      break;
    }
    case 'stairs': {
      const g = TG.makeStairsGaugeGeometry();
      parts = [[g.yellow, 'yellow'], [g.handle, 'handle']];
      break;
    }
    case 'gouge': {
      const g = TG.makeCarveGeometry();
      parts = [[g.metal, 'metal'], [g.red, 'green']];
      break;
    }
    case 'straw': {
      const g = TG.makeStrawGeometry();
      parts = [[g.white, 'handle'], [g.red, 'red']];
      break;
    }
    case 'measure': {
      const g = TG.makeRuleGeometry();
      parts = [[g.yellow, 'yellow'], [g.metal, 'metal']];
      break;
    }
    default: return null;
  }
  GEO_CACHE[key] = parts;
  return parts;
}

export class ToolAvatar {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.root = new THREE.Group();
    this.root.name = 'toolAvatar';
    game.scene.add(this.root);

    this.built = {};
    this.currentId = null;
    this.current = null;

    this.spring = new Spring3(3.5, 0.78);
    this._target = new THREE.Vector3();
    this._prev = new THREE.Vector3();
    this._vel = new THREE.Vector3();
    this._velS = new THREE.Vector3();
    this._axis = new THREE.Vector3();
    this._qLean = new THREE.Quaternion();
    this._qBob = new THREE.Quaternion();
    this._qBase = new THREE.Quaternion();
    this._qTilt = new THREE.Quaternion();
    this._tip = new THREE.Vector3();
    this._tipWorld = new THREE.Vector3();
    /** Seau de sable : levre en local, en monde, et lacet inverse. */
    this._lip = new THREE.Vector3();
    this._lipW = new THREE.Vector3();
    this._qInv = new THREE.Quaternion();
    /** Main en train de lisser : mouvement circulaire, pas de frappe. */
    this._polish = false;
    this._restPos = new THREE.Vector3();

    this.plantAnim = new PlantAnim();
    this.dropAnim = new DropAnim();
    this._pending = null;
    /** Ids d'outils actuellement poses au sol plutot que tenus. */
    this.stowed = new Set();

    this.strikeT = 1e9;
    this.squash = 0;
    this.time = 0;
    this._scale = 1;
    this._started = false;
  }

  // --- construction paresseuse ---------------------------------------------

  /**
   * On construit a la SELECTION et pas au premier clic : la premiere fois
   * qu'un mesh `castShadow` entre dans la scene, three.js peut recompiler la
   * shadow map. Le hoquet a donc lieu au changement d'outil, ou personne ne le
   * remarque.
   */
  _build(id) {
    if (this.built[id]) return this.built[id];
    const g = new THREE.Group();
    g.visible = false;
    g.name = 'tool-' + id;
    this.root.add(g);
    const entry = { group: g, meshes: [] };

    if (id === 'bucket' || id === 'water') {
      entry.bucket = new BucketRig(g, {
        particles: this.game.particles,
        audio: this.game.audio,
      });
      if (id === 'water') entry.bucket.shell.material = TG.TOOL_MATERIALS.blue();
      entry.meshes.push(entry.bucket.shell, entry.bucket.handle);
    } else {
      const parts = partsFor(id, this.game.tools?.current?.spacing ?? 0.05);
      if (parts) {
        for (const [geo, matName] of parts) {
          const m = new THREE.Mesh(geo, TG.TOOL_MATERIALS[matName]());
          m.castShadow = true;
          m.receiveShadow = true;
          g.add(m);
          entry.meshes.push(m);
        }
      }
      if (id === 'shovel') {
        // La pelletee : `carried.volume` existait deja sans aucune
        // representation. Un etat invisible ET absent de l'interface, c'est
        // un bug pour le joueur.
        const load = new THREE.Mesh(TG.makeShovelLoad(), TG.TOOL_MATERIALS.sandWet());
        // Au fond du creux de la lame, pas par-dessus.
        load.position.set(0, -0.074, 0.012);
        load.rotation.x = -0.22;
        load.castShadow = true;
        load.visible = false;
        g.add(load);
        entry.load = load;
        entry.meshes.push(load);
      }
      if (id === 'rake') entry.spacing = this.game.tools?.current?.spacing ?? 0.05;
      if (id === 'sandpour') {
        // Le seau est toujours a moitie plein : c'est un seau sans fond, la
        // jauge n'aurait rien a dire. Un sable clair, sec — c'est ce qu'il
        // verse.
        const sand = TG.makeBucketSand(16, 3);
        sand.setLevel(0.62, 1, GEO_CACHE.bucketDims, false);
        const m = new THREE.Mesh(sand.geometry, TG.TOOL_MATERIALS.sandWet());
        m.material.color.setRGB(0.78, 0.69, 0.55, THREE.SRGBColorSpace);
        m.castShadow = true;
        g.add(m);
        entry.sand = m;
        entry.meshes.push(m);
        entry.pour = 0;
      }
    }

    this.built[id] = entry;
    return entry;
  }

  select(id) {
    // Un geste de pose en cours doit aboutir : sinon l'outil s'evapore entre
    // la main et le sable.
    if (this._pending) {
      const anim = this.plantAnim.active ? this.plantAnim : this.dropAnim;
      // L'entaille (ou l'empreinte) doit exister meme si on coupe le geste
      // avant l'impact : l'outil finira pose, le sable doit etre marque.
      if (!anim._impacted) { anim._impacted = true; this._onPlantImpact(); }
      this._finishPlant(anim);
    }
    // Les animations mortes ne doivent plus piloter personne : sans ce
    // cancel, l'animation de plantage continuait d'animer le NOUVEL outil
    // vers l'ancienne ancre.
    this.plantAnim.cancel();
    this.dropAnim.cancel();
    if (this.current) {
      // Une sequence de demoulage commencee doit aboutir meme si le joueur
      // change d'outil : on la laisse se jouer en arriere-plan. Sinon elle
      // gele en l'air (seau invisible, tour jamais ecrite, seau bloque).
      if (this.current.bucket?.busy && this.built[id] !== this.current) {
        this._bg = this.current;
      } else {
        this.current.group.visible = false;
      }
    }
    this.currentId = id;
    this.current = RIGS[id] ? this._build(id) : null;
    if (this._bg === this.current) this._bg = null;
    // Selectionner un outil, c'est en reprendre un en main : le ou les
    // exemplaires deja plantes restent ou ils sont.
    this.stowed.delete(id);
    if (this.current) {
      this.current.group.visible = true;
      this._started = false;
    }
  }

  /** Le rig du seau courant, utilise par tools.js. */
  get bucket() { return this.current?.bucket ?? null; }

  /** Position monde du point de travail (pomme d'arrosoir, pointe de lame…). */
  tipWorld(out = this._tipWorld) { return out.copy(this._tipWorld); }

  /** L'outil courant est-il pose au sol plutot que tenu ? */
  get isStowed() { return this.stowed.has(this.currentId); }

  /**
   * Reconciliation apres un remplacement complet du monde (chargement d'une
   * sauvegarde, nouvelle plage) : un outil ne peut pas rester marque
   * « plante » si aucun exemplaire n'est au sol — sinon l'outil courant est
   * invisible en main, sans aucun moyen de comprendre pourquoi.
   * @param {Set<string>} idsOnGround ids des outils reellement au sol
   */
  syncStowed(idsOnGround) {
    for (const id of [...this.stowed]) {
      if (!idsOnGround.has(id)) this.stowed.delete(id);
    }
    const cur = this.stowed.has(this.currentId);
    if (this.current) this.current.group.visible = !cur;
    this.game.hud?.setToolStowed?.(cur);
  }

  /** Reprend l'outil en main (n'importe quel clic suffit : jamais d'impasse). */
  unstow() {
    if (!this.currentId || !this.stowed.has(this.currentId)) return;
    this.stowed.delete(this.currentId);
    if (this.current) this.current.group.visible = true;
    this.game.hud?.setToolStowed?.(false);
  }

  // --- boucle ---------------------------------------------------------------

  update(dt, tools) {
    this.time += dt;

    // --- seau en arriere-plan : la sequence continue apres un changement
    //     d'outil, et le seau reste visible jusqu'a sa fin.
    let bgActive = false;
    if (this._bg && this._bg !== this.current) {
      const b = this._bg.bucket;
      if (b?.busy) {
        this._bgRest = this._bgRest || new THREE.Vector3();
        // Le « repos » du retour est juste au-dessus de l'ancre : le seau
        // finit sa course sur place, puis disparait.
        this._bgRest.set(b.anchor.x, b.anchor.y + b.fullH + 0.05, b.anchor.z);
        b.update(dt, this._bgRest);
        this._bg.group.visible = true;
        bgActive = true;
      } else {
        this._bg.group.visible = false;
        this._bg = null;
      }
    }

    const def = RIGS[this.currentId];
    if (!this.current || !def || this.game.photoMode) {
      this.root.visible = bgActive && !this.game.photoMode;
      return;
    }
    // Pas de point vise (souris hors du canvas, ou rayon dans le ciel) : il
    // n'y a rien a tenir. Sans ce garde-fou, l'outil resterait plante a sa
    // derniere position — et au demarrage, a l'origine du monde, sous le
    // sable.
    const aiming = !!tools.hit || this.plantAnim.active || this.dropAnim.active
      || !!this.current.bucket?.busy;
    const stowedNow = this.stowed.has(this.currentId)
      && !this.plantAnim.active && !this.dropAnim.active;
    this.root.visible = (!stowedNow && aiming) || bgActive;
    this.current.group.visible = !stowedNow && aiming;
    if (stowedNow || !aiming) return;

    const g = this.current.group;
    const hit = tools.hit;
    const r = tools.radius;
    const rd = tools.current.radius.def;

    // 1. Echelle : proportionnelle au rayon pour les seaux, amortie ailleurs.
    const scale = def.sizeK >= 0.99
      ? r
      : THREE.MathUtils.clamp(1 + def.sizeK * (r / rd - 1), 0.75, 1.6);
    this._scale = scale;

    // 2. Charge portee : un outil s'alourdit avec ce qu'il porte. C'est le
    //    retour de poids le plus efficace du lot, et il coute une ligne.
    const load01 = this._load01(tools);
    this.spring.f = THREE.MathUtils.lerp(def.f[0], def.f[1], load01);
    this.spring.zeta = def.zeta ?? 0.80;

    // 3. Cible : le point vise, plus l'enfoncement du geste en cours.
    if (hit) {
      this._target.set(hit.point.x, hit.point.y, hit.point.z);
      // Main qui lisse : la paume tourne en petits cercles sur le sable, elle
      // ne tape pas. Le cercle suit le rayon de la brosse ; la cadence, 1,3 Hz,
      // est celle d'une main qui polit sans se presser.
      this._polish = this.currentId === 'hand' && tools.stroke?.button === 0;
      if (this._polish) {
        const ph = 2 * Math.PI * 1.3 * this.time;
        this._target.x += Math.cos(ph) * r * 0.30;
        this._target.z += Math.sin(ph) * r * 0.30;
      }
      // Le seau de sable ne s'enfonce pas en versant : il est en l'air.
      const press = tools.stroke && this.currentId !== 'sandpour' ? r * 0.18 : 0;
      this._target.y -= press;
      this._target.y += this.strikeOffset(this.strikeT, -1, r * 0.35);
      if (!this._started) { this.spring.set(this._target); this._started = true; }
    }
    const sp = this.spring.step(this._target, dt);
    this._restPos.set(sp.x, sp.y, sp.z);

    // 4. Inertie : l'outil s'incline vers l'ARRIERE du mouvement, parce qu'une
    //    main le tire. axis = v x up ; une rotation positive autour de cet axe
    //    couche l'outil dans le sens oppose au deplacement.
    this._vel.set(sp.x - this._prev.x, sp.y - this._prev.y, sp.z - this._prev.z)
      .divideScalar(Math.max(dt, 1e-4));
    this._prev.copy(this._restPos);
    this._velS.lerp(this._vel, 1 - Math.exp(-9 * dt));
    const lean = Math.min(this._velS.length() * 0.055, 0.38);
    if (lean > 1e-3) {
      this._axis.crossVectors(this._velS, UP);
      if (this._axis.lengthSq() > 1e-8) {
        this._axis.normalize();
        this._qLean.setFromAxisAngle(this._axis, lean);
      } else this._qLean.identity();
    } else this._qLean.identity();

    // 5. Orientation de base : « tenu depuis le haut-droite de la camera ».
    //    On prend l'azimut de la camera et on ajoute 0,45 rad : resultat,
    //    l'outil n'est JAMAIS aligne sur les axes du monde, ou que soit la
    //    camera. Un manche parfaitement vertical, c'est un objet pose par un
    //    moteur.
    const cam = this.game.camera;
    const az = Math.atan2(cam.position.x - sp.x, cam.position.z - sp.z);
    this._qBase.setFromAxisAngle(UP, az + 0.45);
    this._qTilt.setFromAxisAngle(X_AXIS, 0.26);
    this._qBase.multiply(this._qTilt);

    // 6. Respiration : deux sinusoides de periodes incommensurables.
    this._qBob.setFromAxisAngle(UP, 0.02 * Math.sin(2 * Math.PI * 0.31 * this.time + 1.7));

    // 7. Les animations du cycle de vie et la sequence du seau ont la
    //    priorite : elles pilotent alors position et orientation.
    let driven = false;
    if (this.plantAnim.active || this.dropAnim.active) {
      driven = this._updatePlant(dt, scale);
    } else if (this.current.bucket) {
      const b = this.current.bucket;
      b.setRadius(r);
      b.flipAxis.set(Math.cos(az), 0, -Math.sin(az));
      driven = b.update(dt, this._restPos);
    } else if (this.currentId === 'sandpour') {
      driven = this._updatePour(dt, scale, tools, az);
    }

    if (!driven) {
      g.quaternion.copy(this._qLean).multiply(this._qBase).multiply(this._qBob);
      this._placeByTip(g, def.tip, scale, this._restPos);
      g.position.y += 0.004 * Math.sin(2 * Math.PI * 0.55 * this.time);
      // 8. Ecrasement : squash & stretch a volume approximativement constant.
      //    6 % maximum — au-dela d'un plastique rigide on quitte le game feel
      //    pour le cartoon.
      this.squash = damp(this.squash, 0, 9, dt);
      const s = 1 - 0.06 * this.squash;
      g.scale.set(scale / Math.sqrt(s), scale * s, scale / Math.sqrt(s));
    } else {
      this.squash = damp(this.squash, 0, 9, dt);
    }

    // 9. Au-dela de 26 m, l'outil devient un pate de 8 px : on l'estompe et on
    //    laisse l'anneau du shader porter le curseur.
    const d = cam.position.distanceTo(g.position);
    const fade = THREE.MathUtils.clamp(1 - (d - 26) / 8, 0, 1);
    for (const m of this.current.meshes) {
      if (!m.material) continue;
      m.material.opacity = fade;
      m.material.transparent = fade < 0.995;
    }
    g.visible = fade > 0.02;

    this.strikeT += dt;
    this._syncState(tools);
  }

  /**
   * Seau de sable : le versement. Tant que le clic gauche est tenu, le seau
   * se souleve puis bascule vers la camera (meme axe que le retournement du
   * seau-moule, pour que la levre qui verse reste devant le corps) et un
   * filet de grains tombe de sa levre sur le point vise. Relache, il se
   * redresse plus lentement qu'il ne s'est penche : on arrete de verser, on
   * ne lache pas le seau.
   *
   * La pose est calculee depuis la LEVRE, pas depuis le fond : c'est la levre
   * qui doit rester au-dessus du point vise, quelle que soit l'inclinaison,
   * sinon le sable tombe a cote de ce que la brosse modifie. A u = 0 la
   * formule redonne exactement la pose par defaut (fond sur le sable), donc
   * il n'y a pas de saut au debut du geste.
   * @returns {boolean} true si la pose a ete pilotee ici
   */
  _updatePour(dt, scale, tools, az) {
    const e = this.current;
    const pouring = !!(tools.stroke && tools.stroke.button === 0 && tools.hit);
    e.pour = damp(e.pour ?? 0, pouring ? 1 : 0, pouring ? 9 : 5, dt);
    const u = e.pour;
    if (u < 0.005) return false;

    const g = e.group;
    const R = scale;                        // rayon monde du seau
    const H = TG.BUCKET_ASPECT * R;         // sa hauteur
    // Deux temps qui se chevauchent : on souleve d'abord, on penche ensuite.
    const lift = smooth01(u / 0.55);
    const tilt = smooth01((u - 0.12) / 0.88);
    const ang = Ease.outCubic(tilt) * 1.95;  // ~112 deg : le sable coule franchement

    // Orientation : inertie (qui s'efface en versant), bascule, lacet.
    this._axis.set(Math.cos(az), 0, -Math.sin(az));
    this._qTilt.setFromAxisAngle(this._axis, ang);
    this._qLean.slerp(IDENTITY_Q, tilt);
    this._qBase.setFromAxisAngle(UP, az + 0.45);
    g.quaternion.copy(this._qLean).multiply(this._qTilt).multiply(this._qBase);
    g.scale.set(scale, scale, scale);

    // Levre : le point du bord tourne vers la camera, en coordonnees locales
    // (le lacet ne touche pas l'axe vertical, on annule juste sa rotation sur
    // la direction horizontale).
    this._lip.set(Math.sin(az), 0, Math.cos(az)).multiplyScalar(R);
    this._qInv.copy(this._qBase).invert();
    this._lip.applyQuaternion(this._qInv);
    this._lip.y += H;
    this._lip.divideScalar(scale);           // en unites locales du groupe
    this._lipW.copy(this._lip).multiplyScalar(scale).applyQuaternion(g.quaternion);

    // Pose : de « fond sur le sable » a « levre a 10 cm + R/2 au-dessus ».
    const at = this._restPos;
    const dropH = 0.10 + 0.5 * R;
    g.position.set(
      at.x + (0 - this._lipW.x) * lift,
      at.y + (dropH - this._lipW.y) * lift,
      at.z + (0 - this._lipW.z) * lift
    );
    this._tipWorld.copy(at);

    // Le filet : des grains secs qui partent de la levre, un peu de poussiere
    // a l'arrivee. Le sable modifie par la brosse est deja la, les grains ne
    // sont que l'image du transfert.
    if (pouring && tilt > 0.55) {
      const P = this.game.particles;
      const lx = g.position.x + this._lipW.x;
      const ly = g.position.y + this._lipW.y;
      const lz = g.position.z + this._lipW.z;
      P?.stream(0, lx, ly - 0.005, lz, 90 + 220 * tilt, dt,
        { speed: 0.25, spread: 0.22, down: true });
      if (Math.random() < 0.30) {
        P?.burst(2, at.x, at.y + 0.015, at.z, 1, { speed: 0.35, spread: 1.0 });
      }
    }
    return true;
  }

  /** Place le groupe pour que son point de travail tombe sur `at`. */
  _placeByTip(g, tip, scale, at) {
    this._tip.fromArray(tip).multiplyScalar(scale).applyQuaternion(g.quaternion);
    g.position.set(at.x - this._tip.x, at.y - this._tip.y, at.z - this._tip.z);
    this._tipWorld.copy(at);
  }

  /** 0..1 : ce que l'outil porte, pour alourdir le ressort. */
  _load01(tools) {
    if (this.currentId === 'shovel') return Math.min(1, this.game.carried.volume / 0.35);
    if (this.currentId === 'sandpour') return 0.6;
    if (this.current.bucket) return Math.min(1, this.current.bucket.fill);
    return 0;
  }

  /**
   * Machine a trois temps : anticipation (recul), frappe, accompagnement
   * (depassement puis retour amorti). `amp` vaut `radius * 0.35` :
   * l'enfoncement est proportionnel a la « force » du geste, donc une grosse
   * pelle s'enfonce plus qu'une mirette, et ca se voit.
   */
  strikeOffset(t, dirY, amp) {
    const A = 0.08, H = 0.09, F = 0.22;
    if (t >= A + H + F) return 0;
    if (t < A) return -dirY * 0.25 * amp * Ease.outQuad(t / A);
    if (t < A + H) return dirY * amp * (Ease.inQuad((t - A) / H) * 1.25 - 0.25);
    return dirY * amp * (1 - Ease.outElastic((t - A - H) / F));
  }

  /**
   * Un coup d'outil. On n'enchaine pas plus vite que 70 % de la duree du coup :
   * au-dela, le geste devient un frottement continu — ce qui est exactement le
   * bon rendu pour un maintien.
   */
  strike() {
    // La paume qui lisse glisse, elle ne frappe pas.
    if (this._polish) return;
    if (this.strikeT < 0.7 * 0.39) return;
    this.strikeT = 0;
    this.squash = 1;
  }

  // --- cycle de vie : planter, poser, ramasser -----------------------------

  /**
   * Plante ou pose l'outil courant.
   * @param {'stab'|'lay'} mode
   * @param {{point:{x,y,z}}} hit  le point vise (ToolManager.hit)
   * @param {import('../tools/Brush.js').EditContext} ctx
   */
  plant(mode, hit, ctx) {
    const def = RIGS[this.currentId];
    if (!def || !def.plant) { this.game.toast('Cet outil ne se pose pas.'); return; }
    if (!hit) return;
    if (this.stowed.has(this.currentId)) return;
    if (this._pending || this.bucket?.busy) return;

    const kind = mode === 'lay' ? 'lay' : def.plant;
    const anchor = new THREE.Vector3(hit.point.x, hit.point.y, hit.point.z);
    const yaw = Math.atan2(
      this.game.camera.position.x - anchor.x,
      this.game.camera.position.z - anchor.z) + 0.45;
    const [tilt0, tiltJit] = def.tilt;
    // On ne plante pas a la verticale : 15 a 23 deg, l'angle naturel d'une
    // pelle qu'on enfonce d'un coup de poignet.
    const tilt = kind === 'lay' ? 0 : tilt0 + Math.random() * tiltJit;
    // « Legerement de travers » : +-6,3 deg. Trois lignes, et c'est la
    // difference entre un outil PLANTE et un outil INSTANCIE. Un objet
    // parfaitement d'aplomb dit « un moteur m'a place ici ».
    const side = (Math.random() - 0.5) * 0.22;

    // On memorise l'IDENTITE de l'outil : si le joueur change d'outil pendant
    // le geste, c'est bien la pelle qui doit finir plantee, pas le seau qu'il
    // vient de prendre en main.
    this._pending = {
      id: this.currentId, kind, anchor, yaw, tilt, side, def, ctx,
      scale: this._scale,
    };
    if (kind === 'lay') {
      this.dropAnim.start(this._tipWorld, anchor, yaw, side, def.layA ?? 0);
    } else {
      this.plantAnim.start(this._tipWorld, anchor, def.depth, tilt, yaw, side);
    }
    return true;
  }

  _updatePlant(dt, scale) {
    const anim = this.plantAnim.active ? this.plantAnim : this.dropAnim;
    const P = this._pending;
    const g = this.current.group;
    const alive = anim.update(dt, () => this._onPlantImpact());
    g.quaternion.copy(anim.quat);
    if (P && P.kind === 'lay') {
      // Un objet qu'on pose n'a pas de pointe a faire coincider : c'est son
      // origine qui vient au sol, remontee de `layY` pour qu'il repose dessus
      // au lieu d'y etre enfonce.
      g.position.set(anim.tip.x, anim.tip.y + (P.def.layY ?? 0) * scale, anim.tip.z);
      this._tipWorld.copy(anim.tip);
    } else {
      this._placeByTip(g, RIGS[this.currentId].tip, scale, anim.tip);
    }
    g.scale.setScalar(scale);
    if (!alive) this._finishPlant(anim);
    return true;
  }

  /** Appele a la frame exacte de l'enfoncement. */
  _onPlantImpact() {
    const P = this._pending;
    if (!P) return;
    const def = P.def;
    const A = P.anchor;

    if (def.slotR > 0 && P.ctx) {
      // LE SABLE EST REELLEMENT ENTAILLE. Sans ca, on voit la lame traverser
      // une surface intacte et toute la credibilite s'effondre. L'entaille est
      // dans son PROPRE groupe d'annulation : sans lui, Ctrl+Z apres un
      // plantage annulerait le coup de pelle precedent.
      this.game.tools?.undo?.beginGroup('Planter');
      const dx = Math.sin(P.yaw) * Math.sin(P.tilt);
      const dz = Math.cos(P.yaw) * Math.sin(P.tilt);
      Brush.slot(P.ctx, A.x, A.y, A.z, dx, -Math.cos(P.tilt), dz,
        def.depth * 1.15, def.slotR);
      this.game.tools?.undo?.endGroup();
      // Le sable retombe autour du manche : c'est la simulation qui le fait.
      const vx = (A.x - ORIGIN_X) / VOXEL;
      const vy = A.y / VOXEL;
      const vz = (A.z - ORIGIN_Z) / VOXEL;
      const R = Math.ceil((def.slotR * 4) / VOXEL);
      this.game.granular?.wakeBox(vx - R, vy - 4, vz - R, vx + R, vy + 2, vz + R);
    } else if (P.ctx) {
      // Objet pose a plat : il TASSE le sable sous lui. L'empreinte devient
      // visible par le canal de compaction, que le shader du sable assombrit
      // deja. Trois lignes, et l'objet cesse de leviter.
      this.game.tools?.undo?.beginGroup('Poser');
      Brush.compact(P.ctx, A.x, A.y, A.z, 0.09, 0.18);
      this.game.tools?.undo?.endGroup();
    }

    this.game.particles?.burst(1, A.x, A.y, A.z, 10, { speed: 1.1, spread: 0.9 });
    this.game.particles?.ring(2, A, def.slotR * 3 + 0.03, 8, 0.35);
    this.game.audio?.play(def.slotR > 0 ? 'pat' : 'place');
  }

  /** Fin de l'animation : l'outil passe de la main au monde. */
  _finishPlant(anim) {
    const P = this._pending;
    this._pending = null;
    if (!P) return;
    const state = { depth: P.kind === 'lay' ? 0.004 : P.def.depth };
    if (P.id === 'bucket' || P.id === 'water') {
      state.fill = this.built[P.id]?.bucket?.fill ?? 0;
      state.moisture = this.built[P.id]?.bucket?._moist ?? 0.12;
    }
    if (P.id === 'rake') state.spacing = this.built.rake?.spacing;
    const q = anim.restQuaternion();
    // On pose l'origine du mesh la ou la pointe doit etre : `DroppedTools`
    // gere ensuite le suivi de terrain a partir de cette origine.
    const pos = new THREE.Vector3().copy(P.anchor);
    if (P.kind === 'lay') {
      pos.y += (P.def.layY ?? 0) * P.scale;
      state.depth = -(P.def.layY ?? 0) * P.scale;
    } else {
      pos.y -= P.def.depth;
      this._tip.fromArray(P.def.tip).multiplyScalar(P.scale).applyQuaternion(q);
      pos.sub(this._tip);
    }
    this.game.droppedTools?.add(P.id, pos, q, P.scale, state);

    this.stowed.add(P.id);
    if (this.built[P.id]) this.built[P.id].group.visible = false;
    if (P.id === this.currentId) this.game.hud?.setToolStowed?.(true);
  }

  /** Ramassage : l'outil revient dans la main. */
  pickUp(item) {
    this.stowed.delete(item.id);
    if (this.currentId === item.id && this.current) {
      this.current.group.visible = true;
      this._started = false;
      if (this.bucket && item.state.fill) {
        this.bucket.setFill(item.state.fill, item.state.moisture ?? 0.12);
      }
    }
    this.game.droppedTools?.remove(item);
    this.game.audio?.play('place');
    this.game.hud?.setToolStowed?.(false);
  }

  /**
   * Fabrique un exemplaire d'outil pour `DroppedTools`. Les geometries sont
   * partagees (cache), les materiaux sont neufs — sinon la surbrillance de
   * survol allumerait tous les exemplaires a la fois.
   */
  makeDropped(id, state = {}) {
    const obj = new THREE.Group();
    if (id === 'bucket' || id === 'water') {
      const g = TG.makeBucketGeometry();
      const shell = new THREE.Mesh(g.shell,
        TG.TOOL_MATERIALS[id === 'water' ? 'blue' : 'yellow']());
      const handle = new THREE.Mesh(g.handle, TG.TOOL_MATERIALS.metal());
      obj.add(shell, handle);
      if (state.fill > 0.02) {
        // Un seau plein pose garde son sable visible : l'objet EST la jauge.
        const sand = TG.makeBucketSand(16, 3);
        sand.setLevel(state.fill, 1, g, false);
        obj.add(new THREE.Mesh(sand.geometry, TG.TOOL_MATERIALS.sandWet()));
      }
      return obj;
    }
    const parts = partsFor(id, state.spacing ?? 0.05);
    if (!parts) return null;
    for (const [geo, matName] of parts) {
      obj.add(new THREE.Mesh(geo, TG.TOOL_MATERIALS[matName]()));
    }
    return obj;
  }

  // --- etat visible de l'outil (les jauges diegetiques) --------------------

  _syncState(tools) {
    const g = this.game;
    if (this.currentId === 'shovel' && this.current.load) {
      const v = Math.min(1, g.carried.volume / 0.35);
      this.current.load.visible = v > 0.02;
      this.current.load.scale.set(1, Math.max(0.15, v), Math.min(1, 0.4 + 0.6 * v));
      // Sable sec = plus clair, exactement comme dans le seau. `setRGB` ecrit
      // en espace LINEAIRE : sans le troisieme argument, le brun sort blanc.
      const dry = 1 - Math.min(1, g.carried.moisture / 0.16);
      this.current.load.material.color.setRGB(
        0.52 + 0.28 * dry, 0.44 + 0.27 * dry, 0.31 + 0.26 * dry,
        THREE.SRGBColorSpace);
    }
    if (this.currentId === 'rake' && this.current.spacing !== tools.current.spacing) {
      // L'ecartement a change : on regenere la tete. Le rateau qu'on voit a le
      // peigne qu'on va graver — une jauge diegetique gratuite.
      this.current.spacing = tools.current.spacing;
      const parts = partsFor('rake', this.current.spacing);
      if (parts) this.current.meshes[0].geometry = parts[0][0];
    }
  }

  dispose() {
    for (const id in this.built) {
      for (const m of this.built[id].meshes) m.material?.dispose?.();
    }
    this.game.scene.remove(this.root);
  }
}
