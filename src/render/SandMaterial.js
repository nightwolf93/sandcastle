/**
 * Materiau du sable.
 *
 * Base MeshStandardMaterial (on garde tout le PBR, les ombres, l'IBL) enrichi
 * par onBeforeCompile :
 *   - l'albedo est calcule par pixel a partir de l'humidite et de la
 *     compaction interpolees depuis les sommets ;
 *   - le sable mouille est assombri ET desature vers l'ocre : physiquement
 *     l'eau remplit les interstices, l'indice de refraction se rapproche de
 *     celui du quartz, la lumiere est piegee par reflexions internes ;
 *   - un bruit triplanaire donne le grain, les micro-dunes et les traces
 *     d'outil ;
 *   - un terme de scintillement ("sparkle") simule les facettes de quartz qui
 *     accrochent le soleil — c'est ce detail qui vend le sable.
 */

import * as THREE from 'three';
import { MAT_ROCK, MAT_SHELL, NX, NZ, VOXEL, WORLD_W, WORLD_D } from '../core/Config.js';
import { WATER_COMMON_GLSL } from './WaterCommon.js';

const COMMON_GLSL = /* glsl */ `
${WATER_COMMON_GLSL}
  float sc_hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
  }
  float sc_hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  vec3 sc_hash33(vec3 p) {
    p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
             dot(p, vec3(269.5, 183.3, 246.1)),
             dot(p, vec3(113.5, 271.9, 124.6)));
    return fract(sin(p) * 43758.5453123);
  }
  float sc_vnoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = sc_hash13(i + vec3(0.0, 0.0, 0.0));
    float n100 = sc_hash13(i + vec3(1.0, 0.0, 0.0));
    float n010 = sc_hash13(i + vec3(0.0, 1.0, 0.0));
    float n110 = sc_hash13(i + vec3(1.0, 1.0, 0.0));
    float n001 = sc_hash13(i + vec3(0.0, 0.0, 1.0));
    float n101 = sc_hash13(i + vec3(1.0, 0.0, 1.0));
    float n011 = sc_hash13(i + vec3(0.0, 1.0, 1.0));
    float n111 = sc_hash13(i + vec3(1.0, 1.0, 1.0));
    return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
               mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
  }
  /**
   * Taille, en metres, de l'empreinte du pixel courant sur la surface.
   * fwidth() donne exactement la variation de la coordonnee monde d'un pixel
   * au suivant : c'est la mesure dont on a besoin, et elle vaut aussi bien
   * pour une surface vue de face que de trois quarts.
   */
  float sc_pixelSize(vec3 wp) {
    return max(fwidth(wp.x), max(fwidth(wp.y), fwidth(wp.z)));
  }

  /**
   * Fondu d'un detail dont la cellule mesure cell metres.
   *
   * Un bruit echantillonne sous sa frequence de Nyquist ne rend pas du grain :
   * il rend un MOIRE, c'est-a-dire un motif regulier et coherent, bien plus
   * visible que le detail qu'il etait cense representer. Et un amortissement
   * partiel ne sauve rien, justement parce que ce qui reste est coherent. Il
   * faut eteindre completement, des que la cellule approche le pixel.
   */
  float sc_detail(float pix, float cell) {
    // Une variation d'ALBEDO reste lisible jusqu'a environ quatre pixels par
    // cellule, et ne devient franchement du bruit qu'en dessous de un et demi.
    return 1.0 - smoothstep(cell * 0.25, cell * 0.67, pix);
  }

  /**
   * Meme chose, mais pour un detail qui passe par la NORMALE ou le spéculaire.
   *
   * Ceux-la doivent s'eteindre bien plus tot. Une inclinaison de normale ne
   * change pas la couleur de quelques pourcents : elle deplace l'echantillon
   * d'environnement, qui peut sauter du ciel au sol. Le meme bruit y est donc
   * dix fois plus contraste, et il lui faut dix pixels par cellule, pas
   * quatre, pour rester du grain plutot que du scintillement.
   */
  float sc_detailN(float pix, float cell) {
    return 1.0 - smoothstep(cell * 0.10, cell * 0.25, pix);
  }

  float sc_fbm(vec3 p, int oct) {
    float a = 0.5, s = 0.0, n = 0.0;
    for (int i = 0; i < 5; i++) {
      if (i >= oct) break;
      s += a * sc_vnoise(p);
      n += a;
      p *= 2.03;
      a *= 0.5;
    }
    return s / n;
  }
`;

export function createSandMaterial(opts = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
    metalness: 0.0,
    flatShading: false,
    ...opts,
  });

  const uniforms = {
    uSunDirection: { value: new THREE.Vector3(0.4, 0.8, 0.35).normalize() },
    uSunColor: { value: new THREE.Color(1.0, 0.94, 0.82) },
    // Sable corallien tropical : presque blanc, a peine chaud. Les trois
    // teintes sont volontairement TRES proches — sur une plage des Caraibes le
    // sable est uniforme ; ce qui le fait vivre, c'est la lumiere, pas des
    // marbrures. Un ecart trop large donne du granit, pas du sable.
    // Sable corallien blanc. Les trois teintes se tiennent volontairement dans
    // un mouchoir de poche : ce qui doit donner la matiere, c'est le grain et
    // la rugosite, pas des ecarts de couleur.
    uDryColor: { value: new THREE.Color(0xeee6d5).convertSRGBToLinear() },
    uSandDark: { value: new THREE.Color(0xe4dbc9).convertSRGBToLinear() },
    uSandLight: { value: new THREE.Color(0xf7f2e6).convertSRGBToLinear() },
    uWetColor: { value: new THREE.Color(0x9a7550).convertSRGBToLinear() },
    uDeepColor: { value: new THREE.Color(0x6b5237).convertSRGBToLinear() },
    uRockColor: { value: new THREE.Color(0x9c8c7c).convertSRGBToLinear() },
    uShellColor: { value: new THREE.Color(0xf3e6d4).convertSRGBToLinear() },
    uTime: { value: 0 },
    uSparkle: { value: 1.0 },
    uGrainScale: { value: 1.0 },
    uAOStrength: { value: 0.85 },
    // Curseur de l'outil : anneau de previsualisation dessine dans le shader.
    uCursor: { value: new THREE.Vector4(0, -999, 0, 0) }, // xyz = position, w = rayon
    uCursorColor: { value: new THREE.Color(0x6ec6ff) },
    uCursorStrength: { value: 0.0 },
    // Emprise du domaine : (minX, minZ, demi-largeur X, demi-largeur Z)
    uDomain: { value: new THREE.Vector4(0, 0, WORLD_W * 0.5, WORLD_D * 0.5) },
    uWaterTable: { value: 0.95 },
    /** Champ d'eau : R = altitude de la surface libre, G = profondeur. */
    uField: { value: null },
    // Pendant la capture refractive, le shader de surface appliquera lui-meme
    // Beer-Lambert. Les caustiques restent ici, mais pas la teinte d'eau.
    uRefractionCapture: { value: 0.0 },
    uUnderColor: { value: new THREE.Color(0.055, 0.34, 0.40) },
    // Humidite ciblee par l'outil arrosoir : halo
    uWetPreview: { value: 0.0 },
  };

  mat.userData.uniforms = uniforms;
  mat.defines = { ...(mat.defines || {}), USE_UV: '' };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    mat.userData.shader = shader;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        attribute vec4 aData;
        varying vec4 vData;
        varying vec3 vWorldPos;
        varying vec3 vObjNormal;
        `
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>
        vData = aData;
        vObjNormal = normal;
        vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        `
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec4 vData;
        varying vec3 vWorldPos;
        varying vec3 vObjNormal;
        uniform vec3 uSunDirection;
        uniform vec3 uSunColor;
        uniform vec3 uDryColor;
        uniform vec3 uSandDark;
        uniform vec3 uSandLight;
        uniform vec3 uWetColor;
        uniform vec3 uDeepColor;
        uniform vec3 uRockColor;
        uniform vec3 uShellColor;
        uniform float uTime;
        uniform float uSparkle;
        uniform float uGrainScale;
        uniform float uAOStrength;
        uniform vec4 uCursor;
        uniform vec3 uCursorColor;
        uniform float uCursorStrength;
        uniform vec4 uDomain;
        uniform float uWaterTable;
        uniform sampler2D uField;
        uniform float uRefractionCapture;
        uniform vec3 uUnderColor;
        // Part de l'ombre portee a effacer sous l'eau (0 a sec). Sous l'eau,
        // la lumiere diffusee par le volume et les caustiques rebouchent les
        // ombres : une ombre noire sur le fond, vue a travers l'eau, se
        // lisait comme un trou dans la mer.
        float sc_uwLift = 0.0;
        ${COMMON_GLSL}
        `
      )
      // --- ombres sous l'eau ----------------------------------------------
      .replace(
        '#include <lights_fragment_begin>',
        THREE.ShaderChunk.lights_fragment_begin.replace(
          /getShadow\( directionalShadowMap\[ i \][^;]*?vDirectionalShadowCoord\[ i \] \)/g,
          (m) => `mix( ${m}, 1.0, sc_uwLift )`
        )
      )
      // --- albedo -----------------------------------------------------------
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        float moist = vData.x;
        float packing = vData.y;
        float bakedAO = vData.z;
        float matId = vData.w * 255.0;

        // Profondeur d'eau au-dessus de ce fragment, lue AVANT l'eclairage :
        // c'est elle qui decide de combien l'ombre portee s'efface.
        {
          vec2 fuv0 = vec2(
            (vWorldPos.x + uDomain.z) / (uDomain.z * 2.0),
            (vWorldPos.z + uDomain.w) / (uDomain.w * 2.0)
          );
          if (fuv0.x > 0.0 && fuv0.x < 1.0 && fuv0.y > 0.0 && fuv0.y < 1.0) {
            vec2 waterGrid0 = vec2(${NX.toFixed(1)}, ${NZ.toFixed(1)});
            vec4 wf0 = texture2D(uField, (floor(fuv0 * waterGrid0) + 0.5) / waterGrid0);
            float wd0 = min(max(0.0, wf0.r - vWorldPos.y), wf0.g);
            sc_uwLift = 0.6 * smoothstep(0.015, 0.10, wd0);
          }
        }

        // --- plage dynamique de l'albedo ---------------------------------
        // Le sable n'est pas d'une seule couleur : c'est un melange de quartz
        // clair, de grains sombres et de debris coquilliers. L'ancienne version
        // ne variait que de +-7 % autour d'une teinte unique, sur un fBm qui ne
        // visite jamais ses extremes : apres tone mapping, il ne restait rien.
        // Trois teintes et trois echelles donnent +-26 %, et c'est ce qui fait
        // que le sable a enfin de la matiere.
        // La variation d'ALBEDO doit rester quasi nulle. Une plage de sable
        // corallien, vue de deux metres, est d'un blanc uniforme : tout ce
        // qu'on lit comme « matiere » vient du relief des grains et de la
        // rugosite, pas de taches de couleur. Les echelles moyennes, qui
        // produisaient de grandes plaques facon granit, sont ramenees au
        // dixieme de leur poids et ne servent plus qu'a empecher un aplat
        // parfaitement mort.
        float sdPix = sc_pixelSize(vWorldPos);
        vec3 gp = vWorldPos * (34.0 * uGrainScale);
        float grain = sc_fbm(gp, 3);                  // ~3 cm
        // Ces deux echelles s'echantillonnent sur une base TOURNEE. Le bruit de
        // valeur a ses lobes alignes sur sa propre grille ; pris avec x, y, z
        // bruts, il dessine des bandes parfaitement regulieres sur toute
        // surface parallele a un axe — c'est-a-dire, ici, sur les quatre
        // tranches du bloc. Mesure faite sur la paroi : periode 50 cm,
        // amplitude 5 %, soit exactement l'octave fine du bruit d'echelle metrique.
        //
        // Une rotation quelconque suffit a casser cet alignement, et elle est
        // gratuite : c'est le meme bruit, lu de biais.
        mat3 SKEW = mat3(
           0.802, -0.341,  0.490,
           0.451,  0.878, -0.127,
          -0.391,  0.335,  0.862
        );
        vec3 wpS = SKEW * vWorldPos;
        float meso  = sc_fbm(wpS * 3.2, 2);     // ~30 cm
        float macro = sc_fbm(wpS * 0.9, 2);     // ~1 m
        // Le grain porte 88 % de la variation d'albedo : c'est donc LUI qu'on
        // voit crener, et il merite le seuil strict. Une fois eteint, il ne
        // reste que les deux echelles lentes, dont les poids sont minuscules —
        // autrement dit, de loin, une plage blanche parfaitement lisse. C'est
        // exactement ce qui est demande, et c'est aussi ce qu'on voit en vrai :
        // le grain d'une plage ne se lit qu'accroupi dessus.
        float grainFade = sc_detailN(sdPix, 0.030);
        grain = 0.5 + (grain - 0.5) * grainFade;
        // Une fois le grain eteint par la distance, ces deux echelles sont TOUT ce
        // qui reste : leur poids doit donc etre choisi pour ce qu'elles donnent
        // seules, pas pour ce qu'elles ajoutent au grain. A 0,08 et 0,04 elles
        // suffisaient a moduler la paroi de 5 %, ce qui se voit. Une plage de
        // sable corallien, de loin, n'a pas de taches.
        float mix1 = clamp((grain * 0.88 + meso * 0.045 + macro * 0.02 - 0.4725) * 0.62 + 0.5, 0.0, 1.0);
        mix1 = mix1 * mix1 * (3.0 - 2.0 * mix1);
        vec3 base = mix1 < 0.5
          ? mix(uSandDark, uDryColor, mix1 * 2.0)
          : mix(uDryColor, uSandLight, (mix1 - 0.5) * 2.0);

        // Debris coquilliers : quelques grains sur cent, franchement plus
        // clairs, poses au hasard. C'est cet accident PONCTUEL qui fait lire
        // du sable de corail — pas une modulation continue.
        // Cellules de 5 mm : c'est un detail de PRES. Passe un metre ou deux il
        // tombe sous le pixel et ne produit plus qu'un mouchetis clair, dont le
        // contraste est d'autant plus agressif qu'il est additif et que la
        // tranche du bloc est a l'ombre.
        float shell = sc_vnoise(vWorldPos * 190.0);
        base += vec3(0.06, 0.055, 0.045)
              * smoothstep(0.86, 0.99, shell)
              * sc_detail(sdPix, 0.0053);

        // --- Assombrissement du sable mouille ---------------------------------
        // L'eau qui remplit les interstices rapproche l'indice de refraction du
        // milieu de celui du quartz : les rayons subissent plus de reflexions
        // internes avant de ressortir, donc moins d'energie revient. La
        // reponse en LUMINANCE suit L' = L^(1+k*w) * 0.72 et sature tres vite
        // (les premiers pourcents d'eau font l'essentiel du travail).
        // On l'applique sur la luminance seule : appliquer la puissance canal
        // par canal sur un sable deja tres jaune le rendrait fluo-orange.
        float ws = 1.0 - exp(-moist * 7.5);
        const vec3 LUMW = vec3(0.2126, 0.7152, 0.0722);
        float lum = max(dot(base, LUMW), 1e-4);
        float lumWet = pow(lum, 1.0 + 0.95 * ws) * mix(1.0, 0.72, ws);
        base *= lumWet / lum;
        // Gain de saturation modere : le mouille est plus "profond", pas fluo.
        base = mix(vec3(lumWet), base, 1.0 + 0.16 * ws);
        // Sable gorge d'eau : derive vers le brun froid.
        base = mix(base, base * vec3(0.92, 0.96, 1.06), smoothstep(0.5, 1.0, moist) * 0.5);

        // Le sable tasse est legerement plus fonce et plus uniforme.
        base *= mix(1.03, 0.94, packing);

        // --- Faces de coupe du bloc diorama -----------------------------------
        // Les parois exterieures ne sont pas de la plage : c'est une tranche
        // geologique. On y dessine des strates et la ligne de nappe.
        float cut = max(
          smoothstep(uDomain.z - 0.055, uDomain.z - 0.005, abs(vWorldPos.x)),
          smoothstep(uDomain.w - 0.055, uDomain.w - 0.005, abs(vWorldPos.z))
        );
        cut *= 1.0 - abs(vObjNormal.y); // seulement les faces verticales
        if (cut > 0.001) {
          float yy = vWorldPos.y;
          // Trois octaves a partir de 9 par metre descendaient a 2,8 cm de
          // periode VERTICALE : sous le pixel des qu'on recule un peu, donc un
          // moire en damier sur toute la tranche du bloc. On garde deux
          // octaves, on part moins haut, et on eteint proprement.
          float cutFine = sc_detail(sdPix, 0.11);
          // Le bruit de valeur a ses lobes alignes sur SA grille. Echantillonne
          // avec x et z bruts, sur une paroi qui est justement parallele a un
          // axe, il produit des bandes VERTICALES parfaitement regulieres — ce
          // qui ne ressemble a aucune coupe geologique. On tourne donc
          // l'echantillonnage lateral de 30 degres pour casser cet alignement,
          // et on ralentit sa variation : une stratification, ca se lit
          // d'abord en couches HORIZONTALES, la variation laterale n'etant
          // qu'une lente ondulation du depot.
          vec2 lat = mat2(0.866, -0.5, 0.5, 0.866) * vWorldPos.xz * 0.19;
          float strata = sc_fbm(vec3(lat, yy * 6.0), 2);
          vec3 cutCol = base * (0.90 + 0.20 * strata);
          // Fines lignes de depot, elles aussi fondues quand elles s'approchent
          // du pixel : une strate de 9 cm ne se lit plus a douze metres.
          float lines = smoothstep(0.42, 0.5, fract(yy * 11.0 + strata * 0.6));
          cutCol *= 1.0 - 0.10 * lines * cutFine;
          // ligne de nappe phreatique : liseré plus sombre et humide
          float wt = 1.0 - smoothstep(0.0, 0.035, abs(yy - uWaterTable));
          cutCol = mix(cutCol, cutCol * vec3(0.55, 0.62, 0.72), wt * 0.8);
          base = mix(base, cutCol, cut);
        }

        diffuseColor.rgb *= base;
        `
      )
      // --- rugosite / specularite ------------------------------------------
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        // Deux regimes bien distincts, et c'est important :
        //  - HUMIDE (jusqu'a ~35 %) : l'eau est dans les pores, la surface
        //    reste rugueuse et MATE. Elle est plus sombre, pas plus brillante.
        //  - SATURE (au-dela) : un film d'eau continu recouvre les grains, et
        //    la surface devient franchement speculaire.
        // Les confondre donne ce fini "plastique mouille" partout.
        float wSat = smoothstep(0.35, 0.75, vData.x);
        float roughDamp = mix(0.86, 0.93, smoothstep(0.01, 0.30, vData.x));
        float roughnessFactor = mix(roughDamp, 0.14, wSat);
        // Le sable tasse est un peu plus lisse que le sable en vrac.
        roughnessFactor *= mix(1.0, 0.90, vData.y);
        // Variation spatiale : sans elle, le lobe speculaire est parfaitement
        // uniforme et trahit la surface synthetique.
        float rghFade = sc_detailN(sc_pixelSize(vWorldPos), 0.052);
        roughnessFactor += 0.20 * (sc_fbm(vWorldPos * 19.0, 2) - 0.5) * rghFade;
        roughnessFactor += 0.10 * (grain - 0.5) * rghFade;
        roughnessFactor = clamp(roughnessFactor, 0.06, 1.0);
        `
      )
      // --- normale : grain + micro relief -----------------------------------
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
        {
          // Perturbation triplanaire bon marche : on derive un bruit et on
          // incline la normale. L'amplitude baisse quand le sable est mouille
          // (le film d'eau lisse le relief).
          // Micro-relief discret : du sable fin, ce n'est pas du crepi.
          float amp = mix(0.026, 0.009, smoothstep(0.05, 0.5, vData.x));

          // Deux attenuations indispensables.
          //
          // 1. LES FACES VERTICALES. Sur une face horizontale, incliner la
          //    normale de quelques degres change a peine l'echantillon
          //    d'environnement : on reste dans le ciel. Sur une face
          //    VERTICALE, la meme inclinaison fait basculer l'echantillon du
          //    ciel (bleu vif) au sol (sombre) — le meme bruit y devient dix
          //    fois plus contraste et couvre les tranches du bloc d'un
          //    moucheté de granit.
          amp *= mix(0.18, 1.0, smoothstep(0.12, 0.55, abs(vObjNormal.y)));

          // 2. LA DISTANCE. La cellule de bruit fait 2,4 cm ; passe deux ou
          //    trois metres elle descend sous le pixel et ne produit plus que
          //    du scintillement. On l'eteint progressivement — le grain reste
          //    lisible la ou on le regarde, c'est-a-dire pres.
          amp *= sc_detailN(sc_pixelSize(vWorldPos), 0.024);

          vec3 p = vWorldPos * 42.0;
          float e = 0.9;
          float n0 = sc_vnoise(p);
          vec3 dn = vec3(
            sc_vnoise(p + vec3(e, 0.0, 0.0)) - n0,
            sc_vnoise(p + vec3(0.0, e, 0.0)) - n0,
            sc_vnoise(p + vec3(0.0, 0.0, e)) - n0
          );
          normal = normalize(normal - dn * amp * 8.0);
        }
        `
      )
      // --- AO baké ----------------------------------------------------------
      .replace(
        '#include <aomap_fragment>',
        /* glsl */ `
        #include <aomap_fragment>
        {
          float ao = mix(1.0, vData.z, uAOStrength);
          reflectedLight.indirectDiffuse *= ao;
          reflectedLight.directDiffuse *= mix(1.0, ao, 0.35);
        }
        `
      )
      // --- scintillement + curseur ------------------------------------------
      .replace(
        '#include <dithering_fragment>',
        /* glsl */ `
        #include <dithering_fragment>
        {
          // --- sparkle : facettes de quartz ---
          // Quelques grains sur mille accrochent le soleil. Deux precautions
          // indispensables : une densite tres faible (sinon la plage se
          // transforme en paillettes) et un fondu en distance (sinon, quand un
          // pixel couvre des dizaines de cellules, l'echantillonnage aliase et
          // le scintillement devient un voile blanc uniforme).
          vec3 V = normalize(cameraPosition - vWorldPos);
          vec3 Nw = normalize(normal);
          vec3 L = uSunDirection;
          float dist = length(cameraPosition - vWorldPos);
          // Cellule de grain PROPORTIONNELLE a la distance : l'eclat garde une
          // taille apparente constante a l'ecran. Avec une taille fixe, le
          // scintillement n'existait que dans le premier metre alors que la
          // camera est a quatre ou huit metres — donc il ne se voyait jamais.
          float cellSize = 520.0 / max(1.0, dist * 0.75);
          float sparkFade = 1.0;
          {
            vec3 cell = floor(vWorldPos * cellSize);
            vec3 rnd = sc_hash33(cell) * 2.0 - 1.0;
            vec3 facet = normalize(Nw + rnd * 0.5);
            vec3 H = normalize(L + V);
            float spec = pow(max(dot(facet, H), 0.0), 900.0);
            float density = step(0.9965, sc_hash13(cell + 7.7));
            // Le sable mouille scintille moins (film d'eau), le sec beaucoup.
            float wetDamp = mix(1.0, 0.2, smoothstep(0.03, 0.4, vData.x));
            float sun = max(dot(Nw, L), 0.0);
            gl_FragColor.rgb += uSunColor * spec * density * 2.2 * uSparkle
                              * wetDamp * sun * sparkFade;
          }

          // --- sous l'eau : absorption, diffusion et caustiques ---
          // C'est ici que le lagon prend sa couleur. Le sable connait sa
          // propre profondeur d'eau, donc il peut appliquer exactement
          // l'attenuation qui lui revient — ce qu'une surface d'eau opaque
          // posee par-dessus ne saurait pas faire.
          {
            vec2 fuv = vec2(
              (vWorldPos.x + uDomain.z) / (uDomain.z * 2.0),
              (vWorldPos.z + uDomain.w) / (uDomain.w * 2.0)
            );
            if (fuv.x > 0.0 && fuv.x < 1.0 && fuv.y > 0.0 && fuv.y < 1.0) {
              // Le champ est une grille de COLONNES, pas une image. Un filtre
              // bilineaire au bord mouille/sec invente une demi-colonne sur la
              // face voisine ; le seuil suit alors les diagonales du maillage
              // et dessine exactement les pointes turquoise observees contre
              // les tours. La colonne qui contient le fragment est la seule
              // qui ait un sens physique pour teinter le sable.
              vec2 waterGrid = vec2(${NX.toFixed(1)}, ${NZ.toFixed(1)});
              vec2 waterUv = (floor(fuv * waterGrid) + 0.5) / waterGrid;
              vec4 wf = texture2D(uField, waterUv);
              float wd = max(0.0, wf.r - vWorldPos.y);
              // Une eau 2D est une colonne au-dessus du sommet du terrain.
              // Sur une paroi/contre-depouille, un film de ressac pose sur le
              // dessus de la colonne ne remplit PAS tout le vide en dessous.
              // Sans cette porte, 2 mm d'eau en haut coloraient toute la face
              // verticale en turquoise : les longues pointes visibles sur le
              // sable. Une vraie paroi immergee (plusieurs centimetres d'eau)
              // conserve en revanche son absorption normale.
              float verticalFace = 1.0 - clamp(abs(normalize(vObjNormal).y), 0.0, 1.0);
              float faceGate = smoothstep(0.25, 0.80, verticalFace);
              float minColumnDepth = mix(0.002, 0.018, faceGate);
              float fullColumnDepth = mix(0.008, 0.045, faceGate);
              float columnWater = smoothstep(minColumnDepth, fullColumnDepth, wf.g);
              if (wd > 0.002 && columnWater > 0.001) {
                vec3 SIG = vec3(2.10, 0.30, 0.20);
                vec3 tr = exp(-SIG * wd * 1.5);
                vec3 underCol = gl_FragColor.rgb * tr + uUnderColor * (1.0 - tr.g);
                // Sur une face verticale, la colonne d'eau est DEVANT le
                // sable, pas posee dessus. Une teinte turquoise complete y
                // dessinait des rideaux verticaux et des pointes suivant les
                // triangles. On garde seulement l'assombrissement humide ; la
                // vraie couleur de l'eau appartient au mesh de surface.
                float waterHue = mix(1.0, 0.10, faceGate);
                if (uRefractionCapture < 0.5) {
                  gl_FragColor.rgb = mix(gl_FragColor.rgb, underCol, columnWater * waterHue);
                  gl_FragColor.rgb *= 1.0 - columnWater * faceGate * 0.10;
                }
                // Caustiques liees a la VRAIE surface de l'eau. Comme dans
                // WebGL Water, la lumiere augmente quand la refraction reduit
                // l'aire projetee d'un petit morceau de surface. Ici on
                // approxime le determinant du Jacobien avec les courbures X/Z
                // du champ de hauteur ; le bruit ne sert plus qu'a casser la
                // regularite, jamais a inventer la concentration lumineuse.
                vec2 wt = 1.0 / waterGrid;
                vec4 wL = texture2D(uField, waterUv - vec2(wt.x, 0.0));
                vec4 wR = texture2D(uField, waterUv + vec2(wt.x, 0.0));
                vec4 wD = texture2D(uField, waterUv - vec2(0.0, wt.y));
                vec4 wU = texture2D(uField, waterUv + vec2(0.0, wt.y));
                float invDx2 = ${(1 / (VOXEL * VOXEL)).toFixed(1)};
                float curvX = (wL.r - 2.0 * wf.r + wR.r) * invDx2;
                float curvZ = (wD.r - 2.0 * wf.r + wU.r) * invDx2;
                float refractSpan = min(wd, 0.9) * 0.245;
                float causticJacobian = abs((1.0 + refractSpan * curvX)
                                          * (1.0 + refractSpan * curvZ));
                float focus = clamp(1.0 / max(causticJacobian, 0.28), 0.35, 3.2);
                float wetNeighbors = step(0.002, wL.g) * step(0.002, wR.g)
                                   * step(0.002, wD.g) * step(0.002, wU.g);
                float physicalFocus = smoothstep(0.92, 2.35, focus) * wetNeighbors;
                vec2 cp = vWorldPos.xz * 11.0;
                float k1 = sc_vnoise(vec3(cp + vec2(uTime * 0.35, uTime * 0.22), 0.0));
                float k2 = sc_vnoise(vec3(cp * 1.7 - vec2(uTime * 0.28, uTime * 0.4), 3.1));
                float lace = pow(clamp(1.0 - abs(k1 - k2) * 3.4, 0.0, 1.0), 2.0);
                float caus = physicalFocus * (0.38 + 0.62 * lace);
                gl_FragColor.rgb += uSunColor * caus * exp(-wd * 1.1) * 0.34
                                  * max(uSunDirection.y, 0.0) * columnWater
                                  * mix(1.0, 0.12, faceGate);
              }

              // --- laisse d'ecume ---
              // La dentelle blanche qui reste sur le sable apres le retrait :
              // elle marque physiquement jusqu'ou la mer est montee. Le canal
              // B d'une cellule seche porte cette ecume deposee ; l'eau n'y
              // dessine rien (elle fait discard sous 1,6 mm), le sable prend
              // le relais avec exactement la meme dentelle, au pixel pres.
              if (wf.g < 0.0016 && wf.b > 0.02) {
                float upFace = clamp(normalize(vObjNormal).y, 0.0, 1.0);
                float dryLace = wc_foamLace(vWorldPos.xz, uTime, wf.b * 0.85, 0.7)
                              * smoothstep(0.35, 0.80, upFace);
                gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.93, 0.95, 0.95),
                                       dryLace * 0.82);
              }
            }
          }

          // --- anneau de curseur (previsualisation d'outil) ---
          if (uCursorStrength > 0.001) {
            float d = distance(vWorldPos, uCursor.xyz);
            float r = uCursor.w;
            float ring = smoothstep(r, r * 0.94, d) * smoothstep(r * 0.80, r * 0.88, d);
            float fill = smoothstep(r, r * 0.9, d) * 0.10;
            gl_FragColor.rgb = mix(gl_FragColor.rgb,
                                   uCursorColor,
                                   clamp((ring * 0.7 + fill) * uCursorStrength, 0.0, 0.85));
          }
        }
        `
      );
  };

  return mat;
}

/**
 * Materiau de profondeur assorti — indispensable pour que les ombres
 * correspondent a la geometrie (elle n'est pas deformee ici, donc le
 * MeshDepthMaterial par defaut suffit ; on garde le hook pour plus tard).
 */
export function createSandDepthMaterial() {
  return new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
}

export { MAT_ROCK, MAT_SHELL };
