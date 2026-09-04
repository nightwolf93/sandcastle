/**
 * Courbes et amortisseurs.
 *
 * Tout est sans allocation et sans etat global. C'est volontairement une
 * bibliotheque de 60 lignes plutot qu'un `THREE.AnimationMixer` : nos outils
 * n'ont ni squelette ni clip preenregistre, et la moitie des parametres
 * (hauteur de tour, rayon de brosse, humidite) n'existent qu'au moment du
 * geste. Un mixer n'aurait rien a melanger.
 */

export const Ease = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => t * (2 - t),
  inCubic: (t) => t * t * t,
  outCubic: (t) => { const f = t - 1; return f * f * f + 1; },
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 + 4 * (t - 1) ** 3),
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  /** Depassement en fin de course : l'accompagnement (follow-through). */
  outBack: (t, s = 1.70158) => 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2,
  /** Recul puis depassement : c'est la courbe du RETOURNEMENT du seau. */
  inOutBack: (t, s = 1.70158) => {
    const c = s * 1.525;
    return t < 0.5
      ? ((2 * t) ** 2 * ((c + 1) * 2 * t - c)) / 2
      : ((2 * t - 2) ** 2 * ((c + 1) * (2 * t - 2) + c) + 2) / 2;
  },
  /** Rebond amorti : le retour apres un impact. */
  outElastic: (t) => ((t === 0 || t === 1) ? t
    : Math.pow(2, -9 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
};

/**
 * Interpolation INDEPENDANTE DU FRAMERATE.
 *
 * Le classique `a += (b - a) * 0.15` est un piege : a 144 fps l'outil colle au
 * curseur, a 30 fps il traine. La forme exponentielle donne le meme
 * comportement a toutes les cadences. `lambda` est un taux en s^-1 :
 * lambda = 12 -> ~92 % du chemin en 0,2 s.
 */
export function damp(a, b, lambda, dt) {
  return a + (b - a) * (1 - Math.exp(-lambda * dt));
}

/**
 * Ressort amorti a 3 composantes, integre en semi-implicite (Euler
 * symplectique) : stable, et il DEPASSE quand zeta < 1 — ce depassement EST
 * l'accompagnement du geste, donc l'illusion d'une main qui tient l'outil.
 *
 *   f    frequence propre en Hz (5,2 = mirette, 3,5 = seau vide, 2,1 = plein)
 *   zeta amortissement          (1 = critique, 0.78 = leger rebond)
 */
export class Spring3 {
  constructor(f = 3.5, zeta = 0.78) {
    this.x = { x: 0, y: 0, z: 0 };
    this.v = { x: 0, y: 0, z: 0 };
    this.f = f;
    this.zeta = zeta;
  }

  set(p) {
    this.x.x = p.x; this.x.y = p.y; this.x.z = p.z;
    this.v.x = 0; this.v.y = 0; this.v.z = 0;
  }

  step(target, dt) {
    const w = 2 * Math.PI * this.f;
    // Sous-pas : l'integration explicite diverge au-dela de w*h ~ 0.5.
    const n = Math.max(1, Math.min(8, Math.ceil((dt * w) / 0.45)));
    const h = dt / n;
    const k = w * w;
    const c = 2 * this.zeta * w;
    for (let i = 0; i < n; i++) {
      this.v.x += (k * (target.x - this.x.x) - c * this.v.x) * h;
      this.v.y += (k * (target.y - this.x.y) - c * this.v.y) * h;
      this.v.z += (k * (target.z - this.x.z) - c * this.v.z) * h;
      this.x.x += this.v.x * h;
      this.x.y += this.v.y * h;
      this.x.z += this.v.z * h;
    }
    return this.x;
  }
}
