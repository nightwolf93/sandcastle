/**
 * Rayons de soleil (light shafts).
 *
 * Méthode radiale classique : on part de la position du soleil à l'écran et on
 * étire les hautes lumières le long des rayons qui en partent. Pas de volume,
 * pas de ray-marching — sur une scène en plein soleil, l'illusion tient
 * entièrement au fait que le ciel autour du disque solaire est déjà beaucoup
 * plus lumineux que la maquette qui le masque.
 *
 * Deux précautions font toute la différence entre un effet crédible et une
 * bouillie laiteuse :
 *
 *  - ON NE FILTRE QUE CE QUI DÉPASSE UN SEUIL. Sans lui, tout le contenu de
 *    l'image se met à baver dans la direction du soleil.
 *  - LA PASSE TOURNE EN LUMIÈRE LINÉAIRE, avant le tone mapping. Le ciel y
 *    dépasse largement 1 alors que le sable plafonne bien en dessous : le
 *    contraste qui fait exister les rayons n'existe que là.
 *
 * L'intensité s'éteint d'elle-même quand le soleil sort du cadre ou passe
 * derrière la caméra.
 */

import * as THREE from 'three';

export const GodRaysShader = {
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    /** Position du soleil a l'ecran, en coordonnees 0..1. */
    uSunPos: { value: new THREE.Vector2(0.5, 0.5) },
    /** Intensite globale ; 0 desactive la passe. */
    uStrength: { value: 0.0 },
    /** Longueur des rayons, en fraction de la distance au soleil. */
    uDensity: { value: 0.62 },
    /** Attenuation le long du rayon. */
    uDecay: { value: 0.955 },
    /** Seuil au-dela duquel un pixel emet des rayons. */
    // Une surface diffuse, meme blanche et en plein soleil, plafonne vers 1,2.
    // Au-dessus de 1,9, il ne reste que le ciel pres du soleil et les eclats
    // speculaires sur l'eau : exactement ce qui doit produire des rayons.
    uThreshold: { value: 1.9 },
    /** Teinte des rayons. */
    uTint: { value: new THREE.Color(1.0, 0.94, 0.80) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform vec2 uSunPos;
    uniform float uStrength;
    uniform float uDensity;
    uniform float uDecay;
    uniform float uThreshold;
    uniform vec3 uTint;
    varying vec2 vUv;

    const int SAMPLES = 28;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec3 base = texture2D(tDiffuse, vUv).rgb;
      if (uStrength <= 0.001) { gl_FragColor = vec4(base, 1.0); return; }

      vec2 delta = (vUv - uSunPos) * (uDensity / float(SAMPLES));
      // Decalage aleatoire par pixel : sans lui, les 28 echantillons se voient
      // sous forme d'anneaux concentriques.
      vec2 coord = vUv - delta * hash12(vUv * uResolution);

      vec3 acc = vec3(0.0);
      float illum = 1.0;
      for (int i = 0; i < SAMPLES; i++) {
        coord -= delta;
        vec3 s = texture2D(tDiffuse, clamp(coord, 0.0, 1.0)).rgb;
        // Seules les hautes lumieres emettent.
        s = max(s - uThreshold, 0.0);
        acc += s * illum;
        illum *= uDecay;
      }
      acc /= float(SAMPLES);

      // Les rayons s'estompent loin du soleil.
      float fall = 1.0 - smoothstep(0.15, 1.05, length(vUv - uSunPos));
      gl_FragColor = vec4(base + acc * uTint * uStrength * fall * 3.4, 1.0);
    }
  `,
};

/**
 * Met a jour la position ecran du soleil et l'intensite de la passe.
 * @param {object} pass ShaderPass des rayons
 * @param {THREE.Vector3} sunDir direction du soleil (unitaire, vers le soleil)
 * @param {THREE.Camera} camera
 * @param {number} baseStrength intensite voulue quand le soleil est bien visible
 */
export function updateGodRays(pass, sunDir, camera, baseStrength = 0.55) {
  const u = pass.uniforms;
  const p = _tmp.copy(sunDir).multiplyScalar(300).add(camera.position);
  p.project(camera);

  const behind = p.z > 1;
  const sx = (p.x + 1) * 0.5;
  const sy = (p.y + 1) * 0.5;
  u.uSunPos.value.set(sx, sy);

  // Le soleil doit etre dans le cadre — avec une marge, sinon l'effet
  // s'allume et s'eteint brutalement quand on tourne la camera.
  const margin = 0.45;
  const inside =
    sx > -margin && sx < 1 + margin && sy > -margin && sy < 1 + margin;
  let s = behind || !inside ? 0 : baseStrength;
  if (s > 0) {
    // Fondu doux sur les bords du cadre.
    const fx = Math.min(1, Math.min(sx + margin, 1 + margin - sx) / margin);
    const fy = Math.min(1, Math.min(sy + margin, 1 + margin - sy) / margin);
    s *= Math.max(0, Math.min(fx, fy));
    // Et le soleil doit etre au-dessus de l'horizon.
    s *= Math.max(0, Math.min(1, sunDir.y * 4));
  }
  // Lissage temporel : une transition brutale se remarque enormement.
  u.uStrength.value += (s - u.uStrength.value) * 0.12;
}

const _tmp = new THREE.Vector3();
