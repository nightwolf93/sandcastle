/**
 * Planter ou lacher un outil dans le sable.
 *
 * « Rendre realistes les outils, par exemple la pelle, quand on n'en a plus
 * besoin on la plante dans le sable. » — c'est la demande, et c'est l'idee la
 * plus economique du projet : aucune geometrie nouvelle, un mecanisme deja
 * ecrit (le suivi de terrain de `Props.update`), et un rapport tout different
 * du joueur a ses outils.
 *
 * Les deux animations produisent une POINTE (`tip`, la position monde du point
 * de travail) et un QUATERNION. C'est `ToolAvatar` qui en deduit la position
 * de l'origine du mesh. Consequence importante : la rotation pivote autour de
 * la pointe, donc le manche vibre AUTOUR DE LA LAME ENFONCEE — c'est ce detail
 * qui fait que l'outil a l'air plante et non pose.
 */

import * as THREE from 'three';
import { Ease } from './Ease.js';

const T_ANTICIPATE = 0.10;
const T_STRIKE = 0.13;
const T_SETTLE = 0.32;
export const PLANT_TOTAL = T_ANTICIPATE + T_STRIKE + T_SETTLE;   // 0,55 s

/** Oscillation du manche : 3,2 Hz, constante de temps 110 ms. */
const OSC_FREQ = 3.2;
const OSC_TAU = 0.11;
const OSC_AMP = 0.13;      // rad, ~7,5 deg au premier depassement

const UP = new THREE.Vector3(0, 1, 0);
/** L'oscillation se fait dans un plan legerement oblique : un vrai outil
 *  plante ne vibre jamais dans un plan parfaitement propre. */
const OSC_AXIS = new THREE.Vector3(1, 0, 0.28).normalize();
const X_AXIS = new THREE.Vector3(1, 0, 0);

export class PlantAnim {
  constructor() {
    this.t = -1;
    this.tip = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.anchor = new THREE.Vector3();
    this._from = new THREE.Vector3();
    this._q1 = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
  }

  get active() { return this.t >= 0 && this.t < PLANT_TOTAL; }

  /** Coupe l'animation net : elle ne pilote plus rien. */
  cancel() { this.t = -1; }

  /**
   * @param {THREE.Vector3} from     position de depart de la pointe
   * @param {THREE.Vector3} anchor   point du sol vise
   * @param {number} depth           enfoncement final de la pointe (m)
   * @param {number} tiltRad         inclinaison finale du manche
   * @param {number} yawRad          orientation horizontale
   * @param {number} sideRad         devers final — « legerement de travers »
   */
  start(from, anchor, depth, tiltRad, yawRad, sideRad) {
    this._from.copy(from);
    this.anchor.copy(anchor);
    this.depth = depth;
    this.tilt = tiltRad;
    this.yaw = yawRad;
    this.side = sideRad;
    this.t = 0;
    this._impacted = false;
  }

  /** Quaternion final, celui que garde l'outil pose au sol. */
  restQuaternion(out = new THREE.Quaternion()) {
    this._q1.setFromAxisAngle(UP, this.yaw);
    this._q2.setFromAxisAngle(OSC_AXIS, this.tilt + this.side);
    return out.copy(this._q1).multiply(this._q2);
  }

  /**
   * @param {number} dt
   * @param {Function} onImpact  appele UNE fois, a la frame de l'enfoncement
   * @returns {boolean} true tant que l'animation pilote l'outil
   */
  update(dt, onImpact) {
    if (this.t < 0) return false;
    this.t += dt;
    const t = this.t;
    const qYaw = this._q1.setFromAxisAngle(UP, this.yaw);

    if (t < T_ANTICIPATE) {
      // 1. ANTICIPATION : l'outil monte de 9 cm et bascule en arriere. Il
      //    prend son elan. Rien ne descend sans etre d'abord monte.
      const u = Ease.outQuad(t / T_ANTICIPATE);
      this.tip.lerpVectors(this._from, this.anchor, u * 0.35);
      this.tip.y = this._from.y + 0.09 * u;
      this._q2.setFromAxisAngle(X_AXIS, this.tilt - 0.35 * u);
      this.quat.copy(qYaw).multiply(this._q2);

    } else if (t < T_ANTICIPATE + T_STRIKE) {
      // 2. FRAPPE : descente acceleree, pointe en avant.
      const u = Ease.inCubic((t - T_ANTICIPATE) / T_STRIKE);
      this.tip.set(this.anchor.x,
        THREE.MathUtils.lerp(this.anchor.y + 0.09, this.anchor.y - this.depth, u),
        this.anchor.z);
      this._q2.setFromAxisAngle(X_AXIS, this.tilt - 0.35 * (1 - u) + 0.10 * u);
      this.quat.copy(qYaw).multiply(this._q2);

    } else {
      // 3. IMPACT (une seule fois), puis 4. OSCILLATION AMORTIE.
      if (!this._impacted) { this._impacted = true; onImpact?.(); }
      const s = t - T_ANTICIPATE - T_STRIKE;
      const env = Math.exp(-s / OSC_TAU);
      const osc = OSC_AMP * env * Math.cos(2 * Math.PI * OSC_FREQ * s);
      this.tip.set(this.anchor.x, this.anchor.y - this.depth, this.anchor.z);
      this._q2.setFromAxisAngle(OSC_AXIS, this.tilt + osc + this.side * (1 - env));
      this.quat.copy(qYaw).multiply(this._q2);
      if (t >= PLANT_TOTAL) { this.t = -1; return false; }
    }
    return true;
  }
}

// ---------------------------------------------------------------------------

const DROP_T = 0.45;

/**
 * Chute libre courte + rebond amorti + rotation qui se stabilise.
 *
 * On ne simule PAS une physique de corps rigide : une parabole plus deux
 * rebonds decroissants suffisent, et c'est trente lignes au lieu d'un moteur.
 */
export class DropAnim {
  constructor() {
    this.t = -1;
    this.tip = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.anchor = new THREE.Vector3();
    this._from = new THREE.Vector3();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
  }

  get active() { return this.t >= 0; }

  /** Coupe l'animation net : elle ne pilote plus rien. */
  cancel() { this.t = -1; }

  /**
   * @param {number} layA inclinaison finale : PI/2 pour un outil a manche
   *   qu'on couche sur le sable, 0 pour un seau qu'on depose droit. Le
   *   « pose » n'est pas un « couche » : un seau se pose debout.
   */
  start(from, anchor, yawRad, sideRad = 0, layA = Math.PI * 0.5) {
    this._from.copy(from);
    this.anchor.copy(anchor);
    this.yaw = yawRad;
    this.side = sideRad;
    this.layA = layA;
    this.t = 0;
    this._impacted = false;
    // L'outil part legerement vers l'avant, comme si on ouvrait la main
    // plutot que de le laisser tomber a la verticale.
    this.arc = 0.10 + Math.random() * 0.06;
    this.spin = (Math.random() - 0.5) * 2.2;
  }

  restQuaternion(out = new THREE.Quaternion()) {
    this._e.set(this.layA, this.yaw, this.side);
    return out.setFromEuler(this._e);
  }

  update(dt, onImpact) {
    if (this.t < 0) return false;
    this.t += dt;
    const u = Math.min(1, this.t / DROP_T);
    const y = THREE.MathUtils.lerp(this._from.y, this.anchor.y, Ease.inQuad(u))
      + this.arc * Math.sin(Math.PI * u);
    // Deux rebonds decroissants sur la fin.
    const b = u > 0.72
      ? Math.abs(Math.sin(((u - 0.72) / 0.28) * Math.PI * 2)) * 0.035 * ((1 - u) / 0.28)
      : 0;
    this.tip.set(
      THREE.MathUtils.lerp(this._from.x, this.anchor.x, Ease.outQuad(u)),
      y + b,
      THREE.MathUtils.lerp(this._from.z, this.anchor.z, Ease.outQuad(u)));

    if (!this._impacted && u > 0.72) { this._impacted = true; onImpact?.(); }

    // La rotation se fige avec le rebond : ce n'est pas un jouet qui roule.
    const spinDamp = Math.exp(-u * 4.5);
    this._e.set(
      this.layA * Math.min(1, u * 1.6),
      this.yaw + this.spin * u * spinDamp,
      this.side + this.spin * 0.4 * u * spinDamp);
    this.quat.setFromEuler(this._e);

    if (u >= 1) { this.t = -1; return false; }
    return true;
  }
}
