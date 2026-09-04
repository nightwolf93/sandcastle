# SANDCASTLE — Document de Game Design & UX

> Jeu cozy 3D de construction de châteaux de sable, navigateur (Three.js).
> Terrain voxel sculptable ~5 cm, humidité par voxel, eau shallow-water 2D, érosion, marée.
> Caméra orbitale diorama sur un bloc de plage de 12 m × 12 m.
>
> **Version du doc :** 1.0 — document d'implémentation, pas un pitch.
> **Public :** l'équipe (toi) qui code. Tout ce qui est chiffré est une valeur de départ à tuner, pas une vérité.

---

## SOMMAIRE

1. [Piliers de design](#1-piliers-de-design)
2. [Boucle de jeu](#2-boucle-de-jeu)
3. [Les outils — spécification détaillée](#3-les-outils--spécification-détaillée)
4. [Contrôles et caméra](#4-contrôles-et-caméra)
5. [UX / Interface](#5-ux--interface)
6. [Feel, audio et ambiance](#6-feel-audio-et-ambiance)
7. [Contenu](#7-contenu)
8. [Plan de production priorisé](#8-plan-de-production-priorisé)
9. [Annexes techniques](#9-annexes-techniques)

---

## 0. MODÈLE DE MATIÈRE — LE VOCABULAIRE COMMUN

Avant les piliers, on fixe le vocabulaire, parce que **tout le document y fait référence**. Ce sont les 4 champs par voxel et les 4 états du sable. Toute la UI, tous les outils, tous les sons dérivent de ça.

### 0.1 Données par voxel

Grille : 240 × 240 × 64 voxels (12 m × 12 m × 3,2 m à 5 cm). Chunks de 32³ → 8 × 8 × 2 = **128 chunks**.

| Champ | Type | Plage | Signification |
|---|---|---|---|
| `density` | `Uint8` | 0–255 | Taux de remplissage du voxel. 0 = air, 255 = plein. Permet une isosurface lisse (Surface Nets), pas des cubes. |
| `moisture` | `Uint8` | 0–255 | Saturation `w` normalisée. C'est LE paramètre héros. |
| `compaction` | `Uint8` | 0–255 | Densité de tassement `φ`. Monte avec le tapotement/pound-up, descend avec l'érosion. |
| `material` | `Uint8` | enum | `SABLE_FIN`, `SABLE_COQUILLE`, `SABLE_NOIR`, `GALET`, `VASE`, `DECO_ANCRE` (voxel décor non érodable). |

Coût mémoire : 240 × 240 × 64 × 4 o = **14,7 Mo**. Acceptable en navigateur. 4 `Uint8Array` séparés (SoA), pas un array d'objets.

### 0.2 Les quatre états du sable

C'est ce que le panneau de gauche affiche. C'est ce que le joueur apprend en 90 secondes sans lire une ligne de texte.

| État | `w` (moisture) | Physique réelle | Angle de repos | Cohésion | Comportement de jeu | Couleur UI |
|---|---|---|---|---|---|---|
| **Sable sec** | 0,00 – 0,10 | Grains libres, pas de ponts capillaires | 32–34° | ~0 | S'écroule immédiatement, coule, fait des tas coniques, se souffle au vent. Inutilisable pour bâtir, parfait pour texturer et pour les dunes. | Crème `#F2E3C4` |
| **Sable humide** | 0,10 – 0,35 | Régime **pendulaire** — ponts capillaires entre grains, cohésion maximale | 70–90° (verticale possible si tassé) | **max** | LE sable à château. Tient les murs verticaux, se sculpte net, garde les arêtes. | Sable moyen `#D9B98A` |
| **Sable mouillé** | 0,35 – 0,70 | Régime **funiculaire** — l'eau remplit les pores, la tension de surface baisse | 45–60° | moyenne | Se travaille bien au seau et à la main, mais s'affaisse lentement, arrondit les arêtes. Bon pour les masses, mauvais pour les détails. | Brun mouillé `#A67C52` |
| **Sable saturé** | 0,70 – 1,00 | Régime capillaire / liquéfaction | 5–20° | ~0 (visqueuse) | Coule comme une soupe. C'est la matière du **drip castle**. Sous charge : liquéfaction, effondrement. | Brun foncé brillant `#6E4B32` |

**Courbe de cohésion** (implémentation) :

```
cohesion(w) = COH_MAX * exp( -((w - 0.22)^2) / (2 * 0.11^2) )   // gaussienne centrée sur 0.22
cohesion_effective = cohesion(w) * (0.35 + 0.65 * φ)             // le tassement multiplie
angle_repos(w, φ) = 32° + 58° * (cohesion_effective / COH_MAX)
```

Trois conséquences de design qui doivent être **lisibles à l'écran** :
1. Trop arroser est aussi mauvais que pas assez. Le joueur doit apprendre ça, pas le lire.
2. Le tassement (`φ`) double presque la résistance. C'est la récompense du geste de tapotement.
3. Le sable sèche avec le temps (évaporation) → un mur parfait à midi devient friable à 15 h. C'est un moteur de tension douce, jamais une punition.

### 0.3 Champs globaux

| Champ | Grille | Description |
|---|---|---|
| `waterHeight h[x,z]` | 240 × 240 `Float32` | Hauteur de la lame d'eau libre (shallow water 2D). |
| `waterVel u,v[x,z]` | 240 × 240 `Float32` ×2 | Vitesse de l'eau, pilote l'érosion et le rendu des remous. |
| `waterTable` | scalaire + gradient | Nappe phréatique. Altitude = niveau de mer + capillarité. Creuser en dessous → l'eau sourd. |
| `seaLevel` | scalaire animé | Niveau de la mer, piloté par la marée. |
| `sediment[x,z]` | 240 × 240 `Float32` | Sable en suspension transporté par l'eau, redéposé quand la vitesse tombe. |

### 0.4 Évaporation, capillarité, drainage

Trois processus lents (tick à 4 Hz suffit) qui font vivre le champ d'humidité :

| Processus | Règle | Effet joueur |
|---|---|---|
| **Évaporation** | `w -= EVAP * soleil * vent * exposition_air * dt`. `EVAP` ≈ 0,004/s au soleil de midi, 0,0008/s à l'aube. | Le château sèche. Blanchiment visible en surface. Il faut ré-humidifier. |
| **Capillarité (remontée)** | Diffusion verticale ascendante depuis la nappe, `w += CAP * (1 - w) * proximité_nappe`. Portée ~35 cm au-dessus de la nappe. | Le bas des murs reste humide et solide. Creuser près de l'eau donne du bon sable gratuitement. C'est une leçon implicite. |
| **Drainage / diffusion** | Diffusion isotrope + gravité : l'eau descend. `w` se lisse entre voxels voisins avec un biais vers le bas. | Arroser le haut d'une tour mouille tout le fût. Verser trop d'eau crée une flaque au pied. |

---

## 1. PILIERS DE DESIGN

Cinq piliers. Chaque décision de design doit pouvoir se justifier par au moins un pilier, et ne contredire aucun. Si une feature ne rentre dans aucun, elle ne rentre pas dans le jeu.

### Pilier 1 — LA MATIÈRE EST LE VRAI PERSONNAGE

Le sable n'est pas un décor ni un support : c'est l'entité avec laquelle on entretient une relation. Il a des humeurs (sec/humide/mouillé/saturé), il réagit, il résiste, il récompense, il vous trahit un peu. Le joueur ne fait pas « poser un mur », il fait « convaincre du sable de tenir debout ».

**Ce que ça implique concrètement :**
- Aucun objet n'est un *prefab posé*. Tout ce qui existe dans la scène est du champ de voxels, ou de la déco posée par-dessus. Une tour est un accident de densité, pas un mesh.
- La qualité du résultat dépend d'un **paramètre physique lisible** (l'humidité), jamais d'un niveau de compétence caché ni d'un jet de dés.
- On investit le budget d'ingénierie dans le **retour de la matière** avant tout le reste : le grain qui glisse, l'arête qui s'effrite, la trace de main mouillée, le brillant qui s'éteint en séchant.
- Il existe toujours une **jauge d'humidité sous le curseur**. Toujours. C'est le HUD le plus important du jeu, avant même la barre d'outils.

**Ce que le jeu N'EST PAS :** un éditeur de meshes déguisé. Pas de « poser une tour préfabriquée ». Pas de grille de construction type Minecraft. Pas de snapping cubique visible.

### Pilier 2 — COZY : SÉCURITÉ, ABONDANCE, DOUCEUR

On applique littéralement la triade classique du cozy game (safety / abundance / softness).

| Axe | Traduction dans Sandcastle |
|---|---|
| **Sécurité** | Aucun danger. Aucune perte irréversible non désirée. Undo illimité dans la session. Sauvegarde auto toutes les 20 s. Aucune activité obligatoire : les défis sont opt-in, visibles mais jamais imposés, et jamais notifiés en rouge. |
| **Abondance** | Le sable est infini. L'eau est infinie. Le temps est infini (mode sans marée). On ne gère pas de stock. Les « coquillages » sont une monnaie de collection cosmétique, jamais un gate sur la création. |
| **Douceur** | Palette crème/sable/turquoise désaturée. Pas de contraste dur. Pas de sons secs sauf ceux de la matière. Aucune animation de UI en dessous de 180 ms. Aucune notification qui interrompt. Aucun compteur qui clignote. |

**Ce que le jeu N'EST PAS :** un jeu de gestion. Pas de barre de faim, d'énergie, d'argent qui manque, de timer imposé, de PNJ mécontent, de score qui baisse, de « game over ». Pas de son d'échec. Le mot « échec » n'apparaît nulle part.

### Pilier 3 — LE PLAISIR TACTILE AVANT LE RÉSULTAT

Un joueur doit pouvoir jouer 10 minutes en ne faisant que **creuser et tapoter**, et trouver ça agréable. Si creuser un trou n'est pas satisfaisant à vide, aucune tour ne sauvera le jeu.

**Ce que ça implique concrètement :**
- Chaque outil a une **micro-boucle de 200–600 ms** entièrement satisfaisante : anticipation → contact → déformation → particules → son → repos.
- L'input est continu et analogique. On maintient le clic, on ne clique pas. La force du geste dépend de la vitesse du curseur (un geste lent = précis et faible, un geste rapide = large et fort).
- Le curseur n'est jamais un pointeur : c'est un **outil physique projeté sur la surface**, orienté par la normale, qui s'enfonce visiblement.
- **Test de validation :** enregistrer 30 s de « creuser un trou et le lisser », sans UI, sans musique. Si ce clip n'est pas agréable à regarder en boucle, on n'est pas prêt.

**Ce que le jeu N'EST PAS :** un jeu de menus. Aucun dialogue modal n'interrompt le geste. Toute la sélection d'outil se fait sans quitter la surface (menu radial sous le curseur).

### Pilier 4 — L'ÉPHÉMÈRE EST BEAU (LA MARÉE REPREND TOUT)

La marée finit toujours par monter. Le château finit toujours par retourner à la plage. **Ce n'est pas une défaite : c'est le troisième acte.** Le jeu est construit pour que la dissolution soit le plus beau moment de la session, pas le plus frustrant.

**Ce que ça implique concrètement :**
- La marée est **annoncée longtemps à l'avance**, en douceur, diégétiquement (la mer monte visiblement, les mouettes se rapprochent, la lumière change, la musique passe sur un thème plus large).
- Avant que la mer n'atteigne le château, le jeu **propose** (jamais n'impose) le mode photo : la caméra ralentit, un léger vignettage apparaît, un bouton « Garder ce moment » pulse doucement.
- L'érosion est jouée comme un **spectacle** : le premier filet d'eau qui contourne les douves, la première tour qui s'affaisse lentement, la trace du château qui persiste comme une ombre dans le sable lissé. Slow motion optionnel.
- Le résultat est **conservé** dans l'Album (photo + petit modèle 3D miniature consultable). Rien n'est perdu, seul le sable l'est.
- Il existe toujours le bouton **« Retenir la mer »** (mode sans marée) et le bouton **« Refaire monter »**. Le joueur contrôle son rapport à l'éphémère.

**Ce que le jeu N'EST PAS :** un roguelike. La marée n'efface aucune progression, aucun déblocage, aucune photo, aucun coquillage. Elle n'efface que du sable.

### Pilier 5 — ZÉRO FRICTION D'ENTRÉE, PROFONDEUR OPTIONNELLE

On doit être en train de creuser **8 secondes** après l'ouverture de l'onglet. Le jeu tourne dans un navigateur : le joueur est à un clic de partir. En même temps, un sculpteur de sable avancé doit pouvoir passer 3 h sur une seule tour.

**Ce que ça implique concrètement :**
- Pas d'écran-titre bloquant : le jeu démarre sur la plage, la caméra descend, la pelle est déjà en main. Le menu est un bouton.
- **Deux couches d'outils** : la couche 1 (pelle, main, seau, arrosoir) suffit à faire un joli château. La couche 2 (truelle, mirette, râteau, coffrages, tampons, symétrie, plans de travail) est de la profondeur pour ceux qui la cherchent, débloquée par l'usage, jamais par un mur.
- Aucun tutoriel textuel de plus de 5 mots. Tout passe par la démonstration, la main fantôme, et l'affordance.
- Budget performance dur : **60 fps sur un laptop intégré de 2020**, chargement < 4 s, build < 8 Mo gzip.

**Ce que le jeu N'EST PAS :** un simulateur professionnel de sculpture sur sable. Pas de courbes de Bézier, pas d'arbre de modificateurs, pas de gestion de calques. La profondeur vient de la matière, pas de la complexité de l'outillage.

### 1.6 Tableau de synthèse : EST / N'EST PAS

| Le jeu EST | Le jeu N'EST PAS |
|---|---|
| Un bac à sable physique | Un jeu de construction à pièces |
| Une relation avec une matière | Un éditeur 3D |
| Contemplatif et tactile | Optimisable et scorable |
| Ephémère par design | Punitif ou roguelike |
| Immédiat à comprendre | Simple à maîtriser |
| Une session de 15 min complète | Un jeu-service à daily quests |
| Beau en photo | Beau en tableau de stats |
| Silencieux quand on ne joue pas | Rempli de notifications |

---

## 2. BOUCLE DE JEU

### 2.1 Boucle minute (5 s – 90 s) — LE GESTE

C'est la boucle qui doit être parfaite. Tout le reste est décoration.

```
  ┌──────────────────────────────────────────────────────────────┐
  │                                                              │
  │   OBSERVER ──▶ HUMIDIFIER ──▶ DÉPLACER ──▶ TASSER ──▶ SCULPTER
  │   (l'état     (arrosoir,     (pelle,      (main,     (truelle,
  │    du sable    seau d'eau,    seau,        tapote)    mirette,
  │    sous le     creuser vers   coffrage)               râteau)
  │    curseur)    la nappe)                                │
  │        ▲                                                │
  │        └────────────────── ÉVALUER ◀────────────────────┘
  │                          (ça tient ? c'est beau ?)
  └──────────────────────────────────────────────────────────────┘
```

**Détail seconde par seconde d'une boucle minute typique :**

| t | Action | Retour du jeu |
|---|---|---|
| 0,0 s | Le joueur survole une zone | Disque de brosse projeté sur la surface, orienté normale. Pastille d'humidité sous le curseur : « SEC ». Le panneau Sable met en avant la jauge Sec. |
| 0,3 s | Il passe à l'arrosoir (molette ou touche `3`) | Le curseur se transforme en pomme d'arrosoir. Prévisualisation : anneau bleu translucide = zone qui sera mouillée. |
| 0,5–2,0 s | Maintient LMB | Filet d'eau animé, sable qui fonce progressivement (shader : `roughness` ↓, `albedo` ↓, léger `specular`). Son : arrosage doux, pitch qui monte avec la saturation locale. La pastille passe SEC → HUMIDE. Micro-vibration haptique continue. |
| 2,0 s | Relâche. Passe à la pelle (`1`) | Le sable reste sombre et brille légèrement. |
| 2,2–5,0 s | Creuse en maintenant LMB, geste circulaire | Le sol s'enfonce, un tas se forme **à côté** (le sable retiré est conservé, pas supprimé). Grains qui roulent. Son de pelle qui mord. À −20 cm, la couche révélée est visiblement plus foncée (humidité de profondeur). |
| 5,0 s | Il voit apparaître un scintillement au fond du trou | La nappe affleure. Un mince film d'eau apparaît, avec une réflexion du ciel. Son : petit « gloup ». Pastille : MOUILLÉ. |
| 5,5–9,0 s | Passe à la main (`2`), tapote le tas | Le tas se compacte visiblement (−12 % de hauteur, +densité), les grains libres tombent, la surface devient lisse et mate. Son : « flop » sourd, satisfaisant, avec variation de pitch. Jauge de stabilité autour du curseur : orange → vert. |
| 9,0 s | Il recule la caméra | Il a un tas compact, humide, stable, prêt à devenir une tour. |

**Règles d'or de la boucle minute :**
- **Latence input → pixel : < 50 ms.** Non négociable. On applique la déformation visuelle immédiatement (remesh du chunk touché seulement), la physique lourde rattrape au tick suivant.
- **Aucune action ne demande de confirmation.** Aucune.
- **Tout est annulable** (Ctrl+Z) y compris un effondrement.
- **Le sable n'est jamais détruit.** Ce qu'on retire apparaît quelque part. Ce déplacement conservatif est la source principale de la crédibilité tactile.

### 2.2 Boucle session (12 – 45 min) — LE CHÂTEAU

Une session est une marée. Structure en quatre actes, entièrement facultative (le joueur peut ne faire que l'acte 2 pendant trois heures).

```
ACTE I — CHOISIR (1–3 min)        ACTE II — BÂTIR (10–30 min)
 ▸ Choisir plage / heure / météo   ▸ Terrasser la plateforme
 ▸ Marée basse, plage vierge       ▸ Monter les masses (seau, coffrage)
 ▸ La caméra descend, on est là    ▸ Sculpter les détails
                                   ▸ Creuser les douves
        │                                    │
        ▼                                    ▼
ACTE IV — GARDER (1–4 min)        ACTE III — LA MER MONTE (5–10 min)
 ▸ Mode photo proposé              ▸ Annonce douce (lumière, mouettes)
 ▸ Photo → Album                   ▸ Premières langues d'eau
 ▸ Coquillages / déblocages        ▸ Douves qui se remplissent
 ▸ « Nouvelle marée ? »            ▸ Érosion, affaissements, dissolution
                                   ▸ (ou : « Retenir la mer »)
```

**Acte I — Choisir (1–3 min).** Écran unique, non modal, en 3D : une carte-carnet ouverte sur le sable avec les plages débloquées, un cadran solaire pour l'heure, un petit baromètre pour la météo. Trois clics maximum. Bouton géant « Reprendre là où j'en étais ».

**Acte II — Bâtir (10–30 min).** Le cœur. Aucune interruption. Aucun objectif affiché sauf si le joueur a activé un défi. La mer est loin, on entend juste les vagues. Le seul indicateur de temps est **diégétique** : la position du soleil et le niveau de la mer au loin.

**Acte III — La mer monte (5–10 min, désactivable).** Progression en quatre paliers, chacun annoncé par un signal sensoriel et non par du texte :

| Palier | Signal diégétique | Signal UI (discret) |
|---|---|---|
| **T-10 min** | Les mouettes se rapprochent et se posent sur la plage. Vagues légèrement plus fortes. | Le badge de lieu en haut ajoute une petite icône de marée montante, sans son. |
| **T-5 min** | La ligne d'écume avance visiblement. Le sable au loin devient miroir. La musique glisse vers un pad plus large. | Une fine ligne bleue apparaît au sol montrant la limite de marée haute prévue. |
| **T-2 min** | Première langue d'eau qui touche les douves. Le vent forcit. | Le bouton Photo pulse doucement (2 % de scale, 1,2 s). Toast non bloquant : « La mer arrive » + bouton « Retenir ». |
| **T-0 → +8 min** | Érosion, affaissements, dissolution. Ralenti optionnel. | Rien. Silence UI total. C'est le spectacle. |

**Acte IV — Garder (1–4 min).** Post-marée : la plage est lissée, il reste une empreinte fantôme du château (une légère bosse, quelques coquillages). Le jeu propose : Album (la photo est là), gains de coquillages, éventuel déblocage. Puis « Nouvelle marée » ou « Retour au carnet ».

### 2.3 Boucle longue (heures / semaines) — LA COLLECTION

**Principe absolu : la progression ne débloque jamais une capacité nécessaire, seulement une capacité désirable.** On peut faire un château magnifique avec les 4 outils de départ. Tout le reste est du confort, de la vitesse ou de la décoration.

Quatre axes de progression, tous non punitifs, tous cumulatifs, aucun ne se perd :

| Axe | Contenu | Déclencheur de déblocage | Sensation visée |
|---|---|---|---|
| **Outils** | 18 outils, dont 4 de départ | **Usage** : le jeu observe ce que fait le joueur et lui offre l'outil qui résout son problème actuel. | « Le jeu m'a compris » |
| **Décorations** | Coquillages, drapeaux, plantes, props | **Achat** en coquillages à la Cabane (boutique) + trouvailles en creusant | Collection, chasse au trésor |
| **Lieux** | 9 plages | **Jalons** du Carnet (nb de châteaux, photos, marées vécues) | Voyage, nouveauté visuelle |
| **Moments** | 8 heures du jour × 6 météos | **Progressif** : nouvelles heures offertes toutes les 2–3 sessions | Ambiance, photo |

#### 2.3.1 Déblocage d'outils par l'usage (détail)

Le jeu maintient un petit compteur de signaux et propose l'outil quand le besoin est démontré. L'offre est **diégétique** : l'outil apparaît physiquement dans le sable à côté du joueur, avec un léger scintillement, et une main fantôme le ramasse si on clique. Jamais de popup.

| Outil offert | Condition déclencheuse | Formulation interne |
|---|---|---|
| **Seau** | Le joueur a compacté ≥ 3 tas à la main | « Il empile, donne-lui un moule » |
| **Seau d'eau** | Il a vidé l'arrosoir ≥ 5 fois d'affilée | « Il veut plus d'eau, plus vite » |
| **Truelle** | Il a lissé la même arête à la main ≥ 4 fois | « Il cherche des plans nets » |
| **Mirette** | Il a fait un mur vertical > 40 cm de haut | « Il va vouloir des fenêtres » |
| **Râteau** | Il a passé > 60 s en mode photo sur un mur nu | « Il regarde une surface vide » |
| **Coffrage** | Il a fait 2 tours au seau côte à côte | « Il veut plus gros que le seau » |
| **Paille** | Il a fait ≥ 15 coups de mirette | « Ses détails sont noyés dans les débris » |
| **Tampons** | Il a sculpté 6 créneaux à la main | « Il fait de la répétition, automatise » |
| **Drip castle** | Il a créé du sable saturé (w > 0,8) accidentellement ≥ 2 fois | « Il a découvert la soupe, montre-lui l'art » |
| **Canal** | Il a creusé une douve fermée ≥ 2 m de périmètre | « Il veut de l'eau dedans » |
| **Symétrie** | Il a construit 2 tours quasi identiques | « Il se répète, aide-le » |
| **Fixatif** | Il a subi 3 effondrements sur la même structure | « Il s'acharne, offre-lui une aide » |

Filet de sécurité : si un outil n'est pas débloqué après **4 sessions**, il est offert d'office. Personne ne reste bloqué.

#### 2.3.2 Le Carnet de plage (progression visible)

Interface diégétique : un carnet à spirale, papier crème, dessins au crayon, écriture manuscrite. Trois onglets :

- **Croquis** — les 18 outils, dessinés à la main. Les non débloqués sont en pointillés très pâles (on voit la forme, on devine, on désire). Pas de « ??? », pas de cadenas : juste un dessin pas encore fini.
- **Plages** — une carte côtière aquarellée. Les plages débloquées sont peintes, les autres au crayon. Un jalon écrit à la main sous chaque plage grisée (« après 5 marées »).
- **Album** — les photos, en polaroids collés, avec la date, le lieu, l'heure, et le nom que le joueur a donné au château.

### 2.4 Défis optionnels cozy

Règles communes à **tous** les défis :
- Toujours accessibles depuis le carnet, **jamais** poussés par notification.
- Toujours **abandonnables** en un clic, sans conséquence, sans dialogue de confirmation.
- Aucun ne peut être « raté ». Le pire résultat est « pas terminé cette fois », formulé comme tel.
- Chaque défi a un interrupteur global « Mode sans chrono » qui remplace le temps par « quand tu veux ».

| Défi | Description | Durée | Récompense | Garde-fou |
|---|---|---|---|---|
| **Marée montante** | La marée est accélérée (×3). Bâtir le plus haut possible avant l'eau. | 8 min | Coquillages selon hauteur atteinte, **jamais zéro** | Bouton « Ralentir la mer » toujours visible ; le chrono est un niveau d'eau, pas des chiffres |
| **Concours de plage** | 3 châteaux PNJ apparaissent à côté. Un jury de mouettes « note » selon 3 critères visibles (hauteur / détail / eau). | 20 min | Un ruban décoratif (déco posable) | Tout le monde reçoit un ruban. Les rubans sont différents, pas hiérarchisés. Pas de classement chiffré. |
| **Commande de PNJ** | Un enfant demande « une tour avec une fenêtre et un drapeau ». Objectifs illustrés par un dessin d'enfant épinglé. | Libre | Coquillages + parfois un outil | Validation floue et généreuse : la détection accepte tout ce qui ressemble. Le PNJ est toujours ravi. |
| **Photo du jour** | Un thème quotidien (« une ombre longue », « quelque chose de bleu », « une tour penchée »). | Libre | 1 coquillage + place dans l'Album communautaire local | Aucune notation. On soumet ou pas. |
| **Restaurer une ruine** | La plage commence avec un château à moitié érodé (généré). Le réparer. | Libre | Déco unique | Pas de « % de restauration » : juste avant/après en photo |
| **Le sable parfait** | Amener une zone de 2 m² pile dans la fenêtre `w ∈ [0,18 ; 0,28]` et `φ > 0,8`. | 3 min | Débloque le fixatif plus tôt | C'est un exercice sensoriel, pas un test. Feedback continu par la couleur du sol. |
| **Marée nocturne** | Marée à la lueur de la lune, plancton bioluminescent dans l'eau. | 15 min | Décos lumineuses | Purement esthétique |

### 2.5 Économie (volontairement minuscule)

Une seule monnaie : **les coquillages**. Non pas parce qu'on en a besoin, mais parce que ramasser des coquillages est agréable.

| Source | Gain |
|---|---|
| Creuser (chance ~1,5 % par m³ déplacé de trouver un objet enfoui) | 1–3 |
| Terminer une marée avec un château debout | 5 |
| Prendre une photo (max 3 récompensées / session) | 1 |
| Défis | 3–15 |
| Trouvailles rares (verre de mer, ammonite, pièce ancienne) | 10–25 + objet de collection |

Dépenses : **uniquement** des décorations et des variantes cosmétiques à la Cabane. Jamais un outil. Jamais une plage. Jamais un slot de sauvegarde. Le joueur ne peut pas se mettre dans une situation où il manque de quelque chose.

---

## 3. LES OUTILS — SPÉCIFICATION DÉTAILLÉE

### 3.0 Grammaire commune à tous les outils

Avant les fiches, les règles qui s'appliquent partout. À implémenter **une seule fois**, dans une classe `Tool` de base.

#### 3.0.1 Contrôles universels

| Input | Effet | Exceptions |
|---|---|---|
| **LMB maintenu** | Action primaire, continue, appliquée à ~60 Hz sur le point de contact | — |
| **RMB maintenu** | Action secondaire = **inverse ou complément** de la primaire | Outils de pose (déco) : RMB = supprimer |
| **Molette** | Rayon de la brosse. Pas multiplicatif ×1,15 par cran. Bornes 5 cm → 150 cm. | Coffrage : diamètre du coffrage |
| **Alt + Molette** | Force / intensité (0–100 %), ou paramètre secondaire propre à l'outil | — |
| **Ctrl + Molette** | Zoom caméra (voir §4) | — |
| **Shift maintenu** | **Modificateur d'outil** — sens propre à chaque outil, mais toujours le même esprit : *« la version douce, précise ou contrainte »* | — |
| **Ctrl maintenu pendant un drag** | **Verrouille l'altitude** du premier point de contact. Le geste devient planaire. C'est LE raccourci qui rend la sculpture à la souris supportable. | — |
| **Espace maintenu** | Mode caméra temporaire (LMB = orbite) | — |
| **Tab** | Fige / libère le **plan de travail** à la hauteur survolée | — |
| **X / Y** | Bascule la symétrie miroir sur l'axe correspondant | — |
| **Ctrl+Z / Ctrl+Y** | Undo / Redo global | — |
| **1–9, 0** | Sélection directe d'outil (slot de la barre) | — |
| **Maintien de `E`** | Ouvre le **menu radial** d'outils sous le curseur | — |

#### 3.0.2 Le modèle de brosse

Toute action est une **brosse volumétrique** appliquée dans un rayon `R` autour d'un point de contact `P`, avec atténuation :

```
falloff(d) = smoothstep(1, hardness, d / R)      // hardness dans [0,1], 0.5 par défaut
delta      = strength * falloff(d) * dt * pressure
```

`pressure` vient de : la vitesse du curseur (geste lent = 1,0 ; geste très rapide = 0,4 — ça empêche les « labours » accidentels) et de la pression du stylet si disponible (`PointerEvent.pressure`).

**Trois modes de placement du point de contact `P`** (cf. §4.3) :
1. **Surface** (défaut) — raycast sur l'isosurface, brosse orientée par la normale.
2. **Plan verrouillé** (`Ctrl` ou `Tab`) — intersection du rayon avec un plan horizontal figé.
3. **Profondeur fixe** — point de surface décalé de `-d` le long de la normale, `d` réglé par `Alt+Molette`.

#### 3.0.3 Conservation de la matière

Règle non négociable, source de la crédibilité : **le sable retiré doit réapparaître**. Chaque outil soustractif accumule un volume `V` et le dépose selon sa politique :

| Politique | Outils | Comportement |
|---|---|---|
| `PILE_ADJACENT` | Pelle | Tas au point de rejet (à `R × 1,8` du trou, dans la direction du geste, projeté au sol) |
| `PILE_LOCAL` | Truelle, mirette, râteau | Fine couche de débris au pied de la zone travaillée, `φ` faible → friables, à souffler |
| `SUSPEND` | Souffleur, paille | Particules aériennes qui retombent plus loin selon le vent |
| `DISSOLVE` | Eau, marée | Passe dans `sediment[]`, redéposé par le flux |
| `NONE` | Gomme, décorations | Le seul outil autorisé à faire disparaître de la matière — et il est signalé comme « magique » (scintillement) |

#### 3.0.4 Feedback partagé par tous les outils

| Canal | Contenu |
|---|---|
| **Curseur 3D** | Décal projeté sur la surface qui suit la courbure. Anneau extérieur = rayon. Anneau intérieur pointillé = hardness. Petite flèche = normale. Le décal prend la couleur de l'outil. |
| **Pastille d'humidité** | Toujours affichée à ~28 px en bas-droite du curseur : une goutte + un mot (SEC / HUMIDE / MOUILLÉ / SATURÉ) + une barre de 40 px. |
| **Prévisualisation** | Chaque outil dessine, avant application, la forme qu'il va produire (fantôme blanc à 25 % d'opacité). |
| **Jauge de stabilité** | Arc autour du curseur, visible seulement quand la structure sous le curseur dépasse 60 % de sa charge critique. Vert → ambre → rouge pâle. |
| **Son** | Boucle continue tant que LMB est maintenu, pitch et volume modulés par la vitesse du geste et par `w`. |
| **Haptique** | `navigator.vibrate` sur mobile ; `GamepadHapticActuator` sur manette. Rumble léger (0,05–0,15), jamais plus. |

---

### 3.1 TABLEAU RÉCAPITULATIF DES OUTILS

| # | Outil | Icône | Slot | Débloqué | Rôle en une phrase |
|---|---|---|---|---|---|
| 1 | **Pelle** | Pelle d'enfant à manche court, bleu délavé | `1` | Départ | Déplace de gros volumes |
| 2 | **Main** | Empreinte de paume | `2` | Départ | Tasse, lisse, augmente la cohésion |
| 3 | **Arrosoir** | Petit arrosoir vert | `3` | Départ | Ajoute de l'humidité en douceur |
| 4 | **Seau** | Seau retourné avec un château dessus | `4` | Départ | Démoule un tronc de cône compacté |
| 5 | **Seau d'eau** | Seau penché avec un filet d'eau | `5` | Usage | Verse un vrai volume d'eau |
| 6 | **Truelle** | Truelle triangulaire | `6` | Usage | Coupe des plans nets et des biseaux |
| 7 | **Mirette** | Boucle de métal sur manche | `7` | Usage | Creuse arcs, fenêtres, portes |
| 8 | **Râteau / peigne** | Petit râteau à 5 dents | `8` | Usage | Texture : stries, briques, tuiles |
| 9 | **Paille / souffleur** | Paille courbée + volutes | `9` | Usage | Retire le sable libre, révèle les détails |
| 10 | **Pinceau** | Pinceau plat doux | `0` | Usage | Adoucit, finition, dépoussière |
| 11 | **Coffrage** | Cylindre ouvert en pointillés | radial | Usage | Forme réutilisable, pound-up couche par couche |
| 12 | **Tampons** | Créneaux en emporte-pièce | radial | Usage | Motifs répétés en un clic |
| 13 | **Drip castle** | Main dégoulinante | radial | Usage | Coulées organiques de sable-soupe |
| 14 | **Canal** | Vague dans une rigole | radial | Usage | Creuse une rigole connectée à la mer |
| 15 | **Décorations** | Coquillage | radial | Départ (3 items) | Pose des props |
| 16 | **Gomme** | Gomme rose | radial | Départ | Efface localement, magiquement |
| 17 | **Symétrie** | Papillon | toggle `X`/`Y` | Usage | Miroir / radial |
| 18 | **Fixatif** | Vaporisateur | radial | Usage | Ralentit l'érosion localement |

---

### 3.2 FICHES DÉTAILLÉES

---

#### OUTIL 1 — PELLE

**Icône :** pelle d'enfant à manche court, plastique bleu délavé, un peu de sable collé dessus. Trait épais, aquarelle.

**Physique.**
- **LMB** : retire `density` dans une sphère de rayon `R` autour de `P`, atténuée. Volume retiré `V = Σ Δdensity`.
- `V` est **conservé** et déposé selon `PILE_ADJACENT` : un tas se forme au point de rejet, avec `w` et `material` hérités de la moyenne du sable retiré, mais `φ` réduit de 45 % (le sable pelleté est meuble).
- Le tas déposé subit immédiatement l'**avalanche** (relaxation d'angle de repos) → forme conique naturelle à `angle_repos(w, φ)`.
- Creuser révèle des couches plus humides (gradient vertical, §0.4). Le fond du trou est visiblement plus foncé que les bords. **Cette révélation est le plaisir central de l'outil.**
- Si le fond passe sous `waterTable`, l'eau **sourd** : `h[x,z]` monte jusqu'au niveau de la nappe, avec suintement animé sur les parois.
- **RMB** : reboucher — prend du sable du tas le plus proche (ou du buffer) et le rajoute au point visé. Symétrie parfaite du geste, essentielle au sentiment de réversibilité.
- **Shift + LMB** : *pelle de précision* — rayon ×0,4, force ×0,5, pas de tas de rejet (le sable va au buffer, déposé au relâchement). Pour des douves nettes.
- **Ctrl + drag** : creuse à **profondeur constante** (plan verrouillé au premier contact). Indispensable pour un fond de douve plat.
- **Molette** : rayon 10 cm → 80 cm (outil de masse, borne haute plus généreuse).

**Feedback visuel.**
- Curseur : décal de pelle + disque de rayon.
- Prévisualisation : hémisphère fantôme + petit tas fantôme au point de rejet, reliés par une flèche courbe animée (elle dit *où va le sable*).
- Pendant : cascade de grains en trajectoire balistique du trou vers le tas. `InstancedMesh` de ~400 grains en pool.
- Poussière : si `w < 0,12`, nuage beige translucide qui dérive avec le vent, 1,4 s.
- Le trou reçoit un **boost d'AO** immédiat (fake AO dans le shader basé sur la profondeur locale) : il a l'air profond tout de suite.
- Suintement : shader de paroi humide qui descend, gouttes qui perlent.

**Feedback sonore.**
- `shovel_dig_dry_01..06` : crissement granuleux, attaque nette, 250 ms.
- `shovel_dig_wet_01..06` : « scrunch » mat, plus grave, plus court.
- Crossfade entre banques selon `w`. Pitch ±8 % aléatoire. Volume mappé sur la vitesse du geste.
- `sand_pour_pile` : chute sur le tas, décalée de 0,3 s après le creusement (le sable met un temps à retomber — ce décalage est capital pour la crédibilité).
- `water_seep` : un « gloup » unique quand la nappe est atteinte, + boucle discrète d'infiltration.

**Déblocage :** dès le départ. Outil en main à l'ouverture du jeu.

---

#### OUTIL 2 — MAIN (TAPOTER / LISSER)

**Icône :** empreinte de paume ouverte, doigts écartés, quelques grains dessinés.

**Physique.** Deux gestes distincts sur le même outil — volontaire, c'est ce que font les vraies mains.

- **LMB (maintenir, tapoter) — COMPACTER**
  - `φ += TAMP_RATE * falloff * dt`, borné à 1,0. `TAMP_RATE` ≈ 0,9/s au centre.
  - La surface **s'affaisse** proportionnellement : `density` local augmente, la hauteur baisse de 8–15 % du volume tassé. Le sable devient plus dense, pas moins.
  - `cohesion_effective` monte (§0.2) → l'angle de repos local peut passer de 45° à 85°.
  - Efficacité modulée par l'humidité : ×1,0 si `w ∈ [0,15 ; 0,40]` ; ×0,25 si sec (rien à tasser) ; ×0,4 si saturé (**liquéfaction** : trop taper du sable saturé le rend liquide, `w` effectif monte, la structure s'affaisse. Vraie propriété physique, excellent moment d'apprentissage).
  - Le geste est **rythmique** : chaque « tap » est discrétisé à ~5 Hz, avec un petit rebond de surface. Ce n'est pas un flux continu, c'est une pulsation. C'est ce qui le rend satisfaisant.
- **RMB (glisser) — LISSER**
  - Filtre de lissage (moyenne pondérée 3×3×3 sur `density`) le long du geste.
  - Ne change pas le volume total (redistribution conservative).
  - Augmente légèrement `φ` (×0,3 du taux de tapotement).
  - Surface visuellement plus **lisse et mate** (`roughness` baisse ; une couche de « peau » lissée est marquée dans un canal séparé).
- **Shift + LMB** : *caresse* — rayon ×2, force ×0,3. Pour lisser de grandes pentes sans les déformer.
- **Ctrl + drag** : lisse **vers un plan** (le plan verrouillé). Crée des surfaces planes propres. Version douce de la truelle.
- **Molette** : rayon 8 cm → 60 cm.

**Feedback visuel.**
- Curseur : silhouette de paume translucide, orientée par la normale, qui **s'enfonce et rebondit** à chaque tap (90 ms, `easeOutBack`).
- Empreintes : chaque tap écrit une empreinte de paume dans une texture de détail (normal + AO), qui s'estompe en 6 s. Sur sable humide, elle reste plus longtemps.
- Grains libres éjectés sur les côtés à chaque impact (burst radial de 15–25 grains).
- Le sable tassé prend un aspect **plus sombre et satiné** progressivement (interpolation vers un matériau « damé »). Le joueur voit son travail.
- Halo de progression : anneau qui se remplit autour du curseur ; quand `φ` atteint 0,9 sur toute la zone → flash blanc doux + son de validation. **Micro-récompense.**

**Feedback sonore.**
- `hand_pat_wet_01..08` : le « flop » — impact mat, corps grave, queue courte. **Le son signature du jeu.**
- `hand_pat_dry_01..06` : plus sec, plus aigu, plus de bruit blanc.
- `hand_smooth_loop` : frottement doux, passe-bas, bouclé avec le glissement.
- `pat_complete` : carillon très discret (une note de marimba, −18 dB) à la compaction max.
- Les taps suivent le rythme du geste ; on quantifie légèrement (±30 ms) vers une grille à 120 BPM pour que ça devienne musical. **Détail de luxe, énorme sur le feel.**

**Déblocage :** départ.

---

#### OUTIL 3 — ARROSOIR / PULVÉRISATEUR

**Icône :** petit arrosoir vert avec une pomme, gouttes stylisées.

**Physique.**
- **LMB** : `w += WET_RATE * falloff * dt`, `WET_RATE` ≈ 0,35/s.
- L'eau **pénètre** : pas seulement en surface. Diffusion verticale immédiate sur ~15 cm, puis diffusion lente aux ticks suivants. Arroser le sommet d'une tour humidifie tout le fût en ~8 s.
- Si `w > 0,85` localement, le surplus devient de l'**eau libre** (`h[x,z] +=`) → flaque. Le jeu ne bloque jamais : il laisse faire l'erreur et la rend visible.
- **RMB** : mode **pulvérisateur** — rayon ×2,5, débit ×0,25, fine brume. Pour ré-humidifier une grande surface sans la déformer ni la saturer. C'est l'outil d'entretien.
- **Shift + LMB** : *goutte à goutte* — rayon ×0,3, débit ×0,4. Pour humidifier juste avant un détail à la mirette.
- **Molette** : rayon 10 cm → 70 cm.
- **Réservoir** : contenance visuelle (~8 s d'arrosage continu), recharge **automatique** en trempant dans l'eau, ou après 3 s d'inactivité. Le réservoir est un **détail de feel, pas une contrainte** : il ne bloque jamais longtemps. Petite jauge sur l'icône de l'outil, pas dans le HUD.

**Feedback visuel.**
- Curseur : arrosoir 3D tenu, incliné selon le geste.
- Jet : ~40 filets en `Line` instanciées, légèrement désordonnés, qui s'écrasent en impacts (decals de 2–4 cm qui grandissent puis fondent).
- **Assombrissement progressif du sable** — le retour le plus important. Le shader interpole albedo, roughness et une petite composante spéculaire selon `w`. Sec → humide instantanément lisible.
- Front d'humidité visible : quand l'eau diffuse dans une paroi verticale, on voit la ligne sombre descendre. Magnifique et pédagogique.
- Sur-saturation : aspect **brillant, presque miroir**, et léger tremblement (noise dans le vertex shader). Signal clair de « trop ».
- Gouttes qui perlent et roulent sur les surfaces très humides.

**Feedback sonore.**
- `watering_can_loop` : la fréquence de coupure du passe-bas monte avec le débit.
- Le pitch de la boucle **monte de +3 demi-tons** quand la zone atteint la fenêtre optimale `w ∈ [0,18 ; 0,30]`, puis redescend en saturation. **On peut arroser à l'oreille** — feature de feel ET d'accessibilité.
- `water_impact_sand_01..04` : petits ploc.
- `puddle_form` : naissance d'une flaque.

**Déblocage :** départ.

---

#### OUTIL 4 — SEAU

**Icône :** seau retourné avec un petit château démoulé dessus.

**Physique.** Un mini-jeu en trois temps. C'est le premier « wow » du jeu.

**Temps 1 — Remplir (LMB sur du sable).**
- Jauge circulaire autour du curseur (2,2 s pour un seau plein).
- Le seau enregistre la **moyenne pondérée** de `w` et `material` du sable aspiré. Volume prélevé au terrain (conservation).
- Remplissage possible en plusieurs fois, à des endroits différents. La composition se mélange.
- **Shift** pendant le remplissage : ajouter de l'eau au seau (si on est près d'eau) → augmente `w` du contenu. C'est la technique réelle du *sloshing*.
- Une **coupe du seau** s'affiche en bas d'écran pendant le remplissage : niveau visible, couleur du contenu = humidité. Diégétique et informatif.

**Temps 2 — Tasser (LMB maintenu, seau plein).**
- Chaque clic tape le seau. `φ_contenu += 0,15` par tap, max 1,0. ~5 taps pour un démoulage parfait.
- Le contenu s'affaisse visiblement dans la coupe → il faut parfois recompléter. Exactement le geste réel.

**Temps 3 — Démouler (RMB, ou LMB sur le sol seau plein).**
- Le seau est posé, retourné, **soulevé lentement** (0,9 s) — moment de suspense qu'on peut regarder.
- Tronc de cône déposé : Ø inférieur 22 cm, Ø supérieur 18 cm, hauteur 20 cm (seau de base).
- **Qualité du démoulage** `Q = normalize(cohesion(w_moyen)) * (0,3 + 0,7·φ)` :

| Score `Q` | Condition | Résultat visuel |
|---|---|---|
| **Parfait** (> 0,85) | `w ∈ [0,15 ; 0,38]` **et** `φ > 0,8` | Cylindre net, arêtes vives, stries du seau visibles. Flash doux + son de validation + 1 particule scintillante. |
| **Bon** (0,60–0,85) | fenêtre un peu large | Cylindre correct, arêtes légèrement arrondies, petit éboulis au pied. |
| **Moyen** (0,35–0,60) | trop sec ou pas assez tassé | La moitié supérieure s'affaisse en cône. Reste utilisable. |
| **Raté** (< 0,35) | trop sec, ou saturé | Une galette informe. **Aucune sanction** : le sable est là, on retasse. Son un peu comique (« splat » doux), jamais un buzzer. |

- **Prévisualisation avant démoulage** : fantôme du cylindre + indicateur de qualité (3 gouttes qui s'allument, comme des étoiles mais en gouttes). Le joueur sait avant de lâcher.
- **Shift + démoulage** : démoulage **empilé** — le seau se pose centré sur le cylindre précédent, pour des tours étagées.
- **Molette** : **taille du seau** (3 tailles débloquables : 15 / 22 / 32 cm). Plus tard : formes différentes (carré, étoile, tour crénelée).

**Feedback visuel.** Coupe du seau en overlay ; jauge circulaire ; soulèvement lent avec le sable qui « décolle » de la paroi ; poussière fine au décollement ; stries verticales imprimées dans la normal map ; éboulis au pied selon `Q`.

**Feedback sonore.** `bucket_fill_scoop` ; `bucket_tamp_01..05` (plus grave et plus mat à chaque tap — **le pitch descend, la compaction devient audible**) ; `bucket_suction_release` (le « schlop » du démoulage, LE son gratifiant) ; `bucket_success_chime` (deux notes très douces) ; `bucket_collapse_soft` (raté).

**Déblocage :** départ. C'est l'outil qui donne le premier château en 40 secondes.

---

#### OUTIL 5 — SEAU D'EAU

**Icône :** seau penché, filet d'eau continu.

**Physique.**
- **LMB maintenu** : verse un **volume** d'eau libre (pas de l'humidité diffuse) : `h[x,z] += POUR_RATE * dt` dans un rayon serré (~12 cm).
- L'eau versée entre dans la simulation shallow-water : elle **coule**, contourne les obstacles, remplit les creux, forme de vraies flaques, déborde.
- Au contact du sable, une partie s'infiltre : `w += INFILT * (1-w) * dt`, `h -=` d'autant. Le taux dépend de `φ` (sable tassé = imperméable — vraie propriété, et une raison de plus de tasser).
- **Saturation → liquéfaction** : si `w > 0,80` sur une zone portante, `cohesion → 0`, la structure coule. Spectaculaire, réversible par Undo, et pédagogique.
- **RMB** : *éponger* — retire l'eau libre localement (le seau la récupère). Répare une inondation accidentelle. Indispensable à la non-punition.
- **Shift + LMB** : verse **très lentement** (×0,2) pour remplir des douves sans les éroder.
- **Molette** : diamètre du filet (5 cm → 30 cm).

**Feedback visuel.** Filet d'eau en mesh tubulaire animé ; impact avec couronne d'éclaboussures ; propagation de flaque avec réflexion du ciel (cubemap + normal map animée) ; **creusement par érosion sous le filet** (le jet creuse — vrai et satisfaisant) ; sable en suspension (l'eau devient trouble puis se clarifie en redéposant le sédiment) ; **liquéfaction** rendue par un shader qui augmente la brillance et fait « fondre » l'isosurface.

**Feedback sonore.** `water_pour_loop` (volume ∝ débit) ; `water_impact_sand` / `water_impact_water` (deux banques selon la cible) ; `water_flow_loop` (spatialisé sur les zones de courant, volume ∝ vitesse) ; `mud_slump` (liquéfaction — visqueux, grave, un peu écœurant, parfait).

**Déblocage :** après 5 vidages d'arrosoir consécutifs.

---

#### OUTIL 6 — TRUELLE / COUTEAU DE SCULPTEUR

**Icône :** truelle triangulaire métallique, manche bois.

**Physique.** L'outil qui transforme des tas en architecture.

- **LMB (glisser)** : **coupe un plan**, défini par la direction du geste (dans le plan écran) et la normale de la surface au premier contact. Tout ce qui dépasse du plan côté caméra est retiré (`density = 0`).
  - Le plan est **prolongé** au-delà du geste sur `R × 1,5` — un petit geste fait une grande coupe nette. C'est ce qui rend l'outil rapide.
  - Débris déposés au pied (`PILE_LOCAL`) : sable friable qu'il faudra souffler. Ce détail donne l'impression de *tailler*.
- **RMB (glisser)** : **applique / lisse à plat** — au lieu de couper, tire la matière vers le plan (ajout dans les creux). Geste de plâtrier. Finit un mur sans le percer.
- **Ctrl + drag** : **coupe verticale parfaite**. Plan forcé vertical. Un fil à plomb fantôme s'affiche.
- **Shift + drag** : **biseau** à 45° par défaut (angle réglable par `Alt+Molette`, 15°→75°). Chanfreins, toits de tour, glacis. Un rapporteur fantôme s'affiche.
- **Double-clic sur une face** : aligne le plan de travail sur cette face.
- **Molette** : longueur de la lame (10 cm → 45 cm).

**Feedback visuel.** Curseur = truelle 3D orientée dans le sens du geste, légèrement inclinée. Ligne fantôme du plan de coupe **avant** application, en pointillés blancs, avec l'angle en degrés. La surface coupée reçoit une texture **plus lisse et plus claire** que le sable brut. Copeaux qui roulent le long de la lame et tombent en petits paquets. Arête vive soulignée par un léger rim-light — **les arêtes nettes brillent**, c'est ce qui donne l'impression de précision.

**Feedback sonore.** `trowel_cut_01..06` (crissement fin, aigu, avec un chuintement — le son le plus « propre » du jeu) ; `trowel_smooth_loop` ; `debris_fall_light`.

**Déblocage :** après avoir lissé la même arête 4 fois à la main.

---

#### OUTIL 7 — MIRETTE / GOUGE

**Icône :** boucle de métal ovale sur un manche fin.

**Physique.**
- **LMB (glisser)** : **creuse une gorge** de section semi-circulaire le long du geste projeté sur la surface. Profondeur = 40 % du rayon, réglable par `Alt+Molette`. Outil de **trait** : on échantillonne le chemin tous les 2 cm et on applique une capsule.
- **RMB** : **ajoute** un bourrelet de même section (matière rapportée). Moulures, cordons, nervures.
- **Shift + clic-glisser** : mode **ARCHE** — le geste définit deux points au sol, le jeu creuse une ouverture cintrée entre les deux, traversant tout le mur. Prévisualisation fantôme ajustable avant relâchement (la molette pendant le drag change le profil : plein cintre / brisé / surbaissé / trilobé). C'est l'outil « porte de château » et il doit être magique.
- **Ctrl + clic** : mode **FENÊTRE** — pose un trou de forme choisie (rectangle, ogive, meurtrière, rosace, quadrilobe) perpendiculairement à la face survolée. Molette = taille, `Alt+Molette` = profondeur (borgne ou traversante).
- **Molette** : diamètre de la gouge (2 cm → 20 cm) ou taille de la fenêtre selon le mode.

**Feedback visuel.** Curseur = boucle métallique tangente au geste. Traînée fantôme du sillon à venir. Le sable sort en **rouleau continu** (un ruban de sable qui s'enroule et se casse) — très satisfaisant et très reconnaissable. AO immédiat dans la gorge. Pour arches/fenêtres : fantôme filaire blanc + cotes en cm.

**Feedback sonore.** `gouge_scrape_01..06` (raclement fin) ; `gouge_ribbon_fall` ; `arch_carve_whoosh` (plus ample, avec un petit chime final — c'est un moment de fierté).

**Déblocage :** après un mur vertical de plus de 40 cm.

---

#### OUTIL 8 — RÂTEAU / PEIGNE

**Icône :** petit râteau à 5 dents.

**Physique.**
- **LMB (glisser)** : creuse `N` sillons parallèles perpendiculaires au geste, profondeur 1–4 cm, espacement réglable. N'affecte que les 5 premiers cm → c'est de la **texture**, pas de la géométrie.
- **Implémentation** : ne modifie **pas** `density`, mais un canal séparé `detail[x,z]` (texture de hauteur 2048² projetée sur la surface) → beaucoup moins cher, et permet de texturer sans fragiliser la structure.
- **Motifs** (changés par `Shift+Molette` ou dans le sous-menu radial) :

| Motif | Description | Usage |
|---|---|---|
| **Stries** | Sillons parallèles simples | Bardage, herbe, eau |
| **Briques** | Alternance décalée, joints creusés | Murs de château |
| **Pierre de taille** | Blocs irréguliers, joints larges | Donjon, remparts |
| **Tuiles / écailles** | Arcs de cercle en écailles | Toits de tourelles |
| **Bois** | Fibres longues avec nœuds | Portes, pontons |
| **Vagues** | Ondulations douces | Sol, dunes, décor |
| **Croisillons** | Losanges | Herse, treillis |

- **RMB** : **efface** la texture (retour à la surface lisse).
- **Shift** : force ×0,3 (texture subtile).
- **Ctrl + drag** : contraint le geste (snapping d'axe tous les 15°) — indispensable pour des rangées de briques droites.
- **Molette** : largeur du peigne (5 cm → 50 cm). **Alt+Molette** : échelle du motif.

**Feedback visuel.** Curseur = le peigne avec le bon nombre de dents pour le motif. Fantôme du motif projeté **avant** application. Sillons écrits en temps réel dans la normal map, avec AO. Grains éjectés entre les dents. Les motifs **s'alignent automatiquement** sur les rangs voisins (snap magnétique à 3 cm) : les rangées de briques se continuent naturellement.

**Feedback sonore.** `rake_drag_01..06` — grattement rythmé, le pitch dépend de la vitesse (**la vitesse de crantage est audible**). Variante par motif (briques = plus percussif, tuiles = plus doux).

**Déblocage :** après > 60 s passées en mode photo devant un mur nu.

---

#### OUTIL 9 — PAILLE / SOUFFLEUR

**Icône :** paille courbée avec trois volutes d'air.

**Physique.**
- **LMB maintenu** : souffle un cône d'air. Retire le sable dont `φ < 0,35` — le sable **libre** uniquement (débris de sculpture, poussière, grains meubles). **Le sable compacté n'est pas affecté.** C'est la règle qui rend l'outil sûr : on ne peut pas détruire son travail avec.
- Le sable retiré est mis en suspension (`SUSPEND`) puis retombe 30–80 cm plus loin selon la force.
- Assèche la surface soufflée : `w -= 0,04 * dt`. Le souffle sèche — c'est vrai, et c'est un effet secondaire à connaître.
- **RMB** : **aspirer** (poire de sculpteur) — attire les grains libres vers le curseur en petit tas. Nettoyer sans disperser.
- **Shift** : souffle **fin et précis** (cône ×0,35, portée ×1,5) — dégager une fenêtre sans souffler tout le mur.
- **Molette** : ouverture du cône (5° → 45°).

**Feedback visuel.** Cône fantôme translucide. Nuage de grains en flux laminaire avec turbulence. **Révélation progressive des détails** : les arêtes et les sillons apparaissent nettement à mesure que les débris partent — un des meilleurs moments visuels du jeu, on « développe » sa sculpture. Léger heat-haze. La surface soufflée devient plus claire (séchée).

**Feedback sonore.** `blow_loop` (souffle, passe-bande, avec un léger souffle humain pour la paille — très intime, très cozy) ; `grain_scatter`. Volume et pitch suivent l'intensité.

**Déblocage :** après ~15 coups de mirette.

---

#### OUTIL 10 — PINCEAU

**Icône :** pinceau plat à poils doux, virole métallique.

**Physique.** L'outil de **finition**, à mi-chemin entre le souffleur et la main.

- **LMB (glisser)** : adoucit très légèrement la géométrie (lissage ×0,15 de la main) **et** retire les grains libres sur son passage (comme le souffleur, mais localisé au trait).
- **RMB** : **dépose** de la poussière de sable sec — matifie une surface trop brillante, ou fait des dégradés avec du sable coloré (v3).
- **Shift** : mode **polissage** — augmente `φ` en surface seulement ; surface très lisse et légèrement brillante, rendu « sable damé » de compétition.
- **Molette** : largeur (2 cm → 15 cm). Volontairement un petit outil.

**Feedback visuel.** Poils qui se déforment au contact (skinning simple, 4 os). Fines traces de poils dans la normal map. Micro-grains qui volent. La surface polie prend un éclat satiné.

**Feedback sonore.** `brush_sweep_01..08` — très doux, presque un chuchotement. **Le son le plus calme du jeu.** Volume bas, beaucoup de réverbération.

**Déblocage :** après 10 utilisations du souffleur.

---

#### OUTIL 11 — COFFRAGE / FORMES

**Icône :** cylindre ouvert dessiné en pointillés, flèche vers le bas.

**Physique.** L'outil qui débloque les grosses structures. Il reproduit la technique réelle du **pound-up** : coffrage sans fond, on remplit, on tasse, on retire, on recommence plus haut.

**Séquence en 4 phases, avec une petite barre d'UI contextuelle au-dessus du coffrage :**

**Phase 1 — POSER.**
- Choix de la forme dans le sous-menu radial : cylindre, cube, hexagone, cône tronqué, arc de mur (portion d'anneau), rampe.
- Prévisualisation fantôme au sol, orientable (`Q`/`E` ou `Alt+drag`).
- **Molette** : diamètre / largeur (25 cm → 200 cm). **Alt+Molette** : hauteur d'étage (10 cm → 60 cm).
- **Snapping** : magnétisme sur les coffrages voisins (bord à bord, concentrique) et sur la grille de 5 cm si `Shift` est maintenu.

**Phase 2 — REMPLIR.**
- LMB au-dessus du coffrage : le sable **tombe dedans** et remplit par le bas. Jauge de niveau sur la paroi.
- Le sable versé garde l'humidité de sa source. Pour du bon sable, il faut le prendre au bon endroit — leçon implicite.
- **Raccourci confort** : `Shift + LMB` = remplissage auto depuis le sable disponible le plus proche, en 1,5 s.

**Phase 3 — TASSER (le pound-up).**
- LMB rythmé sur la surface du remplissage : `φ` monte, **le niveau baisse de ~12 %** → il faut recompléter. Exactement le geste réel.
- Anneau de compaction autour du coffrage. Vert plein = prêt.
- **Remplissage par couches** : 15 cm, tasser, 15 cm, tasser… Le jeu enregistre les couches et les **rend visibles comme des strates** (variation subtile de teinte). Ces strates sont magnifiques quand on sculpte dedans ensuite — un détail gratuit qui donne un cachet énorme.

**Phase 4 — RETIRER.**
- RMB (ou bouton « Retirer ») : le coffrage se soulève lentement (1,2 s).
- Résultat selon `φ` et `w` moyens, même barème `Q` que le seau.
- Après retrait, on peut **reposer le coffrage sur la structure** pour ajouter un étage. C'est ainsi qu'on fait une tour de 2 m.

**Autres contrôles.** `Ctrl + clic` sur un coffrage existant = le duplique avec ses réglages. `Suppr` = retire sans démouler. Maximum 6 coffrages simultanés (lisibilité, pas perf).

**Feedback visuel.** Coffrage en bois ou plastique translucide, matière visible dedans (clip plane). Niveau de remplissage directement lisible. Couches de compaction en lignes horizontales. Retrait avec animation de décollement et un peu de sable collé aux parois. Après retrait : stries du coffrage imprimées.

**Feedback sonore.** `formwork_place` (toc de bois) ; `formwork_fill` (sable qui tombe dans un contenant — résonance !) ; `formwork_tamp_01..06` (plus résonnant que le tapotement libre : le coffrage sonne comme un tambour et **le pitch monte à mesure que ça se compacte**) ; `formwork_lift`.

**Déblocage :** après 2 tours au seau posées côte à côte.

---

#### OUTIL 12 — TAMPONS / EMPORTE-PIÈCES

**Icône :** une rangée de créneaux découpée comme un emporte-pièce à biscuits.

**Physique.** L'outil d'**accélération**. Il fait en un clic ce qu'on ferait en trente secondes à la mirette. Il ne remplace pas la sculpture manuelle : il la démarre.

- **LMB (clic)** : applique un motif volumétrique (SDF pré-calculé) à la position et l'orientation du curseur. Le motif est soustractif, additif, ou mixte selon le tampon.
- **LMB (glisser)** : applique le motif **en série le long du geste**, avec un espacement régulier (créneaux, arcades, marches). L'espacement est réglable et **prévisualisé** : on voit les N copies fantômes avant de lâcher.
- **RMB** : retire le dernier tampon appliqué (undo local instantané).
- **Shift** : contraint l'espacement à un pas rond (5 / 10 / 20 cm) et l'orientation à 15°.
- **Ctrl** : applique le motif **en creux** au lieu d'en relief (inverse).
- **Molette** : échelle du tampon. **Alt+Molette** : rotation.

**Bibliothèque de tampons (v1 → v3) :**

| Tampon | Type | Description |
|---|---|---|
| **Créneaux** | soustractif, série | Merlons et créneaux réguliers en haut d'un mur. Le tampon détecte automatiquement le sommet du mur et s'y aligne. |
| **Mâchicoulis** | mixte, série | Corbeaux + trous, sous un chemin de ronde |
| **Marches** | mixte, série | Volée d'escalier, hauteur/giron réglables |
| **Arcade** | soustractif, série | Suite d'arcs, pour un cloître |
| **Meurtrière** | soustractif, unique | Fente verticale avec ébrasement |
| **Tuiles de toit** | additif surfacique | Écailles sur un cône |
| **Chemin de ronde** | mixte, série | Coursive + parapet |
| **Pont-levis** | additif, unique | Encadrement + rainures |
| **Rosace** | soustractif, unique | Fenêtre circulaire à remplages |
| **Colonne** | additif, unique | Fût + base + chapiteau |
| **Coquillage géant** | additif, unique | Grande conque décorative |
| **Escalier en spirale** | mixte, unique | À l'intérieur d'une tour |

**Feedback visuel.** Fantôme blanc du motif, **aligné automatiquement** sur la face survolée (le tampon se colle et s'oriente : sur le sommet d'un mur, il devient horizontal ; sur une face verticale, il devient perpendiculaire). Pour les séries : les N copies fantômes + un petit compteur (`×7`). À l'application : un léger « pouf » de poussière sur toute la longueur, en cascade de gauche à droite (pas simultané — la cascade est ce qui rend le tampon satisfaisant), 40 ms de décalage entre chaque copie.

**Feedback sonore.** `stamp_press_01..04` (un « pomf » mat) ; en série, les sons se déclenchent en cascade avec le décalage visuel → **cela produit un petit rythme**, très gratifiant. `stamp_dust`.

**Déblocage :** après avoir sculpté 6 créneaux à la main. Le jeu récompense l'effort manuel en offrant l'automatisation — jamais l'inverse.

---

#### OUTIL 13 — DRIP CASTLE (SABLE-SOUPE)

**Icône :** une main dont les doigts dégoulinent, avec trois gouttes.

**Physique.** L'outil le plus « organique » et le plus contemplatif. Il exploite le régime saturé.

- **LMB maintenu** : laisse tomber, depuis le point du curseur, un filet de **slurry** (sable saturé, `w ≈ 0,85`) qui tombe verticalement et s'écrase.
- L'implémentation n'est pas une brosse mais un **système de gouttes** : ~8 gouttes/s, chacune est une petite masse qui tombe, s'écrase à l'impact (splat radial de 3–6 cm), se dépose avec `w = 0,85`, puis **sèche vite** (`w` chute à 0,3 en 4 s → la coulée durcit).
- L'empilement des gouttes crée les formes caractéristiques : stalagmites, tours organiques, gouttes empilées de type Gaudí.
- La forme dépend de la **hauteur de chute** : goutte lâchée de haut = splat large et plat ; de près = pilier fin et haut. **Le joueur contrôle donc la forme par la distance verticale du curseur à la surface** — c'est un usage brillant du plan de travail (`Tab`).
- **RMB** : **lissage humide** — étale la coulée en une nappe, pour des rebords fondus.
- **Shift** : filet plus fin, gouttes plus rapides (structures fines et élancées).
- **Alt + Molette** : hauteur de lâcher (0 → 60 cm), affichée par une petite règle verticale fantôme.
- **Molette** : débit.

**Contrainte :** l'outil consomme de l'eau ET du sable. Il puise dans une petite réserve visible (le bol de slurry), rechargeable en mélangeant sable + eau (`RMB` sur une flaque avec du sable autour). Ce n'est pas une contrainte économique, c'est un **geste supplémentaire agréable** (mélanger la soupe) qu'on ne veut pas perdre.

**Feedback visuel.** Filet visqueux (mesh tubulaire avec noise), gouttes qui s'allongent avant de se détacher, splat avec ondes concentriques. La coulée fraîche est très **brillante et sombre**, puis se mate visiblement en séchant — on voit la structure durcir. AO forte entre les gouttes empilées.

**Feedback sonore.** `drip_plop_01..08` — le son de gouttes épaisses, avec de la résonance. La **cadence des ploc est un métronome** naturel. `slurry_mix` (mélange visqueux). `drip_flow_loop`.

**Déblocage :** après avoir accidentellement créé du sable saturé (`w > 0,8`) deux fois.

---

#### OUTIL 14 — CANAL / OUTIL EAU

**Icône :** une petite vague dans une rigole.

**Physique.** L'outil qui relie la création à la mer, et qui rend le terrain vivant.

- **LMB (glisser)** : creuse une **rigole** en U le long du geste (largeur et profondeur réglables), et **marque** ces voxels comme `channel`.
- **Connexion à la mer** : si la rigole atteint le bord marin (ou une flaque, ou une nappe affleurante), l'eau **s'y engouffre immédiatement** avec un front visible qui parcourt le canal. C'est un moment spectaculaire.
- L'eau qui circule dans le canal **érode** ses berges progressivement (le canal s'élargit et serpente naturellement au fil du temps). Le joueur peut renforcer les berges en les tassant.
- **Marée** : les canaux se remplissent et se vident au rythme de la marée. Une douve connectée est vivante ; une douve fermée reste une flaque stagnante.
- **RMB** : **combler** le canal (bouchon de sable). Permet de faire des **écluses** et des barrages. Un barrage cède si la pression dépasse sa cohésion → petite rupture spectaculaire, non punitive.
- **Shift + LMB** : creuse un **bassin** (élargissement local) au lieu d'un canal linéaire.
- **Ctrl + clic sur deux points** : trace un canal **rectiligne** entre eux, avec pente automatique (le jeu calcule la pente pour que l'eau coule d'un point à l'autre). Une petite étiquette affiche « pente 2,3 % ».
- **Molette** : largeur (10 cm → 60 cm). **Alt+Molette** : profondeur.

**Feedback visuel.** Prévisualisation du tracé en ligne bleue pointillée, avec un **indicateur de pente coloré** (bleu = l'eau coulera, gris = l'eau stagnera, rouge pâle = contre-pente). Front d'eau animé quand la connexion s'établit. Réflexions, caustiques au fond du canal (une texture de caustiques animée suffit). Sédiment en suspension à l'endroit de l'érosion. De petits remous et tourbillons aux coudes.

**Feedback sonore.** `dig_wet` pendant le creusement ; `water_rush_in` (le moment de la connexion — un son montant, gratifiant) ; `stream_loop` spatialisé, dont le volume et le brillant dépendent de la vitesse locale ; `dam_break` si un barrage cède.

**Déblocage :** après avoir creusé une douve fermée de 2 m de périmètre.

---

#### OUTIL 15 — DÉCORATIONS

**Icône :** un coquillage en éventail.

**Physique.** Les décorations sont les **seuls objets non-voxel** du jeu (des meshes instanciés). Elles ne participent pas à la structure mais elles participent à l'érosion (elles sont emportées par la marée, et flottent).

- **LMB** : pose l'objet sélectionné au point survolé, **aligné sur la normale** de la surface (un drapeau reste vertical, un coquillage se couche sur la pente).
- **LMB maintenu + glisser** : mode **semis** — dispose des copies au fil du geste, avec variation aléatoire de rotation et d'échelle (±20 %). Pour éparpiller 30 coquillages en 2 secondes.
- **RMB** : retire l'objet survolé (contour rouge pâle au survol).
- **Molette** : taille de l'objet (×0,6 → ×1,8). **Alt+Molette** : rotation. **Shift** : verrouille l'orientation verticale (utile pour les drapeaux sur une pente).
- **Clic sur un objet posé** : le sélectionne → contour blanc pointillé + gizmo de translation/rotation + bulle d'info (nom, provenance, « trouvé le 12 juin à la Crique aux Galets »).
- **Enfoncement** : un objet lourd posé sur du sable meuble s'enfonce légèrement et laisse une empreinte. Détail gratuit, énorme sur la crédibilité.

**Feedback visuel.** Fantôme de l'objet en survol, avec une ombre portée douce qui indique exactement où il va se poser. Petite animation de pose (l'objet tombe de 4 cm avec un rebond). Puff de poussière. Sélection : contour blanc pointillé animé (dash-offset qui défile lentement, 8 s par tour — jamais agressif).

**Feedback sonore.** `place_shell`, `place_wood`, `place_flag` (bruit de tissu), `place_stone` — banques par matériau. Discrets.

**Déblocage :** 3 items au départ (coquillage simple, bâton, petit galet). Le reste s'achète ou se trouve.

---

#### OUTIL 16 — GOMME / ANNULATION LOCALE

**Icône :** une gomme rose d'écolier, avec des miettes.

**Physique.** L'outil de sécurité psychologique. C'est ce qui autorise le joueur à oser.

- **LMB** : **revient à l'état précédent localement**. Techniquement : le jeu conserve un historique de snapshots par chunk (voir §9.3) ; la gomme rembobine les voxels sous la brosse vers leur état d'il y a `T` secondes (`T` réglable par `Alt+Molette`, 2 s → 120 s, ou « avant ce château »).
- Ce n'est pas un « delete » : c'est un **rembobinage local**. La différence est capitale — on ne creuse pas un trou, on retrouve ce qui était là.
- **RMB** : **rembobine plus loin** dans le temps (accélère le retour en arrière).
- **Shift** : gomme **douce** (mélange 50/50 entre l'état actuel et l'état passé) — pour atténuer une erreur sans l'effacer.
- **Molette** : rayon.

**Feedback visuel.** La zone gommée est parcourue par une **onde de dissolution douce** (les voxels reviennent progressivement, pas d'un coup), avec de petites particules blanches scintillantes qui remontent (c'est le seul effet volontairement « magique » du jeu — il est assumé, et il est joli). Un petit ruban temporel s'affiche sous le curseur montrant à quel moment on rembobine, avec la vignette de l'état visé.

**Feedback sonore.** `eraser_rewind` — un son inversé (reverse), doux, avec un léger shimmer. Volontairement différent de tous les autres sons du jeu, pour signaler que c'est une action hors-fiction.

**Déblocage :** départ.

---

#### OUTIL 17 — SYMÉTRIE (MODIFICATEUR GLOBAL)

**Icône :** un papillon dont une aile est en pointillés.

Ce n'est pas un outil mais un **modificateur** qui s'applique à tous les autres. Toggle depuis la barre ou par `X` / `Y`.

| Mode | Raccourci | Comportement |
|---|---|---|
| **Miroir X** | `X` | Chaque action est dupliquée symétriquement par rapport au plan X du centre du château |
| **Miroir Y** | `Y` | Idem sur l'axe Y |
| **Quadrilatéral** | `X` + `Y` | Les deux → 4 copies |
| **Radial N** | `Shift+X`, puis molette | 2 à 16 copies en rotation autour du centre. Pour les tours rondes, les rosaces, les remparts circulaires. |
| **Déplacer l'axe** | `Alt + drag` sur la ligne d'axe | L'axe de symétrie est un objet visible dans la scène, qu'on peut déplacer et tourner |

**Feedback visuel.** L'axe (ou les axes) sont matérialisés par une **fine ligne de coquillages plantés dans le sable** — diégétique, joli, non intrusif. En mode radial, un cercle de petits galets. La zone miroir du curseur est affichée par un second décal de brosse, plus pâle.

**Déblocage :** après avoir construit 2 tours quasi identiques.

---

#### OUTIL 18 — FIXATIF

**Icône :** un petit vaporisateur en verre, style parfum ancien.

**Physique.** Le « cheat » assumé et cozy, qui existe aussi dans la vraie compétition de sculpture sur sable.

- **LMB** : vaporise. Marque les voxels touchés avec un flag `fixed` qui :
  - divise le taux d'évaporation par 5 (le sable reste humide) ;
  - divise le taux d'érosion par 4 (la marée met plus longtemps) ;
  - augmente `cohesion` de +25 %.
- Ne rend rien invulnérable : la marée finit toujours par gagner. C'est un ralentisseur, pas un bouclier. **Le pilier 4 n'est jamais contredit.**
- **RMB** : retire le fixatif.
- **Molette** : rayon large (30 cm → 150 cm) — c'est un outil de finition globale.
- **Réserve** : ~3 vaporisations pleines par session, rechargées à chaque marée. Assez pour protéger l'essentiel, pas assez pour tout figer.

**Feedback visuel.** Fine brume qui se dépose. Les surfaces fixées ont un **très léger satiné** supplémentaire, visible seulement de près (on ne veut pas gâcher le look). Dans le mode « analyse » (touche `V`), elles apparaissent en surbrillance bleu pâle.

**Feedback sonore.** `spray_pssht_01..03` — court, aigu, satisfaisant.

**Déblocage :** après 3 effondrements sur la même structure. C'est un geste de compassion du jeu envers le joueur.

---

### 3.3 OUTILS TRANSVERSAUX (PAS DANS LA BARRE)

| Fonction | Raccourci | Description |
|---|---|---|
| **Undo global** | `Ctrl+Z` | Rembobine la dernière action complète (un « stroke » = du mousedown au mouseup). Historique de 80 actions. Snapshots delta par chunk. |
| **Redo** | `Ctrl+Y` / `Ctrl+Shift+Z` | — |
| **Plan de travail** | `Tab` | Fige un plan horizontal à la hauteur survolée (voir §4.3) |
| **Vue de dessus** | `T` | Bascule en caméra orthographique zénithale pour tracer les plans |
| **Mode analyse** | `V` (maintenu) | Colorise le terrain par humidité / compaction / stabilité (cycle avec `V+molette`) |
| **Mode photo** | `P` | Voir §7.4 |
| **Aplanir la plage** | menu | Remet le terrain à plat (avec confirmation, la seule du jeu) |
| **Sauvegarder / Charger** | auto | Auto toutes les 20 s dans IndexedDB. 5 emplacements manuels. |

---

## 4. CONTRÔLES ET CAMÉRA

### 4.1 Schéma clavier / souris complet

#### 4.1.1 Souris

| Input | Contexte | Action |
|---|---|---|
| **LMB (maintenu)** | Sur la plage | Action primaire de l'outil |
| **RMB (maintenu)** | Sur la plage | Action secondaire de l'outil |
| **MMB (drag)** | Partout | **Orbite** la caméra (horizontal = azimut, vertical = élévation) |
| **Shift + MMB (drag)** | Partout | **Pan** (translation du point de pivot dans le plan du sol) |
| **Molette** | Partout | **Rayon de la brosse** (l'action la plus fréquente mérite l'input le plus direct) |
| **Ctrl + Molette** | Partout | **Zoom** caméra (dolly vers/depuis le pivot) |
| **Alt + Molette** | Partout | Paramètre secondaire de l'outil (force, profondeur, angle…) |
| **Shift + Molette** | Partout | Variante d'outil (motif du râteau, forme du coffrage, item de déco) |
| **Double-clic MMB** | Sur une zone | **Focus** : la caméra recentre son pivot sur ce point, avec une transition de 400 ms |
| **LMB sur une déco** | — | Sélection (contour blanc pointillé + bulle d'info) |
| **Survol** | Partout | Pastille d'humidité + prévisualisation de l'outil |

**Sur le conflit molette-zoom.** C'est un choix assumé : dans un jeu de sculpture, on change de rayon de brosse 10 à 20 fois plus souvent qu'on ne zoome. Trois filets de sécurité :
1. `Ctrl+Molette` zoome (et un tooltip l'explique la première fois qu'on scrolle beaucoup sans effet visible).
2. Les touches `+` / `-` zooment.
3. Une option dans les réglages inverse les deux, pour les joueurs venant de Cities:Skylines.

#### 4.1.2 Clavier

| Touche | Action |
|---|---|
| `1` … `9`, `0` | Outil du slot correspondant |
| `E` (maintenu) | Menu radial d'outils sous le curseur |
| `Tab` | Fige / libère le plan de travail |
| `Ctrl` (maintenu) | Verrouille l'altitude / contraint le geste |
| `Shift` (maintenu) | Modificateur d'outil |
| `Alt` (maintenu) | Modificateur secondaire ; `Alt+drag` = manipuler les axes/guides |
| `Espace` (maintenu) | Mode caméra temporaire (LMB = orbite, RMB = pan) |
| `Q` / `E` (tap) | Rotation caméra par pas de 45° |
| `W` `A` `S` `D` | Pan de la caméra |
| `+` / `-` | Zoom |
| `T` | Vue de dessus orthographique (toggle) |
| `F` | Focus sur le curseur |
| `R` | Reset caméra (vue par défaut du diorama) |
| `X` / `Y` | Symétrie miroir |
| `Shift+X` | Symétrie radiale |
| `V` (maintenu) | Mode analyse (heatmap humidité / compaction / stabilité) |
| `H` | Masquer toute l'UI (screenshot propre) |
| `P` | Mode photo |
| `G` | Grille au sol (toggle) |
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |
| `Ctrl+S` | Sauvegarde manuelle |
| `Suppr` | Supprime l'objet sélectionné |
| `Échap` | Désélectionne / ferme le panneau / ouvre le menu |
| `M` | Ouvre / ferme le carnet |
| `1..8` en mode photo | Presets de filtre |

#### 4.1.3 Trackpad (important — beaucoup de joueurs navigateur)

| Geste | Action |
|---|---|
| Un doigt | Déplacer le curseur |
| Clic / tap | Action primaire |
| Deux doigts (glisser) | Orbite |
| Deux doigts + `Shift` | Pan |
| Pincement | Zoom |
| `Ctrl` + deux doigts vertical | Rayon de brosse |
| Clic à deux doigts | Action secondaire |

Détection : si aucun `wheel` event avec `deltaMode === DOM_DELTA_LINE` n'est vu en 30 s, on bascule sur le profil trackpad et on affiche discrètement l'aide gestuelle.

#### 4.1.4 Tactile (tablette / mobile, v2)

| Geste | Action |
|---|---|
| Un doigt | Action de l'outil |
| Deux doigts glisser | Orbite |
| Deux doigts pincer | Zoom |
| Trois doigts glisser | Pan |
| Deux doigts tap | Undo |
| Trois doigts tap | Redo |
| Appui long | Menu radial |
| Slider de rayon | Un curseur circulaire permanent à gauche (le pouce y tombe naturellement) |

#### 4.1.5 Manette (v2)

| Input | Action |
|---|---|
| Stick gauche | Déplacer le curseur sur la surface |
| Stick droit | Orbite caméra |
| `RT` (analogique) | Action primaire, **avec force proportionnelle à la pression** — c'est le meilleur support pour cet outil |
| `LT` | Action secondaire |
| `LB` / `RB` | Outil précédent / suivant |
| `Y` maintenu | Menu radial |
| D-pad haut/bas | Rayon |
| `A` | Focus |
| `B` | Undo |
| `X` | Bascule le plan de travail |
| Croix gauche/droite | Paramètre secondaire |

### 4.2 Caméra orbitale diorama

**Modèle :** caméra orbitale contrainte autour d'un pivot, sur un bloc de 12 × 12 m. C'est une caméra de **diorama**, pas une caméra libre : le joueur doit toujours avoir l'impression de regarder un objet posé sur une table.

| Paramètre | Valeur | Note |
|---|---|---|
| **Type de projection** | Perspective FOV 32° | FOV serré → look de maquette, compression agréable |
| **Distance (dolly)** | 2,5 m → 22 m | Bornes dures. À 2,5 m on est le nez dans le sable, à 22 m on voit tout le bloc + un peu de mer |
| **Élévation** | 8° → 82° | Jamais tout à fait au ras du sol (on perdrait la lisibilité), jamais tout à fait zénithal (sauf en mode `T`) |
| **Élévation par défaut** | 38° | L'angle iso classique du diorama |
| **Azimut** | libre 360° | Avec un snapping doux tous les 45° (une légère aimantation à ±4°, désactivable) |
| **Pivot** | contraint dans le bloc | Le pivot ne peut pas sortir de la zone 12 × 12 m, +2 m de marge. Empêche de se perdre. |
| **Hauteur du pivot** | auto | Le pivot suit la hauteur moyenne du terrain sous lui (lissée sur 0,5 s) → quand on construit une tour, la caméra monte naturellement |
| **Amortissement** | 0,12 (lerp) | Toujours de l'inertie, jamais de mouvement sec. Critique pour le cozy. |
| **Roll** | verrouillé à 0 | Sauf en mode photo |

**Projection isométrique optionnelle.** Une option « vue maquette » passe la caméra en orthographique avec un FOV simulé : look Townscaper pur. Recommandée pour le mode photo et pour la vue de dessus.

**Comportements automatiques :**
- **Auto-cadrage à l'ouverture** : la caméra part de haut et descend en 1,8 s vers la vue par défaut, avec un léger overshoot. C'est le seul mouvement de caméra automatique du jeu.
- **Évitement d'occlusion** : si la caméra passe derrière une tour du joueur, la tour ne devient PAS transparente (ça casserait le look) — à la place, la caméra remonte légèrement en élévation (max +12°) pour retrouver la ligne de vue. Doux, invisible, efficace.
- **Zoom vers le curseur** : le dolly converge vers le point sous le curseur, pas vers le centre de l'écran. Différence énorme d'ergonomie.
- **Anti-nausée** : option pour désactiver l'inertie et l'auto-élévation.

### 4.3 LE PROBLÈME CENTRAL : CHOISIR SA PROFONDEUR EN 3D AVEC UNE SOURIS

C'est le point où 90 % des jeux de sculpture 3D échouent. La souris donne 2 dimensions, la sculpture en demande 3. Voici les **sept solutions concrètes** implémentées, en couches, de la plus automatique à la plus manuelle.

#### Solution 1 — Projection sur surface (défaut, 80 % des cas)

Un raycast depuis la caméra à travers le curseur touche l'isosurface. Le point d'impact `P` et la normale `N` définissent la brosse. La brosse est un **décal projeté** qui épouse la courbure.

- **Avantage :** aucun apprentissage. On peint sur ce qu'on voit.
- **Limite :** impossible de travailler dans le vide ou sous la surface.
- **Renforcement :** si le rayon ne touche rien (on vise le ciel), la brosse se pose sur le **plan du sol** et devient grise (état inactif clair). Jamais de clic perdu dans le vide sans explication.

#### Solution 2 — Verrouillage d'altitude en cours de geste (`Ctrl`)

Au `mousedown`, on enregistre l'altitude `z0` du point de contact. Tant que `Ctrl` est maintenu, tous les points suivants du geste sont calculés par intersection avec le **plan horizontal `z = z0`**.

C'est **le raccourci le plus important du jeu**. Il transforme un geste chaotique (qui suit les bosses) en un geste contrôlé (qui suit un niveau). Il permet :
- creuser un fond de douve parfaitement plat ;
- araser un sommet de mur ;
- tracer un chemin de ronde à hauteur constante.

**Feedback :** un disque translucide bleu pâle apparaît au niveau `z0`, avec une **cote en cm** affichée sur le bord (`+34 cm`). Le disque s'étend sur 2 m autour du geste, avec un dégradé vers la transparence.

#### Solution 3 — Plan de travail persistant (`Tab`)

`Tab` fige le plan horizontal à la hauteur actuellement survolée et le rend **persistant** (il reste après avoir relâché). Tous les outils travaillent alors sur ce plan.

- Une **règle verticale** apparaît sur le côté de la scène, graduée tous les 10 cm, avec le curseur de hauteur.
- `Alt + Molette` (quand le plan est actif) monte/descend le plan par pas de 5 cm (`Shift` = pas de 1 cm).
- Le plan est rendu comme une **fine nappe de brume** au-dessus du sable, avec une grille très pâle — jamais un plan opaque qui cache la scène.
- `Tab` à nouveau le libère.

Usages : bâtir un étage entier à niveau, creuser des fenêtres toutes à la même hauteur, poser des décorations alignées.

#### Solution 4 — Vue de dessus orthographique (`T`) pour tracer les plans

Bascule instantanée (transition de 350 ms) en caméra zénithale orthographique. En vue de dessus :
- Une **grille métrique** apparaît (carreaux de 50 cm, subdivision 10 cm).
- Le terrain est rendu en **carte topographique douce** : des courbes de niveau tous les 10 cm, en teinte plus sombre. On lit instantanément le relief.
- Les outils fonctionnent normalement, mais le geste est purement 2D → parfait pour tracer l'emprise d'un château, creuser une douve circulaire, planifier une allée.
- Un outil spécial disponible seulement dans cette vue : **le traceur** — on dessine un contour fermé, et on choisit ensuite « creuser à −X cm » ou « élever à +X cm ». Extrusion instantanée avec prévisualisation.

C'est la réponse directe à « je n'arrive pas à faire un plan carré à la souris en perspective ».

#### Solution 5 — Snapping et guides

| Type de snap | Déclencheur | Effet |
|---|---|---|
| **Altitude** | Toujours (doux) | Les hauteurs s'aimantent aux multiples de 5 cm à ±1 cm. Invisible mais on sent que ça « colle ». |
| **Grille au sol** | `Shift` | Aimante le point de contact à la grille de 5 cm |
| **Angle** | `Ctrl` pendant un drag directionnel | Contraint la direction à des multiples de 15° |
| **Surfaces existantes** | Auto | Un tampon ou un coffrage s'aligne sur la face survolée (position + orientation) |
| **Alignement de rangée** | Auto (râteau, tampons) | Continue une rangée existante à moins de 3 cm |
| **Concentrique** | Auto (coffrage, seau) | S'aligne sur le centre d'une structure cylindrique voisine à moins de 15 cm |

Tous les snaps sont **désactivables globalement** dans les options, et signalés visuellement (un petit aimant apparaît sur le curseur quand un snap est actif).

#### Solution 6 — Gabarits et guides posables

Des objets diégétiques posés dans la scène qui contraignent les outils :

| Gabarit | Description | Usage |
|---|---|---|
| **Ficelle et piquets** | Deux piquets reliés par une ficelle. Les outils s'aimantent à la ligne. | Mur droit, allée |
| **Compas de plage** | Un piquet + une ficelle tendue. Trace des cercles parfaits. | Douve ronde, tour |
| **Équerre** | Un angle droit posé au sol | Coins de rempart |
| **Niveau à bulle** | Posé sur une surface, indique en continu son écart à l'horizontale | Araser un sommet |
| **Règle graduée** | Simple mètre ruban posé | Mesurer, aligner |
| **Pochoirs** | Contours de formes (étoile, cœur, blason, spirale, labyrinthe) posés au sol ; les outils sont masqués hors du pochoir | Formes complexes en un geste |

Ils sont beaux, ils appartiennent au monde, ils enseignent la précision sans écrire un mot. Ils s'achètent à la Cabane.

#### Solution 7 — Symétrie

Voir Outil 17. Diviser le travail par 2, 4, ou N est la solution la plus efficace au problème de la précision manuelle : on ne fait un beau détail qu'une fois.

#### 4.3.8 Récapitulatif : quel mode pour quelle tâche

| Je veux… | Mode recommandé | Raccourci |
|---|---|---|
| Creuser un trou | Surface | (défaut) |
| Fond de douve plat | Verrouillage d'altitude | `Ctrl` + drag |
| Araser un sommet de mur | Plan de travail | `Tab` puis truelle |
| Tracer l'emprise du château | Vue de dessus + traceur | `T` |
| Fenêtres alignées | Plan de travail vertical | double-clic sur la face, puis mirette |
| Mur parfaitement droit | Ficelle et piquets, ou `Ctrl` avec la truelle | — |
| Tour ronde | Compas de plage, ou coffrage cylindrique | — |
| Créneaux réguliers | Tampon en série + `Shift` | — |
| Château symétrique | Symétrie miroir | `X` |
| Rosace, tour à N pans | Symétrie radiale | `Shift+X` |

### 4.4 Ergonomie : la liste anti-frustration

Problèmes classiques de la sculpture 3D à la souris et leur contre-mesure dans Sandcastle :

| Frustration classique | Contre-mesure |
|---|---|
| « Je ne sais pas où ma brosse va toucher » | Décal projeté qui épouse la surface + prévisualisation fantôme systématique de la déformation |
| « Je ne sais pas quelle taille elle fait » | Anneau de rayon toujours visible, avec la valeur en cm en petit à côté. Pendant le changement de rayon, un cercle plein s'affiche brièvement au centre de l'écran. |
| « J'ai creusé beaucoup trop profond d'un coup » | La force dépend de la vitesse du geste (geste rapide = force réduite) ; accélération progressive au maintien (rampe de 0 à 100 % en 0,4 s) ; jamais d'effet maximal au premier frame |
| « Je tourne la caméra sans le vouloir » | Orbite sur MMB uniquement (ou `Espace`), jamais sur RMB qui est un bouton d'outil |
| « Je perds mon château de vue » | Pivot contraint au bloc, `R` remet la vue par défaut, `F` focus sur le curseur |
| « Je ne peux pas atteindre l'arrière » | `Q`/`E` tournent par pas de 45° — pas besoin de gérer un drag pour changer de face |
| « Mes traits ne sont pas droits » | `Ctrl` = contrainte d'angle à 15° ; ficelle et piquets ; vue de dessus |
| « Je ne vois pas ce que je fais, l'outil cache la zone » | Le mesh de l'outil devient transparent à 40 % pendant l'application, et son ombre reste. |
| « Ça rame quand je fais un gros geste » | La déformation visuelle est appliquée immédiatement sur les chunks touchés ; la simulation (avalanche, eau, stabilité) tourne à 20 Hz sur un budget de 4 ms et rattrape progressivement |
| « J'ai fait une erreur il y a 5 minutes » | Gomme temporelle (rembobinage local) + 80 niveaux d'undo |
| « J'ai mal au poignet » | Toutes les actions maintenues ont un mode « toggle » optionnel (un clic active, un clic désactive) |
| « Trop de raccourcis à retenir » | Menu radial sur `E` qui donne accès à tout, avec les raccourcis affichés dedans. On peut jouer sans jamais toucher au clavier sauf `Ctrl` et `Shift`. |

---

## 5. UX / INTERFACE

### 5.1 Description précise de l'écran de jeu

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                            ╭──────────────────╮                   ╭─╮╭─╮╭─╮╭─╮│
│                            │ ☀ Plage du Matin │                   │☀││👤││🛒││📷││
│                            │    10:24 · Doux  │                   ╰─╯╰─╯╰─╯╰─╯│
│                            ╰──────────────────╯                          ╭─╮  │
│ ╭────────────────╮                                                       │≡│  │
│ │  ◉ SABLE       │                                                       ╰─╯  │
│ │                │                                                             │
│ │ Sec     ▓▓░░░░ │                                                             │
│ │ Humide  ▓▓▓▓▓░ │                    [   LE DIORAMA 3D   ]                    │
│ │ Mouillé ▓░░░░░ │                                                             │
│ │                │                       ╭────────────╮                        │
│ │ ── Stabilité ──│                       ┆  ● 24 %    ┆ ← bulle d'info         │
│ │  ●●●●●●●○○○ 68%│                       ┆  Tourelle  ┆   (objet sélectionné,  │
│ ╰────────────────╯                       ╰┈┈┈┈┈┈┈┈┈┈┈┈╯    contour pointillé)  │
│                                                                                │
│                                                                                │
│  ╭─────────╮        ╭────╮╭────╮╭────╮╭────╮╭────╮╭────╮╭────╮╭────╮          │
│  │ 🐚 128  │        │ ⛏ ││ ✋ ││ 💧 ││ 🪣 ││ 🔪 ││ 🔘 ││ 🧹 ││ ⋯ │          │
│  ╰─────────╯        ╰────╯╰────╯╰────╯╰────╯╰────╯╰────╯╰────╯╰────╯          │
│                       1     2     3     4     6     7     9    plus            │
└───────────────────────────────────────────────────────────────────────────────┘
```

#### 5.1.1 Barre d'outils — bas, centrée

- **Forme :** une rangée de **boutons ronds** de 56 px de diamètre (52 px sur petit écran), espacés de 10 px, posés sur une barre-plateau en crème `#FBF3E4` à coins très arrondis (rayon 32 px), avec une ombre douce `0 6px 20px rgba(120,95,60,0.18)`.
- **Icônes :** dessinées à la main, trait de crayon irrégulier, remplissage aquarelle en 2–3 tons. Jamais de pictogramme vectoriel générique. Chaque outil ressemble au vrai objet posé sur la plage.
- **Outil actif :** le bouton **monte de 8 px**, grandit de 8 %, gagne un anneau crème plus clair et une ombre plus marquée. Une petite languette de papier avec le numéro du slot apparaît en dessous.
- **Survol :** le bouton monte de 3 px, l'icône tourne de 2°, et une **étiquette manuscrite** apparaît au-dessus (nom + un seul mot d'usage : « Pelle — creuser »).
- **Slot « plus » (`⋯`)** : ouvre la grille complète des outils (les 18), en overlay flottant au-dessus de la barre, en 3 rangées. Les non débloqués sont en pointillés pâles.
- **Réorganisation :** on peut glisser-déposer un outil de la grille vers un slot. Les slots sont personnalisables.
- **Menu radial (`E` maintenu) :** un anneau de 8 secteurs apparaît **sous le curseur**, sans déplacer la vue. Rayon intérieur 42 px (dead zone anti-flicker), rayon extérieur 130 px. Le nom de l'outil survolé s'affiche **au centre**. Un mouvement rapide dans une direction + relâchement sélectionne immédiatement (gesture-based). Les secteurs des outils les plus utilisés sont plus larges. Un secteur « ▸ plus » ouvre un second anneau.
- **Micro-animation :** l'ouverture du radial est un déploiement en 140 ms avec `easeOutCubic`, chaque secteur décalé de 12 ms (stagger).

#### 5.1.2 Panneau « Sable » — gauche

Une **carte** au format portrait (200 × 210 px), papier crème, coins arrondis 20 px, très légère rotation de −1,2° (comme posée à la main), ombre douce.

- **Titre :** « SABLE », petites capitales, lettrage manuscrit, avec un petit dessin de tas de sable.
- **Trois jauges horizontales**, chacune avec :
  - une pastille de couleur (crème / sable moyen / brun mouillé — cf. §0.2) ;
  - le nom (« Sec », « Humide », « Mouillé ») ;
  - une jauge à **segments** (6 segments arrondis, pas une barre continue — les segments sont plus lisibles et plus mignons) ;
  - le pourcentage en petit à droite.
- **Ce que mesurent les jauges :** la répartition de l'humidité **dans la structure construite** (pas dans toute la plage). C'est le bilan de santé du château. Si « Humide » domine, tout va bien. Si « Sec » monte, il faut arroser.
- **Le 4e état, Saturé**, n'apparaît **que s'il existe** — une 4e jauge se déplie avec une animation de 200 ms, en bleu-brun, avec une petite icône d'alerte douce. Ne pas afficher un état vide en permanence est un choix de sobriété.
- **Séparateur** : un trait ondulé dessiné à la main.
- **Jauge de stabilité** : une rangée de 10 petits ronds qui se remplissent, plus le pourcentage. Couleur : vert sauge (> 70 %), ambre (40–70 %), corail pâle (< 40 %). **Jamais de rouge vif.** Sous la jauge, une ligne de texte manuscrit très courte et non alarmiste : « Ça tient bien » / « Un peu fragile » / « Le mur nord penche ». Cliquer sur cette ligne fait **pointer la caméra** sur la zone concernée.
- **Repliable** : un petit onglet permet de replier le panneau en une simple pastille (pour le mode photo ou la concentration).

#### 5.1.3 Badge de lieu — haut, centré

Une petite **pancarte en bois flotté** (ou une étiquette de carnet) de 220 × 54 px, légèrement inclinée de +0,8°.

- **Ligne 1 :** icône météo (soleil / soleil voilé / nuage / pluie / lune) + nom du lieu, en lettrage manuscrit, 17 px.
- **Ligne 2 :** heure du jeu + qualificatif de météo (« 10:24 · Doux », « 17:40 · Vent d'ouest »), 12 px, opacité 70 %.
- **Indicateur de marée :** une fine ligne ondulée sous la pancarte, qui monte lentement pour représenter le niveau de marée. Quand la marée monte, la ligne s'anime et prend une teinte plus bleue. C'est un **timer diégétique sans chiffres**.
- **Clic :** ouvre le sélecteur de lieu/heure/météo.
- Le badge **disparaît en fondu** après 6 s d'inactivité de la souris et revient au mouvement. Toute la UI fait ça (voir §5.4).

#### 5.1.4 Boutons ronds — haut à droite

Cinq boutons ronds de 44 px, empilés horizontalement avec 10 px d'écart, plus le menu isolé en dessous.

| Bouton | Icône | Action |
|---|---|---|
| **Météo / heure** | Soleil avec un petit nuage | Ouvre le cadran : heure du jour (roue de 8 positions) + météo (6 vignettes). Changement en 2 s avec transition de lumière fondue. |
| **Profil** | Silhouette dans un cercle | Carnet de plage : croquis, plages, album, statistiques douces (« 14 marées vécues », « 312 minutes de plage ») |
| **Boutique** | Petite cabane de plage | La Cabane : décorations, gabarits, seaux, tampons, contre des coquillages. Étalage en 3D, pas une grille. |
| **Photo** | Appareil photo compact | Mode photo (`P`) |
| **Menu** | Trois traits ondulés | Options, accessibilité, sauvegarde, crédits, quitter |

- **Style :** fond crème translucide (`rgba(251,243,228,0.88)` + `backdrop-filter: blur(8px)`), bordure de 1,5 px en `#E3D2B4`, icône au trait brun `#8A6A45`.
- **Survol :** l'icône fait un petit mouvement propre à sa nature (le soleil tourne de 15°, l'appareil photo fait un clic de diaphragme, la cabane a sa porte qui bat).
- **Notification** : jamais un point rouge. Quand un déblocage est disponible, le bouton concerné a un **très léger halo doré pulsant** (1,8 s de cycle), qui s'éteint après consultation.

#### 5.1.5 Badge de ressource — bas à gauche

Une pastille ovale de 110 × 40 px, crème, avec un coquillage dessiné et le nombre.

- **Gain :** quand on gagne des coquillages, un petit coquillage **vole depuis le point de collecte** jusqu'au badge (courbe de Bézier, 700 ms), le badge fait un rebond de 6 %, et le nombre s'incrémente avec un petit son de carillon.
- **Clic :** ouvre la Cabane.
- Aucun compteur de « niveau », d'« XP », de « quête ». Juste des coquillages.

#### 5.1.6 Sélection d'objet

Quand une décoration est sélectionnée :
- **Contour blanc pointillé** dessiné en post-process (détection de silhouette), tirets de 6 px, espacement 5 px, `dash-offset` qui défile lentement (un tour toutes les 8 s). Épaisseur 2 px. Légère lueur externe blanche à 25 %.
- **Bulle d'info** ancrée à l'objet, orientée vers l'espace libre (elle évite les bords de l'écran) : petit rectangle crème à coins arrondis, avec une pointe. Contenu : le nom, une ligne de provenance manuscrite, et 3 petits boutons ronds (rotation, échelle, supprimer).
- **Gizmo** : trois anneaux très fins pour la rotation, une poignée pour l'échelle. Style dessiné à la main, pas des flèches CAO.

### 5.2 Style visuel de l'UI

| Aspect | Spécification |
|---|---|
| **Palette de base** | Crème `#FBF3E4` (fonds) · Sable `#E3D2B4` (bordures) · Brun doux `#8A6A45` (texte, icônes) · Brun foncé `#5C4531` (titres) |
| **Accents** | Turquoise `#7FBFC4` (eau, actions liées à l'eau) · Vert sauge `#9CB380` (validation) · Corail pâle `#E39D8B` (alerte douce) · Doré `#E8C27A` (récompense) |
| **Interdits** | Le rouge saturé, le noir pur, le blanc pur (sauf le contour de sélection), les dégradés violents, les néons |
| **Formes** | Rayon de coin minimum 16 px, souvent 24–32 px. **Aucun angle droit dans toute l'UI.** Les cartes ont une légère rotation (±1,5°). |
| **Ombres** | Toujours douces, colorées (brun-chaud, jamais grises) : `0 4px 16px rgba(120,95,60,0.15)`. Deux couches max. |
| **Typographie** | Titres : une ronde manuscrite lisible (*Caveat*, *Gochi Hand*, ou une police maison). Corps : une sans-serif géométrique arrondie (*Quicksand*, *Nunito*, *Baloo 2*). Chiffres tabulaires pour les jauges. |
| **Tailles** | Corps 14 px · Étiquettes 12 px · Titres 17 px · Grands chiffres 22 px. Tout ×1,0 à ×1,6 selon le réglage d'échelle. |
| **Texture** | Un très léger grain de papier (bruit 3 % en overlay) sur tous les panneaux. Les bords des cartes sont légèrement irréguliers (masque SVG). |
| **Iconographie** | Trait de crayon 2 px, irrégulier (pas de trait parfaitement constant), remplissage aquarelle avec débordement volontaire de 1–2 px. Toutes les icônes sont des **objets réels**, jamais des symboles abstraits. |

**Micro-animations (toutes en `cubic-bezier(0.34, 1.3, 0.64, 1)` sauf mention) :**

| Élément | Animation | Durée |
|---|---|---|
| Apparition d'un panneau | Fondu + montée de 8 px + scale 0,97→1 | 220 ms |
| Bouton au survol | Montée 3 px, scale 1,04 | 130 ms |
| Bouton au clic | Scale 0,94 puis rebond | 90 + 140 ms |
| Sélection d'outil | Le bouton monte de 8 px, les voisins s'écartent de 2 px | 200 ms |
| Menu radial | Déploiement avec stagger de 12 ms par secteur | 140 ms |
| Jauge qui change | Interpolation amortie, jamais instantanée | 400 ms |
| Gain de coquillage | Vol en Bézier + rebond du badge | 700 ms |
| Toast | Glisse du bas, reste 3,5 s, s'efface | 250/250 ms |
| Déblocage d'outil | L'icône se dessine au trait (path animation) puis se remplit | 1,4 s |

**Règle absolue :** aucune animation d'UI ne dépasse 500 ms sauf les célébrations. Aucune n'est bloquante. Le joueur peut cliquer pendant.

### 5.3 Feedbacks in-world

| Feedback | Forme | Déclencheur |
|---|---|---|
| **Pastille d'humidité** | Goutte + mot + mini-barre, collée au curseur (offset 28 px) | En permanence pendant le survol de la plage |
| **Prévisualisation d'outil** | Fantôme blanc 25 % de la déformation à venir | En permanence |
| **Rayon de brosse** | Anneau projeté sur la surface + valeur en cm | En permanence |
| **Jauge de stabilité locale** | Arc de 240° autour du curseur, se remplit selon la contrainte | Seulement si contrainte > 60 % |
| **Alerte d'effondrement** | La zone à risque est **hachurée** en post-process (fines lignes diagonales couleur corail, animées lentement) + les grains commencent à trembler et à tomber un par un | Contrainte > 90 % |
| **Message de conseil** | Une phrase manuscrite, 4 à 7 mots, qui apparaît en bas de la zone concernée, en 3D ancrée au monde. « Trop sec, ce mur. » | Max 1 toutes les 45 s. Jamais deux fois la même en une session. |
| **Effondrement** | Ralenti à 0,45× pendant 0,8 s, la caméra ne bouge pas, les grains cascadent, poussière. Puis un toast : « Ça arrive. » + bouton « Annuler » | Effondrement de plus de 0,02 m³ |
| **Réussite discrète** | Petit flash blanc doux + une note de marimba + 3 particules dorées | Démoulage parfait, compaction complète, arche terminée |
| **Niveau de marée** | Ligne bleue très fine dessinée au sol montrant la limite de marée haute | À partir de T-5 min |
| **Mode analyse (`V`)** | Le terrain est colorisé : humidité (dégradé crème→bleu), compaction (dégradé), ou stabilité (vert→corail). Une légende apparaît en bas. | Touche maintenue |

**Sur l'alerte d'effondrement.** C'est le seul « avertissement » du jeu, et il est conçu pour être **informatif, pas anxiogène** :
- Il n'y a **aucun son d'alerte**. Juste le grain qui commence à couler, qui est un son naturel.
- Le hachurage est en corail pâle, pas en rouge.
- Il n'y a **pas de compte à rebours**. La structure tient tant qu'on ne la charge pas plus.
- Le message est toujours formulé comme une observation, jamais comme un ordre : « Ce mur est bien sec » plutôt que « Arrosez immédiatement ».
- Après un effondrement, le jeu propose l'undo mais **ne l'exécute pas** : certains joueurs trouvent l'effondrement joli et veulent le garder.

### 5.4 UI qui s'efface

Le jeu est fait pour être regardé. L'UI doit savoir disparaître.

| Règle | Détail |
|---|---|
| **Auto-fade** | Après 6 s sans mouvement de souris ni input, toute l'UI passe à 25 % d'opacité en 600 ms. Elle revient instantanément (120 ms) au moindre mouvement. |
| **Fade en action** | Pendant qu'un bouton de souris est maintenu, le panneau Sable et le badge de lieu passent à 40 % — on sculpte, on ne lit pas. |
| **Masquage total** | `H` masque tout. Un très petit point crème en bas à droite rappelle qu'on est en mode masqué. |
| **Mode photo** | UI totalement remplacée par les outils photo (voir §7.4) |
| **Marée haute** | À partir de T-0, l'UI passe automatiquement à 15 % pendant l'érosion, sauf le bouton Photo. Le spectacle prime. |

### 5.5 Onboarding sans texte lourd

**Objectif : que le joueur ait creusé, mouillé, tassé et démoulé un seau dans les 90 premières secondes, sans avoir lu plus de 25 mots au total.**

Le tutoriel est **diégétique et incarné** : une **main fantôme** (une main d'enfant translucide, dessinée dans le même style que les icônes) apparaît et fait le geste. Le joueur imite. C'est tout.

| Étape | Déclencheur | Ce qui se passe | Mots affichés |
|---|---|---|---|
| **0. Arrivée** | Chargement fini | La caméra descend du ciel vers la plage vierge. Bruit de vagues et de mouettes. La pelle est déjà l'outil actif. Rien d'autre. | 0 |
| **1. Creuser** | 3 s d'inactivité | Une main fantôme apparaît, tient la pelle, fait un geste de creusement, laisse une trace lumineuse. Elle recommence toutes les 4 s. Disparaît dès que le joueur creuse. | « Creuse. » |
| **2. Le sable sec** | Le joueur a creusé 2 s | Le tas de sable sec s'écroule visiblement. Le panneau Sable **apparaît en glissant** et la jauge « Sec » se remplit en surbrillance. Rien n'est dit. | 0 |
| **3. Mouiller** | 4 s après l'étape 2 | La main fantôme prend l'arrosoir dans la barre (le bouton `3` pulse une fois) et arrose. Le sable fonce. | « Mouille. » |
| **4. L'aha** | Le joueur a arrosé | La jauge « Humide » se remplit. Le tas **cesse de s'écrouler** et tient une pente raide. Un petit carillon. **C'est le moment où le joueur comprend tout le jeu.** | 0 |
| **5. Tasser** | 3 s après | Main fantôme, geste de tapotement, à 5 Hz, très démonstratif. | « Tasse. » |
| **6. Le seau** | Le joueur a tapé 5 fois | Un seau apparaît **physiquement dans le sable** à côté, avec un léger scintillement. La main fantôme le montre. | 0 |
| **7. Premier château** | Le joueur démoule | Confettis de sable, deux notes de marimba, le badge de lieu apparaît, la barre d'outils complète se déplie. Le tutoriel est fini. | « Joli. » |
| **8. Suite** | À l'usage | Chaque nouvel outil est introduit de la même façon : il apparaît dans le sable, la main fantôme le montre une fois, et un seul verbe s'affiche. | 1 mot |

Total : **6 mots** dans le tutoriel principal.

**Découverte permanente (au-delà du tutoriel) :**
- **Les objets enseignent** : quand le joueur reçoit la truelle, elle est plantée dans le sable, avec une petite planche à côté déjà taillée net par elle. L'objet montre son résultat.
- **Le mode analyse (`V`)** est mentionné une seule fois, quand un premier effondrement survient : « Maintiens V pour voir. »
- **Le carnet** contient un croquis par outil avec un dessin de son usage — consultable mais jamais poussé.
- **Aucun tooltip ne s'ouvre tout seul.** Les tooltips existent au survol, c'est tout.
- **Les PNJ enseignent** : un vieux sculpteur de sable passe parfois sur la plage, regarde, hoche la tête, et laisse derrière lui une petite sculpture démonstrative (une arche parfaite, un créneau) qui reste. On peut l'observer, la copier, ou la détruire.

### 5.6 Accessibilité

| Domaine | Fonctionnalité |
|---|---|
| **Daltonisme** | Les 4 états du sable sont distingués par **couleur ET forme ET texte** : les jauges ont des motifs différents (plein / pointillé / rayé / croisillé) et le nom est toujours écrit. Trois palettes alternatives : deutéranopie, protanopie, tritanopie. Le mode analyse propose un dégradé monochrome (clair→foncé) qui fonctionne pour tous. |
| **Contraste** | Un mode « contraste renforcé » qui opacifie les panneaux à 100 %, épaissit les bordures à 3 px, et fonce le texte à `#3A2B1E`. Ratio minimum 4,5:1 dans ce mode. |
| **Taille d'UI** | Curseur de 100 % à 160 %, par pas de 10 %. Tous les panneaux sont en `rem`, pas en `px` fixes. La barre d'outils réduit son nombre de slots visibles plutôt que de déborder. |
| **Taille du curseur 3D** | Réglage séparé de l'épaisseur de l'anneau de brosse et de la taille de la pastille d'humidité. |
| **Contrôles remappables** | Toutes les touches, y compris les modificateurs. Presets : Défaut, Blender, ZBrush, Cities:Skylines, Gaucher. Détection de conflit avec avertissement. |
| **Mode toggle** | Chaque action « maintenir » peut devenir « cliquer pour activer / cliquer pour arrêter ». Réglable par action ou globalement. Pour les joueurs avec fatigue ou douleur. |
| **Mode une main** | Un layout complet mappé sur la moitié gauche du clavier + souris, ou entièrement à la souris via le menu radial. |
| **Sans chrono** | Interrupteur global. Désactive la marée automatique, les défis chronométrés deviennent des défis libres, le cycle jour/nuit devient manuel. **Accessible depuis le premier écran de jeu, pas enterré dans les options.** |
| **Réduction de mouvement** | Désactive l'inertie de caméra, les screenshakes, le parallaxe, les micro-animations d'UI (elles deviennent des fondus simples), et le tremblement des structures instables (remplacé par le hachurage seul). |
| **Sous-titres sonores** | Option qui affiche les sons importants en texte discret en bas d'écran (« effondrement », « l'eau entre dans le canal », « mouette »). Utile aussi pour jouer sans son. |
| **Indicateurs sonores → visuels** | Le pitch de l'arrosoir (qui indique l'humidité optimale) est doublé par un anneau qui devient vert. Aucune information n'est **uniquement** sonore. |
| **Lecture d'écran** | Toute l'UI 2D est du DOM réel (pas du canvas) avec des rôles ARIA, une navigation au clavier, et un focus visible. Le diorama 3D n'est pas accessible au lecteur d'écran, mais toute la navigation, la boutique, le carnet et les options le sont. |
| **Pause** | `Échap` met tout en pause, y compris la marée et l'érosion. Pas de « are you sure ». |
| **Épilepsie** | Aucun flash de plus de 3 Hz. Le seul flash du jeu (validation) est un fondu blanc à 20 % d'opacité sur 200 ms. |

---

## 6. FEEL, AUDIO ET AMBIANCE

### 6.1 Philosophie audio

Le son est **la moitié de la physique**. Le joueur ne peut pas toucher le sable, donc il doit l'entendre. Trois règles :

1. **Tout son de matière est modulé en continu** par `w` (humidité), `φ` (compaction), et la vitesse du geste. Aucun son n'est déclenché « tel quel ».
2. **La musique ne couvre jamais la matière.** Le mix donne la priorité absolue aux sons d'outils : la musique est duckée de −6 dB dès qu'un bouton de souris est maintenu.
3. **Le silence est un instrument.** Il y a des moments sans musique du tout : l'aube, l'érosion, le mode photo.

### 6.2 Liste complète des sons

#### 6.2.1 Sable (banque principale — la plus importante)

| ID | Description | Variations | Modulation |
|---|---|---|---|
| `sand_dig_dry` | Crissement de pelle dans du sable sec, grains qui glissent | 6 | Pitch ±8 %, volume ∝ vitesse, filtre passe-haut ∝ sécheresse |
| `sand_dig_wet` | « Scrunch » mat, plus grave, plus court | 6 | Idem, crossfade avec la version sèche selon `w` |
| `sand_dig_saturated` | Bruit visqueux, succion | 4 | — |
| `sand_pour` | Sable qui tombe et forme un tas | 5 | Durée ∝ volume |
| `sand_slide` | Avalanche de grains sur une pente | 4 | Volume ∝ masse déplacée |
| `sand_scatter` | Grains qui s'éparpillent | 6 | Pour les impacts et le souffle |
| `sand_crunch_step` | Pas sur du sable (PNJ, crabe) | 8 | — |
| `sand_squeak_dry` | Le crissement caractéristique du sable très sec très fin | 3 | Rare, très évocateur, joué au survol de zones sèches |

#### 6.2.2 Gestes et outils

| ID | Description | Variations |
|---|---|---|
| `hand_pat_wet` | Le **« flop »** — le son signature | 8 |
| `hand_pat_dry` | Tapotement sec | 6 |
| `hand_smooth_loop` | Frottement de lissage | boucle |
| `bucket_fill_scoop` | Remplissage du seau | 4 |
| `bucket_tamp` | Tapotement sur le seau, **pitch descendant avec la compaction** | 5 |
| `bucket_suction_release` | Le « schlop » du démoulage | 4 |
| `bucket_success_chime` | Deux notes de marimba, très douce | 2 |
| `bucket_collapse_soft` | Démoulage raté, « splat » comique | 3 |
| `trowel_cut` | Coupe nette, crissement fin et aigu | 6 |
| `trowel_smooth_loop` | Lissage à plat | boucle |
| `gouge_scrape` | Raclement de mirette | 6 |
| `gouge_ribbon_fall` | Le ruban de sable qui tombe | 4 |
| `arch_carve_whoosh` | Découpe d'arche + petit chime | 2 |
| `rake_drag` | Grattement rythmé, pitch ∝ vitesse | 6 (× 7 motifs) |
| `blow_loop` | Souffle (paille : avec un léger souffle humain) | boucle |
| `brush_sweep` | Balayage de pinceau, le son le plus doux du jeu | 8 |
| `stamp_press` | « Pomf » du tampon | 4 |
| `formwork_place` | Toc de bois | 3 |
| `formwork_fill` | Sable dans un contenant (résonance) | 3 |
| `formwork_tamp` | Tambour, pitch montant avec la compaction | 6 |
| `formwork_lift` | Décollement du coffrage | 3 |
| `spray_pssht` | Fixatif | 3 |
| `eraser_rewind` | Son inversé, shimmer (hors-fiction assumé) | 2 |
| `place_shell` / `_wood` / `_stone` / `_flag` | Pose de décoration | 4 chacun |

#### 6.2.3 Eau

| ID | Description |
|---|---|
| `watering_can_loop` | Arrosage, **pitch +3 demi-tons à l'humidité optimale** |
| `water_pour_loop` | Versement du seau d'eau |
| `water_impact_sand` | Impact sur sable (×4) |
| `water_impact_water` | Impact sur eau (×4) |
| `water_seep` | Nappe atteinte, « gloup » |
| `puddle_form` | Naissance d'une flaque |
| `stream_loop` | Écoulement dans un canal, spatialisé, brillant ∝ vitesse |
| `water_rush_in` | La mer entre dans un canal — son montant, gratifiant |
| `dam_break` | Rupture de barrage |
| `mud_slump` | Liquéfaction, visqueux et grave |
| `drip_plop` | Goutte de slurry (×8) — métronome naturel |
| `slurry_mix` | Mélange de la soupe |

#### 6.2.4 Structure

| ID | Description |
|---|---|
| `crack_micro` | Micro-fissure, très discret, prévient l'effondrement (×6) |
| `grain_trickle` | Un filet de grains qui tombe — le vrai avertissement |
| `collapse_small` | Effondrement < 0,05 m³, doux |
| `collapse_medium` | Effondrement moyen, avec un léger « whumpf » |
| `collapse_large` | Grosse chute, avec réverbération |
| `dust_puff` | Nuage de poussière (×5) |

#### 6.2.5 Ambiance et nature

| ID | Description |
|---|---|
| `waves_far_loop` | Ressac lointain, base de l'ambiance. **Volume et brillance pilotés par le niveau de marée.** |
| `waves_near_loop` | Vagues proches, quand la mer approche |
| `wave_break_01..12` | Vagues individuelles, déclenchées par la simulation, spatialisées |
| `foam_hiss` | L'écume qui se retire en sifflant sur le sable — un son merveilleux |
| `wind_light_loop` / `wind_strong_loop` | Vent, crossfade selon la météo |
| `seagull_call_01..08` | Mouettes, spatialisées, déclenchées aléatoirement (1 toutes les 20–60 s) |
| `seagull_flock` | Groupe, joué à l'approche de la marée |
| `tern_call` | Sternes, plus aigu |
| `crab_scuttle` | Petit crabe qui court |
| `crab_click` | Pince |
| `beach_ambience_day` | Lit d'ambiance : vagues + vent + oiseaux lointains |
| `beach_ambience_night` | Version nuit : vagues plus douces, grillons, chouette lointaine |
| `distant_children` | Très lointain, très discret, joué 2–3 fois par session. Extrêmement évocateur. |
| `distant_dog_bark` | Rare |
| `rain_light_loop` / `rain_on_water` | Pluie |
| `thunder_far` | Orage lointain, jamais proche |

#### 6.2.6 UI

| ID | Description |
|---|---|
| `ui_hover` | Un très léger « tick » de bois (−22 dB) |
| `ui_click` | Un petit « pop » doux |
| `ui_tool_select` | Le son du vrai objet qu'on ramasse (spécifique par outil) |
| `ui_panel_open` / `_close` | Froissement de papier |
| `ui_radial_open` | Un souffle court montant |
| `ui_shell_collect` | Carillon cristallin, une note |
| `ui_unlock` | Trois notes ascendantes, marimba + une nappe |
| `ui_photo_shutter` | Déclencheur d'appareil argentique |
| `ui_notebook_page` | Page qui tourne |
| `ui_save` | Presque inaudible, un souffle |

**Total :** ~280 fichiers audio. Format : OGG Vorbis (fallback MP4/AAC pour Safari). Budget total ≤ 6 Mo. Sons courts en `AudioBuffer` décodés au chargement ; ambiances en `<audio>` streamé.

### 6.3 Juice : la liste complète

| Effet | Détail | Coût |
|---|---|---|
| **Grains individuels** | `InstancedMesh` de 2 000 petits quads face-caméra, pool réutilisé. Chaque grain a une vélocité, une gravité, un rebond amorti, et disparaît en se fondant dans le terrain (il ne « pop » jamais out). | 1 draw call |
| **Poussière** | Billboards doux, additifs à faible opacité, qui dérivent avec le vent. Naissent grands, meurent en s'étalant. | 1 draw call |
| **Éclaboussures** | Couronne de gouttes + une onde circulaire en decal sur l'eau | faible |
| **Traînée d'outil** | Chaque outil laisse une trace éphémère dans la normal map de détail (empreinte de main, sillon de mirette, trace de pinceau), qui s'estompe en 4–8 s selon l'humidité | 1 render target |
| **Micro-déformation** | Toute surface touchée « rebondit » légèrement (une impulsion dans le vertex shader qui s'amortit en 250 ms). Donne l'impression que la matière est molle. | shader |
| **Screenshake** | **Maximum 3 px d'amplitude, décroissance exponentielle en 180 ms.** Uniquement sur : gros effondrement, démoulage parfait, vague qui frappe une structure. **Jamais** sur un geste d'outil normal. Désactivable. | — |
| **Squash & stretch de l'UI** | Chaque bouton, chaque jauge, chaque badge a un rebond élastique. Rien n'est rigide. | CSS |
| **Réponse à l'anticipation** | Avant l'application d'un outil, il y a 60 ms d'anticipation visuelle (l'outil recule légèrement). Après, 120 ms de suivi (il rebondit). C'est ce qui fait qu'un geste « existe ». | — |
| **Haptique** | Mobile : `navigator.vibrate([8])` par tap, `vibrate([3])` en continu pendant un lissage. Manette : rumble faible modulé par la vitesse du geste, avec un pic à chaque tap. | — |
| **Chromatic aberration** | Extrêmement subtile (0,3 px) sur les bords de l'écran seulement, pour le look photographique. | post |
| **Depth of field** | Bokeh doux, plan de netteté sur le point de pivot. Renforce le look diorama/maquette. **C'est LE post-process qui fait la moitié du charme.** | post |
| **Bloom** | Très doux, seuil haut. Uniquement sur les reflets d'eau et le soleil. | post |
| **Grain de film** | 2 % animé, pour éviter le banding et donner de la texture | post |
| **Vignettage** | 12 %, chaud (pas noir) | post |
| **Rim light** | Une lumière de contour chaude sur toutes les arêtes vives. **C'est ce qui fait qu'une sculpture nette a l'air nette.** | shader |
| **Ombres douces** | PCSS ou une approximation ; les ombres du sable doivent être **bleutées et douces**, jamais noires. | — |
| **Sous-surface scattering fake** | Le sable humide laisse passer un peu de lumière sur les arêtes fines. Approximation par un wrap-lighting. Effet subtil, gros impact sur la crédibilité. | shader |
| **Réflexion spéculaire mouillée** | Le sable mouillé réfléchit le ciel (cubemap) proportionnellement à `w`. **Le retour visuel n° 1 du jeu.** | shader |

**Budget de performance :** tous les post-process en une seule passe combinée. Cible 60 fps sur une Intel Iris Xe. Si le framerate descend sous 45, on désactive automatiquement (dans l'ordre) : DOF → bloom → nombre de particules ÷2 → résolution des ombres ÷2. Le joueur voit un petit message une fois, avec un lien vers les options.

### 6.4 Musique

**Principe :** une musique **adaptative en couches**, très légère, jamais mélodique au point d'être fatigante. On vise l'ambient tempéré (références : Dorfromantik, Cloud Gardens, A Short Hike, les nappes de Townscaper).

**Instrumentation :** piano feutré (feutre entre les marteaux), guitare nylon en harmoniques, marimba, harpe, nappes de synthé chaud, quelques bols chantants, très peu de percussion (jamais de batterie).

**Système de couches (5 stems, mixés dynamiquement) :**

| Couche | Contenu | Condition d'entrée |
|---|---|---|
| **L0 — Fond** | Une nappe très ténue, presque un drone | Toujours (−22 dB) |
| **L1 — Base** | Piano feutré, arpèges lents, sans mélodie affirmée | Quand le joueur construit depuis > 60 s |
| **L2 — Mélodie** | Une ligne de guitare ou de marimba | Quand le joueur est en train de sculpter activement, monte progressivement |
| **L3 — Ampleur** | Cordes douces, chœur bouche fermée | Pendant la marée montante et l'érosion |
| **L4 — Intime** | Une seule note tenue + réverbération longue | Mode photo, mode analyse, pause |

**Règles :**
- Transitions par fondu de 4 à 8 s. Jamais de coupure.
- La musique **s'arrête complètement** pendant 40 à 90 s toutes les 8 à 12 minutes. Ces silences (juste les vagues) sont conçus, pas accidentels. Ils rendent le retour de la musique agréable.
- Duck de −6 dB dès qu'un bouton de souris est maintenu.
- Tempo global : 58–72 BPM. Les tapotements de main sont légèrement quantifiés sur ce tempo (§ outil 2).
- **Une variante par lieu** (7 thèmes) + une variante nocturne de chacun.

### 6.5 Cycle jour/nuit et météo

| Moment | Heure | Lumière | Ambiance | Débloqué |
|---|---|---|---|---|
| **Aube** | 05:30 | Rasante, rose-orange, brume au sol, ombres très longues | Silence, quelques oiseaux, mer plate | Session 4 |
| **Matin** | 09:00 | Douce, jaune pâle, ciel dégagé | Mouettes, vagues moyennes | Départ |
| **Midi** | 12:30 | Zénithale, dure, contrastée, sable très clair | Chaud, cigales lointaines, évaporation rapide (×2) | Départ |
| **Après-midi doré** | 16:30 | Chaude, dorée, ombres longues, beaucoup de rim light | Le plus beau pour la photo | Session 2 |
| **Coucher** | 19:15 | Orange-rouge, contre-jour, mer en miroir | Vagues plus fortes, oiseaux qui rentrent | Session 3 |
| **Crépuscule bleu** | 20:30 | Bleu profond, lumière diffuse, premières étoiles | Très calme | Session 6 |
| **Nuit** | 23:00 | Lune, sable bleu-argent, écume qui brille | Vagues, grillons, chouette. **Plancton bioluminescent** dans l'eau. | Session 8 |
| **Nuit étoilée** | 02:00 | Voie lactée visible, pas de lune | Silence quasi total | Session 12 |

| Météo | Effet sur le gameplay | Effet visuel |
|---|---|---|
| **Clair** | Évaporation normale | Ombres nettes |
| **Voilé** | Évaporation ×0,6 | Lumière douce, idéale pour sculpter |
| **Brume matinale** | Évaporation ×0,3, humidité ambiante ×1,4 (le sable reste humide tout seul) | Fog dense, superbe, portée réduite |
| **Vent d'ouest** | **Érosion éolienne** : le sable sec est emporté, les surfaces sèches se creusent lentement. Le fixatif devient utile. | Voiles de sable au sol, drapeaux qui claquent |
| **Averse** | `w += 0,02/s` partout. Peut saturer une structure ! Les flaques se forment. | Pluie, ondes sur l'eau, sable qui fonce |
| **Après-pluie** | Humidité parfaite partout, `w ≈ 0,25` — **le meilleur moment pour bâtir**. Dure 6 min. | Ciel dégagé, arc-en-ciel possible, sable brillant, air lavé |

Le cycle avance en temps réel (1 h de jeu = 6 min réelles) OU est verrouillé sur le moment choisi (option par défaut : **verrouillé**, parce que le cozy n'aime pas être bousculé).

### 6.6 La marée en détail

| Phase | Durée (défaut) | Niveau | Comportement |
|---|---|---|---|
| **Marée basse** | 12 min | −0,45 m | Le sable est nu sur 12 m. Flaques résiduelles. Zone de construction maximale. |
| **Montante lente** | 8 min | −0,45 → −0,15 m | L'eau avance de ~4 m. Vagues qui portent plus loin. La nappe monte → le sable en profondeur devient plus humide (bonus). |
| **Montante rapide** | 5 min | −0,15 → +0,20 m | Les vagues atteignent les douves. Érosion active des bases. |
| **Marée haute** | 6 min | +0,20 m | Presque toute la plage est sous l'eau. Seules les structures hautes émergent. Le spectacle de l'érosion. |
| **Descendante** | 9 min | +0,20 → −0,45 m | L'eau se retire. Le sable est lissé, brillant, parfait. **Ce moment est magnifique : plage vierge, miroir, ciel réfléchi.** Il révèle aussi les coquillages apportés par la mer. |

Cycle complet : **40 min**. Réglable : 20 / 40 / 90 min / infini (désactivée).

**Érosion pendant la marée :**
- Chaque vague est un événement d'eau qui pousse : `waterVel` élevée sur un front qui avance.
- Le sable dont `cohesion_effective` est inférieure au cisaillement local passe dans `sediment[]`.
- Le sédiment est transporté et redéposé quand la vitesse tombe → **des bancs de sable se forment naturellement**, et les douves se comblent partiellement.
- Le sable fixé (fixatif) résiste 4× plus longtemps.
- Les structures perdent d'abord leur **base** → elles s'affaissent d'un bloc, ce qui est bien plus beau que de fondre par le haut.
- Les décorations flottent et dérivent. Un drapeau peut finir 3 m plus loin, planté dans le sable lissé. C'est charmant et mélancolique.

---

## 7. CONTENU

### 7.1 Décorations et props

#### 7.1.1 Coquillages et trouvailles (posables + collection)

| Item | Rareté | Source |
|---|---|---|
| Coquillage éventail | commune | Ramassage au sol |
| Bigorneau | commune | Ramassage |
| Couteau (coquille) | commune | Creuser |
| Coque striée | commune | Ramassage |
| Moule | commune | Rochers |
| Bulot | peu commune | Creuser |
| Ormeau (nacré) | peu commune | Creuser profond |
| Oursin séché | peu commune | Marée descendante |
| Sable dollar | rare | Marée descendante |
| Nautile | rare | Marée haute |
| Conque géante | rare | Plage tropicale |
| Verre de mer (5 couleurs) | peu commune | Ramassage |
| Ammonite fossile | très rare | Creuser très profond |
| Dent de requin fossile | très rare | Creuser |
| Bouteille à message | très rare | Apportée par la marée |
| Pièce ancienne | très rare | Creuser |
| Clé rouillée | très rare | Creuser |
| Bille de verre | rare | Creuser |

#### 7.1.2 Drapeaux et fanions

Petit drapeau triangulaire, fanion long, banderole, guirlande de fanions (posée entre deux points), girouette, moulin à vent en papier (qui tourne avec le vent), manche à air. 12 motifs de tissu, 8 couleurs. **Tous les drapeaux réagissent au vent** (simulation de tissu simple, 3 segments).

#### 7.1.3 Props de plage

Seau et pelle abandonnés, tongs, serviette pliée, parasol (ouvert ou fermé), chaise longue, panier de pique-nique, glacière, ballon, bouée, épuisette, cerf-volant (qui vole vraiment, attaché au sol), radio portable (joue une station lointaine — un vrai stem musical alternatif !), lunettes de soleil, chapeau de paille, livre ouvert posé face contre sable, appareil photo argentique, boîte de peinture, tasse émaillée, lanterne, guirlande lumineuse (s'allume la nuit), feu de camp (avec vraie lumière et fumée), planche de surf plantée, rame, ancre, filet de pêche, casier à homard, bouée de balisage, bidon, caisse en bois, bois flotté (7 formes).

#### 7.1.4 Végétation

Oyat (herbe de dune, ondule au vent), chardon des dunes, criste marine, salicorne, algue échouée (3 types), varech, plante grasse, palmier nain (plage tropicale), pin maritime (silhouette lointaine), fleur de dune (rose), liseron des sables, mousse sur rocher, roseau, bambou.

Toutes les plantes ont **une animation de vent** synchronisée sur le vecteur de vent global. Coût : un vertex shader partagé.

#### 7.1.5 Rochers et minéraux

Galet (12 formes, 4 teintes), gros rocher, rocher couvert de balanes, ardoise plate, silex, quartz blanc, roche volcanique (plage noire), corail mort (tropical), banc de rochers (grande pièce paysagère).

#### 7.1.6 Créatures

Toutes les créatures sont **autonomes, non interactives obligatoirement, et jamais menaçantes**. Elles réagissent au joueur (elles s'écartent) mais on ne peut pas les blesser.

| Créature | Comportement | Interaction |
|---|---|---|
| **Crabe** | Court latéralement, creuse un petit trou, s'y cache si on approche. Laisse des traces dans le sable. | Peut « emménager » dans un trou creusé par le joueur. Si on lui creuse un beau terrier, il reste. |
| **Bernard-l'ermite** | Marche lentement, cherche des coquillages. **Si le joueur pose un coquillage vide, il peut venir l'essayer et changer de maison.** Le meilleur micro-moment du jeu. | Poser des coquillages |
| **Mouette** | Se pose, marche, picore, s'envole. Se pose volontiers sur les points hauts des châteaux (**et elle choisit toujours le point le plus haut** — récompense implicite de la construction en hauteur). Peut voler une décoration et la déposer ailleurs. | Regarder |
| **Sterne** | Vole en piqué au-dessus de l'eau | — |
| **Échassier (bécasseau)** | Court au bord de l'eau en suivant le va-et-vient des vagues. Extrêmement charmant. | — |
| **Petit poisson** | Dans les flaques et les canaux. Suit le courant. | Creuser un canal les fait entrer |
| **Étoile de mer** | Immobile, dans les flaques | Ramassable |
| **Méduse échouée** | Immobile, translucide, brille la nuit | — |
| **Anémone** | Dans les flaques de rocher, se rétracte au toucher | Toucher |
| **Papillon** | Sur les fleurs de dune | — |
| **Libellule** | Au-dessus de l'eau douce | — |
| **Ver de sable** | Laisse des tortillons caractéristiques dans le sable mouillé | Détail décoratif automatique |
| **Chien** | Passe très rarement (1 session sur 6), court, renifle, et **peut marcher sur le château** (dégâts minimes, réversibles, et surtout : c'est drôle). On peut lui lancer un bâton. | Lancer un bâton |
| **Enfant PNJ** | Rare. Regarde le château, applaudit, laisse un coquillage en cadeau. | Commandes (défi) |
| **Vieux sculpteur PNJ** | Très rare. Laisse une petite démonstration sculptée. | Observer |

#### 7.1.7 Éléments d'eau

Bulles, écume, méduses flottantes, reflets, plancton bioluminescent (nuit), traînée de sillage.

### 7.2 Lieux / plages déblocables

| # | Plage | Déblocage | Particularités de gameplay | Look |
|---|---|---|---|---|
| 1 | **Plage du Matin** | Départ | Sable fin classique, humidité équilibrée, marée douce. La plage-tutoriel et le foyer. | Sable clair doré, dunes basses, oyats, ciel dégagé |
| 2 | **Crique aux Galets** | 3 marées | Sable mêlé de galets (le `material` GALET ne se sculpte pas mais s'intègre : on peut le déterrer et l'utiliser comme déco). Flaques de rocher permanentes avec anémones. Marée plus violente. | Falaise, rochers, bois flotté, ciel gris-bleu |
| 3 | **Lagon Turquoise** | 6 marées | Eau très claire et peu profonde, sable corallien très blanc et très fin (cohésion plus faible : plus dur à bâtir !), marée quasi nulle. Palmiers. | Turquoise saturé, blanc, palmiers |
| 4 | **Plage Noire** | 10 marées | Sable volcanique noir, dense, **très cohésif** (on peut faire des structures folles), mais il chauffe au soleil → évaporation ×2. Contraste visuel superbe avec l'écume blanche. | Noir, gris, vert de la végétation, ciel dramatique |
| 5 | **Dune du Nord** | 14 marées | Vent permanent → érosion éolienne constante. Il faut bâtir à l'abri, ou fixer. Sable très sec en surface, très humide à 30 cm. Grandes dunes en fond. | Beige pâle, ciel immense, oyats, lumière rasante |
| 6 | **Plage aux Coquillages** | 18 marées | Sable composé de débris de coquillages — texture unique, éclats nacrés. Trouvailles ×3. Beaucoup de bernard-l'ermite. | Rose pâle, nacré, chaud |
| 7 | **Estuaire** | 22 marées | Une rivière traverse la plage : de l'eau douce permanente, des canaux naturels, de la vase (`material` VASE, très cohésive mais moche à sculpter, excellente en fondations). Marée forte et bidirectionnelle. | Vert-gris, roseaux, brume, oiseaux |
| 8 | **Plage Urbaine** | 26 marées | Une plage de ville : lampadaires, un ponton de bois, des graffitis sur le mur du fond, des gens en fond. Le soir, guirlandes lumineuses. | Coucher de soleil urbain, néons doux |
| 9 | **Baie du Bout du Monde** | 32 marées | Sable presque blanc, aurores boréales possibles la nuit, eau très froide (le sable reste humide longtemps : `evaporation ×0,3`, c'est la plage la plus « facile » et la plus contemplative). | Bleu glacé, aurores, silence |

**Chaque plage définit :** un `material` de base et sa courbe de cohésion, une amplitude de marée, un profil de vent, une palette de lumière, un skybox, un set de props d'environnement, un thème musical, et un set de créatures.

**Ré-jouabilité :** chaque plage a une **seed** de génération pour le relief initial (dunes, rochers, flaques). Bouton « Nouvelle plage » pour re-générer.

### 7.3 Boutique — La Cabane

Une petite cabane de plage en bois délavé, posée en bord de scène. On clique, la porte s'ouvre, et on entre dans une vue rapprochée : des étagères en 3D avec les objets **posés dessus**, pas une grille de tuiles.

Catégories : Décorations · Drapeaux · Plantes · Seaux et formes · Tampons · Gabarits · Cadres photo · Filtres photo.

Aucun achat n'affecte la capacité de créer. Prix de 5 à 60 coquillages. Pas de monnaie premium. Pas de loot box. Pas de timer.

### 7.4 Mode photo

Déclenché par `P`. Toute l'UI disparaît, remplacée par une interface photo minimale en bas.

| Contrôle | Fonction |
|---|---|
| **Caméra libre** | Le pivot est libéré (dans une bulle de 15 m). WASD + molette. Le roll est débloqué (`Q`/`E`). |
| **Focale** | 18 mm → 200 mm. Une longue focale écrase la perspective : c'est le secret du look maquette. |
| **Ouverture** | f/1.4 → f/16 → contrôle direct du bokeh |
| **Mise au point** | Clic sur un point de la scène, ou curseur manuel. Un indicateur de plan de netteté s'affiche. |
| **Exposition** | ±2 EV |
| **Heure du jour** | Une roue permet de changer l'heure **sans quitter le mode photo** — on cherche sa lumière. |
| **Grille de composition** | Off / Tiers / Nombre d'or / Diagonales |
| **Horizon** | Niveau à bulle qui indique si l'horizon est droit, avec un bouton « redresser » |
| **Filtres** | 12 presets : Naturel, Argentique, Polaroid, Noir & blanc, Sépia, Été 1978, Contre-jour, Aquarelle, Carte postale, Miniature (tilt-shift accentué), Nocturne, Rêve |
| **Cadres** | 8 cadres : aucun, polaroid, carte postale, page de carnet, film 35 mm, bord déchiré, aquarelle, cadre coquillages |
| **Légende** | Le joueur peut écrire un titre manuscrit sur la photo (police manuscrite) |
| **Masquer** | Toggle : décorations, créatures, eau, UI |
| **Ralenti** | Pendant l'érosion, un curseur de vitesse 0,1× → 1× pour capturer le bon instant |
| **Capture** | Barre d'espace. Son de déclencheur. Rendu en 2× la résolution d'écran (jusqu'à 4K). |

**Partage :**
- La photo va dans l'**Album** (IndexedDB, format WebP, plus une miniature).
- Bouton « Télécharger » (PNG).
- Bouton « Copier » (presse-papiers).
- Bouton « Partager » (Web Share API sur mobile).
- **Watermark discret** optionnel : un petit coquillage + le nom du lieu, en bas à droite.
- **Export du modèle 3D** (v3) : `.glb` du château, pour l'impression 3D ou Sketchfab. Le geste ultime contre l'éphémère.
- **Cartes postales** (v3) : le jeu compose automatiquement une carte postale (photo + nom du lieu en lettrage vintage + une bordure), partageable en un clic.

**Photo automatique :** le jeu prend discrètement une photo de « meilleur angle » toutes les 5 minutes et à T-1 min avant la marée haute. Elles vont dans un dossier « Souvenirs » de l'Album. Le joueur qui a oublié de photographier son château n'a rien perdu. **C'est une des features les plus importantes du pilier 4.**

**Timelapse** (v2) : le jeu enregistre en continu une image toutes les 4 s (au format vidéo léger). À la fin de la session, il propose un timelapse de 15 s montrant la construction puis la dissolution. C'est le meilleur objet de partage possible pour ce jeu.

---

## 8. PLAN DE PRODUCTION PRIORISÉ

### 8.1 MVP — v1 jouable

**Objectif du MVP :** un joueur ouvre l'URL, et 90 secondes plus tard il a construit une tour de sable qu'il trouve jolie, puis la mer la reprend et il a une photo. Rien de plus, mais ça, parfaitement.

**Critère de sortie :** un testeur non prévenu joue 12 minutes sans qu'on lui explique rien, et sourit au moins une fois.

#### Lot 1 — Fondations techniques (semaines 1–3)

1. **Scène Three.js de base** : caméra orbitale contrainte (§4.2), lumière directionnelle + ambiante HDRI, sol de test, post-process minimal (tone mapping ACES).
2. **Grille de voxels** 240 × 240 × 64, SoA en `Uint8Array` (`density`, `moisture`, `compaction`, `material`), découpée en 128 chunks de 32³.
3. **Meshing par Surface Nets** (préférer à Marching Cubes : moins de triangles, meilleures arêtes), par chunk, avec un worker pool (4 workers). Remesh incrémental : seuls les chunks marqués `dirty` sont recalculés.
4. **Boucle de simulation** à 20 Hz, budget dur de 4 ms/frame, avec file de priorité des chunks à traiter.
5. **Raycast sur voxels** (DDA) pour le curseur, avec raffinement sur l'isosurface.
6. **Sauvegarde IndexedDB** : sérialisation compressée (RLE sur `density`, quantification sur `moisture`).

#### Lot 2 — La matière (semaines 3–6)

7. **Système de brosse générique** (§3.0.2) avec falloff, pressure, 3 modes de placement.
8. **Champ d'humidité** : diffusion, évaporation, capillarité depuis la nappe (§0.4).
9. **Cohésion et angle de repos** : `cohesion(w, φ)` (§0.2).
10. **Avalanche / relaxation** : chaque tick, les colonnes dont la pente locale dépasse `angle_repos` transfèrent de la matière vers le bas. Algorithme itératif sur les chunks dirty, 3 itérations max par tick.
11. **Shader de sable** : albedo/roughness/spéculaire pilotés par `moisture`, teinte pilotée par `compaction`, normal map de détail, AO local, rim light. **C'est le shader le plus important du projet — lui consacrer une semaine entière.**
12. **Conservation de la matière** (§3.0.3) avec les politiques `PILE_ADJACENT` et `PILE_LOCAL`.

#### Lot 3 — Les 4 outils de départ (semaines 6–8)

13. **Pelle** (creuser, rejeter, reboucher, révélation de l'humidité de profondeur).
14. **Main** (tapoter → compaction, lisser). Avec le rythme à 5 Hz et le rebond.
15. **Arrosoir** (humidifier, diffusion, sur-saturation visible).
16. **Seau** (remplir / tasser / démouler, avec le score `Q` et les 4 résultats).
17. **Undo global** (Ctrl+Z, 80 niveaux, snapshots delta par chunk).
18. **Gomme** (rembobinage local).

#### Lot 4 — L'eau (semaines 8–10)

19. **Shallow water 2D** sur la grille 240 × 240 : hauteur + vitesse, schéma semi-lagrangien stable, 20 Hz. Couplage avec la hauteur du terrain.
20. **Nappe phréatique** : l'eau sourd quand on creuse en dessous.
21. **Rendu de l'eau** : surface avec réflexion (cubemap + SSR simplifié), réfraction approximée, écume aux bords, normal map animée.
22. **Marée** : `seaLevel` animé sur le cycle de 40 min, avec des vagues procédurales qui déferlent sur la pente.
23. **Érosion de base** : le sable dont la cohésion est inférieure au cisaillement de l'eau passe dans `sediment[]`, transporté et redéposé.

#### Lot 5 — UI et feel (semaines 10–13)

24. **Barre d'outils ronde** en bas au centre, avec les 4 outils + slot « plus ». Icônes dessinées.
25. **Panneau Sable** à gauche (3 jauges + stabilité).
26. **Badge de lieu** en haut au centre, avec l'indicateur de marée diégétique.
27. **Boutons ronds** en haut à droite (météo/heure, photo, menu — profil et boutique en v2).
28. **Badge de coquillages** en bas à gauche.
29. **Pastille d'humidité** au curseur + anneau de rayon + prévisualisation fantôme.
30. **Système audio** : 60 sons essentiels (les banques sable, main, seau, arrosoir, eau, vagues, mouettes, UI), avec la modulation par `w` et par la vitesse.
31. **Particules** : grains, poussière, éclaboussures (3 systèmes instanciés, un pool chacun).
32. **Post-process** : DOF, bloom doux, vignettage chaud, grain.
33. **Auto-fade de l'UI** (§5.4).

#### Lot 6 — Boucle complète (semaines 13–15)

34. **Onboarding** : la main fantôme, les 6 mots, les 8 étapes (§5.5).
35. **Mode photo** (version réduite : caméra libre, focale, ouverture, 4 filtres, capture, téléchargement).
36. **Album** local (IndexedDB).
37. **Photo automatique** avant la marée haute.
38. **Cycle de session complet** : plage vierge → construction → marée → érosion → photo → nouvelle marée.
39. **Une plage** (Plage du Matin) avec **trois moments** (matin, après-midi doré, coucher).
40. **Options minimales** : volume, échelle d'UI, mode sans marée, réduction de mouvement, inverser molette/zoom.

**Récapitulatif MVP — outils inclus (dans l'ordre d'implémentation) :**

| Ordre | Outil | Pourquoi maintenant |
|---|---|---|
| 1 | **Pelle** | Sans elle il n'y a pas de jeu |
| 2 | **Main (tapoter/lisser)** | La compaction est la moitié de la physique |
| 3 | **Arrosoir** | L'humidité est le paramètre héros |
| 4 | **Seau** | Le premier « wow », le premier château |
| 5 | **Gomme / Undo** | La sécurité psychologique, pilier 2 |
| 6 | **Décorations (3 items)** | Le drapeau au sommet, c'est ce qui fait dire « c'est fini » |
| 7 | **Truelle** | La seule extension d'outil du MVP — parce que sans elle tout est arrondi et le résultat n'est pas photogénique |

**Hors MVP explicitement :** coffrages, mirette, râteau, souffleur, pinceau, tampons, drip castle, canal, symétrie, fixatif, gabarits, boutique, autres plages, défis, PNJ, créatures (sauf mouettes), timelapse, tactile, manette.

### 8.2 v2 — La profondeur (3–4 mois après la v1)

Ordre de priorité décroissante :

1. **Outils de sculpture fine** : mirette (avec arches et fenêtres), râteau (7 motifs), souffleur, pinceau. → C'est ce qui transforme des tas en châteaux.
2. **Coffrages / pound-up** avec les couches visibles. → C'est ce qui permet les grandes structures.
3. **Tampons** (les 6 premiers : créneaux, marches, arcade, meurtrière, tuiles, chemin de ronde). → C'est ce qui rend un château « lisible comme un château » en 30 secondes.
4. **Symétrie** (miroir + radiale). → Multiplicateur de qualité par 2 à 8.
5. **Plan de travail (`Tab`) et vue de dessus (`T`)** avec le traceur. → Résout la frustration ergonomique n° 1.
6. **Système de stabilité complet** : analyse structurelle par colonnes, jauge, hachurage, effondrements progressifs et beaux.
7. **Outil canal** + couplage complet marée/canaux.
8. **Trois plages supplémentaires** : Crique aux Galets, Lagon Turquoise, Plage Noire.
9. **Cycle jour/nuit complet** (8 moments) + **météo** (6 types) avec l'érosion éolienne.
10. **Progression** : déblocage d'outils par l'usage, Carnet de plage, coquillages, La Cabane, 40 décorations.
11. **Créatures** : crabe, bernard-l'ermite (avec l'interaction coquillage), mouette qui se pose sur le point le plus haut, bécasseau.
12. **Défis cozy** : marée montante, commande de PNJ, photo du jour.
13. **Mode photo complet** : tous les filtres, cadres, grilles, légendes, tilt-shift.
14. **Timelapse** de session.
15. **Tactile** (tablette) et **manette**.
16. **Accessibilité complète** : palettes daltoniens, mode toggle, remapping, sous-titres sonores, contraste renforcé.
17. **Drip castle** et **fixatif**.
18. **Optimisation** : LOD sur les chunks lointains, WebGPU en option, réduction du budget mémoire.

### 8.3 v3 — L'ampleur (6–12 mois)

1. **Les 5 dernières plages** : Dune du Nord, Plage aux Coquillages, Estuaire, Plage Urbaine, Baie du Bout du Monde.
2. **Concours de plage** (défi avec châteaux PNJ et jury de mouettes).
3. **Sable coloré** (poudre à saupoudrer au pinceau), gravure, incrustations de coquillages en mosaïque.
4. **Gabarits complets** : ficelle, compas, équerre, niveau, pochoirs (12 formes).
5. **Export `.glb`** du château + cartes postales composées.
6. **Galerie partagée** : publier une photo ou un `.glb`, voir ceux des autres, « visiter » un château (chargement du modèle dans sa propre plage). Modération : uniquement des modèles 3D et des titres courts, pas de texte libre.
7. **Éditeur de tampons** : le joueur sculpte une forme et la sauvegarde comme tampon réutilisable. Partageable.
8. **Événements saisonniers doux** : marée d'équinoxe (amplitude ×1,5), lune de sang, migration d'oiseaux, plage enneigée en décembre.
9. **Mode « Deux mains »** : coopération locale sur la même plage (WebRTC), deux curseurs.
10. **Musique générative** : les stems s'adaptent finement au geste (le tapotement rythme la percussion).
11. **Sculpture avancée** : sable coloré en strates, structures suspendues avec armature de bois flotté, ponts.
12. **Mode Zen** : pas d'UI du tout, pas de progression, juste du sable et le temps.

### 8.4 Risques et parades

| Risque | Probabilité | Parade |
|---|---|---|
| **La simulation ne tient pas 60 fps** | Élevée | Budget dur de 4 ms/tick avec file de priorité ; simulation à 20 Hz (pas 60) ; remesh incrémental ; workers ; profiler dès la semaine 2, pas à la fin |
| **La sculpture à la souris frustre** | Élevée | Les 7 solutions du §4.3 ; playtest ergonomique dès le lot 3 (avant même l'eau) |
| **Le sable n'est pas beau** | Moyenne | Consacrer une semaine entière au shader de sable au lot 2 ; faire des cibles de rendu en amont (moodboard + rendu Blender de référence) |
| **La marée est vécue comme punitive** | Moyenne | Photo automatique ; bouton « Retenir la mer » très visible ; érosion mise en scène comme un spectacle ; playtest spécifique sur ce point |
| **Le jeu est trop vide au bout de 20 min** | Moyenne | Les tampons et les coffrages sont le remède : ils élèvent le plafond de complexité. Les prioriser en v2. |
| **Mémoire navigateur** | Moyenne | 14,7 Mo de voxels + textures ; surveiller le total sous 250 Mo ; pas de fuite de `BufferGeometry` (dispose systématique) |
| **Safari / iOS** | Moyenne | Tester dès le lot 1 ; fallback audio AAC ; pas de `SharedArrayBuffer` obligatoire (chemin de repli sans workers partagés) |
| **Scope creep sur les outils** | Élevée | Le MVP est verrouillé à 7 outils. Toute demande d'outil supplémentaire va en v2, sans discussion. |

### 8.5 Jalons et démos

| Jalon | Semaine | Ce qu'on doit pouvoir montrer |
|---|---|---|
| **J1 — Le trou** | 4 | Creuser un trou dans du sable qui s'écroule, avec du son. 20 s de vidéo. |
| **J2 — L'humidité** | 7 | Arroser, voir le sable foncer, tasser, faire tenir un mur vertical. **C'est le jalon qui valide ou tue le projet.** |
| **J3 — Le château** | 9 | Démouler un seau, empiler deux tours, planter un drapeau. |
| **J4 — La mer** | 11 | Le château s'érode et disparaît sous la marée. |
| **J5 — Le jeu** | 15 | Boucle complète, onboarding, photo. Playtest externe sur 10 personnes. |
| **J6 — La v1** | 17 | Polish, options, perf, mise en ligne. |

---

## 9. ANNEXES TECHNIQUES

### 9.1 Budget de performance

| Poste | Budget | Note |
|---|---|---|
| Frame total | 16,6 ms | 60 fps |
| Rendu (draw calls) | ≤ 90 | Terrain : 128 chunks, mais frustum-cullés → ~40 visibles. Décos : `InstancedMesh` par type. Particules : 3 draw calls. |
| Simulation (main thread) | ≤ 4 ms | Tick à 20 Hz, donc ~1,3 ms/frame moyen |
| Meshing | 0 ms main thread | Entièrement en workers, résultats transférés en `Transferable` |
| Post-process | ≤ 3 ms | Une seule passe combinée |
| Mémoire GPU | ≤ 180 Mo | Textures 2K max, compression BasisU |
| Mémoire JS | ≤ 250 Mo | 14,7 Mo de voxels, le reste en geometry + audio |
| Taille du build | ≤ 8 Mo gzip | Three.js tree-shaké, audio en lazy-load par plage |
| Temps de chargement | ≤ 4 s | Première image jouable ; le reste (audio, décos) en arrière-plan |

### 9.2 Architecture de simulation (ordre d'un tick à 20 Hz)

```
1. INPUT       — appliquer les brosses accumulées depuis le dernier tick
2. AVALANCHE   — relaxation d'angle de repos sur les chunks dirty (3 itérations max)
3. STABILITÉ   — analyse par colonnes : contrainte verticale vs cohésion ; marquer les effondrements
4. EFFONDREMENT— convertir les voxels marqués en matière qui tombe (mise à jour + particules)
5. HUMIDITÉ    — diffusion, évaporation, capillarité depuis la nappe
6. EAU         — shallow water : advection, hauteur, vitesse, débordements
7. ÉROSION     — cisaillement > cohésion → sediment ; transport ; dépôt
8. MARÉE       — mise à jour de seaLevel, génération des vagues
9. DIRTY       — collecter les chunks modifiés, les envoyer au pool de meshing
```

Chaque étape a un **budget en microsecondes**. Si le budget total est dépassé, les étapes 5–7 sont exécutées sur la moitié de la grille (alternance pair/impair), jamais sautées.

### 9.3 Système d'undo

- Un « stroke » = du `pointerdown` au `pointerup`.
- Avant modification, chaque chunk touché est **copié** dans un buffer (les 4 canaux). On stocke un delta compressé (les indices modifiés + les anciennes valeurs) plutôt que le chunk entier quand moins de 15 % du chunk est touché.
- Historique : 80 strokes, plafonné à 60 Mo. Au-delà, les plus anciens sont fusionnés puis supprimés.
- La **gomme temporelle** utilise le même historique, mais reconstruit un état local en rejouant les deltas à l'envers uniquement sur les voxels sous la brosse.

### 9.4 Modèle de stabilité (simplifié mais suffisant)

Pour chaque colonne `(x, z)`, de haut en bas :
```
charge[y] = charge[y+1] + density[y] * poids_voxel
resistance[y] = cohesion_effective(w[y], φ[y]) * surface_portante[y]
si charge[y] > resistance[y] * MARGE  →  la colonne s'effondre à partir de y
```
`surface_portante` compte les voisins solides dans le plan horizontal (une colonne isolée est plus fragile qu'un mur épais).

Pour les **surplombs**, un second passage : un voxel sans support en dessous ne tient que si le nombre de voisins latéraux solides et cohésifs dépasse un seuil (approximation de la traction). C'est ce qui permet les arches — et ce qui les fait tomber si elles sont trop sèches.

Fréquence : l'analyse complète tourne sur 1/8 de la grille par tick (donc 2,5 fois par seconde pour l'ensemble), sauf sur les chunks récemment modifiés qui sont analysés immédiatement.

### 9.5 Ce qu'il faut prototyper en premier, avant tout le reste

Trois prototypes jetables, une semaine chacun, avant d'écrire une ligne du vrai jeu :

1. **Proto « angle de repos »** — un tas de sable, un curseur qui en ajoute et en retire, un slider d'humidité. But : valider que la relaxation d'avalanche est stable, rapide, et *jolie*.
2. **Proto « shader mouillé »** — une sphère de sable, un slider d'humidité, un HDRI. But : valider que le passage sec→mouillé est visuellement spectaculaire. Si ce proto n'est pas beau, le jeu ne le sera pas.
3. **Proto « flop »** — un seul son de tapotement, modulé par 3 paramètres, joué en boucle sur une déformation. But : valider le feel tactile de base.

Si ces trois prototypes sont bons, le jeu est bon. S'ils ne le sont pas, aucune quantité de contenu ne sauvera le projet.

---

## SOURCES DE RECHERCHE

- [Cozy Games — Lostgarden](https://lostgarden.com/2018/01/24/cozy-games/)
- [Designing for Coziness — Kitfox Games](https://medium.com/kitfox-games/designing-for-coziness-d33d2519a59e)
- [Using Coziness in Game Design — 80.lv](https://80.lv/articles/using-coziness-in-game-design)
- [Coziness in Games: Second Homes, Audiences, and Esthetics](https://journals.sagepub.com/doi/10.1177/15554120241310920)
- [Radial Menus in Game Design — 300mind](https://300mind.studio/blog/radial-menus-in-game-design/)
- [The power of the radial menu — UX Collective](https://uxdesign.cc/the-power-of-the-radial-menu-a-love-letter-to-apex-legends-from-a-ux-designer-and-perpetual-noob-1bec9b05e805)
- [The Brush — Blender Manual](https://docs.blender.org/manual/en/3.5/sculpt_paint/sculpting/introduction/brush.html)
- [Terrain Sculpting Tool for Blender](https://github.com/blackears/blenderTerrainSculpt)
- [How to terraform in Cities Skylines 2](https://www.ggrecon.com/guides/cities-skylines-2-how-to-terraform/)
- [Juice in Game Design — Blood Moon Interactive](https://www.bloodmooninteractive.com/articles/juice.html)
- [The "Juice" Problem — Wayline](https://www.wayline.io/blog/the-juice-problem-how-exaggerated-feedback-is-harming-game-design)
- [Beyond the HUD: Diegetic Interfaces — Wayline](https://www.wayline.io/blog/diegetic-interfaces-game-design)
- [Types of UI in Gaming: Diegetic, Non-Diegetic, Spatial and Meta](https://medium.com/@lorenzoardeni/types-of-ui-in-gaming-diegetic-non-diegetic-spatial-and-meta-5024ce6362d0)
- [Tide Level — TV Tropes](https://tvtropes.org/pmwiki/pmwiki.php/Main/TideLevel)
- [Photo Mode — TV Tropes](https://tvtropes.org/pmwiki/pmwiki.php/Main/PhotoMode)
- [Sandcastle Engineering — Scientific American](https://www.scientificamerican.com/article/sandcastle-engineering-a-geotechnical-engineer-explains-how-water-air-and-sand-create-solid-structures/)
- [How to Build a Sandcastle — Smithsonian](https://www.smithsonianmag.com/travel/how-build-sandcastle-180975406/)
- [Sand Sculpting 101 — Broken Glass Sand Sculptures](https://www.bgsandsculptures.com/sand-sculpting-101)
- [Angle of Repose — Engineering LibreTexts](https://eng.libretexts.org/Bookshelves/Materials_Science/TLP_Library_I/33:_Granular_Materials/33.4:_Angle_of_Repose)
- [Wet Granular Materials (arXiv)](https://arxiv.org/pdf/cond-mat/0601660)
- [Tutorial UX: Your Indie Game's Onboarding Roadmap — Wayline](https://www.wayline.io/blog/tutorial-ux-indie-game-onboarding)
- [Cloud Gardens — Game Developer](https://gamedeveloper.com/design/Getting-tangled-up-in-the-beautiful-landscapes-of-Cloud-Gardens)
- [Build mode (The Sims 4) — The Sims Wiki](https://sims.fandom.com/wiki/Build_mode_(The_Sims_4))
- [Maximize Performance with WebGL in Three.js Apps — MoldStud](https://moldstud.com/articles/p-maximize-performance-with-webgl-in-threejs-apps)
- [Video Game Accessibility — TestDevLab](https://www.testdevlab.com/blog/video-game-accessibility-testing)

---

*Fin du document. Version 1.0.*
