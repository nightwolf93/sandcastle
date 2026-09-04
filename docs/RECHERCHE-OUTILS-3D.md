# RECHERCHE — DONNER UNE EXISTENCE PHYSIQUE AUX OUTILS

## Des objets qu'on voit, qu'on tient, qui se remplissent et qui se vident

> **Document de conception technique.** Il répond à deux demandes précises du
> joueur :
>
> 1. « améliore visuellement tout, par exemple avoir **un vrai seau qu'on
>    remplit de sable et qu'on retourne et démoule** » ;
> 2. « **rendre réalistes les outils, par exemple la pelle, quand on n'en a plus
>    besoin on la plante dans le sable** ».
>
> Et à trois captures de référence du jeu « Sandcastle » (démo Steam), décodées
> en **§1.4** : outils = props physiques posés sur la plage, anneau de brosse
> blanc pointillé, et l'invite « RIGHT CLICK TO DROP THE ACTIVE ITEM ».
>
> **Contrainte absolue : aucun fichier d'asset.** Tout ce qui suit est généré en
> code, dans le style de `src/render/Props.js`.
>
> **État de la recherche documentaire.** Le budget de recherche web de la session
> a été épuisé avant que ce document soit rédigé. Les partis pris techniques
> ci-dessous s'appuient donc sur la connaissance directe des API three.js
> (`LatheGeometry`, `Points`, `InstancedMesh`, `DecalGeometry`, `AnimationMixer`)
> et sur le corpus classique de game feel — les douze principes d'animation de
> Thomas & Johnston, *Game Feel* de Steve Swink, la conférence « Juice it or lose
> it » de Jonasson & Purho, et « Fast and Funky 1D Nonlinear Transformations »
> de Squirrel Eiserloh (GDC 2015) pour les courbes. **Tout le code a été écrit
> contre les fichiers réels du dépôt** (`tools.js`, `ToolManager.js`, `Brush.js`,
> `Props.js`, `Config.js`, `Game.js`, `HUD.js`) et se branche sur leurs points
> d'entrée existants. Les quelques chiffres qui mériteraient d'être revérifiés
> en ligne sont signalés par ⚠︎.

---

## SOMMAIRE

1. [Principe : main visible ou outil flottant ?](#1-principe)
2. [Géométries procédurales, outil par outil](#2-geometries)
3. [Le seau, en détail](#3-le-seau)
4. [Animation et sensation](#4-animation)
5. [Particules et traces](#5-particules)
6. [Retour sur l'état de l'outil](#6-etat)
7. [Le cycle de vie de l'outil : tenu, planté, posé, ramassé](#7-cycle)
8. [L'anneau de curseur](#8-anneau)
9. [Plan d'implémentation ordonné](#9-plan)

---

<a name="1-principe"></a>
# 1. PRINCIPE — MAIN VISIBLE OU OUTIL FLOTTANT ?

## 1.1 L'état actuel, et pourquoi il est frustrant

Aujourd'hui, `ToolManager.updateCursorUniforms()` écrit trois uniformes dans le
shader du sable :

```js
u.uCursor.value.set(hit.point.x, hit.point.y, hit.point.z, this.radius);
u.uCursorColor.value.set(col);
u.uCursorStrength.value = this.cursorFade;
```

…et `SandMaterial.js` en tire un anneau coloré projeté sur la surface. C'est
propre, c'est lisible, ça ne coûte rien — et **c'est un curseur de logiciel de
sculpture, pas un jouet de plage**. Le joueur clique, le terrain change. Entre
les deux, rien ne se passe : pas d'objet, pas de geste, pas de matière qui vole.
Le verbe du jeu (« creuser », « démouler ») n'a aucun corps.

L'anneau doit **rester** — il porte une information que l'objet ne peut pas
porter (le rayon exact de la brosse, projeté sur le relief). Mais il ne doit
plus être le seul retour.

## 1.2 Le rapport d'échelle : combien de pixels fait un seau ?

C'est la question qui tranche le débat. Le jeu utilise une caméra en orbite de
diorama :

```js
this.camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.05, 120);
this.controls.focus(-0.3, 1.35, -0.3, 15.5);   // distance par défaut : 15,5 m
// DioramaControls : minDistance 1.4 — maxDistance 34
```

La hauteur de monde couverte par l'écran à une distance `d` vaut
`H = 2·d·tan(fov/2)`, avec `fov = 32°` donc `tan(16°) = 0,2867`.
Sur un écran de 1080 px de haut, l'échelle est `1080 / H` pixels par mètre :

| Distance caméra | Hauteur visible | px / m (1080p) | **Un seau de 15 cm** | Une main de 18 cm |
|---|---|---|---|---|
| 1,4 m (zoom max) | 0,80 m | 1345 | **202 px** | 242 px |
| 4 m | 2,29 m | 471 | **71 px** | 85 px |
| 8 m | 4,59 m | 235 | **35 px** | 42 px |
| **15,5 m (défaut)** | **8,89 m** | **121** | **18 px** | **22 px** |
| 24 m | 13,8 m | 78 | **12 px** | 14 px |
| 34 m (dézoom max) | 19,5 m | 55 | **8 px** | 10 px |

**Le verdict tombe tout seul.** À la distance de travail par défaut, un seau
occupe 18 pixels de haut. Une main en occuperait 22 — soit **environ trois
pixels par doigt**. Aucune modélisation de main, si soignée soit-elle, ne
survit à ça : ça devient une patate rose. Pire, une main crédible appelle un
avant-bras, qui appelle un bras, qui appelle un corps — et un corps dans un
diorama en orbite libre, ça occulte la moitié du chantier dès qu'on tourne la
caméra derrière.

En revanche, **un seau de 18 px se lit parfaitement** : c'est une silhouette
trapézoïdale à contraste fort, orange sur beige. La silhouette est le seul
canal d'information qui fonctionne à cette taille — ce qui gouverne toute la
section 2.

## 1.3 Ce que font les jeux de référence

| Jeu | Caméra | Solution retenue | Leçon |
|---|---|---|---|
| **Black & White** | orbite au-dessus du terrain | **la main EST le curseur**, énorme, occupant 15 % de l'écran | marche parce que la main est le protagoniste, pas un accessoire |
| **From Dust** | drone au-dessus du paysage | le « Souffle » : un tourbillon lumineux, aucune main | l'outil peut être une **abstraction incarnée** |
| **Viva Piñata** | orbite jardin | les outils **flottent seuls**, orientés comme s'ils étaient tenus | référence la plus proche de notre cas |
| **Astroneer** | 3e personne | outil de terrain **tenu par l'avatar**, mais le retour porteur est le flux de matière | le jet de matière compte plus que l'outil |
| **Animal Crossing** | 3e personne proche | outil tenu, silhouette **très exagérée** (arrosoir gros comme le torse) | l'exagération d'échelle est un outil de lisibilité |
| **Powerwash Simulator** | 1re personne | lance tenue, animation d'inertie très travaillée | inatteignable ici : nous sommes 15 m trop loin |
| **Tiny Glade** | orbite diorama | **aucun outil**, seulement un curseur et le résultat | prouve qu'on peut s'en passer… mais le jeu n'a pas de verbe physique |
| **Dorfromantik / Townscaper** | orbite diorama | aucun outil | même remarque |
| **« Sandcastle » (démo Steam)** | **orbite diorama, même distance que nous** | **outils = props physiques du monde**, posés sur le sable, plus anneau blanc pointillé | **la référence directe — voir §1.6** |

## 1.4 Les captures de référence, décodées

Le joueur a fourni trois captures du jeu « Sandcastle » (démo Steam), qui est
notre voisin le plus proche en caméra et en propos. Ce qu'elles montrent, et
ce qu'on en retient :

**a) Les outils sont de vrais objets du monde, pas des icônes.**
On voit une **pelle de plage en plastique rouge — manche blanc, poignée en D
rouge, lame rouge — posée à plat sur le sable mouillé, avec son ombre portée**.
Sur une autre capture, un **râteau rouge et une seconde pelle traînent sur la
plage à côté du château**. Ce ne sont pas des éléments d'interface : ce sont des
props que le joueur a laissés là. C'est exactement la validation du parti pris
§1.4 (l'outil est un objet), **plus une extension majeure** : l'objet **survit à
son usage**. Il ne disparaît pas quand on change d'outil, il **reste au sol**.

**b) L'outil actif survole le curseur**, et le sol porte un **anneau de brosse
blanc en pointillés**, fin et net, projeté sur le relief. Une des captures montre
**deux cercles concentriques** : l'anneau de rayon d'action, plus un cercle plus
large qui lit comme une zone d'effet ou une prévisualisation. On garde donc notre
anneau shader, mais on le retravaille — voir **§8**.

**c) L'invite « RIGHT CLICK TO DROP THE ACTIVE ITEM »** : le joueur peut
**lâcher** l'outil courant, qui tombe et reste au sol.

**d) La demande explicite du joueur : « rendre réalistes les outils, par exemple
la pelle, quand on n'en a plus besoin on la plante dans le sable ».**

Ces quatre points imposent une **quatrième dimension** à ce document, absente de
la mission initiale : l'outil n'a pas deux états (rangé / tenu) mais **quatre**,
et le passage de l'un à l'autre est en soi un geste de plaisir. C'est l'objet de
la section **§7**, et cela **modifie l'ordre du plan** (§9) : le geste de planter
la pelle est peu coûteux et très payant, il remonte juste après le seau.

## 1.5 Ce qu'on garde, ce qu'on ajoute

| Décision | Statut |
|---|---|
| Pas de main, pas d'avatar : l'outil flotte | **inchangée** (§1.6) |
| L'inertie remplace la main | **inchangée** (§4.1) |
| L'outil est un objet physique | **renforcée** : il devient aussi un objet **persistant** |
| L'anneau du shader reste | **inchangée**, mais **blanc et pointillé** (§8) |
| L'outil disparaît quand on en change | **abandonnée** : il reste au sol (§7) |
| Style « jouet de plage » | **précisée** : plastique moulé saturé (§2.1) |

## 1.6 VERDICT : l'outil flotte seul, mais il est tenu

**On ne modélise ni main, ni bras, ni avatar. L'outil flotte.** Mais il ne
flotte pas *n'importe comment* — et c'est là que se joue la différence entre
« un objet posé dans le vide » et « un objet tenu ».

Quatre règles font qu'un outil flottant se lit comme tenu :

1. **Il n'est jamais aligné sur les axes.** Un manche parfaitement vertical
   ou une lame parfaitement horizontale, c'est un objet posé par un moteur.
   On impose au repos une inclinaison de **12 à 20°**, orientée depuis le
   « haut-droite » de la caméra — la position d'une main droite.
2. **Il n'est jamais parfaitement immobile.** Une respiration de ±4 mm à
   0,55 Hz et un micro-lacet de ±0,02 rad à 0,31 Hz suffisent. Un objet
   absolument fixe est mort.
3. **Il traîne derrière le curseur.** Un ressort amorti (§4.1) crée le retard
   et l'inclinaison qui disent « une main le tire ».
4. **Il anticipe et il accompagne.** Un coup de pelle recule avant de partir
   et dépasse avant de revenir (§4.2).

> **Règle de conception :** ce n'est pas la main qui rend l'objet tenu, c'est
> l'**inertie**. Le budget qu'on aurait mis à modéliser une main est dix fois
> mieux investi dans les courbes d'animation.

**Exception unique — l'outil « Main ».** Le seul outil qui n'a pas d'objet,
c'est justement celui qu'on ne peut pas modéliser. La réponse est dans la Bible
§3.1 : le geste de tassement, dans la vraie vie, se fait à la **dame** (ou
*tamper*) — une plaque de 15 à 20 cm de côté sur un manche court, qu'on laisse
tomber. On modélise donc **une petite dame en bois**, et on garde l'icône
« main » dans le HUD parce que le joueur pense « main ». C'est plus fidèle à la
pratique réelle, ça se lit à 18 px, et ça évite la patate rose. Voir §2.8.

## 1.7 Où l'outil se place exactement

Chaque géométrie déclare un **point de travail** (`tip`) en coordonnées locales :
la pointe de la lame pour la pelle, le plan de la bouche pour le seau, le bord
de la boucle pour la mirette. Le rig place l'outil de façon que ce point
coïncide avec `hit.point`, ce qui garantit que **ce qu'on voit toucher le sable
est ce qui modifie le sable**. C'est l'exigence numéro un : dès que l'outil
visible et la brosse invisible divergent, tout l'effort est perdu.

---

<a name="2-geometries"></a>
# 2. GÉOMÉTRIES PROCÉDURALES, OUTIL PAR OUTIL

## 2.0 Architecture des fichiers

Trois fichiers nouveaux, dans le style exact de `Props.js` :

```
src/render/GeoUtils.js      helpers partages (mergeGeoms, mulberry, arc)
src/render/Ease.js          courbes, amortisseurs, ressort 3D            (§4.1)
src/render/ToolGeometry.js  une fabrique de BufferGeometry par outil     (§2)
src/render/ToolAvatar.js    le rig : suivi du curseur, inertie, poses    (§4.4)
src/render/BucketRig.js     le seau et sa sequence de demoulage          (§3.5)
src/render/Particles.js     le systeme de particules mutualise           (§5)
src/render/PlantAnim.js     planter / lacher un outil                    (§7.4)
src/render/DroppedTools.js  les outils laisses sur la plage              (§7.7)
```

Sept fichiers nouveaux, **aucun fichier existant réécrit** : les modifications
dans `tools.js`, `ToolManager.js`, `Game.js`, `HUD.js`, `Brush.js` et
`SandMaterial.js` sont toutes des ajouts localisés, listés au fil du document.

`mergeGeoms()` et `mulberry()` existent déjà dans `Props.js` mais y sont
privés. **Première tâche : les extraire dans `GeoUtils.js`** et les réimporter
depuis `Props.js`. Aucune régression, et on arrête de dupliquer.

```js
// ---------------------------------------------------------------------------
// src/render/GeoUtils.js
// Helpers de geometrie procedurale partages par Props.js et ToolGeometry.js.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

/** Fusion simple de BufferGeometry indexees ou non. Sortie non indexee. */
export function mergeGeoms(list) {
  let total = 0;
  for (const g of list) total += g.index ? g.index.count : g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  let o = 0;
  for (const g of list) {
    const p = g.attributes.position;
    if (!g.attributes.normal) g.computeVertexNormals();
    const n = g.attributes.normal;
    const idx = g.index;
    const count = idx ? idx.count : p.count;
    for (let i = 0; i < count; i++) {
      const j = idx ? idx.getX(i) : i;
      pos[o * 3] = p.getX(j); pos[o * 3 + 1] = p.getY(j); pos[o * 3 + 2] = p.getZ(j);
      nrm[o * 3] = n.getX(j); nrm[o * 3 + 1] = n.getY(j); nrm[o * 3 + 2] = n.getZ(j);
      o++;
    }
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return out;
}

/** PRNG deterministe : la meme touffe, le meme seau, a chaque lancement. */
export function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Anse / arceau : un tube de section carree suivant un arc de cercle.
 * Moins cher qu'un TorusGeometry (4 faces par segment au lieu de 8) et la
 * section carree accroche mieux la lumiere a petite taille.
 *
 * @param {number} R      rayon de l'arc
 * @param {number} th     demi-epaisseur du tube
 * @param {number} a0,a1  angles de debut et de fin (radians)
 * @param {number} seg    nombre de segments le long de l'arc
 */
export function makeArc(R, th, a0, a1, seg = 12) {
  const pos = [];
  const quad = (p0, p1, p2, p3) => pos.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3);
  let prev = null;
  for (let i = 0; i <= seg; i++) {
    const a = a0 + (a1 - a0) * (i / seg);
    const cx = Math.cos(a) * R, cy = Math.sin(a) * R;
    // repere local : radial (nx,ny) et binormal Z
    const nx = Math.cos(a), ny = Math.sin(a);
    const ring = [
      [cx + nx * th, cy + ny * th, +th],
      [cx + nx * th, cy + ny * th, -th],
      [cx - nx * th, cy - ny * th, -th],
      [cx - nx * th, cy - ny * th, +th],
    ];
    if (prev) {
      for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) % 4;
        quad(prev[k], ring[k], ring[k2], prev[k2]);
      }
    }
    prev = ring;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  return g;
}

/** Nombre de triangles d'une geometrie — sert au controle de budget. */
export function triCount(g) {
  return (g.index ? g.index.count : g.attributes.position.count) / 3;
}
```

## 2.1 La palette et les matériaux — plastique moulé de jouet de plage

Les captures de référence (§1.4) fixent la direction artistique de façon nette :
**jouets de plage en plastique injecté, couleurs franches et saturées, formes
simples et arrondies, matériau légèrement brillant qui tranche avec le sable
mat.** Ce n'est pas une décoration : c'est le seul moyen de rendre lisible un
objet de 18 px sur un fond beige.

### Le raisonnement chromatique

Le sable du jeu est un beige clair, désaturé et **très clair** (`uDryColor`
autour de `0xd9c9a8`, HSL ≈ 38°, 42 %, 76 %). Pour qu'un outil se détache :

| Levier | Sable | Outil | Écart |
|---|---|---|---|
| **Teinte** | 38° (orangé) | 8° (rouge) ou 212° (bleu) | 30° à 174° |
| **Saturation** | 42 % | **72 à 85 %** | ×2 |
| **Luminosité** | 76 % | 48 à 58 % | −20 pts |
| **Rugosité** | 0,92 (mat) | **0,34 (satiné)** | reflet spéculaire net |

C'est la **rugosité** qui fait le plus gros du travail, et c'est le paramètre
qu'on oublie le plus souvent. À 18 px, un objet mat est une tache de couleur ;
un objet satiné a **un point de spéculaire qui bouge quand la caméra tourne**,
et ce point vaut à lui seul dix fois la géométrie. `roughness = 0.34` est la
valeur du polypropylène injecté brillant ; c'est aussi la valeur demandée
(« ~0,35 »).

### Le piège des ombres, et le correctif

Un plastique saturé placé à l'ombre, dans un rendu PBR avec un ciel bleu,
**vire au gris-bleu et perd toute son identité**. Un jouet réel ne fait pas
ça : sa couleur reste franche même à l'ombre, parce que le pigment est dans la
masse et que le matériau est légèrement translucide (diffusion sous-surfacique
courte). On triche pour 3 lignes : un `emissive` égal à la couleur de base
multipliée par **0,05** maintient la saturation dans les ombres sans jamais
donner l'impression que l'objet brille.

```js
// --- src/render/ToolGeometry.js (haut de fichier) --------------------------

import * as THREE from 'three';
import { mergeGeoms, mulberry, makeArc } from './GeoUtils.js';

/**
 * PALETTE « JOUET DE PLAGE EN PLASTIQUE MOULE ».
 *
 * Regles :
 *   - couleurs FRANCHES et SATUREES : elles doivent tenir a 18 px sur du beige
 *   - roughness 0.34 : polypropylene injecte brillant. C'est le point de
 *     speculaire mobile qui donne le volume, pas la geometrie
 *   - metalness 0 partout sur le plastique (une erreur classique : mettre un
 *     peu de metalness « pour la brillance » — ca noircit le plastique)
 *   - emissive = couleur x 0.05 : le pigment est dans la masse, un jouet ne
 *     devient pas gris a l'ombre
 *   - les manches sont BLANC CASSE : c'est le code visuel du jouet de plage
 *     (manche blanc, partie active coloree), et ca cree une coupure de
 *     silhouette qui aide enormement la lecture a petite taille
 */
const PLASTIC = (hex, rough = 0.34) => {
  const c = new THREE.Color(hex);
  return new THREE.MeshStandardMaterial({
    color: c,
    roughness: rough,
    metalness: 0.0,
    emissive: c.clone().multiplyScalar(0.05),
  });
};

/** Les six couleurs du bac a jouets. Ne pas en ajouter une septieme. */
export const TOY = {
  red:    0xe0341f,   // pelle, rateau  — la couleur des captures de reference
  blue:   0x1f6fd0,   // arrosoir, seau d'eau
  yellow: 0xf2b21f,   // seau a demouler
  green:  0x33a05a,   // truelle
  white:  0xf2efe7,   // manches
  grey:   0x8e959c,   // pieces metalliques (mirette)
};

export const TOOL_MATERIALS = {
  red:      () => PLASTIC(TOY.red),
  blue:     () => PLASTIC(TOY.blue),
  yellow:   () => PLASTIC(TOY.yellow),
  green:    () => PLASTIC(TOY.green),
  // Le manche : blanc casse, un peu plus mat (il est granuleux au toucher).
  handle:   () => PLASTIC(TOY.white, 0.46),
  // Le metal des mirettes et des anses : la seule metalness du jeu.
  metal:    () => new THREE.MeshStandardMaterial({ color: 0xb9bec4, roughness: 0.30, metalness: 0.75 }),
  wood:     () => new THREE.MeshStandardMaterial({ color: 0xb98a4e, roughness: 0.78, metalness: 0.0 }),
  // Le sable CONTENU dans un outil. Plus fonce que le sable du sol : c'est du
  // sable travaille, donc humide et tasse.
  sandWet:  () => new THREE.MeshStandardMaterial({ color: 0x9c8560, roughness: 0.95, metalness: 0.0,
                                                   side: THREE.DoubleSide }),
  water:    () => new THREE.MeshStandardMaterial({ color: 0x4fa3d8, roughness: 0.15, metalness: 0.0,
                                                   transparent: true, opacity: 0.72 }),
};

// Alias de compatibilite avec le reste du document.
TOOL_MATERIALS.plastic  = TOOL_MATERIALS.red;
TOOL_MATERIALS.plastic2 = TOOL_MATERIALS.blue;
```

### Attribution par outil

| Outil | Partie active | Manche / poignée | Note |
|---|---|---|---|
| Pelle | **rouge `0xe0341f`** | blanc `0xf2efe7` | exactement la pelle des captures |
| Râteau | **rouge `0xe0341f`** | blanc | assorti à la pelle : c'est le même set |
| Seau à démouler | **jaune `0xf2b21f`** | anse métal | le jaune est la couleur du seau de plage |
| Seau d'eau | **bleu `0x1f6fd0`** | anse métal | la couleur dit la fonction |
| Arrosoir | **bleu `0x1f6fd0`** | — | idem |
| Truelle | **vert `0x33a05a`** | blanc | seul outil vert : il est unique dans le set |
| Mirette | métal `0xb9bec4` | **rouge** | « l'outil à manche rouge » de la Bible §3.3.2 |
| Dame (main) | blanc | rouge | — |

> **Règle de non-régression :** on n'ajoute jamais une couleur au-delà de ces
> six. Un bac à jouets réel a trois ou quatre couleurs qui reviennent, et c'est
> précisément ce qui fait qu'il ressemble à un ensemble et non à un inventaire
> de jeu vidéo. C'est aussi ce qui permet de reconnaître un outil à la couleur
> seule, à 8 px, quand il traîne au fond de la plage.

### Cohérence avec `Props.js`

Les props existants (`0xd9463c` drapeau rouge, `0x3f7fd4` bleu) sont déjà dans
la même famille. On aligne au passage le rouge du drapeau sur `TOY.red` et le
bleu sur `TOY.blue` : deux valeurs à changer, et tout le décor et tous les
outils appartiennent enfin au même monde.

> **Note de rendu.** Les outils utilisent `MeshStandardMaterial` et **pas** le
> shader du sable : ils n'ont ni humidité ni compaction à afficher, et ils
> doivent recevoir les ombres de `sky.sun` comme les props. `castShadow = true`
> sur l'outil : l'ombre portée sur le sable est **le signal de profondeur le
> plus fort** dont on dispose à 18 px. C'est elle qui dit si le seau est posé ou
> soulevé de 10 cm. À ne surtout pas couper, même en qualité basse.

## 2.2 Le seau — tronc de cône par révolution

C'est l'objet phare. Il doit avoir :

- une **paroi d'épaisseur non nulle** : on voit l'intérieur depuis le dessus, et
  une paroi d'épaisseur zéro se trahit immédiatement (bord infiniment fin, et
  face arrière noire) ;
- un **bourrelet** en haut : les seaux moulés par injection en ont tous un, et
  il donne une ligne de spéculaire qui souligne la bouche ;
- une **anse articulée**, qui pendra du bon côté selon l'inclinaison ;
- un **contenu de sable** dont le niveau monte, visible depuis le dessus.

Le profil est décrit une fois, puis mis en révolution par `LatheGeometry`.
Le profil part du **centre du fond**, remonte la paroi **extérieure**, passe le
bourrelet, redescend la paroi **intérieure**, et revient au centre : une seule
révolution produit une coque fermée d'épaisseur constante.

```js
/**
 * Seau de plage, construit a rayon de bouche unitaire (1 m) : le rig le met a
 * l'echelle par `s.radius`, ce qui garantit que le seau VU correspond
 * exactement au volume STAMPE par `Brush.stampBucket`.
 *
 * Convention geometrique, cohérente avec `stampBucket(…, rBottom = r,
 * rTop = r * 0.86, …)` : la BOUCHE du seau est le rayon 1, le FOND est le
 * rayon 0.86. Une fois retourne, le seau produit donc une tour large en bas
 * (1) et retrecie en haut (0.86) — exactement la forme empilable de la
 * Bible §2.4.2.
 *
 * Budget : LATHE_SEG = 16 -> 8 quads de profil x 16 = 256 triangles pour la
 * coque, 96 pour l'anse. Total 352.
 */

/** Proportion hauteur / rayon de bouche. Un seau de plage reel vaut ~1.9. */
export const BUCKET_ASPECT = 2.0;
/** Epaisseur de paroi, en fraction du rayon de bouche. */
const WALL = 0.055;
const LATHE_SEG = 16;

export function makeBucketGeometry() {
  const H = BUCKET_ASPECT;        // hauteur totale
  const RB = 0.86;                // rayon du fond
  const RT = 1.0;                 // rayon de bouche
  const w = WALL;

  // Profil (x = rayon, y = hauteur). Sens : fond -> exterieur -> levre ->
  // interieur -> fond. Les normales sortent alors du solide.
  const P = (x, y) => new THREE.Vector2(x, y);
  const profile = [
    P(0.0,        0.0),            // centre du fond (exterieur)
    P(RB * 0.72,  0.0),
    P(RB,         0.035 * H),      // conge du fond
    P(RT,         H - 0.05 * H),   // paroi exterieure, legerement conique
    P(RT + w * 0.9, H - 0.012 * H),// bourrelet, qui deborde vers l'exterieur
    P(RT + w * 0.5, H),            // levre
    P(RT - w,     H - 0.02 * H),   // retour interieur
    P(RB - w,     0.05 * H),       // paroi interieure
    P(RB * 0.7 - w, w),            // conge interieur
    P(0.0,        w),              // centre du fond (interieur)
  ];

  const shell = new THREE.LatheGeometry(profile, LATHE_SEG);
  // three.js calcule des normales analytiques a partir du profil ; elles sont
  // correctes tant que le profil ne repasse pas par x = 0 au milieu. Ici il
  // commence et finit a 0, ce qui est le cas d'usage nominal.
  // ⚠︎ Si le seau apparait noir a l'ecran, c'est que l'ordre du profil est
  // inverse : il suffit de faire profile.reverse().

  // --- anse : arceau qui part de deux tetons sous la levre -----------------
  const handle = makeArc(RT * 1.02, w * 0.55, 0.08, Math.PI - 0.08, 10);
  handle.rotateZ(0);                  // arc dans le plan XY
  handle.translate(0, H - 0.09 * H, 0);

  return { shell, handle, height: H, rBottom: RB, rTop: RT, wall: w };
}
```

### 2.2.1 Le contenu : une surface de sable qui monte

C'est **le cœur de la demande du joueur**. Le seau doit se remplir *visiblement*.

Solution : un maillage en grille cylindrique de `(RING+1) × SEG` sommets plus
un sommet central, **alloué une seule fois**, dont on réécrit les positions
quand le niveau change. Aucune allocation en jeu, aucune recréation de
`BufferGeometry`, et la forme reste exacte (le rayon suit le tronc de cône à la
hauteur atteinte, ce qu'un simple `scale.y` ne saurait pas faire).

```js
/**
 * Surface de sable a l'interieur du seau.
 * Retourne { geometry, setLevel } : `setLevel(fill, wobble)` reecrit les
 * positions en place. 16 x 3 + 1 = 49 sommets, 128 triangles.
 */
export function makeBucketSand(SEG = 16, RING = 3) {
  const rows = RING + 1;
  const vertCount = rows * SEG + 1;
  const center = rows * SEG;

  const pos = new Float32Array(vertCount * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));

  const idx = [];
  for (let r = 0; r < RING; r++) {
    for (let c = 0; c < SEG; c++) {
      const a = r * SEG + c, b = r * SEG + ((c + 1) % SEG);
      const a2 = (r + 1) * SEG + c, b2 = (r + 1) * SEG + ((c + 1) % SEG);
      idx.push(a, a2, b2, a, b2, b);
    }
  }
  for (let c = 0; c < SEG; c++) {
    idx.push(RING * SEG + c, center, RING * SEG + ((c + 1) % SEG));
  }
  geo.setIndex(idx);

  // Bruit fige : le dessus du sable n'est jamais parfaitement lisse.
  const rnd = mulberry(1337);
  const bump = new Float32Array(SEG);
  for (let c = 0; c < SEG; c++) bump[c] = (rnd() - 0.5) * 2;

  /**
   * @param {number} fill    0..1
   * @param {number} wobble  0..1 — desordre du dessus (sable frais = 1)
   * @param {object} B       la description renvoyee par makeBucketGeometry()
   */
  function setLevel(fill, wobble, B) {
    const f = Math.max(0.0001, Math.min(1, fill));
    const inner = (t) => (B.rBottom - B.wall) +
                         ((B.rTop - B.wall) - (B.rBottom - B.wall)) * t;
    const y0 = B.wall * 1.05;               // on pose sur le fond interieur
    const y1 = y0 + (B.height - y0) * f;    // niveau atteint
    // Bombement central : le sable verse forme un petit cone (angle de repos).
    const dome = 0.10 * (B.rTop) * wobble;

    for (let r = 0; r <= RING; r++) {
      const t = r / RING;
      const y = y0 + (y1 - y0) * t;
      const tGlobal = (y - 0) / B.height;
      const R = inner(tGlobal) * (r === RING ? 0.995 : 1.0);
      for (let c = 0; c < SEG; c++) {
        const a = (c / SEG) * Math.PI * 2;
        const i = (r * SEG + c) * 3;
        const irregular = r === RING ? 1 + 0.045 * wobble * bump[c] : 1;
        pos[i]     = Math.cos(a) * R * irregular;
        pos[i + 1] = y + (r === RING ? 0.02 * dome * bump[c] : 0);
        pos[i + 2] = Math.sin(a) * R * irregular;
      }
    }
    pos[center * 3] = 0;
    pos[center * 3 + 1] = y1 + dome;
    pos[center * 3 + 2] = 0;

    geo.attributes.position.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
  }

  return { geometry: geo, setLevel };
}
```

> **Détail qui compte.** Le paramètre `wobble` passe de `1` (sable frais qu'on
> vient de verser, dessus bombé et irrégulier) à `0` après le tapotage
> (§3), où le dessus s'arase. C'est la traduction visuelle des étapes 5–8 du
> protocole de la Bible §2.4.1 : *tasser au poing, vibrer, araser*.

## 2.3 La pelle

```js
/**
 * Pelle de plage : manche + poignee en D + lame creuse.
 * La lame est une grille 5x5 deformee en cuillere. Elle est rendue en
 * DoubleSide : on la voit de dessus quand elle est chargee, de dessous quand
 * elle se vide. Une lame « solide » couterait le double pour rien a 18 px.
 *
 * Budget : manche 12 + D 80 + lame 32 + collier 12 = 136 triangles.
 */
export function makeShovelGeometry() {
  const L = 0.52;                 // longueur du manche, en metres, taille 1:1
  const parts = [];

  const shaft = new THREE.CylinderGeometry(0.011, 0.013, L, 6, 1, true);
  shaft.translate(0, L * 0.5, 0);
  parts.push(shaft);

  // Poignee en D : deux montants + un arc. Silhouette immediatement lisible.
  const d = makeArc(0.036, 0.007, -0.25, Math.PI + 0.25, 9);
  d.rotateY(Math.PI / 2);
  d.translate(0, L + 0.030, 0);
  parts.push(d);

  const collar = new THREE.CylinderGeometry(0.016, 0.016, 0.03, 6, 1, true);
  collar.translate(0, 0.02, 0);
  parts.push(collar);

  const blade = makeScoop(0.075, 0.115, 0.030);
  blade.rotateX(-0.22);            // la lame « ouvre » vers l'avant
  blade.translate(0, -0.055, 0.012);
  parts.push(blade);

  const g = mergeGeoms(parts);
  return g;
}

/**
 * Cuillere / creux : grille (N+1)x(N+1) projetee sur un paraboloide tronque,
 * avec un rebord releve. C'est LE helper reutilise par la pelle, la truelle
 * et la dame.
 */
function makeScoop(halfW, len, depth, N = 4) {
  const pos = [];
  const P = (u, v) => {
    // u : -1..1 en largeur, v : 0..1 en longueur (0 = talon, 1 = pointe)
    const taper = 1 - 0.42 * v * v;         // la lame s'affine vers la pointe
    const x = u * halfW * taper;
    const z = (v - 0.5) * len;
    // Creux : plus profond au talon, nul a la pointe. Le bord se releve.
    const y = -depth * (1 - v) * (1 - u * u) + depth * 0.35 * u * u * (1 - v);
    return [x, y, z];
  };
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const u0 = -1 + (2 * i) / N, u1 = -1 + (2 * (i + 1)) / N;
      const v0 = j / N, v1 = (j + 1) / N;
      const a = P(u0, v0), b = P(u1, v0), c = P(u1, v1), d = P(u0, v1);
      pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  return g;
}
```

### 2.3.1 La charge de sable sur la pelle

`Game.carried = { volume, moisture, packing }` existe déjà et n'a **aucune**
représentation visuelle. On lui en donne une : une calotte posée dans le creux
de la lame, dont le volume suit `carried.volume` (plafonné à 0,35 m³ dans
`tools.js`, ce qui est en réalité une unité arbitraire — voir §6.3).

```js
/**
 * Pelletee : demi-ellipsoide aplati, N=8 x 3 = 48 triangles.
 * `setLoad(v01)` change l'echelle : plein = 1, vide = 0 (mesh masque).
 */
export function makeShovelLoad() {
  const g = new THREE.SphereGeometry(1, 10, 4, 0, Math.PI * 2, 0, Math.PI * 0.5);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // Aplatissement + bosse aleatoire figee : ca doit ressembler a un tas,
    // pas a un dome de cathedrale.
    const n = 0.9 + 0.18 * Math.sin(x * 23) * Math.cos(z * 19);
    p.setXYZ(i, x * 0.072 * n, y * 0.030 * n, z * 0.100 * n);
  }
  g.computeVertexNormals();
  return g;
}
```

## 2.4 L'arrosoir

```js
/**
 * Arrosoir : corps par revolution, anse en pont, goulot incline, pomme
 * d'arrosage percee (les trous sont suggeres par un disque sombre, pas
 * modelises : a 18 px on ne les verrait pas, et ils couteraient 200 tris).
 *
 * Budget : corps 112 + anse 80 + goulot 24 + pomme 48 = 264 triangles.
 */
export function makeWateringCanGeometry() {
  const H = 0.20, R = 0.085;
  const P = (x, y) => new THREE.Vector2(x, y);
  const body = new THREE.LatheGeometry([
    P(0, 0), P(R * 0.85, 0), P(R, 0.03),
    P(R * 0.98, H * 0.72), P(R * 0.80, H * 0.93),
    P(R * 0.62, H), P(R * 0.58, H - 0.012),   // levre rentrante
    P(0, H - 0.012),
  ], 14);

  const parts = [];

  // Anse en pont, d'arriere en haut : c'est elle qui donne la silhouette.
  const handle = makeArc(R * 0.9, 0.006, 0.35, Math.PI - 0.35, 8);
  handle.rotateY(Math.PI / 2);
  handle.translate(0, H * 0.80, -R * 0.25);
  parts.push(handle);

  // Goulot : cylindre incline qui part du bas du corps et monte.
  const spout = new THREE.CylinderGeometry(0.011, 0.016, 0.19, 6, 1, true);
  spout.rotateX(-0.62);
  spout.translate(0, H * 0.52, R * 0.72);
  parts.push(spout);

  // Pomme : disque bombe au bout du goulot.
  const rose = new THREE.SphereGeometry(0.028, 8, 3, 0, Math.PI * 2, 0, Math.PI * 0.42);
  rose.scale(1, 0.55, 1);
  rose.rotateX(-0.62 + Math.PI * 0.5);
  rose.translate(0, H * 0.52 + 0.088, R * 0.72 + 0.055);
  parts.push(rose);

  return { body, rest: mergeGeoms(parts), height: H, radius: R };
}
```

### 2.4.1 Le niveau d'eau, visible

Même principe que le sable dans le seau, avec un disque translucide qui
descend au fur et à mesure. **Nouveauté de jeu** : aujourd'hui l'arrosoir est
infini. Lui donner un réservoir de 8 L (⚠︎ un arrosoir de plage réel fait 1 à
2 L, 8 L est un compromis de confort) qui se vide en ~14 s d'arrosage continu
et se recharge en le plongeant dans l'eau de mer ou dans un trou d'eau, c'est :

- une **jauge diégétique gratuite** (§6) ;
- un **rappel de la boucle du jeu** : il faut aller chercher l'eau, ce qui est
  littéralement l'étape 1 de tous les protocoles de la Bible ;
- **zéro interface supplémentaire**.

C'est le seul changement de règles que ce document propose sur un outil autre
que le seau, et il est optionnel (phase 6 du plan).

## 2.5 La truelle

```js
/**
 * Truelle langue-de-chat (Bible §3.3.1 : Marshalltown 7" x 3", soit
 * 18 x 7,5 cm). Lame triangulaire biseautee obtenue par extrusion avec
 * biseau, plus manche et soie.
 *
 * Budget : lame ~72 + manche 12 + soie 12 = 96 triangles.
 */
export function makeTrowelGeometry() {
  const shape = new THREE.Shape();
  const L = 0.18, W = 0.075;
  shape.moveTo(0, L * 0.55);                  // pointe
  shape.quadraticCurveTo(W * 0.52, L * 0.02, W * 0.46, -L * 0.34);
  shape.quadraticCurveTo(W * 0.30, -L * 0.46, 0, -L * 0.45);
  shape.quadraticCurveTo(-W * 0.30, -L * 0.46, -W * 0.46, -L * 0.34);
  shape.quadraticCurveTo(-W * 0.52, L * 0.02, 0, L * 0.55);

  const blade = new THREE.ExtrudeGeometry(shape, {
    depth: 0.0018, bevelEnabled: true,
    bevelSize: 0.0035, bevelThickness: 0.0016, bevelSegments: 1,
    curveSegments: 5,
  });
  blade.rotateX(-Math.PI / 2);

  const parts = [blade];
  const tang = new THREE.CylinderGeometry(0.005, 0.005, 0.045, 5, 1, true);
  tang.rotateZ(0.0); tang.translate(0, 0.026, -L * 0.30);
  parts.push(tang);

  const grip = new THREE.CylinderGeometry(0.014, 0.011, 0.085, 6, 1, true);
  grip.rotateX(0.22);
  grip.translate(0, 0.062, -L * 0.36);
  parts.push(grip);

  return mergeGeoms(parts);
}
```

## 2.6 La mirette

```js
/**
 * Mirette (loop tool, Bible §3.3.2) : manche + soie + boucle metallique.
 * Le seul outil dont l'element actif est un TROU — la boucle doit donc etre
 * un vrai anneau ferme, sinon la lecture s'effondre.
 *
 * Budget : manche 12 + soie 8 + boucle 96 = 116 triangles.
 */
export function makeCarveGeometry() {
  const parts = [];
  const grip = new THREE.CylinderGeometry(0.009, 0.0075, 0.10, 6, 1, true);
  grip.translate(0, 0.055, 0);
  parts.push(grip);

  const stem = new THREE.CylinderGeometry(0.0022, 0.0022, 0.055, 4, 1, true);
  stem.rotateX(0.30);
  stem.translate(0, -0.020, 0.008);
  parts.push(stem);

  // Boucle : arc complet en section carree, incline dans le prolongement.
  const loop = makeArc(0.022, 0.0016, 0, Math.PI * 2, 12);
  loop.rotateX(Math.PI * 0.5 + 0.30);
  loop.translate(0, -0.058, 0.024);
  parts.push(loop);

  return mergeGeoms(parts);
}
```

## 2.7 Le râteau

```js
/**
 * Rateau : manche, traverse, dents. Le nombre de dents suit `tool.spacing`
 * (0.02 a 0.22 m), donc la geometrie est REGENEREE quand l'ecartement change
 * — evenement rare (molette + Maj) et geometrie minuscule.
 *
 * Budget : manche 12 + traverse 12 + 5 a 9 dents x 8 = 64 a 96 triangles.
 */
export function makeRakeGeometry(spacing = 0.05, width = 0.28) {
  const parts = [];
  const L = 0.44;
  const shaft = new THREE.CylinderGeometry(0.010, 0.012, L, 6, 1, true);
  shaft.rotateX(0.30);
  shaft.translate(0, L * 0.48, -0.05);
  parts.push(shaft);

  const bar = new THREE.BoxGeometry(width, 0.014, 0.016);
  parts.push(bar);

  const n = Math.max(3, Math.min(9, Math.round(width / Math.max(0.02, spacing)) + 1));
  for (let i = 0; i < n; i++) {
    const x = -width * 0.5 + (width * i) / (n - 1);
    const tooth = new THREE.CylinderGeometry(0.0022, 0.0042, 0.052, 4, 1, true);
    tooth.translate(x, -0.030, 0);
    parts.push(tooth);
  }
  return mergeGeoms(parts);
}
```

## 2.8 La « main » : une dame, pas une main

```js
/**
 * Dame / tamper (Bible §3.1) : plaque + manche court. Remplace la main.
 * On la fait volontairement PETITE (12 cm de cote) pour qu'elle lise comme un
 * outil de main et non comme une dame de terrassier de 20 cm.
 *
 * Budget : plaque 32 + manche 12 + poignee 24 = 68 triangles.
 */
export function makeTamperGeometry() {
  const parts = [];
  const plate = makeScoop(0.060, 0.100, 0.004, 3);   // presque plate
  plate.rotateX(Math.PI);                            // creux vers le haut
  parts.push(plate);

  const rim = new THREE.BoxGeometry(0.120, 0.010, 0.100);
  rim.translate(0, 0.006, 0);
  parts.push(rim);

  const shaft = new THREE.CylinderGeometry(0.010, 0.010, 0.10, 6, 1, true);
  shaft.translate(0, 0.062, 0);
  parts.push(shaft);

  const knob = new THREE.SphereGeometry(0.017, 7, 4);
  knob.scale(1, 0.75, 1);
  knob.translate(0, 0.118, 0);
  parts.push(knob);

  return mergeGeoms(parts);
}
```

**Pour la gomme**, pas d'objet : c'est un outil « meta » sans équivalent
physique. On garde l'anneau du shader seul, et on lui donne un traitement
visuel différent (anneau pointillé, plus large, gris) pour dire « ceci n'est
pas un geste, c'est une commande ».

## 2.9 Récapitulatif de budget

| Outil | Éléments | Triangles | Draw calls |
|---|---|---|---|
| Seau | coque, anse, sable, débord | 256 + 96 + 128 | 3 |
| Pelle | manche, D, lame, charge | 136 + 48 | 2 |
| Arrosoir | corps, anse+goulot+pomme, eau | 112 + 152 + 48 | 3 |
| Truelle | lame + manche | 96 | 1 |
| Mirette | manche + boucle | 116 | 1 |
| Râteau | manche + dents | 64–96 | 1 |
| Dame | plaque + manche | 68 | 1 |
| Seau d'eau | = seau + contenu eau | 352 + 48 | 3 |
| Gomme | — (anneau shader) | 0 | 0 |

**Maximum instantané : 480 triangles et 3 draw calls**, puisqu'un seul outil est
visible à la fois. À comparer aux ~200 000 triangles du terrain : c'est
**0,24 %** du budget. Le coût réel est l'ombre portée (une passe de plus dans la
shadow map), qui est ce qu'on paie le plus volontiers.

---

<a name="3-le-seau"></a>
# 3. LE SEAU, EN DÉTAIL

C'est l'exemple donné par le joueur : on le traite jusqu'au bout.

## 3.1 Ce qui existe déjà, et ce qu'on garde

`tools.js` implémente déjà le bon squelette :

- `down()` remet `fill`, `fillMoist`, `fillPack` à zéro ;
- `apply()` creuse vraiment sous le curseur et fait monter `fill` de 0 à 1 ;
- `up()` calcule `demouldQuality(fillMoist, packing)` et appelle
  `B.stampBucket()` qui écrit une tour tronconique dans le champ de voxels,
  avec un gauchissement (`wob`) et un affaissement (`slump`) proportionnels à
  `1 - quality`.

**Tout le modèle est là. Il ne lui manque qu'un corps et du temps.** Le
problème actuel : `up()` fait tout en une frame. Le joueur relâche, une tour
apparaît. Aucune des huit étapes du protocole réel n'est jouée.

## 3.2 Les cinq temps (le joueur en a demandé quatre, il en faut cinq)

| # | Temps | Déclenché par | Durée | Courbe |
|---|---|---|---|---|
| 0 | **Approcher** | mouvement souris | — | ressort continu |
| 1 | **Remplir** | bouton maintenu | **libre** (≈ 1,1 s pour remplir) | — |
| 2 | **Soulever et retourner** | relâchement | 0,07 + 0,22 + 0,34 s | anticipation → `outCubic` → `inOutBack` |
| 3 | **Poser et tapoter** | automatique | 0,18 + 0,42 s | `inQuad` puis 3 impulsions |
| 4 | **Attendre le drainage** | automatique | 0,15 s | immobile |
| 5 | **Soulever et découvrir** | automatique | 0,55 s | `inOutSine` lent au départ |
| 6 | **Résultat** | automatique | 0,30 s | — |
| 7 | **Retour à la main** | automatique | 0,35 s | `outCubic` |

**Total : 1,88 s** hors remplissage. C'est long pour une action de jeu — et
c'est assumé : c'est la scène payante du jeu, celle que le joueur a demandée.
Deux soupapes :

1. **Un clic pendant la séquence l'accélère ×2,5** (elle tombe à 0,75 s). Le
   joueur pressé n'est jamais bloqué. C'est la règle d'or des cinématiques
   courtes : jamais d'attente non-interruptible.
2. **Le curseur reste actif** : on peut déjà viser ailleurs pendant que le seau
   finit son travail.

### Détail temps par temps

**Temps 0 — approcher.** Le seau flotte, légèrement incliné, à ~8 cm au-dessus
de la surface visée, anse pendante. Sa bouche est tournée vers le bas quand il
est vide (comme on porte un seau vide) et **se redresse** quand `fill > 0`
(comme on porte un seau plein). Ce simple basculement de 25° dit tout.

**Temps 1 — remplir.** À chaque `apply()`, `fill` monte. Trois choses arrivent
en même temps :
- le maillage de sable intérieur monte (`setLevel(fill, wobble = 1)`) ;
- un **filet de grains** tombe en continu du point de creusement vers la bouche
  du seau (§5) — c'est ce qui explique visuellement d'où vient le sable ;
- le seau **s'enfonce de 2 cm** dans le sable pendant le maintien (le joueur
  appuie) et **s'alourdit** : la constante de raideur du ressort de suivi
  descend de 3,5 Hz à 2,1 Hz quand `fill` passe de 0 à 1. Un seau plein
  traîne davantage. **C'est le retour de poids le plus efficace du lot, et il
  coûte une ligne.**

À `fill ≥ 0,98` : quelques grains **débordent** par-dessus le bourrelet et
tombent le long de la paroi, et `audio.play('bucketFull')` (déjà présent).

**Temps 2 — soulever et retourner.** Le relâchement déclenche la séquence.
- 0,07 s d'**anticipation** : le seau descend de 1,5 cm (`outQuad`). Rien ne
  monte sans être d'abord descendu.
- 0,22 s de **levée** de 14 cm (`outCubic` : rapide puis freinée).
- 0,34 s de **retournement** de 180° autour de l'axe horizontal
  perpendiculaire à la direction caméra, avec `inOutBack` (dépassement de 8°,
  puis retour). Le pivot est le **centre de masse du contenu**, pas l'origine
  de l'objet : sinon le seau décrit un arc absurde.
- Pendant le retournement, la surface de sable **reste collée** au seau
  (`wobble` tombe à 0,15) : elle est tassée, donc solidaire. Un seau mal rempli
  (`fillPack` faible) laisse tomber quelques grains à mi-rotation — c'est
  l'annonce de l'échec.

**Temps 3 — poser et tapoter.**
- 0,18 s de **descente** (`inQuad` : accélérée), contact au sol. À l'impact :
  couronne de poussière + `audio.play('bucketSet')` + **écrasement de l'outil**
  (scale Y ×0,94 / XZ ×1,03, relâché en 0,18 s par `outElastic`).
- 3 **tapes** de 0,14 s : le seau descend de 6 mm et remonte (demi-sinusoïde).
  Chaque tape : un anneau de 6 grains qui glisse au pied du seau, un « toc »
  sourd, et `wobble` qui descend de 0,15 vers 0 (le sable s'arase).

**Temps 4 — le drainage.** 0,15 s d'immobilité totale. C'est l'étape 9 de la
Bible (« attendre que l'eau libre ait disparu ») **et** l'astuce technique la
plus importante du document :

> **C'est ici qu'on appelle `B.stampBucket()`.** La tour est écrite dans le
> champ de voxels *pendant que le seau est encore posé dessus et la cache
> intégralement*. Le remaillage asynchrone de `MesherPool` (typiquement
> 60–150 ms pour deux ou trois chunks) a donc le temps de finir avant que le
> seau ne commence à se lever. **Le joueur ne voit jamais un chunk apparaître :
> il voit un seau se lever sur une tour déjà là.** L'illusion est parfaite et
> ne demande aucun shader.

**Temps 5 — découvrir.** 0,55 s de levée verticale de `hauteur + 6 cm`,
courbe `inOutSine` **volontairement lente au départ** : c'est l'instruction
littérale de la Bible (« lever bien droit, vertical, lentement mais sans
arrêt »). Aucune rotation pendant cette phase — le moindre lacet trahirait la
règle. La tour se découvre du haut vers le bas.

**Temps 6 — résultat.** Un fin nuage de poussière retombe au pied, un anneau
de grains marque le joint, un toast s'affiche.

**Temps 7 — retour.** Le seau revient à la verticale au-dessus du curseur en
0,35 s. S'il est resté plein (échec « trop sec »), il revient **plein**, ce qui
est en soi le message d'erreur.

## 3.3 Ce qui coule, ce qui vole, ce qui goutte

| Événement | Émission | Détail |
|---|---|---|
| Remplissage | flux de 90 grains/s, `kind = 0` ou `1` selon l'humidité | du point de creusement vers la bouche, vitesse initiale 0,6 m/s vers le bas |
| Seau plein | 14 grains en bouffée | débordent du bourrelet, glissent le long de la paroi |
| Retournement raté (`fillPack < 0,3`) | 8 grains à mi-rotation | annonce l'échec 0,9 s à l'avance |
| Pose au sol | 24 particules `kind = 2` (poussière) en anneau | vitesse radiale 0,5 m/s, gravité 0,3× |
| Chaque tape | 6 grains | tombent le long de la paroi |
| Levée / démoulage réussi | 30 poussières + 12 grains | anneau au pied de la tour |
| Démoulage raté | 60 poussières + 40 grains | et `granular.wakeBox()` sur la tour |
| Seau mouillé (`fillMoist > 0,25`) | 1 goutte toutes les 0,25 s | depuis le point bas du bourrelet, tant que le seau est porté |

Le dernier point est le plus « sensoriel » du lot : **un seau qui a servi à
transporter du sable saturé goutte pendant qu'on le porte**. Deux lignes de
code, un détail que personne ne demande et que tout le monde remarque.

## 3.4 Les échecs

`demouldQuality(w, p)` renvoie déjà une note continue. On la découpe en quatre
issues, au lieu d'une seule :

```js
// Quatre issues, decidees a l'instant du relachement.
//   q >= 0.55  -> 'clean'    tour nette
//   q >= 0.22  -> 'slump'    tour affaissee, flancs gauchis (deja gere par
//                            stampBucket via `wob` et `slump`)
//   sec        -> 'stuck'    le sable NE SORT PAS : il reste dans le seau
//   mouille    -> 'collapse' la tour sort et s'ecroule sur elle-meme
```

**`stuck` (sable trop sec, `fillMoist < 0.05`).** Physiquement juste : du sable
sec n'a aucune cohésion, il ne tient pas la forme du moule, il retombe *dans le
seau* dès qu'on le retourne. Conséquence de jeu :

- on n'appelle **pas** `stampBucket` ;
- `fill` est **conservé** ;
- le seau se relève **encore plein**, et le sable dedans est visiblement sec
  (couleur plus claire) ;
- toast : « Trop sec — le sable est resté dans le seau. Clic droit pour le
  vider, arrosoir pour mouiller. » ;
- **il faut vider le seau** (clic droit) avant de pouvoir le remplir à nouveau.

C'est la seule vraie punition du jeu, et elle est parfaite : elle coûte trois
secondes, elle est parfaitement lisible (le seau *est* le message), et elle
enseigne la règle numéro un du sable.

**`collapse` (sable trop mouillé, `fillMoist > 0.30`).** La tour sort, puis
s'affaisse. Implémentation : on stampe avec `quality = 0.05` (donc gauchissement
et affaissement maximaux) **puis** on réveille le simulateur granulaire sur la
boîte de la tour. Le sable trop humide a un angle de repose de 45° à 22° selon
`REPOSE_CURVE` : `Granular` fera le travail tout seul, et la tour s'étalera en
galette sous les yeux du joueur, avec le son `collapse` déjà câblé dans
`Game.update()`. **Aucun code d'effondrement spécifique à écrire** — c'est tout
l'intérêt d'avoir une vraie simulation.

## 3.5 Le code complet de la machine à états

```js
// ---------------------------------------------------------------------------
// src/render/BucketRig.js
//
// Le seau : geometrie, contenu, et la sequence de demoulage en sept temps.
//
// Le rig ne DECIDE de rien : il est pilote par `tools.js` (qui garde toute la
// logique de jeu) et il rend la main via des callbacks. C'est la meme
// separation que Props.js, qui ne connait que `field` et jamais le gameplay.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { makeBucketGeometry, makeBucketSand, TOOL_MATERIALS, BUCKET_ASPECT } from './ToolGeometry.js';
import { Ease, damp, Spring3 } from './Ease.js';

/** Table des phases. Modifier ici change tout le rythme. */
const PHASES = [
  { id: 'anticipate', dur: 0.07 },
  { id: 'lift',       dur: 0.22 },
  { id: 'flip',       dur: 0.34 },
  { id: 'lower',      dur: 0.18 },
  { id: 'tap',        dur: 0.42 },
  { id: 'settle',     dur: 0.15 },   // <- c'est ici qu'on stampe
  { id: 'reveal',     dur: 0.55 },
  { id: 'result',     dur: 0.30 },
  { id: 'ret',        dur: 0.35 },
];
const PHASE_INDEX = Object.fromEntries(PHASES.map((p, i) => [p.id, i]));

const UP = new THREE.Vector3(0, 1, 0);

export class BucketRig {
  /**
   * @param {THREE.Group} parent  le groupe de l'outil (porte par ToolAvatar)
   * @param {object} deps { particles, audio, onStamp, onResult }
   */
  constructor(parent, deps) {
    this.deps = deps;
    this.group = new THREE.Group();
    parent.add(this.group);

    const B = makeBucketGeometry();
    this.B = B;
    this.shell = new THREE.Mesh(B.shell, TOOL_MATERIALS.yellow());
    this.handle = new THREE.Mesh(B.handle, TOOL_MATERIALS.metal());
    const sand = makeBucketSand(16, 3);
    this.sandSet = sand.setLevel;
    this.sand = new THREE.Mesh(sand.geometry, TOOL_MATERIALS.sandWet());

    for (const m of [this.shell, this.handle, this.sand]) {
      m.castShadow = true; m.receiveShadow = true;
      this.group.add(m);
    }
    // Le seau est construit a rayon de bouche 1 : l'echelle porte le rayon.
    this.group.scale.setScalar(0.15);

    /** Etat visuel. */
    this.fill = 0;
    this.wobble = 1;
    this.phase = -1;          // -1 = au repos / en remplissage
    this.t = 0;               // temps ecoule dans la phase
    this.speed = 1;           // x2.5 si le joueur clique pour accelerer
    this.outcome = null;      // 'clean' | 'slump' | 'stuck' | 'collapse'
    this.anchor = new THREE.Vector3();   // point au sol ou le seau demoule
    this.height = 0;          // hauteur de la tour a demouler (m)
    this.radius = 0.15;
    this.dripTimer = 0;
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._axis = new THREE.Vector3();
  }

  get busy() { return this.phase >= 0; }

  /** Met a jour le contenu visible pendant le remplissage. */
  setFill(fill, moisture) {
    this.fill = fill;
    this.sand.visible = fill > 0.004;
    if (this.sand.visible) this.sandSet(fill, this.wobble, this.B);
    // Sable sec = plus clair. C'est le premier avertissement d'echec, et il
    // arrive AVANT le demoulage : le joueur peut encore corriger.
    const dry = 1 - Math.min(1, moisture / 0.16);
    this.sand.material.color.setRGB(
      0.61 + 0.21 * dry, 0.52 + 0.20 * dry, 0.38 + 0.19 * dry);
  }

  setRadius(r) {
    this.radius = r;
    this.group.scale.setScalar(r);
  }

  /**
   * Lance la sequence de demoulage.
   * @param {THREE.Vector3} at   point de pose au sol
   * @param {string} outcome     issue decidee par tools.js
   * @param {number} height      hauteur de la tour, en metres
   */
  demould(at, outcome, height) {
    this.anchor.copy(at);
    this.outcome = outcome;
    this.height = height;
    this.phase = 0;
    this.t = 0;
    this.speed = 1;
    this._stamped = false;
    this._taps = 0;
  }

  /** Un clic pendant la sequence l'accelere. Jamais de blocage. */
  hurry() { if (this.busy) this.speed = 2.5; }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} restPos position de repos (suivi du curseur)
   * @returns {boolean} true si le rig pilote la position (sequence en cours)
   */
  update(dt, restPos) {
    // --- gouttes : un seau qui a porte du sable sature s'egoutte -----------
    if (this.fill > 0.05 && this._moist > 0.25) {
      this.dripTimer -= dt;
      if (this.dripTimer <= 0) {
        this.dripTimer = 0.25 / Math.min(3, (this._moist - 0.2) * 12);
        const p = this.group.getWorldPosition(this._v);
        this.deps.particles?.spawn(3,
          p.x + (Math.random() - 0.5) * this.radius * 1.6,
          p.y + this.radius * 0.1,
          p.z + (Math.random() - 0.5) * this.radius * 1.6,
          0, -0.2, 0);
      }
    }

    if (!this.busy) return false;

    const ph = PHASES[this.phase];
    this.t += dt * this.speed;
    const u = Math.min(1, this.t / ph.dur);

    switch (ph.id) {
      case 'anticipate': this._poseAnticipate(u, restPos); break;
      case 'lift':       this._poseLift(u, restPos);       break;
      case 'flip':       this._poseFlip(u);                break;
      case 'lower':      this._poseLower(u);               break;
      case 'tap':        this._poseTap(u);                 break;
      case 'settle':     this._poseSettle(u);              break;
      case 'reveal':     this._poseReveal(u);              break;
      case 'result':     this._poseResult(u);              break;
      case 'ret':        this._poseReturn(u, restPos);     break;
    }

    if (u >= 1) {
      this.t = 0;
      this.phase++;
      if (this.phase >= PHASES.length) { this.phase = -1; this._onEnd(); }
      else this._onPhaseStart(PHASES[this.phase].id);
    }
    return true;
  }

  // --- poses ---------------------------------------------------------------

  _poseAnticipate(u, rest) {
    // Descendre AVANT de monter : sans ca, la levee n'a aucun poids.
    this.group.position.copy(rest);
    this.group.position.y -= 0.015 * Ease.outQuad(u);
    this.group.quaternion.identity();
  }

  _poseLift(u, rest) {
    const e = Ease.outCubic(u);
    this.group.position.lerpVectors(rest, this._liftTarget(rest), e);
    this.group.quaternion.identity();
  }

  _liftTarget(rest) {
    return this._v.set(this.anchor.x, this.anchor.y + 0.14 + this.height, this.anchor.z);
  }

  _poseFlip(u) {
    // inOutBack : le seau depasse de 8 deg puis revient. C'est le geste
    // « franc et continu » de la Bible §2.4.1 etape 10.
    const e = Ease.inOutBack(u, 0.9);
    const ang = Math.PI * e;
    this._axis.set(1, 0, 0).applyQuaternion(this._camYaw || new THREE.Quaternion());
    this.group.quaternion.setFromAxisAngle(this._axis, ang);
    // Le pivot est le centre de masse du contenu, pas l'origine du mesh :
    // on compense la translation induite par la rotation.
    const cy = this.height * 0.5;
    this.group.position.y = this.anchor.y + 0.14 + this.height - cy * (1 - Math.cos(ang));
    // Le sable se decolle si le tassement est mauvais : annonce de l'echec.
    if (this.outcome === 'stuck' || this.outcome === 'collapse') {
      if (u > 0.45 && u < 0.55) this._spill(8);
    }
  }

  _poseLower(u) {
    const e = Ease.inQuad(u);
    this.group.position.y = THREE.MathUtils.lerp(
      this.anchor.y + 0.14 + this.height * 0.5, this.anchor.y + this.height, e);
    if (u >= 1) {
      this.deps.audio?.play('bucketSet');
      this.deps.particles?.ring(2, this.anchor, this.radius * 1.15, 24, 0.5);
      this._squash = 1;                 // ecrasement a l'impact
    }
  }

  _poseTap(u) {
    // Trois impulsions : |sin(3 pi u)|, decroissantes.
    const n = 3;
    const s = Math.abs(Math.sin(Math.PI * n * u)) * (1 - u * 0.4);
    this.group.position.y = this.anchor.y + this.height - 0.006 * s;
    const tap = Math.floor(u * n);
    if (tap !== this._taps) {
      this._taps = tap;
      this.deps.audio?.play('bucketTap');
      this.deps.particles?.ring(0, this.anchor, this.radius * 1.05, 6, 0.25);
      // Le sable s'arase a chaque tape (Bible etape 8).
      this.wobble = Math.max(0, this.wobble - 0.35);
      this.sandSet(this.fill, this.wobble, this.B);
    }
  }

  _poseSettle(u) {
    this.group.position.y = this.anchor.y + this.height;
    if (!this._stamped) {
      this._stamped = true;
      // ICI. La tour est ecrite pendant que le seau la cache entierement :
      // le remaillage asynchrone a 150 ms pour se terminer.
      this.deps.onStamp?.(this.outcome);
    }
  }

  _poseReveal(u) {
    // « Lever bien droit, vertical, lentement mais sans arret. »
    const e = Ease.inOutSine(u);
    this.group.position.y = this.anchor.y + this.height + (this.height + 0.06) * e;
    this.group.position.x = this.anchor.x;
    this.group.position.z = this.anchor.z;
    // Le contenu descend au fur et a mesure qu'il « reste » dans la tour —
    // sauf si le sable est colle au seau (echec 'stuck').
    if (this.outcome !== 'stuck') {
      this.fill = Math.max(0, this.fill * (1 - e));
      this.setFill(this.fill, this._moist ?? 0.12);
    }
  }

  _poseResult(u) {
    if (u < 0.03) {
      const n = this.outcome === 'clean' ? 30 : 60;
      this.deps.particles?.ring(2, this.anchor, this.radius * 1.3, n, 0.6);
      this.deps.onResult?.(this.outcome);
    }
  }

  _poseReturn(u, rest) {
    const e = Ease.outCubic(u);
    this.group.position.lerp(rest, e);
    this.group.quaternion.slerp(new THREE.Quaternion(), e);
  }

  _spill(n) {
    const p = this.group.getWorldPosition(this._v);
    this.deps.particles?.burst(1, p.x, p.y, p.z, n, { speed: 0.5, spread: 0.6 });
  }

  _onPhaseStart(id) {
    if (id === 'flip') this.wobble = 0.15;   // le sable est solidaire du seau
  }

  _onEnd() {
    if (this.outcome !== 'stuck') { this.fill = 0; this.setFill(0, 0.12); }
    this.wobble = 1;
    this.speed = 1;
  }
}
```

## 3.6 Le branchement dans `tools.js`

Les modifications restent **chirurgicales** : `down`, `apply` et `up` gardent
exactement leur rôle, on ajoute la conduite du rig.

```js
// --- src/tools/tools.js — outil « bucket », version corps physique ---------

import { BUCKET_ASPECT } from '../render/ToolGeometry.js';

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
    // Un clic pendant la sequence l'ACCELERE. Jamais de blocage.
    if (rig?.busy) { rig.hurry(); return; }
    if (s.button === 2) {                 // clic droit : vider le seau
      if (s.tool.fill > 0.02) {
        const p = s.hit.point;
        B.sphere(s.ctx, p.x, p.y + s.radius * 0.3, p.z, s.radius * 0.9,
          200 * s.tool.fill, { moisture: s.tool.fillMoist, packing: 0.1, hardness: 0.15 });
        s.game.audio?.play('pour', { moisture: s.tool.fillMoist });
        s.tool.fill = 0; s.tool.stuck = false;
        rig?.setFill(0, 0.12);
      }
      return;
    }
    if (s.tool.stuck) {
      s.game.toast('Le seau est encore plein — clic droit pour le vider.');
      return;
    }
    s.tool.fill = 0; s.tool.fillMoist = 0; s.tool.fillPack = 0;
  },

  apply(s) {
    if (s.button !== 0 || s.tool.stuck) return;
    const rig = s.game.toolAvatar?.bucket;
    if (rig?.busy) return;
    const p = s.hit.point;
    const t = s.tool;
    if (t.fill >= 1) return;

    const w = s.game.field.averageMoisture(p.x, p.y, p.z, s.radius);
    const pk = s.game.field.averagePacking(p.x, p.y, p.z, s.radius);
    const v = B.sphere(s.ctx, p.x, p.y, p.z, s.radius * 0.85, -180 * s.dt * 30, { hardness: 0.25 });
    const got = -v;

    // Capacite EXACTE du tronc de cone dessine a l'ecran :
    //   V = (pi h / 3)(R^2 + R r + r^2), avec r = 0.86 R et h = ASPECT * R.
    //   -> V = 0.8665 * pi * R^2 * h
    const R = s.radius;
    const capacity = 0.8665 * Math.PI * R * R * (BUCKET_ASPECT * R);

    const before = t.fill;
    t.fill = clamp(t.fill + got / capacity, 0, 1);
    const added = t.fill - before;
    if (added > 0) {
      t.fillMoist = (t.fillMoist * before + w * added) / t.fill;
      t.fillPack = (t.fillPack * before + pk * added) / t.fill;
      // Filet de sable qui coule vers la bouche du seau.
      s.game.particles?.stream(w > 0.08 ? 1 : 0, p.x, p.y + 0.02, p.z, 90, s.dt,
        { speed: 0.6, spread: 0.25, down: true });
    }
    s.game.toolAvatar?.bucket?.setFill(t.fill, t.fillMoist);

    if (t.fill >= 1 && !t.fullNotified) {
      t.fullNotified = true;
      s.game.audio?.play('bucketFull');
      s.game.particles?.ring(0, p, s.radius * 1.0, 14, 0.35);   // debordement
    }
  },

  up(s) {
    const t = s.tool;
    t.fullNotified = false;
    if (s.button !== 0) return;
    if (t.fill < 0.08) { t.fill = 0; s.game.toolAvatar?.bucket?.setFill(0, 0); return; }

    const p = s.hit.point;
    const packing = clamp(t.fillPack + 0.25, 0, 1);
    const q = demouldQuality(t.fillMoist, packing);
    const r = s.radius;
    const h = BUCKET_ASPECT * r * t.fill;

    // --- l'issue est decidee MAINTENANT, la sequence ne fait que la jouer ---
    let outcome;
    if (t.fillMoist < 0.05) outcome = 'stuck';
    else if (t.fillMoist > 0.30 || q < 0.22) outcome = 'collapse';
    else if (q >= 0.55) outcome = 'clean';
    else outcome = 'slump';

    const rig = s.game.toolAvatar?.bucket;
    if (!rig) {                       // secours : pas de rig -> comportement actuel
      B.stampBucket(s.ctx, p.x, p.y - r * 0.15, p.z, r, r * 0.86, h, t.fillMoist, packing, q);
      t.fill = 0;
      return;
    }

    // Le groupe d'annulation doit survivre a la sequence : on le rouvre au
    // moment du stamp, et on le referme a la fin. ToolManager.endStroke() a
    // deja ferme celui du remplissage — c'est voulu : « remplir » et
    // « demouler » sont deux actions annulables distinctes.
    rig._moist = t.fillMoist;
    rig.demould(new THREE.Vector3(p.x, p.y - r * 0.15, p.z), outcome, h);

    rig.deps.onStamp = () => {
      s.game.tools.undo.beginGroup('Demoulage');
      if (outcome !== 'stuck') {
        const qq = outcome === 'collapse' ? 0.05 : q;
        B.stampBucket(s.ctx, p.x, p.y - r * 0.15, p.z, r, r * 0.86, h, t.fillMoist, packing, qq);
      }
      s.game.tools.undo.endGroup();
    };

    rig.deps.onResult = (out) => {
      if (out === 'collapse') {
        // On ne code AUCUN effondrement : on reveille le simulateur granulaire
        // et la physique fait le travail, avec le son deja cable dans Game.
        const R = Math.ceil((r * 1.6) / 0.04);
        const HH = Math.ceil((h + 0.1) / 0.04);
        const v = { x: (p.x + 5.12) / 0.04, y: p.y / 0.04, z: (p.z + 5.12) / 0.04 };
        s.game.granular.wakeBox(v.x - R, v.y - 1, v.z - R, v.x + R, v.y + HH, v.z + R);
      }
      s.game.audio?.play(out === 'clean' ? 'demouldGood' : 'demouldBad',
                         { moisture: t.fillMoist });
      s.game.toast(
        out === 'clean'    ? 'Beau demoulage !' :
        out === 'slump'    ? 'Demoulage correct — tasse davantage' :
        out === 'stuck'    ? 'Trop sec — le sable est reste dans le seau. Clic droit pour le vider.'
                           : 'Trop mouille — la tour s affaisse');
      if (out === 'stuck') { t.stuck = true; }
      else { t.fill = 0; t.stuck = false; }
    };
  },
}
```

> **Point d'attention sur l'annulation.** `ToolManager.onUp()` appelle `up()`
> puis `endStroke()`, qui ferme le groupe d'annulation *avant* que la séquence
> ne stampe. C'est pour cela que `onStamp` rouvre son propre groupe
> « Démoulage ». Résultat : `Ctrl+Z` annule le démoulage sans annuler le
> creusement du remplissage, ce qui est exactement ce que le joueur attend.

---

<a name="4-animation"></a>
# 4. ANIMATION ET SENSATION

## 4.1 Le suivi du curseur : retard et inclinaison

### Pourquoi pas `AnimationMixer`

`THREE.AnimationMixer` sert à jouer des `AnimationClip` **préenregistrés**, avec
des `KeyframeTrack` figées. Il est excellent pour un personnage skinné importé
d'un glTF. Ici :

- **il n'y a pas de clip** : tout est procédural, et la moitié des paramètres
  (hauteur de la tour, rayon de l'outil, humidité) ne sont connus qu'au
  moment du geste ;
- **il n'y a pas de squelette** : nos outils sont des `Group` de 2 à 4 meshes ;
- **le mixer n'a pas d'état continu piloté** : nos poses sont des fonctions
  d'un `u` normalisé, il n'y a rien à mélanger ;
- **il ajoute une dépendance et une couche d'indirection** pour 0 bénéfice.

**Verdict : tween manuel**, avec une petite bibliothèque d'easings et un
ressort. C'est 60 lignes, c'est déterministe, et c'est exactement l'esprit du
reste du dépôt (`DioramaControls` fait déjà son propre amortissement).

### Le module `Ease.js`

```js
// ---------------------------------------------------------------------------
// src/render/Ease.js
// Courbes et amortisseurs. Tout est sans allocation et sans etat global.
// ---------------------------------------------------------------------------

export const Ease = {
  linear:   (t) => t,
  inQuad:   (t) => t * t,
  outQuad:  (t) => t * (2 - t),
  inCubic:  (t) => t * t * t,
  outCubic: (t) => { const f = t - 1; return f * f * f + 1; },
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 + 4 * (t - 1) ** 3),
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  /** Depassement en fin de course : l'« accompagnement » (follow-through). */
  outBack: (t, s = 1.70158) => 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2,
  /** Recul puis depassement : c'est la courbe du RETOURNEMENT du seau. */
  inOutBack: (t, s = 1.70158) => {
    const c = s * 1.525;
    return t < 0.5
      ? ((2 * t) ** 2 * ((c + 1) * 2 * t - c)) / 2
      : ((2 * t - 2) ** 2 * ((c + 1) * (2 * t - 2) + c) + 2) / 2;
  },
  /** Rebond amorti : le retour apres un impact. */
  outElastic: (t) => (t === 0 || t === 1) ? t
    : Math.pow(2, -9 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1,
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
 * Ressort amorti a 3 composantes, integre en semi-implicite (symplectique
 * d'Euler) : stable, et il DEPASSE quand zeta < 1 — ce depassement EST
 * l'accompagnement du geste.
 *
 *   f    frequence propre en Hz  (3.5 = outil leger, 2.1 = seau plein)
 *   zeta amortissement           (1 = critique, 0.7 = leger rebond)
 */
export class Spring3 {
  constructor(f = 3.5, zeta = 0.78) {
    this.x = { x: 0, y: 0, z: 0 };
    this.v = { x: 0, y: 0, z: 0 };
    this.f = f; this.zeta = zeta;
  }
  set(p) { this.x.x = p.x; this.x.y = p.y; this.x.z = p.z; this.v.x = this.v.y = this.v.z = 0; }
  step(target, dt) {
    const w = 2 * Math.PI * this.f;
    // Sous-pas : l'integration explicite diverge au-dela de w*h ~ 0.5.
    const n = Math.max(1, Math.ceil((dt * w) / 0.45));
    const h = dt / n;
    const k = w * w, c = 2 * this.zeta * w;
    for (let i = 0; i < n; i++) {
      this.v.x += (k * (target.x - this.x.x) - c * this.v.x) * h;
      this.v.y += (k * (target.y - this.x.y) - c * this.v.y) * h;
      this.v.z += (k * (target.z - this.x.z) - c * this.v.z) * h;
      this.x.x += this.v.x * h; this.x.y += this.v.y * h; this.x.z += this.v.z * h;
    }
    return this.x;
  }
}
```

### Réglages recommandés

| Outil | `f` (Hz) | `zeta` | Effet perçu |
|---|---|---|---|
| Mirette, truelle | 5,2 | 0,90 | précis, colle au curseur |
| Pelle vide | 3,8 | 0,80 | vif |
| Pelle chargée | 2,8 | 0,85 | lourd |
| Seau vide | 3,5 | 0,78 | balance légère |
| **Seau plein** | **2,1** | **0,88** | **traîne franchement** |
| Arrosoir plein | 2,6 | 0,86 | pendulaire |
| Râteau | 4,0 | 0,82 | — |

La formule de mélange, une ligne :

```js
// Un outil s'alourdit avec ce qu'il porte.
spring.f = lerp(F_EMPTY, F_FULL, load01);
```

### L'inclinaison dans le sens du mouvement

```js
/**
 * Un outil traine derriere la main : il s'incline VERS L'ARRIERE du mouvement.
 *
 * L'axe d'inclinaison est perpendiculaire a la fois a la vitesse et a la
 * verticale : axis = v x up. Une rotation POSITIVE autour de cet axe couche
 * l'outil dans le sens oppose au deplacement — verifiable a la main :
 *   v = +X, up = +Y  ->  v x up = +Z
 *   rotation de +theta autour de +Z : +Y -> (-sin, cos)  ->  penche vers -X.
 * C'est bien le comportement voulu (l'outil est « tire »).
 *
 * L'angle sature : au-dela de ~22 degres l'outil a l'air cassé.
 */
const LEAN_GAIN = 0.055;    // rad par (m/s)
const LEAN_MAX  = 0.38;     // rad (~22 deg)

updateLean(dt) {
  // Vitesse lissee : la vitesse brute d'une souris est un signal en creneaux.
  this._vel.subVectors(this.spring.x, this._prev).divideScalar(Math.max(dt, 1e-4));
  this._prev.copy(this.spring.x);
  const k = 1 - Math.exp(-9 * dt);
  this._velS.lerp(this._vel, k);

  const speed = this._velS.length();
  const lean = Math.min(speed * LEAN_GAIN, LEAN_MAX);
  if (lean < 1e-3) { this._qLean.identity(); return; }
  this._axis.crossVectors(this._velS, UP).normalize();
  this._qLean.setFromAxisAngle(this._axis, lean);
}
```

### La respiration au repos

```js
/**
 * Aucune main n'est immobile. Deux sinusoides de periodes INCOMMENSURABLES
 * (0.55 et 0.31 Hz) : le motif ne se repete jamais de facon perceptible.
 */
bob(t) {
  this.group.position.y += 0.004 * Math.sin(2 * Math.PI * 0.55 * t);
  this._qBob.setFromAxisAngle(UP, 0.02 * Math.sin(2 * Math.PI * 0.31 * t + 1.7));
}
```

## 4.2 Anticipation, impact, accompagnement

Les trois temps de tout geste, appliqués au coup de pelle :

```
   +y
    |    ___                            .
    |   /   \  anticipation            /  \  accompagnement
    |  /     \  (recul, 0.08 s)       /    \  (depassement, 0.22 s)
  0 +-'-------\-------------------.--'------`----------
    |          \                 /
    |           \_______________/
    |            frappe (0.09 s, inQuad)
```

```js
/**
 * Machine a trois temps pour un coup d'outil (pelle, dame, truelle).
 * On la pilote depuis `apply()` : chaque application de brosse declenche un
 * coup, mais la cadence de `tools.js` (14 a 24 Hz) est trop rapide pour un
 * coup complet. Regle : on ne declenche un coup que si le precedent est
 * termine a plus de 70 %, sinon on ENCHAINE (le geste devient un frottement
 * continu, ce qui est exactement le bon rendu pour un maintien).
 */
const STRIKE = { anticipate: 0.08, hit: 0.09, follow: 0.22 };
const STRIKE_TOTAL = STRIKE.anticipate + STRIKE.hit + STRIKE.follow;

strikeOffset(t, dirY = -1, amp = 1) {
  if (t >= STRIKE_TOTAL) return 0;
  if (t < STRIKE.anticipate) {
    const u = t / STRIKE.anticipate;
    return -dirY * 0.25 * amp * Ease.outQuad(u);          // recul
  }
  t -= STRIKE.anticipate;
  if (t < STRIKE.hit) {
    const u = t / STRIKE.hit;
    return dirY * amp * (Ease.inQuad(u) * 1.25 - 0.25);   // frappe, depasse
  }
  t -= STRIKE.hit;
  const u = t / STRIKE.follow;
  return dirY * amp * (1 - Ease.outElastic(u));           // retour amorti
}
```

`amp` vaut `radius * 0.35` : **l'enfoncement dans le sable est proportionnel au
rayon de la brosse**, donc à la « force » du geste. Une grosse pelle s'enfonce
plus qu'une mirette, et ça se voit.

**Rebond.** À la fin de la frappe (`t === anticipate + hit`), on déclenche un
écrasement de l'outil relâché par `outElastic` en 0,18 s :

```js
// squash & stretch : conservation approximative du volume.
const s = 1 - 0.06 * this._squash;         // _squash decroit de 1 a 0
this.group.scale.set(scale / Math.sqrt(s), scale * s, scale / Math.sqrt(s));
```

6 % d'écrasement, pas plus. Sur un objet rigide en plastique, au-delà de 8 % on
quitte le « game feel » pour le cartoon — ce qui est un choix légitime, mais pas
celui d'un jeu qui revendique une simulation granulaire sérieuse.

**Le sable, lui, a droit à davantage** : la charge de la pelle et le contenu du
seau peuvent aller jusqu'à 12 % d'écrasement, parce que c'est de la matière
molle.

## 4.3 Le décalage de caméra : NON

**Verdict : pas de screen shake.** Trois raisons, dans l'ordre :

1. **La caméra est en orbite sur un diorama.** Une secousse de caméra sur une
   vue en orbite ne se lit pas comme un impact, elle se lit comme un
   tremblement de terre — ou pire, comme un bug de contrôleur. Le screen shake
   fonctionne quand la caméra est *solidaire du personnage* (1re/3e personne).
   Ce n'est pas notre cas.
2. **Le jeu est cozy.** Le shake est un outil de tension. Il pousse
   l'adrénaline, il fatigue, et il est une cause connue de mal des transports.
   Un jeu où l'on construit des châteaux de sable pendant quarante minutes ne
   peut pas se permettre de secouer l'écran quatorze fois par seconde (la
   cadence de la pelle !).
3. **Le mode photo existe** (`Game.togglePhotoMode`). Une caméra qui bouge
   toute seule est incompatible avec la promesse d'un mode photo.

**Ce qu'on fait à la place — la règle « l'impact va dans l'objet ».**

| Au lieu de… | On fait… |
|---|---|
| secouer la caméra | **secouer l'outil** (écrasement + rebond, §4.2) |
| secouer la caméra | **une bouffée de particules** au point d'impact (§5) |
| secouer la caméra | un **assombrissement local** de 40 ms sur le sable via la compaction |

**Une seule exception, et elle est ailleurs :** l'effondrement d'une grosse
structure ou l'arrivée d'une vague sur le château. Là, un mouvement de **0,6 cm
sur la cible d'orbite** (jamais sur la rotation), amorti en 0,4 s, et jamais en
mode photo. C'est un événement dramatique du jeu, pas un retour d'outil.

```js
// --- dans DioramaControls, si on veut cette exception ---------------------
kick(amount) {
  if (this.photoMode) return;
  this._kick = Math.min(0.006, amount);   // metres, plafonne dur
}
update(dt) {
  // ... code existant ...
  if (this._kick > 1e-5) {
    const s = this._kick;
    this.camera.position.x += (Math.random() - 0.5) * s;
    this.camera.position.y += (Math.random() - 0.5) * s;
    this._kick *= Math.exp(-dt / 0.12);   // constante de temps 120 ms
  }
}
```

## 4.4 Le rig complet : `ToolAvatar.js`

```js
// ---------------------------------------------------------------------------
// src/render/ToolAvatar.js
//
// L'outil visible. Un seul a la fois : on construit les geometries
// paresseusement, a la premiere selection, puis on masque/affiche.
//
// Responsabilites :
//   - suivre le point vise avec inertie et inclinaison
//   - poser l'outil de facon que son POINT DE TRAVAIL touche le sable
//   - afficher l'etat de l'outil (contenu du seau, charge de la pelle…)
//   - jouer les coups (anticipation / frappe / accompagnement)
//
// Ce fichier ne connait AUCUNE regle de jeu. Il est pilote par tools.js.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import * as TG from './ToolGeometry.js';
import { Ease, Spring3, damp } from './Ease.js';
import { BucketRig } from './BucketRig.js';

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Descripteur par outil :
 *   tip      point de travail, en coordonnees LOCALES de l'outil
 *   f, zeta  ressort de suivi (vide / plein)
 *   scale    echelle de base
 *   sizeK    part du rayon de brosse reportee sur la taille de l'outil
 *            (0 = taille fixe, 1 = proportionnel — le seau seul est a 1)
 */
const RIGS = {
  shovel: { tip: [0, -0.09, 0.05], f: [3.8, 2.8], scale: 1.0, sizeK: 0.25, mat: 'red' },
  hand:   { tip: [0, -0.005, 0],   f: [4.2, 4.2], scale: 1.0, sizeK: 0.35, mat: 'handle' },
  can:    { tip: [0, 0.14, 0.19],  f: [3.0, 2.6], scale: 1.0, sizeK: 0.20, mat: 'blue' },
  water:  { tip: [0, 0.0, 0],      f: [3.2, 2.1], scale: 1.0, sizeK: 1.00, mat: 'blue' },
  bucket: { tip: [0, 0.0, 0],      f: [3.5, 2.1], scale: 1.0, sizeK: 1.00, mat: 'yellow' },
  trowel: { tip: [0, 0.0, 0.10],   f: [5.2, 5.2], scale: 1.0, sizeK: 0.30, mat: 'green' },
  carve:  { tip: [0, -0.078, 0.024], f: [5.2, 5.2], scale: 1.0, sizeK: 0.45, mat: 'metal' },
  rake:   { tip: [0, -0.056, 0],   f: [4.0, 4.0], scale: 1.0, sizeK: 0.60, mat: 'red' },
  decor:  { tip: [0, 0, 0],        f: [5.0, 5.0], scale: 1.0, sizeK: 0.0,  mat: 'handle' },
  eraser: null,                    // pas d'objet : anneau du shader seul
};

export class ToolAvatar {
  /** @param {import('../core/Game.js').Game} game */
  constructor(game) {
    this.game = game;
    this.root = new THREE.Group();
    this.root.name = 'toolAvatar';
    game.scene.add(this.root);

    this.built = {};            // id -> { group, rig, ... }
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
    this._tmp = new THREE.Vector3();
    this._tip = new THREE.Vector3();

    this.strikeT = 1e9;
    this.squash = 0;
    this.time = 0;
    this.visibleFade = 0;
  }

  // --- construction paresseuse --------------------------------------------

  _build(id) {
    if (this.built[id]) return this.built[id];
    const g = new THREE.Group();
    g.visible = false;
    this.root.add(g);
    const entry = { group: g, meshes: [] };
    const add = (geo, matName) => {
      const m = new THREE.Mesh(geo, TG.TOOL_MATERIALS[matName]());
      m.castShadow = true; m.receiveShadow = true;
      g.add(m); entry.meshes.push(m); return m;
    };

    switch (id) {
      case 'shovel': {
        // Deux materiaux : lame + poignee rouges, manche blanc. La coupure de
        // silhouette blanc/rouge est ce qui rend la pelle lisible a 18 px.
        add(TG.makeShovelGeometry(), 'red');
        entry.load = add(TG.makeShovelLoad(), 'sandWet');
        entry.load.position.set(0, -0.052, 0.012);
        entry.load.visible = false;
        break;
      }
      case 'hand':   add(TG.makeTamperGeometry(), 'handle'); break;
      case 'trowel': add(TG.makeTrowelGeometry(), 'green'); break;
      case 'carve':  add(TG.makeCarveGeometry(), 'metal'); break;
      case 'rake':   entry.spacing = 0.05; add(TG.makeRakeGeometry(0.05), 'red'); break;
      case 'can': {
        const c = TG.makeWateringCanGeometry();
        add(c.body, 'blue'); add(c.rest, 'metal');
        break;
      }
      case 'bucket':
      case 'water':
        entry.bucket = new BucketRig(g, {
          particles: this.game.particles,
          audio: this.game.audio,
        });
        break;
      default: break;
    }
    this.built[id] = entry;
    return entry;
  }

  select(id) {
    if (this.currentId === id) return;
    if (this.current) this.current.group.visible = false;
    this.currentId = id;
    this.current = RIGS[id] ? this._build(id) : null;
    if (this.current) this.current.group.visible = true;
  }

  /** Accès direct au rig du seau, utilisé par tools.js. */
  get bucket() { return this.currentId === 'bucket' ? this.built.bucket?.bucket : null; }

  // --- boucle --------------------------------------------------------------

  update(dt, tools) {
    this.time += dt;
    const hit = tools.hit;
    const def = RIGS[this.currentId];
    if (!this.current || !def) { this.root.visible = false; return; }
    this.root.visible = true;

    // 1. Échelle : proportionnelle au rayon pour le seau, amortie ailleurs.
    const r = tools.radius, rd = tools.current.radius.def;
    const k = def.sizeK;
    const scale = def.sizeK >= 0.99 ? r
      : def.scale * THREE.MathUtils.clamp(1 + k * (r / rd - 1), 0.75, 1.6);

    // 2. Cible : le point vise, avec un decalage de « prise ».
    if (hit) {
      this._target.set(hit.point.x, hit.point.y, hit.point.z);
      // Enfoncement pendant le maintien + coup en cours.
      const press = tools.stroke ? r * 0.18 : 0;
      this._target.y -= press;
      this._target.y += this.strikeOffset(this.strikeT, -1, r * 0.35);
    }
    const pos = this.spring.step(this._target, dt);

    // 3. Inertie : inclinaison vers l'arriere du mouvement.
    this._vel.set(pos.x - this._prev.x, pos.y - this._prev.y, pos.z - this._prev.z)
             .divideScalar(Math.max(dt, 1e-4));
    this._prev.set(pos.x, pos.y, pos.z);
    this._velS.lerp(this._vel, 1 - Math.exp(-9 * dt));
    const lean = Math.min(this._velS.length() * 0.055, 0.38);
    if (lean > 1e-3) {
      this._axis.crossVectors(this._velS, UP).normalize();
      this._qLean.setFromAxisAngle(this._axis, lean);
    } else this._qLean.identity();

    // 4. Orientation de base : « tenu depuis le haut-droite de la camera ».
    //    On prend l'azimut de la camera et on ajoute 0.45 rad. Le resultat :
    //    l'outil n'est JAMAIS aligne sur les axes du monde, quelle que soit
    //    la position de la camera.
    const cam = this.game.camera;
    const az = Math.atan2(cam.position.x - pos.x, cam.position.z - pos.z);
    this._qBase.setFromAxisAngle(UP, az + 0.45);
    const tiltQ = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0), 0.26);          // ~15 deg d'inclinaison de prise
    this._qBase.multiply(tiltQ);

    // 5. Respiration.
    this._qBob.setFromAxisAngle(UP, 0.02 * Math.sin(2 * Math.PI * 0.31 * this.time + 1.7));

    // 6. Composition finale.
    const g = this.current.group;
    const seq = this.current.bucket?.update(dt, this._tmp.set(pos.x, pos.y, pos.z));
    if (!seq) {
      g.quaternion.copy(this._qLean).multiply(this._qBase).multiply(this._qBob);
      // Le point de travail doit coincider avec le point vise : on decale
      // l'origine du groupe de -R * tip.
      this._tip.fromArray(def.tip).multiplyScalar(scale).applyQuaternion(g.quaternion);
      g.position.set(pos.x - this._tip.x, pos.y - this._tip.y, pos.z - this._tip.z);
      g.position.y += 0.004 * Math.sin(2 * Math.PI * 0.55 * this.time);
    }

    // 7. Ecrasement.
    this.squash = damp(this.squash, 0, 9, dt);
    const s = 1 - 0.06 * this.squash;
    if (def.sizeK < 0.99) g.scale.set(scale / Math.sqrt(s), scale * s, scale / Math.sqrt(s));

    // 8. Distance : au-dela de 26 m, l'outil devient un pate de 8 px.
    //    On l'estompe et on laisse l'anneau du shader porter le curseur.
    const d = cam.position.distanceTo(g.position);
    const fade = THREE.MathUtils.clamp(1 - (d - 26) / 8, 0.0, 1.0);
    for (const m of this.current.meshes || []) {
      m.material.opacity = fade; m.material.transparent = fade < 0.995;
      m.visible = fade > 0.02;
    }

    // 9. Etat visible de l'outil (§6).
    this.strikeT += dt;
    this._syncState(tools);
  }

  strike(amp = 1) {
    // On n'enchaine pas les coups plus vite que 70 % de leur duree :
    // au-dela, le geste devient un frottement continu, ce qui est juste.
    if (this.strikeT < 0.7 * 0.39) return;
    this.strikeT = 0;
    this.squash = 1;
  }

  strikeOffset(t, dirY, amp) {
    const A = 0.08, H = 0.09, F = 0.22;
    if (t >= A + H + F) return 0;
    if (t < A) return -dirY * 0.25 * amp * Ease.outQuad(t / A);
    if (t < A + H) return dirY * amp * (Ease.inQuad((t - A) / H) * 1.25 - 0.25);
    return dirY * amp * (1 - Ease.outElastic((t - A - H) / F));
  }

  /** Reporte l'etat du jeu sur les objets : c'est la §6. */
  _syncState(tools) {
    const g = this.game;
    if (this.currentId === 'shovel' && this.current.load) {
      const v = Math.min(1, g.carried.volume / 0.35);
      this.current.load.visible = v > 0.02;
      this.current.load.scale.set(1, Math.max(0.15, v), Math.min(1, 0.4 + 0.6 * v));
      // Sable sec = plus clair, exactement comme dans le seau.
      const dry = 1 - Math.min(1, g.carried.moisture / 0.16);
      this.current.load.material.color.setRGB(
        0.61 + 0.21 * dry, 0.52 + 0.20 * dry, 0.38 + 0.19 * dry);
    }
    if (this.currentId === 'rake' && this.current.spacing !== tools.current.spacing) {
      // L'ecartement a change : on regenere la tete (evenement rare).
      this.current.spacing = tools.current.spacing;
      const old = this.current.meshes[0];
      old.geometry.dispose();
      old.geometry = TG.makeRakeGeometry(this.current.spacing);
    }
  }

  dispose() {
    for (const id in this.built) {
      for (const m of this.built[id].meshes || []) {
        m.geometry.dispose(); m.material.dispose();
      }
    }
    this.game.scene.remove(this.root);
  }
}
```

### Branchements dans `Game.js` et `ToolManager.js`

```js
// --- Game.init(), juste apres `this.props = new Props(...)` ---------------
this.particles = new SandParticles(this.scene, this.field, 3000);

// --- Game.init(), apres `this.tools = new ToolManager(this)` --------------
this.toolAvatar = new ToolAvatar(this);
this.toolAvatar.select(this.tools.current.id);
const prevOnToolChanged = this.onToolChanged;
this.onToolChanged = (t) => { prevOnToolChanged?.(t); this.toolAvatar.select(t.id); };

// --- Game.update(), juste apres `this.tools.update(dt)` -------------------
this.toolAvatar.update(dt, this.tools);
this.particles.update(dt);

// --- Game.resize() -------------------------------------------------------
this.particles?.setViewport(innerHeight, this.camera.fov);
```

Et dans `ToolManager.applyOnce()`, une ligne pour déclencher le coup :

```js
applyOnce(dt) {
  if (!this.stroke || !this.hit) return;
  const s = this.makeState(this.hit, dt);
  this.current.apply?.(s);
  this.game.toolAvatar?.strike();     // <- anticipation / frappe / retour
  // ... reste inchange
}
```

---

<a name="5-particules"></a>
# 5. PARTICULES ET TRACES

## 5.1 `Points` ou `InstancedMesh` ?

| | `THREE.Points` | `THREE.InstancedMesh` |
|---|---|---|
| Sommets par particule | **1** | 12 à 24 |
| Rotation propre | ✗ | ✓ |
| Ombre portée | ✗ (sans travail) | ✓ |
| Coût CPU de mise à jour | 1 écriture Vec3 | 1 `Matrix4.compose()` (16 flottants + quaternion) |
| Taille perspective correcte | oui, mais **à la main** dans le shader | native |
| Draw calls | 1 | 1 |
| Budget réaliste | **5 000** | ~400 |

**À notre échelle, un grain de sable fait 1 à 3 pixels.** À 1–3 px, une
rotation n'existe pas, une ombre n'existe pas, une forme n'existe pas. Payer
24 sommets par grain serait absurde.

> **Verdict : un seul système `Points` mutualisé, budget 3 000 particules,
> cinq « espèces » encodées dans un attribut.** Pas d'`InstancedMesh` pour les
> grains. On garde l'`InstancedMesh` en réserve pour une phase 8 optionnelle :
> les **mottes** (les gros paquets de sable humide qui tombent d'une pelle
> pleine), au plus 48 à la fois, qui elles méritent une ombre et une rotation.

**GPU particles ?** Simuler dans un shader avec ping-pong de FBO devient
rentable au-delà de ~50 000 particules. À 3 000, la simulation CPU coûte
environ **12 opérations flottantes × 3 000 = 36 kflops par frame**, soit
0,05 ms — trois ordres de grandeur sous le coût de la passe granulaire
(`BUDGET_GRANULAR = 60000` voxels). Le GPU ne servirait qu'à ajouter de la
complexité et à empêcher les particules de lire `field.surfaceHeightAt()`.

## 5.2 Les cinq espèces

| id | Nom | Taille monde | Couleur | Gravité | Vie | Comportement au sol |
|---|---|---|---|---|---|---|
| 0 | grain sec | 2,5 mm | sable clair | 1,0 | 0,9 s | rebondit une fois puis meurt |
| 1 | grain humide | 4 mm | sable foncé | 1,0 | 0,7 s | colle immédiatement |
| 2 | poussière | 9 mm | blanc cassé, α 0,35 | 0,25 | 1,4 s | s'évanouit |
| 3 | goutte | 3 mm | bleu, spéculaire | 1,0 | 1,1 s | mouille le sable (1 sur 8) |
| 4 | éclaboussure | 6 mm | blanc, α 0,7 | 0,9 | 0,5 s | meurt |

## 5.3 Le code

```js
// ---------------------------------------------------------------------------
// src/render/Particles.js
//
// Un seul systeme de particules pour tout le jeu : grains, poussiere, gouttes.
//
// Choix : THREE.Points, pool a taille fixe, simulation CPU en tableaux typés,
// un seul draw call. A 1-3 pixels par grain, une geometrie instanciee serait
// 24 fois plus chere pour une information que l'ecran ne peut pas montrer.
//
// Style : meme esprit que Props.js — tout est preallouable, rien n'alloue en
// jeu, et le systeme ne connait du jeu que `field.surfaceHeightAt()`.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

/** Parametres par espece : [taille (m), gravite, vie (s), drag] */
const KIND = [
  [0.0025, 1.00, 0.90, 0.02],   // 0 grain sec
  [0.0040, 1.00, 0.70, 0.03],   // 1 grain humide
  [0.0090, 0.25, 1.40, 0.55],   // 2 poussiere
  [0.0030, 1.00, 1.10, 0.05],   // 3 goutte
  [0.0060, 0.90, 0.50, 0.10],   // 4 eclaboussure
];

export class SandParticles {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../sim/VoxelField.js').VoxelField} field
   * @param {number} max
   */
  constructor(scene, field, max = 3000) {
    this.scene = scene;
    this.field = field;
    this.max = max;
    this.count = 0;            // particules vivantes, compactees en tete

    this.px = new Float32Array(max * 3);   // position (attribut GPU)
    this.vx = new Float32Array(max * 3);   // vitesse  (CPU seul)
    this.life = new Float32Array(max);     // temps restant
    this.life0 = new Float32Array(max);    // duree initiale
    this.kind = new Float32Array(max);
    this.ground = new Float32Array(max);   // altitude du sol, echantillonnee
    this.seed = new Float32Array(max);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.px, 3).setUsage(THREE.DynamicDrawUsage));
    // aData : x = espece, y = vie normalisee 1->0, z = graine
    this.data = new Float32Array(max * 3);
    geo.setAttribute('aData', new THREE.BufferAttribute(this.data, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 40);   // pas de recalcul
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      // NORMAL et pas Additive : en plein soleil, une poussiere additive
      // ressemble a du feu. Le sable diffuse, il n'emet pas.
      blending: THREE.NormalBlending,
      uniforms: {
        // pixelScale = hauteur du viewport / (2 tan(fov/2)).
        // gl_PointSize = taille_monde * pixelScale / distance  ->  taille
        // perspective EXACTE, en pixels.
        uPixelScale: { value: 600 },
        uSun: { value: new THREE.Color(0xfff0d8) },
      },
      vertexShader: /* glsl */`
        attribute vec3 aData;
        varying vec3 vData;
        uniform float uPixelScale;
        const float SIZES[5] = float[5](0.0025, 0.0040, 0.0090, 0.0030, 0.0060);
        void main() {
          vData = aData;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float sz = SIZES[int(aData.x + 0.5)];
          // La poussiere ENFLE en vieillissant, les grains non.
          if (aData.x > 1.5 && aData.x < 2.5) sz *= 1.0 + 2.2 * (1.0 - aData.y);
          gl_PointSize = clamp(sz * uPixelScale / max(-mv.z, 0.05), 1.0, 24.0);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        varying vec3 vData;
        uniform vec3 uSun;
        const vec3 COLORS[5] = vec3[5](
          vec3(0.86, 0.78, 0.62),   // grain sec
          vec3(0.58, 0.48, 0.35),   // grain humide
          vec3(0.92, 0.89, 0.83),   // poussiere
          vec3(0.36, 0.62, 0.82),   // goutte
          vec3(0.95, 0.97, 1.00));  // eclaboussure
        void main() {
          // Point rond : on jette les coins du quad.
          vec2 d = gl_PointCoord - 0.5;
          float r2 = dot(d, d);
          if (r2 > 0.25) discard;
          int k = int(vData.x + 0.5);
          float life = vData.y;                       // 1 -> 0
          float a = k == 2 ? 0.35 * life * life       // la poussiere s'evanouit
                  : k == 4 ? 0.70 * life
                  : 1.0;
          // Un soupcon de relief : plus clair au centre.
          vec3 c = COLORS[k] * (0.86 + 0.30 * (1.0 - r2 * 4.0)) * uSun;
          gl_FragColor = vec4(c, a);
        }
      `,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.name = 'particles';
    scene.add(this.points);

    this._acc = 0;     // accumulateur pour les flux fractionnaires
    this._gsCursor = 0;
  }

  /** A appeler dans Game.resize() : c'est ce qui rend la taille exacte. */
  setViewport(heightPx, fovDeg) {
    this.material.uniforms.uPixelScale.value =
      heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  // --- emission ------------------------------------------------------------

  /** Une particule. Renvoie false si le pool est plein (on ne grossit jamais). */
  spawn(kind, x, y, z, vx, vy, vz) {
    if (this.count >= this.max) return false;
    const i = this.count++;
    const K = KIND[kind];
    this.px[i * 3] = x; this.px[i * 3 + 1] = y; this.px[i * 3 + 2] = z;
    this.vx[i * 3] = vx; this.vx[i * 3 + 1] = vy; this.vx[i * 3 + 2] = vz;
    this.life[i] = this.life0[i] = K[2] * (0.7 + Math.random() * 0.6);
    this.kind[i] = kind;
    this.seed[i] = Math.random();
    // Echantillonnage du sol UNE FOIS. Rafraichir chaque frame pour chaque
    // particule couterait plus cher que toute la simulation.
    this.ground[i] = this.field.surfaceHeightAt(x, z);
    return true;
  }

  /**
   * Bouffee dans un cone.
   * @param {object} o { speed, spread, dir:[x,y,z] }
   */
  burst(kind, x, y, z, n, o = {}) {
    const sp = o.speed ?? 1.2, spread = o.spread ?? 0.8;
    const d = o.dir ?? [0, 1, 0];
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * spread;
      const s = sp * (0.55 + Math.random() * 0.9);
      this.spawn(kind,
        x + (Math.random() - 0.5) * 0.02,
        y + Math.random() * 0.02,
        z + (Math.random() - 0.5) * 0.02,
        (d[0] + Math.cos(a) * r) * s,
        (d[1] + (Math.random() - 0.3) * r) * s,
        (d[2] + Math.sin(a) * r) * s);
    }
  }

  /** Anneau horizontal : impact au sol, couronne de poussiere. */
  ring(kind, center, radius, n, speed = 0.5) {
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + Math.random() * 0.4;
      const c = Math.cos(a), s = Math.sin(a);
      this.spawn(kind,
        center.x + c * radius, center.y + 0.01, center.z + s * radius,
        c * speed * (0.6 + Math.random() * 0.8),
        speed * (0.35 + Math.random() * 0.5),
        s * speed * (0.6 + Math.random() * 0.8));
    }
  }

  /**
   * Flux continu : `perSecond` particules par seconde, avec accumulateur
   * fractionnaire pour rester exact meme a 144 fps.
   */
  stream(kind, x, y, z, perSecond, dt, o = {}) {
    this._acc += perSecond * dt;
    const n = Math.floor(this._acc);
    this._acc -= n;
    if (n > 0) this.burst(kind, x, y, z, Math.min(n, 24),
      { ...o, dir: o.down ? [0, -1, 0] : [0, 1, 0] });
  }

  // --- simulation ----------------------------------------------------------

  update(dt) {
    const px = this.px, vx = this.vx, life = this.life;
    // Rafraichissement paresseux du sol : 1/8 des particules par frame.
    // Le sable bouge sous les particules pendant qu'elles volent (avalanches),
    // mais une erreur de 4 cm pendant 1/8 de seconde est invisible.
    const gsStride = 8;
    let n = this.count;

    for (let i = 0; i < n; i++) {
      life[i] -= dt;
      if (life[i] <= 0) { this._kill(i); n = this.count; i--; continue; }

      const k = this.kind[i] | 0;
      const K = KIND[k];
      const i3 = i * 3;

      // Gravite + trainee lineaire (suffisant : nous ne simulons pas un
      // ecoulement, seulement une jolie chute).
      vx[i3 + 1] -= 9.81 * K[1] * dt;
      const drag = 1 - K[3] * dt * 6;
      vx[i3] *= drag; vx[i3 + 1] *= drag; vx[i3 + 2] *= drag;

      px[i3] += vx[i3] * dt;
      px[i3 + 1] += vx[i3 + 1] * dt;
      px[i3 + 2] += vx[i3 + 2] * dt;

      if ((i + this._gsCursor) % gsStride === 0) {
        this.ground[i] = this.field.surfaceHeightAt(px[i3], px[i3 + 2]);
      }

      // --- collision avec le sable ------------------------------------------
      if (px[i3 + 1] <= this.ground[i]) {
        px[i3 + 1] = this.ground[i];
        if (k === 2 || k === 4) { this._kill(i); n = this.count; i--; continue; }
        if (k === 1) { this._kill(i); n = this.count; i--; continue; }  // colle
        if (k === 3) {
          // Une goutte sur huit mouille VRAIMENT le sable. Le retour visuel
          // precede alors la consequence physique : cause -> image -> effet.
          if (this.seed[i] < 0.125 && this._wet) {
            this._wet(px[i3], px[i3 + 1], px[i3 + 2]);
          }
          this._kill(i); n = this.count; i--; continue;
        }
        // grain sec : un rebond mou, puis il meurt vite
        if (vx[i3 + 1] < -0.25) {
          vx[i3 + 1] *= -0.25;
          vx[i3] *= 0.55; vx[i3 + 2] *= 0.55;
          life[i] = Math.min(life[i], 0.22);
        } else { this._kill(i); n = this.count; i--; continue; }
      }
    }
    this._gsCursor++;

    // --- upload -------------------------------------------------------------
    const d = this.data;
    for (let i = 0; i < n; i++) {
      d[i * 3] = this.kind[i];
      d[i * 3 + 1] = this.life[i] / this.life0[i];
      d[i * 3 + 2] = this.seed[i];
    }
    this.geometry.setDrawRange(0, n);
    this.geometry.attributes.position.updateRanges = [{ start: 0, count: n * 3 }];
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aData.needsUpdate = true;
  }

  /** Suppression par echange avec le dernier : O(1), pas de trou dans le pool. */
  _kill(i) {
    const last = --this.count;
    if (i === last) return;
    for (let c = 0; c < 3; c++) {
      this.px[i * 3 + c] = this.px[last * 3 + c];
      this.vx[i * 3 + c] = this.vx[last * 3 + c];
    }
    this.life[i] = this.life[last];
    this.life0[i] = this.life0[last];
    this.kind[i] = this.kind[last];
    this.ground[i] = this.ground[last];
    this.seed[i] = this.seed[last];
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.scene.remove(this.points);
  }
}
```

**Le crochet `_wet`** se branche depuis `Game.init()` :

```js
this.particles._wet = (x, y, z) => this.moisture.wetSphere(x, y, z, 0.05, 0.010);
```

## 5.4 Où chaque outil émet

```js
// --- src/tools/tools.js, ajouts a l'interieur des `apply` existants -------

// PELLE, creuser : les grains jaillissent VERS LE HAUT et vers le joueur.
if (removed > 0) {
  const wetKind = w > 0.08 ? 1 : 0;
  s.game.particles?.burst(wetKind, p.x, p.y + 0.01, p.z,
    3 + Math.round(removed * 900), { speed: 1.4, spread: 0.7, dir: [0, 1, 0] });
}

// PELLE, vider : un filet continu, pas une bouffee.
s.game.particles?.stream(g.carried.moisture > 0.08 ? 1 : 0,
  p.x, p.y + s.radius * 0.5, p.z, 120, s.dt, { speed: 0.5, spread: 0.3, down: true });

// ARROSOIR : des gouttes, en pluie large, depuis la POMME de l'arrosoir.
const rose = s.game.toolAvatar?.tipWorld();     // position monde du point de travail
s.game.particles?.stream(3, rose.x, rose.y, rose.z, 160, s.dt,
  { speed: 0.35, spread: 0.9, down: true });

// SEAU D'EAU : un jet dense + eclaboussures a l'arrivee.
s.game.particles?.stream(3, p.x, p.y + 0.25, p.z, 200, s.dt, { speed: 1.1, spread: 0.18, down: true });
if (Math.random() < 0.35) s.game.particles?.ring(4, p, s.radius * 0.5, 4, 0.9);

// MIRETTE, TRUELLE : quelques grains seulement — ce sont des outils fins.
s.game.particles?.burst(0, p.x, p.y, p.z, 2, { speed: 0.6, spread: 0.5 });

// RATEAU : une petite gerbe le long du trait.
s.game.particles?.burst(0, p.x, p.y, p.z, 4, { speed: 0.8, spread: 0.9 });

// DAME (main), tasser : PAS de grains — de la POUSSIERE, et un anneau.
s.game.particles?.ring(2, p, s.radius * 0.8, 8, 0.35);
```

Et l'effondrement, déjà détecté dans `Game.update()` :

```js
// --- Game.update(), a la place du simple `audio.play('collapse')` ---------
if (this.granular.events.length) {
  let played = false;
  for (const e of this.granular.events) {
    if (e.type !== 'collapse') continue;
    if (!played) { this.audio.play('collapse'); played = true; }
    // Un panache de poussiere par evenement, plafonne : lors d'un gros
    // effondrement il peut y en avoir des centaines par frame.
    if (Math.random() < 0.15) {
      this.particles.burst(2, e.x, e.y, e.z, 3, { speed: 0.5, spread: 1.0 });
    }
  }
}
```

> **Poussière et effondrement : le meilleur rapport plaisir/effort du document
> après le seau.** Quatorze lignes, et une avalanche de sable passe de « les
> polygones bougent » à « quelque chose s'écroule ».

## 5.5 Les traces persistantes : rien à faire, et c'est le bon choix

La question posée est : les marques de pelle, empreintes de main et sillons de
râteau sont-elles déjà dans la géométrie, ou faut-il des décalcomanies ?

**Réponse en trois temps.**

**1. La forme est déjà dans la géométrie.** `Brush.rake()` grave de vraies
rainures dans le champ de densité ; `Brush.sphere()` creuse de vrais trous.
Ce sont des modifications de voxels, remaillées par `SurfaceNets`, éclairées et
ombrées comme le reste. **Aucune décalcomanie ne ferait mieux** : une décalque
est plate, elle ne porte pas d'ombre propre, elle ne s'effondre pas quand le
sable coule. Notre géométrie fait les trois.

**2. Ce que la géométrie ne peut PAS porter, c'est le sub-voxel.** `VOXEL = 0.04`.
Une empreinte de paume de 3 mm de profondeur est **treize fois plus fine que la
résolution du champ**. Elle est physiquement inreprésentable en géométrie.

**3. Et pourtant elle est déjà là — dans les canaux de matière.** Le shader du
sable lit déjà la compaction :

```glsl
// SandMaterial.js, ligne ~209
base *= mix(1.03, 0.94, packing);
```

`Brush.compact()` augmente `packing` là où la dame tape. **Le sable tassé est
donc déjà rendu plus sombre que le sable en vrac.** Une empreinte de dame
*existe* visuellement, sans une seule ligne de code supplémentaire : c'est une
tache sombre de la taille de la brosse. Il suffit de l'accentuer :

```glsl
// Proposition : porter le contraste de 9 % a ~16 %, et retirer le scintillement
// sur le sable tasse — physiquement juste, les grains tasses ne renvoient plus
// de reflets speculaires isoles.
base *= mix(1.05, 0.89, packing);
sparkle *= 1.0 - 0.55 * packing;
```

Deux lignes de shader, et toutes les traces d'outil de tout le jeu gagnent en
lisibilité, à coût nul.

**Pourquoi `DecalGeometry` est explicitement rejeté ici.**
`THREE.DecalGeometry` construit un maillage en découpant la géométrie d'un mesh
cible. Or notre terrain est **remaillé en continu, chunk par chunk, de façon
asynchrone** (`MesherPool`, `BUDGET_REMESH = 6` chunks par frame). Chaque
décalque devrait donc être :
- reprojetée à chaque remaillage du chunk qui la porte ;
- invalidée si le chunk disparaît ;
- retriée en Z contre la géométrie qui bouge sous elle.

C'est un système de gestion de durée de vie complet, pour un résultat inférieur
à ce que la compaction donne gratuitement. **Verdict : pas de décalcomanies.**

---

<a name="6-etat"></a>
# 6. LE RETOUR SUR L'ÉTAT DE L'OUTIL — L'OBJET EST LA JAUGE

## 6.1 Le principe

Le HUD contient aujourd'hui :

```js
// HUD.js
this.bucketFill = el('div', 'bucket-fill', r);
this.bucketFillBar = el('div', 'bucket-fill-bar', this.bucketFill);
// …
const filling = tool.id === 'bucket' && (tool.fill ?? 0) > 0.001;
this.bucketFill.classList.toggle('on', filling);
if (filling) this.bucketFillBar.style.width = `${(tool.fill * 100).toFixed(0)}%`;
```

Une barre de progression, en bas de l'écran, pour dire qu'un seau se remplit.
Le joueur doit **quitter des yeux le chantier** pour lire une abstraction de ce
qu'il est en train de faire.

> **Principe : l'interface ne garde que ce que le monde ne peut pas montrer.**
> Trois catégories seulement méritent d'exister en HUD :
> 1. **la physique invisible** — on ne voit pas « 12 % de saturation » ;
> 2. **les événements hors champ** — la marée qui monte derrière la caméra ;
> 3. **les réglages abstraits** — le rayon en centimètres, l'outil actif.
>
> Tout le reste, s'il a un corps, s'affiche par son corps.

## 6.2 Ce qui devient diégétique

| Information | Aujourd'hui | Demain |
|---|---|---|
| Remplissage du seau | barre HTML | **le sable monte dans le seau** |
| Humidité du sable dans le seau | invisible | **couleur du contenu** (clair = sec) |
| Sable porté à la pelle (`carried.volume`) | **invisible** | **calotte sur la lame** |
| Humidité du sable porté | invisible | couleur de la calotte |
| Seau bloqué (échec « trop sec ») | toast fugace | **le seau reste plein** — état permanent |
| Niveau d'eau de l'arrosoir | n'existe pas | **disque d'eau qui descend** |
| Écartement du râteau | texte | **le nombre de dents change** |
| Rayon de la brosse | texte « 16 cm » | anneau du shader **+ taille de l'outil** |
| Outil actif | barre d'icônes | **l'objet dans la scène** (+ barre gardée) |
| Force du geste | invisible | profondeur d'enfoncement de l'outil |

**Suppression proposée dans `HUD.js` :** les deux `div` `bucket-fill` et leurs
règles CSS. Sept lignes de JS, une douzaine de CSS.

## 6.3 Ce qui doit rester dans l'interface

**1. La pastille d'humidité (`moistSwatch`) — à garder absolument.**
La saturation est une grandeur physique invisible. Le shader rend le sable
mouillé plus foncé, mais l'œil ne sait pas distinguer 6 % de 14 % — or c'est
*toute* la différence entre un mur qui tient et un mur qui s'écroule
(§Config `REPOSE_CURVE` : 78° à 6 %, 89° à 12 %). C'est le cas d'école du
« la simulation le sait, le joueur ne peut pas le voir ».

**2. La pastille de marée — à garder.** Événement hors champ par définition.

**3. La barre d'outils — à garder**, pour la découvrabilité et les raccourcis.
Mais son rôle change : elle devient un **sélecteur**, plus un indicateur d'état.

**4. Le rayon en centimètres — à garder**, réglage abstrait, valeur numérique.

**5. Les toasts — à garder, mais à réduire.** Aujourd'hui `up()` envoie un toast
à chaque démoulage, y compris quand tout va bien. Avec le rig, « Beau démoulage »
est redondant : le joueur *voit* la tour nette et *entend* `demouldGood`.
**Proposition : ne plus toaster que les échecs**, et seulement la première fois
de chaque type par session. Un jeu cozy qui commente chacun de vos gestes est
un jeu qui vous surveille.

## 6.4 La limite du principe : ce qu'il ne faut pas diégétiser

L'écueil symétrique, c'est le fétichisme du zéro-interface. Trois contre-exemples
à ne **pas** suivre :

- **Ne pas supprimer la barre d'outils** pour forcer les raccourcis clavier :
  la découvrabilité passe avant l'élégance.
- **Ne pas remplacer la pastille d'humidité** par « regarde la couleur du
  sable » : l'information n'a pas la précision requise.
- **Ne pas cacher le compteur de sable porté** *sans* la calotte sur la lame.
  Un état invisible **et** absent de l'interface, c'est un bug pour le joueur.
  La règle est : **on ne retire de l'interface que ce qu'on a effectivement
  donné au monde.** Dans l'ordre : d'abord la calotte, ensuite seulement le
  droit de ne rien afficher.

---

<a name="7-cycle"></a>
# 7. LE CYCLE DE VIE DE L'OUTIL : TENU, PLANTÉ, POSÉ, RAMASSÉ

> « Rendre réalistes les outils, par exemple la pelle, quand on n'en a plus
> besoin on la plante dans le sable. »

C'est, avec le seau, la deuxième demande explicite du joueur — et c'est
**l'idée la plus économique du document** : elle ne demande presque aucune
géométrie nouvelle (les outils existent déjà depuis §2), elle réutilise un
mécanisme déjà écrit (le suivi de terrain de `Props.js`), et elle change
complètement le rapport du joueur à ses outils.

## 7.1 Pourquoi c'est important, et pas seulement joli

Un outil qui disparaît quand on change d'outil est un **item d'inventaire**.
Un outil qui reste planté là où on l'a laissé est un **objet**. La différence
n'est pas cosmétique :

1. **Ça raconte la session.** Une plage avec une pelle plantée près du trou
   d'eau, un râteau posé au bord de l'allée ratissée et un seau retourné au pied
   de la tour, c'est un **chantier**. Le joueur lit son propre travail dans la
   disposition de ses outils. C'est de la narration environnementale gratuite.
2. **Ça donne un poids au geste.** Poser un outil, c'est admettre qu'on a fini
   avec lui. C'est une petite ponctuation, et les ponctuations sont ce qui
   transforme une activité continue en une suite d'étapes satisfaisantes.
3. **Ça crée un enjeu avec la marée.** Le jeu tout entier est construit sur
   `TIDE_AMPLITUDE = 0.46` et la promesse « la mer va tout reprendre ». Une
   pelle laissée trop bas sur l'estran **et emportée par la vague**, c'est la
   règle du jeu rendue personnelle.
4. **Ça donne un sujet aux photos.** `Game.photoMode` existe. Une pelle plantée
   de travers, dorée par le soleil rasant, à côté d'un château : c'est la photo
   que le joueur partagera.

## 7.2 La machine à états

```
                 ┌──────────────────────────────────────────────┐
                 │                                              │
                 ▼                                              │
        ┌────────────────┐   selection (1..0)   ┌────────────────┴───┐
        │    STOWED      │─────────────────────▶│       HELD         │
        │  (invisible)   │◀─────────────────────│  (suit le curseur) │
        └────────────────┘   selection d'un      └───┬────────────┬───┘
                 ▲           autre outil             │            │
                 │                          G        │            │  Maj+G
                 │                      (planter)    ▼            ▼ (poser a plat)
                 │                            ┌──────────┐  ┌──────────┐
                 │       ramassage (clic)     │ PLANTING │  │ DROPPING │
                 └────────────────────────────┤  0,55 s  │  │  0,45 s  │
                                              └────┬─────┘  └────┬─────┘
                                                   │             │
                                                   ▼             ▼
                                              ┌─────────────────────────┐
                                              │        GROUNDED         │
                                              │  objet du monde, suit   │
                                              │  le terrain, ombre      │
                                              │  portee, ramassable     │
                                              └───────────┬─────────────┘
                                                          │ maree / ensablement
                                                          ▼
                                              ┌─────────────────────────┐
                                              │  DRIFTING / BURIED      │
                                              └─────────────────────────┘
```

| État | Description | Rendu |
|---|---|---|
| `STOWED` | l'outil n'est ni tenu ni au sol | aucun mesh |
| `HELD` | l'outil actif, suit le curseur (§4) | `ToolAvatar` |
| `PLANTING` | animation de plantage, 0,55 s | `ToolAvatar`, position pilotée |
| `DROPPING` | animation de chute à plat, 0,45 s | idem |
| `GROUNDED` | objet du monde | `DroppedTools`, `castShadow` |
| `DRIFTING` | emporté par une vague | `DroppedTools`, position pilotée par l'eau |
| `BURIED` | recouvert de sable | masqué, ressort à la marée descendante |

**Un même outil peut avoir plusieurs exemplaires au sol.** On ne gère pas un
inventaire : sélectionner la pelle avec `1` en fait apparaître une dans la main,
qu'on ait ou non déjà planté une pelle ailleurs. C'est le bon compromis : le
joueur n'est jamais bloqué par une gestion d'objets, mais son chantier se
peuple. On plafonne à **12 outils au sol**, le plus ancien disparaissant en
s'enfonçant dans le sable (avec une animation, pas une disparition).

## 7.3 Les commandes

Les références montrent **« RIGHT CLICK TO DROP THE ACTIVE ITEM »**. On ne peut
pas reprendre ce bouton tel quel : dans notre jeu, le **clic droit est déjà
l'action secondaire de chacun des dix outils** (vider la pelletée, sécher,
éponger, replâtrer, reboucher, effacer les rainures, retirer un objet…). C'est
un pilier de la conception — « le bouton secondaire est toujours l'inverse ou le
complément », dit l'en-tête de `tools.js`. On ne le sacrifie pas.

**Verdict : la touche `G`.**

| Entrée | Action | Justification |
|---|---|---|
| **`G`** | **planter / poser l'outil courant** | *G* comme *ground*, touche libre, à portée de la main gauche qui tient déjà `1`–`0` |
| **`Maj + G`** | poser **à plat** au lieu de planter | pour la photo, et pour les outils qu'on ne plante pas |
| **clic gauche sur un outil au sol** | **le ramasser** | geste évident, aucune découverte nécessaire |
| **`G` deux fois** | planter, puis re-planter ailleurs | on plante autant de fois qu'on veut |

Et l'invite, affichée **une seule fois**, la première fois que le joueur reste
plus de 4 secondes sans cliquer avec un outil sélectionné :

> `G pour planter la pelle dans le sable`

Le survol d'un outil au sol affiche, lui, un liseré clair sur l'objet (pas de
texte) : la surbrillance suffit, le clic est le geste par défaut.

## 7.4 Le geste de planter — l'animation, en détail

C'est le morceau de bravoure de cette section. Le plantage se décompose en
quatre temps, sur **0,55 s** :

| # | Temps | Durée | Courbe | Ce qui se passe |
|---|---|---|---|---|
| 1 | **Anticipation** | 0,10 s | `outQuad` | l'outil **monte de 9 cm** et **bascule de 20° vers l'arrière**. Il prend son élan. |
| 2 | **Frappe** | 0,13 s | `inCubic` | il descend, **pointe en avant**, jusqu'à ce que la lame soit **enfoncée de 5 à 8 cm** sous la surface |
| 3 | **Impact** | 1 frame | — | **le champ de voxels est réellement entaillé**, gerbe de grains, son `plant`, léger recul |
| 4 | **Oscillation** | 0,32 s | sinusoïde amortie | le manche **vibre autour de la lame enfoncée**, 3,2 Hz, τ = 0,11 s, et s'immobilise **légèrement de travers** |

### Le point qui rend le geste crédible : la lame creuse vraiment

Un outil planté qui n'a pas modifié le sable est un autocollant. **La lame doit
entailler le champ de voxels**, exactement comme le fait n'importe quel coup de
pelle — sinon on voit la géométrie de la lame traverser une surface intacte, et
tout s'effondre.

L'entaille n'est pas une sphère : c'est une **fente**, étroite et allongée dans
le plan de la lame. On l'obtient en enchaînant trois petites sphères le long de
la ligne d'enfoncement, ce qui donne une capsule — et on réveille le simulateur
granulaire pour que le sable retombe autour du manche.

```js
// --- src/tools/Brush.js — a ajouter -----------------------------------------

/**
 * Entaille de plantage : une fente etroite, dans la direction (dx,dy,dz),
 * de longueur `len` et de demi-largeur `r`.
 *
 * On enchaine des spheres le long du segment plutot que d'ecrire un vrai
 * champ de distance de capsule : trois appels a `sphere()` coutent moins cher
 * a ecrire ET a executer qu'une nouvelle primitive, et le resultat est
 * indistinguable a 4 cm de resolution.
 */
export function slot(ctx, wx, wy, wz, dx, dy, dz, len, r, moisture) {
  const n = 3;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    total += sphere(ctx,
      wx + dx * len * t, wy + dy * len * t, wz + dz * len * t,
      r * (1 - 0.25 * t),          // la fente s'affine vers le fond
      -255, { hardness: 0.55 });
  }
  return total;
}
```

### Le code de l'animation

```js
// ---------------------------------------------------------------------------
// src/render/PlantAnim.js
//
// Le geste de planter un outil dans le sable.
//
// Quatre temps : anticipation, frappe, impact, oscillation amortie.
// Le rig ne DECIDE de rien : `onImpact` est appele une fois, a la frame
// exacte de l'enfoncement, et c'est tools.js qui y entaille le sable.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { Ease } from './Ease.js';

const T_ANTICIPATE = 0.10;
const T_STRIKE     = 0.13;
const T_SETTLE     = 0.32;
const T_TOTAL      = T_ANTICIPATE + T_STRIKE + T_SETTLE;

/** Oscillation du manche : 3,2 Hz, constante de temps 110 ms. */
const OSC_FREQ = 3.2;
const OSC_TAU  = 0.11;
const OSC_AMP  = 0.13;      // rad, ~7,5 deg au premier depassement

export class PlantAnim {
  constructor() {
    this.t = -1;
    this.pos = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this._q1 = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._axis = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  get active() { return this.t >= 0 && this.t < T_TOTAL; }
  get done()   { return this.t >= T_TOTAL; }

  /**
   * @param {THREE.Vector3} anchor  point du sol vise
   * @param {number} depth          enfoncement final de la pointe (m)
   * @param {number} tiltRad        inclinaison finale du manche (rad)
   * @param {number} yawRad         orientation horizontale
   * @param {number} sideRad        devers final — « legerement de travers »
   */
  start(anchor, depth, tiltRad, yawRad, sideRad) {
    this.anchor = anchor.clone();
    this.depth = depth;
    this.tilt = tiltRad;
    this.yaw = yawRad;
    this.side = sideRad;
    this.t = 0;
    this._impacted = false;
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} from  position de depart (l'outil dans la main)
   * @param {Function} onImpact   appele UNE fois, a l'enfoncement
   */
  update(dt, from, onImpact) {
    if (!this.active && !this.done) return false;
    this.t += dt;
    const t = this.t;

    // Base : lacet + inclinaison finale.
    const qYaw = this._q1.setFromAxisAngle(this._up, this.yaw);
    const qTilt = this._q2.setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.tilt);

    if (t < T_ANTICIPATE) {
      // --- 1. ANTICIPATION : on monte et on bascule EN ARRIERE ------------
      const u = Ease.outQuad(t / T_ANTICIPATE);
      this.pos.lerpVectors(from, this.anchor, u * 0.35);
      this.pos.y = from.y + 0.09 * u;
      const back = this._q2.clone().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0), this.tilt - 0.35 * u);   // −20 deg
      this.quat.copy(qYaw).multiply(back);

    } else if (t < T_ANTICIPATE + T_STRIKE) {
      // --- 2. FRAPPE : descente acceleree, pointe en avant ----------------
      const u = Ease.inCubic((t - T_ANTICIPATE) / T_STRIKE);
      this.pos.copy(this.anchor);
      this.pos.y = THREE.MathUtils.lerp(
        this.anchor.y + 0.09, this.anchor.y - this.depth, u);
      const fwd = this._q2.clone().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0), this.tilt - 0.35 * (1 - u) + 0.10 * u);
      this.quat.copy(qYaw).multiply(fwd);

    } else {
      // --- 3. IMPACT (une seule fois) -------------------------------------
      if (!this._impacted) { this._impacted = true; onImpact?.(); }

      // --- 4. OSCILLATION AMORTIE -----------------------------------------
      // Le manche vibre AUTOUR DE LA LAME ENFONCEE : le pivot est la pointe,
      // pas le centre de l'objet. C'est ce detail qui fait que l'outil a
      // l'air planté et non posé.
      const s = t - T_ANTICIPATE - T_STRIKE;
      const osc = OSC_AMP * Math.exp(-s / OSC_TAU) *
                  Math.cos(2 * Math.PI * OSC_FREQ * s);
      this.pos.copy(this.anchor);
      this.pos.y = this.anchor.y - this.depth;
      // L'oscillation se fait dans un plan legerement oblique : un vrai outil
      // planté ne vibre jamais dans un plan parfaitement propre.
      this._axis.set(1, 0, 0.28).normalize();
      const wob = this._q2.clone().setFromAxisAngle(
        this._axis, this.tilt + osc + this.side * (1 - Math.exp(-s / OSC_TAU)));
      this.quat.copy(qYaw).multiply(wob);
    }
    return true;
  }
}
```

### « Légèrement de travers » : pourquoi c'est capital

Le paramètre `sideRad` vaut `(Math.random() - 0.5) * 0.22` — soit **±6,3° de
dévers aléatoire**, atteint progressivement pendant l'amortissement. C'est
trois lignes, et c'est **la différence entre un outil planté et un outil
instancié**. Un objet parfaitement d'aplomb dit « un moteur m'a placé ici ». Un
objet à 4° de travers dit « une main m'a planté là, et le sable a un peu
cédé ».

Même logique pour l'inclinaison principale : on ne plante pas à la verticale.
La valeur cible est **`tilt = 0,26 + rnd·0,14` rad, soit 15 à 23°** — l'angle
naturel d'une pelle qu'on enfonce d'un coup de pied ou de poignet.

## 7.5 Qui se plante, qui se pose

| Outil | Geste par défaut (`G`) | Pose | Détail |
|---|---|---|---|
| **Pelle** | **planté**, lame en avant, 15–23° | à plat sur `Maj+G` | l'exemple donné par le joueur |
| **Râteau** | **planté**, dents dans le sable | à plat, dents vers le bas | posé à plat, il grave discrètement le sable — joli |
| **Truelle** | **plantée**, lame verticale | à plat | s'enfonce peu (lame courte), oscille beaucoup |
| **Mirette** | **plantée**, manche en l'air | à plat | c'est un petit outil : il se plante à peine |
| **Seau** | **posé** | **retourné** si vide, **droit** si plein | un seau plein posé garde son sable visible |
| **Seau d'eau** | **posé** droit | — | s'il reste de l'eau, elle est visible |
| **Arrosoir** | **posé** droit | couché sur `Maj+G` | couché, il « fuit » : quelques gouttes |
| **Dame** | **posée** à plat | — | elle **tasse** légèrement le sable en se posant |
| **Décoration, gomme** | — | — | pas d'objet à poser |

Le tableau tient dans une table de données :

```js
// --- src/render/ToolAvatar.js : a ajouter dans RIGS ------------------------
// plant : 'stab' (planté), 'lay' (posé a plat), null (rien a poser)
// depth : enfoncement de la pointe, en metres
// slotR : demi-largeur de l'entaille dans le sable
shovel: { …, plant: 'stab', depth: 0.075, slotR: 0.035, tilt: [0.26, 0.14] },
rake:   { …, plant: 'stab', depth: 0.050, slotR: 0.045, tilt: [0.30, 0.16] },
trowel: { …, plant: 'stab', depth: 0.045, slotR: 0.020, tilt: [0.18, 0.12] },
carve:  { …, plant: 'stab', depth: 0.030, slotR: 0.012, tilt: [0.20, 0.14] },
bucket: { …, plant: 'lay',  depth: 0.008, slotR: 0.0,   tilt: [0.00, 0.06] },
water:  { …, plant: 'lay',  depth: 0.008, slotR: 0.0,   tilt: [0.00, 0.06] },
can:    { …, plant: 'lay',  depth: 0.010, slotR: 0.0,   tilt: [0.00, 0.08] },
hand:   { …, plant: 'lay',  depth: 0.006, slotR: 0.0,   tilt: [0.00, 0.05] },
decor:  { …, plant: null },
eraser: null,
```

## 7.6 Lâcher à plat : l'animation de chute

Sur `Maj+G`, l'outil ne se plante pas : il **tombe**. C'est plus court et plus
simple, et ça doit rester **satisfaisant** — donc pas une simple téléportation.

```js
/**
 * Chute libre courte + rebond amorti + rotation qui se stabilise.
 * 0,45 s au total. On ne simule PAS une vraie physique de corps rigide :
 * une parabole plus deux rebonds decroissants suffisent, et c'est 30 lignes
 * au lieu d'un moteur physique.
 */
export class DropAnim {
  start(from, to, yawRad) {
    this.from = from.clone(); this.to = to.clone();
    this.yaw = yawRad;
    this.t = 0;
    // Vitesse horizontale : l'outil part legerement vers l'avant, comme si
    // on ouvrait la main plutot que de le laisser tomber a la verticale.
    this.arc = 0.10 + Math.random() * 0.06;
    this.spin = (Math.random() - 0.5) * 2.2;   // tours par seconde
    this.bounce = 0;
  }
  update(dt) {
    this.t += dt;
    const T = 0.45;
    const u = Math.min(1, this.t / T);
    // Parabole : montee courte, chute acceleree.
    const y = THREE.MathUtils.lerp(this.from.y, this.to.y, Ease.inQuad(u))
            + this.arc * Math.sin(Math.PI * u);
    // Deux rebonds decroissants sur la fin.
    const b = u > 0.72 ? Math.abs(Math.sin((u - 0.72) / 0.28 * Math.PI * 2))
                       * 0.035 * (1 - u) / 0.28 : 0;
    this.pos.set(
      THREE.MathUtils.lerp(this.from.x, this.to.x, Ease.outQuad(u)),
      y + b,
      THREE.MathUtils.lerp(this.from.z, this.to.z, Ease.outQuad(u)));
    // La rotation se fige avec le rebond : ce n'est pas un jouet qui roule.
    const spinDamp = Math.exp(-u * 4.5);
    this.quat.setFromEuler(new THREE.Euler(
      Math.PI * 0.5 * Math.min(1, u * 1.6),      // il se couche
      this.yaw + this.spin * u * spinDamp,
      this.spin * 0.4 * u * spinDamp));
    return u < 1;
  }
}
```

Au contact : `audio.play('drop')`, une petite bouffée de 6 grains, et **un
léger tassement du sable sous l'objet** (`B.compact(ctx, …, 0.15)`) — l'objet
laisse son empreinte, qui devient visible grâce au contraste de compaction
de §5.5. Détail à trois lignes, effet considérable.

## 7.7 Les outils au sol : `DroppedTools.js`

Le mécanisme de suivi de terrain **existe déjà** dans `Props.update()` : les
objets descendent quand on creuse dessous et remontent quand on les ensable.
On ne le réécrit pas, on le reprend — avec deux différences :

- les outils sont **peu nombreux** (≤ 12) et **tous différents** : un
  `InstancedMesh` par type serait absurde, on utilise des `Mesh` simples ;
- ils ont un **comportement de marée** que les coquillages n'ont pas.

```js
// ---------------------------------------------------------------------------
// src/render/DroppedTools.js
//
// Les outils que le joueur a laisses sur la plage.
//
// Ce sont de vrais objets du monde : ils portent une ombre, ils suivent le
// terrain (si on creuse dessous, ils tombent), la maree peut les emporter, et
// un clic les ramasse. Ils font partie du decor autant que les coquillages.
//
// Plafond volontairement bas (12) : au-dela, la plage devient un debarras et
// le chantier ne se lit plus. Le plus ancien s'enfonce et disparait.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { clamp } from '../core/Config.js';

const MAX_TOOLS = 12;

export class DroppedTools {
  /**
   * @param {import('../core/Game.js').Game} game
   * @param {(id:string)=>THREE.Object3D} makeMesh  fabrique fournie par ToolAvatar
   */
  constructor(game, makeMesh) {
    this.game = game;
    this.makeMesh = makeMesh;
    this.group = new THREE.Group();
    this.group.name = 'droppedTools';
    game.scene.add(this.group);
    this.items = [];
    this._cursor = 0;
    this._ray = new THREE.Raycaster();
    this.hovered = null;
  }

  /**
   * @param {string} id       identifiant d'outil
   * @param {THREE.Vector3} p position
   * @param {THREE.Quaternion} q
   * @param {object} state    { fill, moisture… } — l'etat visible est conserve
   */
  add(id, p, q, scale, state = {}) {
    if (this.items.length >= MAX_TOOLS) this._retireOldest();
    const obj = this.makeMesh(id, state);
    obj.position.copy(p);
    obj.quaternion.copy(q);
    obj.scale.setScalar(scale);
    obj.traverse((m) => { m.castShadow = true; m.receiveShadow = true; });
    obj.userData.toolId = id;
    this.group.add(obj);
    const item = { id, obj, state, born: this.game.time, sink: 0, drift: 0 };
    this.items.push(item);
    return item;
  }

  /** Le plus ancien s'enfonce sur 1,2 s puis disparait. Jamais de « pop ». */
  _retireOldest() {
    const it = this.items.shift();
    if (!it) return;
    it.retiring = 0;
    this._retiringList = this._retiringList || [];
    this._retiringList.push(it);
  }

  /** Ramassage : renvoie l'item sous le pointeur, ou null. */
  pick(pointer, camera) {
    this._ray.setFromCamera(pointer, camera);
    const hits = this._ray.intersectObjects(this.group.children, true);
    if (!hits.length) return null;
    let o = hits[0].object;
    while (o && !o.userData.toolId) o = o.parent;
    if (!o) return null;
    return this.items.find((it) => it.obj === o) || null;
  }

  remove(item) {
    const i = this.items.indexOf(item);
    if (i >= 0) this.items.splice(i, 1);
    this.group.remove(item.obj);
    item.obj.traverse((m) => { m.geometry?.dispose?.(); });
  }

  /** Surbrillance au survol : un liseré, pas de texte. */
  setHover(item) {
    if (this.hovered === item) return;
    const paint = (it, on) => it?.obj.traverse((m) => {
      if (m.material) m.material.emissiveIntensity = on ? 1.9 : 1.0;
    });
    paint(this.hovered, false);
    this.hovered = item;
    paint(item, true);
  }

  // -------------------------------------------------------------------------

  update(dt) {
    const F = this.game.field;
    const W = this.game.water;

    // Retraits en cours : l'outil s'enfonce doucement et disparait.
    if (this._retiringList) {
      for (let i = this._retiringList.length - 1; i >= 0; i--) {
        const it = this._retiringList[i];
        it.retiring += dt;
        it.obj.position.y -= dt * 0.09;
        if (it.retiring > 1.2) {
          this.group.remove(it.obj);
          this._retiringList.splice(i, 1);
        }
      }
    }

    // Comme Props.update() : on ne verifie qu'une tranche par frame. Avec 12
    // objets et une tranche sur 3, chacun est verifie 20 fois par seconde —
    // largement assez pour qu'aucun outil ne reste suspendu en l'air.
    const stride = 3;
    for (let i = this._cursor % stride; i < this.items.length; i += stride) {
      const it = this.items[i];
      const p = it.obj.position;
      const surf = F.surfaceHeightAt(p.x, p.z);
      // La cible : la POINTE de l'outil au niveau du sable, donc l'origine
      // legerement au-dessus (l'enfoncement est deja dans la pose).
      const target = surf - (it.state.depth ?? 0.01);
      const d = target - p.y;
      if (d < -0.004) p.y += Math.max(d, -2.5 * dt);        // le sol a baisse
      else if (d > 0.02) p.y += Math.min(d, 0.25 * dt);     // ensablement lent

      // --- la maree ---------------------------------------------------------
      const depth = W.depthAt(p.x, p.z);
      if (depth > 0.05) {
        // L'objet part vers l'aval : on suit le gradient de hauteur d'eau,
        // qui est le seul champ dont on soit sur qu'il existe.
        const e = 0.12;
        const gx = W.depthAt(p.x + e, p.z) - W.depthAt(p.x - e, p.z);
        const gz = W.depthAt(p.x, p.z + e) - W.depthAt(p.x, p.z - e);
        const s = clamp(depth * 0.9, 0, 0.6);
        p.x += gx * s * dt * 3.0;
        p.z += gz * s * dt * 3.0;
        // Il roule un peu en derivant : c'est ce qui rend la scene vivante.
        it.obj.rotateY(dt * s * 2.2);
        it.drift += dt;
        if (it.drift > 0.6 && !it.warned) {
          it.warned = true;
          this.game.toast('La mer emporte tes outils !');
        }
      } else it.drift = 0;

      // --- ensablement complet ---------------------------------------------
      // A plus de 12 cm sous la surface, on masque : l'outil est enterre.
      // Il ressortira quand la maree redescendra et erodera le sable.
      it.obj.visible = surf - p.y < 0.12;
    }
    this._cursor++;
  }

  serialize() {
    return this.items.map((it) => ({
      id: it.id,
      p: [+it.obj.position.x.toFixed(3), +it.obj.position.y.toFixed(3), +it.obj.position.z.toFixed(3)],
      q: [+it.obj.quaternion.x.toFixed(3), +it.obj.quaternion.y.toFixed(3),
          +it.obj.quaternion.z.toFixed(3), +it.obj.quaternion.w.toFixed(3)],
      s: +it.obj.scale.x.toFixed(3),
      st: it.state,
    }));
  }

  deserialize(data) {
    for (const it of [...this.items]) this.remove(it);
    if (!Array.isArray(data)) return;
    for (const d of data) {
      this.add(d.id, new THREE.Vector3(...d.p),
        new THREE.Quaternion(...d.q), d.s, d.st || {});
    }
  }
}
```

> **À ajouter dans `Save.js`** : `droppedTools: game.droppedTools.serialize()`.
> Un chantier qu'on retrouve exactement comme on l'a laissé, outils compris,
> c'est la moitié du plaisir de revenir sur une sauvegarde.

## 7.8 Le branchement complet

```js
// --- src/tools/ToolManager.js ----------------------------------------------

onKeyDown(e) {
  // … code existant …
  if (e.code === 'KeyG' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    this.game.toolAvatar?.plant(e.shiftKey ? 'lay' : 'stab', this.hit, this.ctx);
    return;
  }
  // … reste inchange …
}

onDown(e) {
  if (!this.enabled) return;
  if (e.button !== 0 && e.button !== 2) return;
  if (e.altKey) return;
  this.updatePointer(e);

  // PRIORITE AU RAMASSAGE : un clic sur un outil au sol le reprend, et ne
  // creuse pas. Le raycast contre 12 meshes est negligeable face au raycast
  // voxel qui suit.
  if (e.button === 0) {
    const it = this.game.droppedTools?.pick(this.pointer, this.game.camera);
    if (it) {
      e.preventDefault();
      this.select(it.id);
      this.game.toolAvatar?.pickUp(it);
      return;
    }
  }
  // … suite inchangee …
}

onMove(e) {
  if (!this.enabled) return;
  this.updatePointer(e);
  // Surbrillance au survol, seulement hors geste.
  if (!this.stroke) {
    this.game.droppedTools?.setHover(
      this.game.droppedTools.pick(this.pointer, this.game.camera));
  }
}
```

```js
// --- src/render/ToolAvatar.js : les trois methodes du cycle de vie ---------

/**
 * Plante ou pose l'outil courant.
 * @param {'stab'|'lay'} mode
 * @param {object} hit    le point vise (ToolManager.hit)
 * @param {object} ctx    EditContext, pour entailler le sable
 */
plant(mode, hit, ctx) {
  const def = RIGS[this.currentId];
  if (!hit || !def || !def.plant) {
    this.game.toast('Cet outil ne se pose pas.');
    return;
  }
  if (this.plantAnim?.active || this.bucket?.busy) return;

  const kind = mode === 'lay' ? 'lay' : def.plant;
  const anchor = new THREE.Vector3(hit.point.x, hit.point.y, hit.point.z);
  const yaw = Math.atan2(
    this.game.camera.position.x - anchor.x,
    this.game.camera.position.z - anchor.z) + 0.45;
  const [tilt0, tiltJit] = def.tilt;
  const tilt = kind === 'lay' ? Math.PI * 0.5 : tilt0 + Math.random() * tiltJit;
  const side = (Math.random() - 0.5) * 0.22;   // « legerement de travers »

  this._pendingPlant = { kind, anchor, yaw, tilt, side, def, ctx };

  if (kind === 'lay') {
    this.dropAnim.start(this.current.group.position, anchor, yaw);
  } else {
    this.plantAnim.start(anchor, def.depth, tilt, yaw, side);
  }
}

/** Appele par PlantAnim a la frame exacte de l'enfoncement. */
_onPlantImpact() {
  const P = this._pendingPlant;
  if (!P) return;
  const def = P.def;

  // 1. LE SABLE EST REELLEMENT ENTAILLE. Sans ca, l'outil traverse une
  //    surface intacte et toute la credibilite s'effondre.
  if (def.slotR > 0) {
    this.game.tools.undo.beginGroup('Planter ' + this.currentId);
    // Direction d'enfoncement : le manche est incline de `tilt`, la lame
    // descend donc obliquement.
    const dx = Math.sin(P.yaw) * Math.sin(P.tilt);
    const dz = Math.cos(P.yaw) * Math.sin(P.tilt);
    Brush.slot(P.ctx, P.anchor.x, P.anchor.y, P.anchor.z,
      dx, -Math.cos(P.tilt), dz, def.depth * 1.15, def.slotR);
    this.game.tools.undo.endGroup();
    // 2. Le sable retombe autour du manche : c'est la simulation qui le fait.
    const V = 0.04;
    const v = { x: (P.anchor.x + 5.12) / V, y: P.anchor.y / V, z: (P.anchor.z + 5.12) / V };
    const R = Math.ceil(def.slotR * 4 / V);
    this.game.granular.wakeBox(v.x - R, v.y - 4, v.z - R, v.x + R, v.y + 2, v.z + R);
  } else {
    // Objet pose a plat : il TASSE le sable sous lui, ce qui laisse une
    // empreinte visible grace au contraste de compaction (§5.5).
    Brush.compact(P.ctx, P.anchor.x, P.anchor.y, P.anchor.z, 0.09, 0.18);
  }

  // 3. Gerbe de grains + son.
  this.game.particles?.burst(1, P.anchor.x, P.anchor.y, P.anchor.z,
    10, { speed: 1.1, spread: 0.9 });
  this.game.particles?.ring(2, P.anchor, def.slotR * 3 + 0.03, 8, 0.35);
  this.game.audio?.play(def.slotR > 0 ? 'plant' : 'drop');
}

/** Fin de l'animation : l'outil passe de la main au monde. */
_finishPlant() {
  const P = this._pendingPlant;
  if (!P) return;
  this._pendingPlant = null;
  const state = { depth: P.def.depth };
  if (this.currentId === 'bucket') {
    state.fill = this.bucket?.fill ?? 0;
    state.moisture = this.bucket?._moist ?? 0.12;
  }
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(P.tilt, P.yaw, P.side, 'YXZ'));
  this.game.droppedTools.add(this.currentId, P.anchor, q, this._lastScale, state);
  // L'outil quitte la main : on repasse en STOWED, et le HUD le montre.
  this.stowed = true;
  this.current.group.visible = false;
  this.game.hud?.setToolStowed(true);
}

/** Ramassage : l'outil revient dans la main en 0,25 s, en arc. */
pickUp(item) {
  this.stowed = false;
  this.current && (this.current.group.visible = true);
  this._pickFrom = item.obj.position.clone();
  this._pickT = 0;
  if (this.currentId === 'bucket' && item.state.fill) {
    this.bucket?.setFill(item.state.fill, item.state.moisture);
    this.game.tools.current.fill = item.state.fill;
    this.game.tools.current.fillMoist = item.state.moisture;
  }
  this.game.droppedTools.remove(item);
  this.game.audio?.play('pickup');
}
```

## 7.9 Ils doivent être beaux à l'arrêt

Un outil au sol est vu **de loin, immobile, pendant des minutes** — la
contrainte inverse de celle de la section §4, où tout est mouvement. Trois
règles pour qu'il tienne le regard :

1. **La silhouette doit se lire couchée.** Une pelle vue de dessus n'est qu'un
   trait. C'est pour ça qu'on la **plante** par défaut : plantée, elle
   projette une **ombre longue** au soleil rasant, et l'ombre est la vraie
   silhouette. `castShadow = true` n'est pas optionnel ici.
2. **Le contact avec le sol doit être sale.** Un objet posé sur une surface
   parfaitement lisse a l'air en lévitation. On le règle par le tassement
   (`B.compact`) sous l'objet posé, et par l'entaille (`Brush.slot`) sous
   l'objet planté. Le sable **réagit** à l'objet, donc l'objet est là.
3. **Aucun objet n'est vertical, aucun n'est aligné.** Le `side` aléatoire de
   §7.4 et le `yaw` dérivé de la caméra garantissent que deux pelles plantées
   ne seront jamais parallèles.

**Bonus quasi gratuit : l'ensablement partiel.** Quand le sable monte autour
d'un outil (marée, avalanche, ou le joueur qui verse dessus), la boucle §7.7
le laisse ressortir **quatre fois plus lentement** que les props
(`0.25 * dt` contre `0.6 * dt` dans `Props.js`). Résultat : un outil passe
plusieurs secondes **à moitié enterré**, manche dépassant du sable. C'est une
image forte, et elle coûte un changement de constante.

---

<a name="8-anneau"></a>
# 8. L'ANNEAU DE CURSEUR

Les captures montrent un **anneau blanc en pointillés, fin et net, projeté sur
le relief**, avec par endroits un **second cercle concentrique plus large**.
C'est très proche de ce qu'on a déjà — mais notre anneau est coloré, plein,
et son épaisseur varie avec la distance. On le retravaille.

## 8.1 Shader ou géométrie projetée ?

| | Anneau dans le shader du sable (actuel) | Anneau en géométrie projetée |
|---|---|---|
| Épouse le relief | **exactement, gratuitement** | il faut le mailler ou le décalquer |
| Coût | quelques ALU dans un fragment shader déjà exécuté | 1 draw call + tri Z + z-fighting |
| Marche sur un mur vertical | **oui** | il faut reprojeter |
| Survit au remaillage asynchrone | **oui, il ne connaît pas le maillage** | non : à réattacher à chaque chunk |
| Anticrénelage | `fwidth`, parfait | dépend du MSAA |
| Sur l'eau et les props | non | oui |

**Verdict : on reste dans le shader.** L'argument décisif est le même qu'en
§5.5 : notre terrain est remaillé en continu et de façon asynchrone, donc tout
ce qui doit **coller à la surface** doit être calculé **à partir de la position
monde du fragment**, jamais attaché à une géométrie.

Le fait que l'anneau ne s'affiche pas sur les objets posés ou sur l'eau est un
**avantage** : il dit visuellement « la brosse agit sur le sable, pas sur ce
qui est posé dessus ».

## 8.2 Ce qui cloche dans l'anneau actuel

```glsl
// SandMaterial.js, etat actuel
if (uCursorStrength > 0.001) {
  float d = distance(vWorldPos, uCursor.xyz);
  float r = uCursor.w;
  // … ring … fill …
  clamp((ring * 0.7 + fill) * uCursorStrength, 0.0, 0.85));
}
```

Trois défauts :

1. **L'épaisseur du trait est en mètres, pas en pixels.** Le trait s'épaissit
   quand on zoome et disparaît quand on dézoome. Une bonne ligne d'interface a
   une largeur **constante à l'écran**.
2. **Il est plein, coloré et à 85 % d'opacité.** Il attire l'œil plus que le
   sable qu'il désigne, et sa couleur change à chaque outil, ce qui devient
   redondant maintenant que l'outil est un objet coloré présent dans la scène.
3. **Il n'a pas de pointillés**, donc rien ne le distingue d'un cerne
   d'humidité ou d'une ombre.

**Ce qui va bien, en revanche, et qu'il ne faut surtout pas casser :** la
distance est calculée **en 3D** (`distance(vWorldPos, uCursor.xyz)`). C'est
correct, et même subtil : la brosse `B.sphere` **est** une sphère 3D, donc son
empreinte sur une surface quelconque est exactement l'intersection d'une sphère
et de cette surface. Sur un mur de château vertical, l'anneau devient donc
naturellement un **arc de cercle qui remonte le mur** ; au fond d'un trou, il
devient une **ellipse déformée**. C'est physiquement juste et gratuit. On garde.

## 8.3 Le nouvel anneau

Trois améliorations, toutes dans le fragment shader :

**a) Largeur constante en pixels, avec `fwidth`.**

```glsl
// `fwidth(d)` = variation de d entre deux pixels voisins. Diviser par elle
// convertit une distance MONDE en distance PIXEL : on obtient un trait de
// largeur constante a l'ecran, quelle que soit la distance de camera ou
// l'inclinaison de la surface. C'est LA technique des lignes propres en 3D.
float aa = fwidth(d);
float ring = 1.0 - smoothstep(0.0, aa * 1.6, abs(d - r));
```

Sur une pente très inclinée, `fwidth(d)` devient grand et le trait s'élargit
légèrement dans l'espace monde tout en restant net à l'écran : c'est exactement
le comportement souhaité.

**b) Pointillés à pas constant en longueur d'arc.**

Il faut un angle autour du centre du curseur, **stable quelle que soit
l'orientation de la surface**. On envoie depuis le CPU deux vecteurs
orthonormés tangents à la surface au point visé — `ToolManager` a déjà
`hit.normal` sous la main, donc c'est trois lignes.

```glsl
uniform vec3 uCursorT;      // tangente 1
uniform vec3 uCursorB;      // tangente 2
uniform float uCursorDashes; // nombre de tirets, calcule CPU

vec3 rel = vWorldPos - uCursor.xyz;
float phase = atan(dot(rel, uCursorB), dot(rel, uCursorT));   // -PI..PI
// Pas constant en LONGUEUR D'ARC : le nombre de tirets est proportionnel au
// rayon, donc un tiret mesure toujours ~3 cm, que la brosse fasse 8 ou 42 cm.
float dash = step(0.42, fract(phase * (uCursorDashes / 6.2831853)));
```

```js
// --- ToolManager.updateCursorUniforms(), cote CPU -------------------------
updateCursorUniforms(hit) {
  const u = this.game.sandMaterial.userData.uniforms;
  if (hit) {
    u.uCursor.value.set(hit.point.x, hit.point.y, hit.point.z, this.radius);
    // Base tangente stable : on prend l'axe monde le MOINS aligne avec la
    // normale, ce qui evite toute singularite.
    const n = this._n.set(hit.normal.x, hit.normal.y, hit.normal.z).normalize();
    const a = Math.abs(n.y) < 0.9 ? this._axY : this._axX;
    u.uCursorT.value.crossVectors(n, a).normalize();
    u.uCursorB.value.crossVectors(n, u.uCursorT.value).normalize();
    // Un tiret tous les 3 cm d'arc, entre 12 et 64 tirets.
    u.uCursorDashes.value = Math.round(
      clamp((2 * Math.PI * this.radius) / 0.03, 12, 64));
    // La couleur de l'anneau est BLANCHE : l'identite de l'outil est
    // maintenant portee par l'objet lui-meme, qui est dans la scene et
    // colore. Un anneau colore ferait doublon et brouillerait la lecture.
    u.uCursorColor.value.setRGB(1, 1, 1);
    u.uCursorTint.value.set(this.current.cursor || '#7ec8ff');
  }
  u.uCursorStrength.value = this.cursorFade;
}
```

**c) Deux cercles concentriques, et ce qu'ils veulent dire.**

Les captures montrent un second cercle plus large. On lui donne un **sens
précis**, différent selon l'outil — sinon c'est de la décoration :

| Outil | Cercle intérieur (plein trait) | Cercle extérieur (pointillé fin) |
|---|---|---|
| Pelle, gomme, mirette | rayon d'action `r` | `r × 1.35` : la **zone d'influence douce** (`hardness < 1`, le bord de la brosse) |
| **Seau** | rayon de la bouche `r` | **l'empreinte de la tour à démouler** — le joueur voit *exactement* où elle atterrira |
| Arrosoir, seau d'eau | rayon d'arrosage | portée du ruissellement |
| Râteau | rayon | — (masqué) |
| Truelle | rayon | trace du plan de coupe |

Le cercle du seau est le plus utile des trois : c'est une **prévisualisation**,
et elle supprime l'essentiel de l'incertitude du geste.

```glsl
// --- SandMaterial.js, remplacement du bloc de curseur ---------------------
if (uCursorStrength > 0.001) {
  vec3  rel = vWorldPos - uCursor.xyz;
  float d   = length(rel);
  float r   = uCursor.w;
  float aa  = fwidth(d);

  // Angle stable sur toute surface, pour les pointilles.
  float phase = atan(dot(rel, uCursorB), dot(rel, uCursorT));
  float dash  = step(0.42, fract(phase * (uCursorDashes * 0.15915494)));

  // 1. Anneau principal : blanc, fin, pointille, largeur constante a l'ecran.
  float ring = (1.0 - smoothstep(0.0, aa * 1.6, abs(d - r))) * dash;

  // 2. Anneau exterieur : plus fin encore, plus discret, pointille decale.
  float dash2 = step(0.62, fract(phase * (uCursorDashes * 0.15915494) + 0.5));
  float ring2 = (1.0 - smoothstep(0.0, aa * 1.3, abs(d - r * uCursorOuter)))
                * dash2 * step(1.01, uCursorOuter);

  // 3. Remplissage interieur : tres leger, TEINTE DE L'OUTIL. C'est le seul
  //    endroit ou la couleur d'outil subsiste — a 10 % elle informe sans crier.
  float fill = (1.0 - smoothstep(r * 0.86, r, d)) * 0.10;

  vec3 mark = mix(uCursorTint, uCursorColor, ring + ring2);
  base = mix(base, mark,
             clamp((ring * 0.80 + ring2 * 0.34 + fill) * uCursorStrength, 0.0, 0.82));
}
```

## 8.4 Comportement sur les pentes et les murs

| Situation | Ce qui se passe | Pourquoi c'est juste |
|---|---|---|
| Sable plat | cercle parfait | — |
| Pente à 30° | ellipse, légèrement allongée dans la pente | la sphère coupe une surface inclinée |
| **Mur de château vertical** | **arc qui remonte le mur, refermé en U** | la sphère de brosse mord réellement le mur sur cette hauteur |
| Arête d'un créneau | l'anneau **se coupe en deux** de part et d'autre | la surface est discontinue, la brosse aussi |
| Fond d'un trou | ellipse resserrée, plus dense en pointillés | on est plus près, `fwidth` compense |
| Surface cachée derrière un mur | **rien** | le fragment n'est pas rendu — l'occultation est gratuite |

Le troisième cas est le plus important, et c'est celui qui justifie de garder
la distance 3D : **quand le joueur vise le flanc d'une tour, l'anneau lui montre
qu'il va entamer une hauteur de mur, pas une surface au sol.** Aucun décalque
plat ne saurait dire ça.

## 8.5 Ce qui reste à faire côté uniformes

```js
// --- SandMaterial.js : trois uniformes a ajouter --------------------------
uCursorT:      { value: new THREE.Vector3(1, 0, 0) },
uCursorB:      { value: new THREE.Vector3(0, 0, 1) },
uCursorDashes: { value: 28 },
uCursorOuter:  { value: 1.35 },   // 1.0 = pas de second cercle
uCursorTint:   { value: new THREE.Color(0x7ec8ff) },
```

Et `derivatives` : `fwidth` demande l'extension `OES_standard_derivatives` en
WebGL 1. **Le projet est en WebGL 2** (three.js r150+ par défaut), où elle est
native — rien à activer. ⚠︎ à vérifier si un jour un repli WebGL 1 est ajouté.

---

<a name="9-plan"></a>
# 9. PLAN D'IMPLÉMENTATION ORDONNÉ

Ordonné par **rapport plaisir apporté / effort**, pas par dépendances
techniques (celles-ci sont notées). Chaque étape est livrable et testable
seule : aucune ne laisse le jeu dans un état intermédiaire cassé.

| # | Étape | Effort | Plaisir | Ratio | Fichiers |
|---|---|---|---|---|---|
| **1** | **`GeoUtils` + `Ease` + `ToolAvatar` minimal, avec 3 outils** (pelle, dame, seau), palette plastique, inertie | 0,5 j | ★★★★★ | **le meilleur** | `GeoUtils.js`, `Ease.js`, `ToolGeometry.js`, `ToolAvatar.js`, `Game.js` |
| **2** | **`SandParticles` + grains à la pelle + poussière d'effondrement** | 0,5 j | ★★★★★ | **excellent** | `Particles.js`, `tools.js`, `Game.js` |
| **3** | **Le seau complet : `BucketRig` + machine à états + quatre issues** | 1,0 j | ★★★★★ | très bon | `BucketRig.js`, `tools.js` |
| **4** | **Planter la pelle (`G`) : `PlantAnim` + entaille `Brush.slot` + `DroppedTools`** | **0,5 j** | ★★★★★ | **excellent** | `PlantAnim.js`, `DroppedTools.js`, `Brush.js`, `ToolManager.js` |
| **5** | **Ramassage au clic + surbrillance de survol + sérialisation** | 0,25 j | ★★★★☆ | très bon | `ToolManager.js`, `DroppedTools.js`, `Save.js` |
| **6** | **Anneau de curseur blanc pointillé, `fwidth`, second cercle** | **0,25 j** | ★★★★☆ | **très bon** | `SandMaterial.js`, `ToolManager.js` |
| **7** | **Jauges diégétiques** : contenu du seau, calotte de la pelle, couleur d'humidité ; suppression de la barre HUD | 0,25 j | ★★★★☆ | très bon | `ToolAvatar.js`, `HUD.js`, `hud.css` |
| **8** | Contraste de compaction dans le shader (2 lignes) | 0,1 j | ★★★☆☆ | bon | `SandMaterial.js` |
| **9** | Les 4 géométries restantes (arrosoir, truelle, mirette, râteau) | 0,5 j | ★★★☆☆ | correct | `ToolGeometry.js` |
| **10** | Anticipation / frappe / accompagnement + écrasement | 0,25 j | ★★★★☆ | bon | `ToolAvatar.js`, `ToolManager.js` |
| **11** | Lâcher à plat (`Maj+G`) : `DropAnim` + empreinte de tassement | 0,25 j | ★★★☆☆ | correct | `PlantAnim.js`, `ToolAvatar.js` |
| **12** | La marée emporte et ensable les outils laissés trop bas | 0,25 j | ★★★★☆ | bon | `DroppedTools.js` |
| **13** | Gouttes d'arrosoir qui mouillent réellement le sable | 0,25 j | ★★★☆☆ | correct | `Particles.js`, `tools.js` |
| **14** | Réservoir d'arrosoir (8 L) + recharge à l'eau | 0,5 j | ★★★☆☆ | à débattre | `tools.js`, `ToolAvatar.js` |
| **15** | Mottes en `InstancedMesh` (48 max, ombrées) | 0,5 j | ★★☆☆☆ | faible | `Particles.js` |
| **16** | `kick()` de caméra sur effondrement majeur uniquement | 0,15 j | ★★☆☆☆ | faible | `DioramaControls.js` |

**Chemin critique recommandé : 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8.**
Trois jours et demi de travail, et le jeu passe d'« un curseur qui modifie un
terrain » à « des outils qu'on manipule, qu'on remplit, qu'on retourne et qu'on
plante dans le sable quand on a fini ». Les étapes 9 à 16 sont du polissage.

> **Note d'ordonnancement.** Les étapes 4 et 5 (planter / ramasser) sont
> remontées très haut par rapport à la version initiale de ce plan : elles
> répondent à une demande explicite du joueur, elles réutilisent des
> mécanismes déjà écrits (`Props.update()`, `Brush.sphere()`), et elles ne
> dépendent que de l'étape 1. **Rapport plaisir/effort : le second meilleur du
> document, juste après le seau.** L'étape 6 (l'anneau) est un quart de journée
> qui aligne le jeu sur sa référence visuelle directe.

## 9.1 Ordre de test après chaque étape

| Après | On doit voir |
|---|---|
| 1 | La pelle rouge à manche blanc apparaît, penche quand on bouge la souris, s'enfonce quand on maintient |
| 2 | Du sable jaillit à chaque coup ; une avalanche fait de la poussière |
| 3 | Le seau se remplit, se retourne, se pose, tapote, se lève, révèle la tour |
| 3 | Sable sec → le seau revient plein ; sable trop mouillé → la tour s'affaisse toute seule |
| 4 | `G` plante la pelle ; **elle entaille vraiment le sable**, oscille, s'immobilise de travers, porte une ombre |
| 4 | On change d'outil : la pelle **reste plantée** ; on creuse à côté, elle **descend avec le terrain** |
| 5 | Un clic sur la pelle plantée la reprend en main ; elle est surlignée au survol |
| 5 | On sauvegarde, on recharge : les outils sont exactement où on les avait laissés |
| 6 | L'anneau est blanc, pointillé, de largeur constante quel que soit le zoom |
| 6 | Sur le flanc d'une tour, l'anneau **remonte le mur** au lieu de rester à plat |
| 7 | Plus de barre HTML ; la pelle porte visiblement sa pelletée |
| 8 | Les zones tassées à la dame sont nettement plus sombres |
| 12 | Une pelle plantée bas sur l'estran est emportée à marée montante, avec un toast |

## 9.2 Pièges connus, à vérifier au fur et à mesure

1. **Le seau ne doit jamais diverger de la brosse.** `BUCKET_ASPECT` doit être
   la **même constante** dans `ToolGeometry.js` et dans le calcul de `capacity`
   de `tools.js`. Si l'un des deux dérive, le seau se remplit « à moitié »
   quand il est plein à l'écran, et l'illusion meurt.
2. **`up()` de `ToolManager` est appelé avant `endStroke()`.** Le stamp de la
   séquence arrive **après** que le groupe d'annulation ait été fermé : d'où le
   `beginGroup('Demoulage')` dans `onStamp` (§3.6).
3. **`field.surfaceHeightAt()` dans la boucle de particules.** Ne jamais
   l'appeler pour chaque particule à chaque frame. Le `gsStride = 8` est là
   pour ça, et il est non négociable.
4. **`geometry.computeBoundingSphere()` sur les `Points`.** À proscrire : on
   fixe une sphère de 40 m une fois pour toutes et `frustumCulled = false`.
   Sinon on recalcule une borne sur 3 000 points, 60 fois par seconde.
5. **`castShadow` sur l'outil** : la première fois qu'on ajoute un mesh à la
   scène avec `castShadow`, three.js peut recompiler la shadow map. C'est
   pour ça que `ToolAvatar` construit paresseusement à la **sélection**, pas
   au premier clic : le hoquet a lieu au changement d'outil, où personne ne le
   remarque.
6. **Le mode photo** doit masquer l'outil (`this.toolAvatar.root.visible = false`
   dans `togglePhotoMode`) : `tools.enabled = false` y est déjà.
7. **La sauvegarde.** `tool.fill` et `tool.stuck` ne sont pas sérialisés dans
   `Save.js`. Un seau resté plein est perdu au rechargement — acceptable, mais
   il faut alors réinitialiser `stuck = false` au chargement, sinon le joueur
   se retrouve avec un seau bloqué et vide.
8. **La touche `G` ne doit pas partir quand un champ de saisie a le focus.**
   `ToolManager.onKeyDown` teste déjà `e.target instanceof HTMLInputElement` —
   il faut placer la branche `KeyG` **après** ce test, pas avant.
9. **Le ramassage doit passer avant le raycast voxel**, sinon un clic sur une
   pelle plantée creuse un trou dessous au lieu de la reprendre. C'est le sens
   du bloc placé en tête de `onDown()` (§7.8).
10. **L'entaille de plantage doit être dans son propre groupe d'annulation.**
    Sans `beginGroup('Planter …')`, `Ctrl+Z` après un plantage annule le coup
    de pelle précédent, ce qui est incompréhensible pour le joueur.
11. **Les outils au sol ne doivent pas bloquer le raycast du terrain** quand
    on n'est pas en train de les viser : `DroppedTools.pick()` ne teste que le
    groupe des outils, jamais la scène entière. Ne jamais passer
    `scene.children` à ce raycaster.
12. **`fwidth` sur les bords de chunk.** Les dérivées sont calculées par
    quads de 2×2 pixels ; sur le bord d'un chunk remaillé, elles peuvent
    donner un pixel légèrement plus épais. C'est invisible en pratique, mais
    si ça se voit, la parade est de plafonner : `aa = min(fwidth(d), r * 0.06)`.
13. **`emissiveIntensity` pour la surbrillance** ne fonctionne que si le
    matériau a un `emissive` non nul — c'est le cas de tous nos plastiques
    (§2.1), et c'est une des raisons de l'avoir mis.

---

## ANNEXE A — Aide-mémoire des chiffres

| Grandeur | Valeur | Origine |
|---|---|---|
| FOV caméra | 32° | `Game.js` |
| Distance de travail | 15,5 m | `controls.focus(…, 15.5)` |
| Échelle à 15,5 m | 121 px/m à 1080p | `1080 / (2·15,5·tan16°)` |
| Un seau de 15 cm à 15,5 m | **18 px** | idem |
| Budget triangles / outil | < 500 | ce document |
| Triangles max instantanés | 480 | §2.9 |
| Draw calls outil | ≤ 3 | §2.9 |
| Budget particules | 3 000 | §5.1 |
| Coût CPU particules | ~0,05 ms/frame | §5.1 |
| Durée séquence de démoulage | 1,88 s (0,75 s accélérée) | §3.2 |
| Ressort outil léger | 5,2 Hz, ζ = 0,90 | §4.1 |
| Ressort seau plein | 2,1 Hz, ζ = 0,88 | §4.1 |
| Inclinaison max d'inertie | 0,38 rad (22°) | §4.1 |
| Écrasement max outil rigide | 6 % | §4.2 |
| Écrasement max matière molle | 12 % | §4.2 |
| Screen shake | **0** (sauf effondrement majeur : 6 mm) | §4.3 |
| Taille voxel | 4 cm | `Config.VOXEL` |
| Empreinte de paume réelle | 3 mm → sub-voxel → canal `packing` | §5.5 |
| **Rugosité du plastique jouet** | **0,34** (metalness 0, emissive ×0,05) | §2.1 |
| Rouge des outils | `0xe0341f` | §2.1 |
| Bleu / jaune / vert / manche | `0x1f6fd0` / `0xf2b21f` / `0x33a05a` / `0xf2efe7` | §2.1 |
| **Touche pour planter / poser** | **`G`** (`Maj+G` = à plat) | §7.3 |
| Durée du plantage | **0,55 s** (0,10 + 0,13 + 0,32) | §7.4 |
| Enfoncement de la pelle | 7,5 cm | §7.5 |
| Inclinaison d'un outil planté | 15 à 23°, plus ±6,3° de dévers | §7.4 |
| Oscillation du manche | 3,2 Hz, τ = 0,11 s, amplitude 0,13 rad | §7.4 |
| Outils au sol simultanés | **12** max | §7.7 |
| Vitesse de désensablement d'un outil | 0,25 m/s (4× plus lent qu'un prop) | §7.9 |
| Anneau de curseur | **blanc, pointillé, ~1,6 px, un tiret / 3 cm d'arc** | §8.3 |
| Second cercle | `r × 1,35` (prévisualisation de la tour pour le seau) | §8.3 |

## ANNEXE B — Références

Corpus utilisé (⚠︎ à revérifier en ligne quand le budget de recherche sera
disponible ; les API three.js citées ont été vérifiées contre l'usage réel du
dépôt, qui utilise déjà `LatheGeometry`-compatible, `ExtrudeGeometry`,
`InstancedMesh` et `ShaderMaterial`) :

- **three.js** — `LatheGeometry`, `ExtrudeGeometry`, `Points` /
  `PointsMaterial`, `InstancedMesh`, `BufferAttribute.setUsage`,
  `DecalGeometry` (addon), `AnimationMixer` / `AnimationClip`.
- **Thomas & Johnston**, *The Illusion of Life* — les douze principes ; ici
  surtout **anticipation**, **follow-through & overlapping action**,
  **squash & stretch**, **slow in / slow out**, **arcs**.
- **Steve Swink**, *Game Feel* (2008) — la notion de *real-time control*,
  *simulated space*, *polish* ; et l'idée que le retour d'un outil doit arriver
  dans les 100 ms du geste.
- **Martin Jonasson & Petri Purho**, « Juice it or lose it » (2012) — le
  catalogue d'effets à coût nul : écrasement, particules, retard, sur-course.
- **Squirrel Eiserloh**, « Fast and Funky 1D Nonlinear Transformations »
  (GDC 2015) — la famille de courbes `SmoothStart` / `SmoothStop` / `Crossfade`,
  base des easings de `Ease.js`.
- **« Sandcastle » (démo Steam)** — trois captures fournies par le joueur,
  décodées en §1.4 : outils-props posés sur le sable avec ombre portée, anneau
  blanc pointillé, double cercle concentrique, invite de lâcher d'objet. C'est
  la référence de direction artistique la plus proche de notre caméra.
- **Bible des châteaux de sable**, §2.4 (protocole du seau, treize étapes),
  §3.1 (dame / tamper), §3.3 (truelle, mirette), §3.4 (arrosoir) — le document
  interne du projet.
- Fichiers du dépôt lus pour ce document : `src/tools/tools.js`,
  `src/tools/ToolManager.js`, `src/tools/Brush.js`, `src/render/Props.js`,
  `src/render/SandMaterial.js`, `src/render/DioramaControls.js`,
  `src/core/Config.js`, `src/core/Game.js`, `src/sim/SandPhysics.js`,
  `src/sim/Granular.js`, `src/ui/HUD.js`.
