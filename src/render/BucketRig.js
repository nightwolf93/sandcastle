/**
 * Le seau : geometrie, contenu visible, et la sequence de demoulage.
 *
 * C'est l'exemple donne par le joueur — « un vrai seau qu'on remplit, qu'on
 * retourne et qu'on demoule » — donc il est traite jusqu'au bout : sept temps,
 * 1,88 s (0,75 s si le joueur clique pour accelerer).
 *
 * Le rig ne DECIDE de rien. Il est pilote par `tools.js`, qui garde toute la
 * logique de jeu, et il rend la main par des callbacks. C'est la meme
 * separation que `Props.js`, qui ne connait que `field` et jamais le gameplay.
 *
 * L'astuce technique du fichier est au temps « settle » : c'est LA qu'on
 * appelle `stampBucket`, pendant que le seau pose cache integralement la tour.
 * Le remaillage asynchrone (60-150 ms pour deux ou trois chunks) a donc le
 * temps de finir avant la levee. Le joueur ne voit jamais un chunk apparaitre :
 * il voit un seau se lever sur une tour deja la.
 */

import * as THREE from 'three';
import {
  makeBucketGeometry, makeBucketSand, TOOL_MATERIALS, BUCKET_ASPECT,
} from './ToolGeometry.js';
import { Ease, damp } from './Ease.js';

/** Table des phases. Modifier ici change tout le rythme. */
const PHASES = [
  { id: 'anticipate', dur: 0.07 },
  { id: 'lift', dur: 0.22 },
  { id: 'flip', dur: 0.34 },
  { id: 'lower', dur: 0.18 },
  { id: 'tap', dur: 0.42 },
  { id: 'settle', dur: 0.15 },   // <- c'est ici qu'on stampe
  { id: 'reveal', dur: 0.55 },
  { id: 'result', dur: 0.30 },
  { id: 'ret', dur: 0.35 },
];

/** Garde d'air au-dessus du sol au moment du contact. */
const DROP = 0.06;

export class BucketRig {
  /**
   * @param {THREE.Group} group  le groupe de l'outil, porte par ToolAvatar
   * @param {{particles?:any, audio?:any, onStamp?:Function, onResult?:Function}} deps
   */
  constructor(group, deps) {
    this.deps = deps;
    this.group = group;

    const B = makeBucketGeometry();
    this.B = B;
    this.shell = new THREE.Mesh(B.shell, TOOL_MATERIALS.yellow());
    this.handle = new THREE.Mesh(B.handle, TOOL_MATERIALS.metal());
    const sand = makeBucketSand(16, 3);
    this.sandSet = sand.setLevel;
    this.sand = new THREE.Mesh(sand.geometry, TOOL_MATERIALS.sandWet());
    this.sand.visible = false;

    for (const m of [this.shell, this.handle, this.sand]) {
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
    }

    this.fill = 0;
    this.wobble = 1;
    this.phase = -1;          // -1 = au repos / en remplissage
    this.t = 0;
    this.speed = 1;           // x2.5 si le joueur clique pour accelerer
    this.outcome = null;      // 'clean' | 'slump' | 'stuck' | 'collapse'
    this.anchor = new THREE.Vector3();
    this.height = 0;          // hauteur de la tour a demouler (m)
    this.radius = 0.15;
    this.squash = 0;
    this.dripTimer = 0;
    this._moist = 0.12;
    this._flipped = false;
    this._stamped = false;
    this._taps = -1;
    /** Axe de retournement : horizontal, perpendiculaire a la vue. */
    this.flipAxis = new THREE.Vector3(1, 0, 0);
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
  }

  get busy() { return this.phase >= 0; }

  /** Nom de la phase en cours, ou null. Lisible depuis la console et les tests. */
  get phaseId() { return this.phase >= 0 ? PHASES[this.phase].id : null; }

  /** Hauteur totale du seau dans le monde. */
  get fullH() { return BUCKET_ASPECT * this.radius; }

  /** Met a jour le contenu visible pendant le remplissage. */
  setFill(fill, moisture) {
    this.fill = fill;
    if (moisture !== undefined) this._moist = moisture;
    this.sand.visible = fill > 0.004;
    if (this.sand.visible) this.sandSet(fill, this.wobble, this.B, this._flipped);
    // Sable sec = plus clair. C'est le premier avertissement d'echec, et il
    // arrive AVANT le demoulage : le joueur peut encore corriger.
    // NB : `setRGB` ecrit dans l'espace de TRAVAIL (lineaire) depuis three
    // r152. Sans le troisieme argument, un brun 0.61/0.52/0.38 ressort presque
    // blanc a l'ecran — le sable du seau cessait de se distinguer du sable de
    // la plage, qui est justement ce qu'il doit trancher.
    const dry = 1 - Math.min(1, this._moist / 0.16);
    this.sand.material.color.setRGB(
      0.52 + 0.28 * dry, 0.44 + 0.27 * dry, 0.31 + 0.26 * dry,
      THREE.SRGBColorSpace);
  }

  setRadius(r) { this.radius = r; }

  /**
   * Lance la sequence de demoulage.
   * @param {THREE.Vector3} at      point de pose au sol
   * @param {string} outcome        issue decidee par tools.js
   * @param {number} height         hauteur de la tour, en metres
   */
  demould(at, outcome, height) {
    this.anchor.copy(at);
    this.outcome = outcome;
    this.height = height;
    this.phase = 0;
    this.t = 0;
    this.speed = 1;
    this._stamped = false;
    this._taps = -1;
    this._flipped = false;
    this.wobble = 0.9;
  }

  /** Un clic pendant la sequence l'accelere. Jamais de blocage. */
  hurry() { if (this.busy) this.speed = 2.5; }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} restPos position de repos (suivi du curseur)
   * @returns {boolean} true si le rig pilote la transformation
   */
  update(dt, restPos) {
    this.squash = damp(this.squash, 0, 9, dt);

    // Un seau qui a porte du sable sature s'egoutte pendant qu'on le porte.
    // Deux lignes, un detail que personne ne demande et que tout le monde
    // remarque.
    if (this.fill > 0.05 && this._moist > 0.25 && this.deps.particles) {
      this.dripTimer -= dt;
      if (this.dripTimer <= 0) {
        this.dripTimer = 0.25 / Math.min(3, (this._moist - 0.2) * 12);
        const p = this.group.getWorldPosition(this._v);
        this.deps.particles.spawn(3,
          p.x + (Math.random() - 0.5) * this.radius * 1.6,
          p.y + this.radius * 0.1,
          p.z + (Math.random() - 0.5) * this.radius * 1.6,
          0, -0.2, 0);
      }
    }

    if (!this.busy) return false;

    // Le reste de temps est REPORTE d'une phase a l'autre : sinon, sur une
    // machine a 10 fps, chaque phase couterait au moins une frame entiere et
    // la sequence durerait le double. Chaque pose est tout de meme jouee au
    // moins une fois a u = 1, pour que ses effets de bord partent (le stamp,
    // les tapes, la poussiere).
    this.t += dt * this.speed;
    this._lastDt = dt * this.speed;
    let guard = 0;
    while (this.busy && guard++ <= PHASES.length) {
      const ph = PHASES[this.phase];
      const u = Math.min(1, this.t / ph.dur);
      this._pose(ph.id, u, restPos);
      if (this.t < ph.dur) break;
      this.t -= ph.dur;
      this.phase++;
      if (this.phase >= PHASES.length) { this.phase = -1; this._onEnd(); break; }
      this._onPhaseStart(PHASES[this.phase].id);
    }

    // Ecrasement a l'impact : c'est ici que va la secousse, PAS dans la
    // camera. 6 % au maximum sur un objet rigide.
    const s = 1 - 0.06 * this.squash;
    this.group.scale.set(
      this.radius / Math.sqrt(s), this.radius * s, this.radius / Math.sqrt(s));
    return true;
  }

  _pose(id, u, restPos) {
    // Un crochet par frame, avec le nom de la phase et son avancement : c'est
    // par la que `tools.js` fait vivre ce qui doit se derouler PENDANT la
    // sequence (l'affaissement d'une tour trop mouillee, par exemple). Le rig,
    // lui, ne decide toujours de rien.
    this.deps.onTick?.(id, u, this._lastDt);
    switch (id) {
      case 'anticipate': this._poseAnticipate(u, restPos); break;
      case 'lift': this._poseLift(u, restPos); break;
      case 'flip': this._poseFlip(u); break;
      case 'lower': this._poseLower(u); break;
      case 'tap': this._poseTap(u); break;
      case 'settle': this._poseSettle(u); break;
      case 'reveal': this._poseReveal(u); break;
      case 'result': this._poseResult(u); break;
      case 'ret': this._poseReturn(u, restPos); break;
      default: break;
    }
  }

  // --- poses ---------------------------------------------------------------

  /** Hauteur de levee avant retournement. */
  get _liftH() { return 0.16 + this.fullH * 0.4; }

  _poseAnticipate(u, rest) {
    // Descendre AVANT de monter : sans ca, la levee n'a aucun poids.
    this.group.position.copy(rest);
    this.group.position.y -= 0.015 * Ease.outQuad(u);
    this.group.quaternion.identity();
  }

  _poseLift(u, rest) {
    const e = Ease.outCubic(u);
    this._v.set(this.anchor.x, this.anchor.y + this._liftH, this.anchor.z);
    this.group.position.lerpVectors(rest, this._v, e);
    this.group.quaternion.identity();
  }

  _poseFlip(u) {
    // inOutBack : le seau depasse puis revient. C'est le geste « franc et
    // continu » de la Bible §2.4.1.
    const e = Ease.inOutBack(u, 0.9);
    const ang = Math.PI * e;
    this.group.quaternion.setFromAxisAngle(this.flipAxis, ang);
    // Le pivot est le milieu du seau — le centre de masse du contenu — et pas
    // l'origine du mesh : sinon le seau decrit un arc absurde.
    const H = this.fullH;
    this.group.position.set(
      this.anchor.x,
      this.anchor.y + H * 0.5 - H * 0.5 * Math.cos(ang)
        + this._liftH * (1 - e) + DROP * e,
      this.anchor.z);
    // Un seau mal tasse laisse tomber quelques grains a mi-rotation : c'est
    // l'annonce de l'echec, 0,9 s a l'avance.
    if ((this.outcome === 'stuck' || this.outcome === 'collapse')
        && u > 0.45 && u < 0.55 && !this._spilled) {
      this._spilled = true;
      this._spill(8);
    }
  }

  _poseLower(u) {
    const e = Ease.inQuad(u);
    const H = this.fullH;
    this.group.position.y = THREE.MathUtils.lerp(
      this.anchor.y + H + DROP, this.anchor.y + H, e);
  }

  _poseTap(u) {
    // Trois impulsions decroissantes : |sin(3 pi u)|.
    const n = 3;
    const s = Math.abs(Math.sin(Math.PI * n * u)) * (1 - u * 0.4);
    this.group.position.y = this.anchor.y + this.fullH - 0.006 * s;
    const tap = Math.floor(u * n);
    if (tap !== this._taps) {
      this._taps = tap;
      this.deps.audio?.play('bucketTap');
      this.deps.particles?.ring(0, this.anchor, this.radius * 1.05, 6, 0.25);
      // Le sable s'arase a chaque tape (Bible, etape 8).
      this.wobble = Math.max(0, this.wobble - 0.35);
      if (this.sand.visible) this.sandSet(this.fill, this.wobble, this.B, true);
    }
  }

  _poseSettle() {
    this.group.position.y = this.anchor.y + this.fullH;
    if (!this._stamped) {
      this._stamped = true;
      this.deps.onStamp?.(this.outcome);
    }
  }

  _poseReveal(u) {
    // « Lever bien droit, vertical, lentement mais sans arret. » Aucune
    // rotation ici : le moindre lacet trahirait la regle.
    const e = Ease.inOutSine(u);
    this.group.position.set(
      this.anchor.x,
      this.anchor.y + this.fullH + (this.height + 0.08) * e,
      this.anchor.z);
  }

  _poseResult(u) {
    if (!this._resulted) {
      this._resulted = true;
      const n = this.outcome === 'clean' ? 30 : 60;
      this.deps.particles?.ring(2, this.anchor, this.radius * 1.3, n, 0.6);
      if (this.outcome !== 'clean') {
        this.deps.particles?.ring(1, this.anchor, this.radius * 1.1, 12, 0.5);
      }
      this.deps.onResult?.(this.outcome);
    }
  }

  _poseReturn(u, rest) {
    const e = Ease.outCubic(u);
    this.group.position.lerp(rest, e);
    this._q.identity();
    this.group.quaternion.slerp(this._q, e);
  }

  _spill(n) {
    const p = this.group.getWorldPosition(this._v);
    this.deps.particles?.burst(1, p.x, p.y, p.z, n, { speed: 0.5, spread: 0.6 });
  }

  _onPhaseStart(id) {
    if (id === 'flip') {
      // Le sable est tasse, donc solidaire du seau — et il bascule contre la
      // bouche, comme dans la realite.
      this.wobble = 0.15;
      this._flipped = true;
      this._spilled = false;
      if (this.sand.visible) this.sandSet(this.fill, this.wobble, this.B, true);
    }
    if (id === 'lower') this._resulted = false;
    if (id === 'tap') {
      // Contact : couronne de poussiere, « toc » sourd, et l'outil s'ecrase.
      this.deps.audio?.play('bucketSet');
      this.deps.particles?.ring(2, this.anchor, this.radius * 1.15, 24, 0.5);
      this.squash = 1;
    }
    if (id === 'reveal' && this.outcome !== 'stuck') {
      // La tour est deja ecrite dans le champ de voxels : le contenu du seau
      // n'a plus rien a montrer. Le sable reste visible pour l'echec « stuck »,
      // ou il n'est justement pas sorti.
      this.sand.visible = false;
    }
  }

  _onEnd() {
    this._flipped = false;
    this.wobble = 1;
    this.speed = 1;
    if (this.outcome !== 'stuck') this.setFill(0, this._moist);
    else this.setFill(this.fill, this._moist);
  }
}
