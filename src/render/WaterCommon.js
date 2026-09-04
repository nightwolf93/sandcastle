/**
 * Morceaux de GLSL partages par tout ce qui dessine de l'eau ou de l'ecume :
 * la surface, la jupe du diorama, les gouttes et le sable (laisse d'ecume).
 *
 * Une seule definition de la dentelle d'ecume garantit que l'ecume portee par
 * l'eau et celle deposee sur le sable se raccordent au pixel pres a la ligne
 * d'eau : c'est la meme fonction, evaluee sur la meme position monde.
 */

export const WATER_COMMON_GLSL = /* glsl */ `
float wc_hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float wc_vnoise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wc_hash12(i), wc_hash12(i + vec2(1, 0)), f.x),
             mix(wc_hash12(i + vec2(0, 1)), wc_hash12(i + vec2(1, 1)), f.x), f.y);
}

/**
 * Dentelle d'ecume.
 *
 * De loin, l'ecume de mer est une nappe blanche trouee ; de pres, un reseau
 * de bulles qui se dechire en flocons. Trois octaves de bruit donnent la
 * nappe, un seuil qui DESCEND avec la quantite d'ecume transforme quelques
 * flocons epars en tapis continu, et une derniere octave tres fine perce les
 * trous de bulles. lod (1 pres, 0 loin) eteint les octaves fines avant
 * qu'elles ne scintillent.
 *
 *   p    position monde XZ (m)
 *   t    temps (s)
 *   f    quantite d'ecume, 0..1.2
 */
float wc_foamLace(vec2 p, float t, float f, float lod) {
  float n1 = wc_vnoise2(p * 9.0 + vec2(t * 0.17, -t * 0.12));
  float n2 = wc_vnoise2(p * 21.0 - vec2(t * 0.30, t * 0.22));
  float n3 = wc_vnoise2(p * 55.0 + vec2(-t * 0.45, t * 0.55));
  float pattern = n1 * 0.50 + n2 * 0.32 + mix(0.5, n3, lod) * 0.18;
  float cover = clamp(f, 0.0, 1.0);
  float thr = 0.80 - cover * 0.56;
  float lace = smoothstep(thr, thr + 0.17, pattern);
  float holes = smoothstep(0.28, 0.56, wc_vnoise2(p * 140.0 + vec2(t * 0.8, 0.0)));
  lace *= mix(1.0, holes, 0.38 * cover * lod);
  return lace * smoothstep(0.015, 0.10, f);
}
`;
