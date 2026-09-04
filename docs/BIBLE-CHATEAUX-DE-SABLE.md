# LA BIBLE DES CHÂTEAUX DE SABLE
## Document de référence exhaustif pour un jeu vidéo de construction de château de sable ultra-réaliste

> **Statut** : document de référence interne (design bible).
> **Public** : game designers, programmeurs gameplay/physique, artistes 3D, sound designers.
> **Niveau visé** : compétiteur international (World Championship of Sand Sculpting, Master Sand Sculptor).
> **Version** : 1.0
> **Langue** : français, avec la terminologie anglaise d'origine systématiquement donnée (c'est la langue de travail du milieu).

---

## SOMMAIRE

1. [Les bases physiques du sable](#1-les-bases-physiques-du-sable)
2. [Les techniques de construction](#2-les-techniques-de-construction)
3. [Les outils](#3-les-outils)
4. [Vocabulaire et glossaire FR/EN](#4-vocabulaire-et-glossaire-fren)
5. [Les erreurs classiques et les pièges](#5-les-erreurs-classiques-et-les-pièges)
6. [Progression / rituel d'un build complet](#6-progression--rituel-dun-build-complet)
7. [Implications pour le gameplay](#7-implications-pour-le-gameplay)
8. [Sources](#8-sources)

---

# 1. LES BASES PHYSIQUES DU SABLE

## 1.0 Le principe fondamental en une phrase

> **Un château de sable ne tient pas parce que le sable est mouillé. Il tient parce que de minuscules ponts d'eau (ponts capillaires) tirent les grains les uns contre les autres, et parce que la compaction a préalablement imbriqué ces grains dans une géométrie qui ne peut plus se réarranger.**

L'eau n'est **pas** une colle. C'est une erreur de vulgarisation qui traîne partout. L'eau ne colle rien : elle crée une **dépression capillaire** (pression négative) à l'intérieur de chaque ménisque, et c'est la pression atmosphérique qui, de l'extérieur, presse les grains ensemble. Enlevez l'eau : le sable retombe en poudre. Mettez-en trop : les ponts fusionnent, la dépression disparaît, la cohésion s'effondre.

C'est le triptyque à retenir pour toute simulation :

| Facteur | Rôle | Ce qui arrive si on l'oublie |
|---|---|---|
| **Eau** (teneur en eau) | crée la cohésion capillaire | sable sec = tas conique inerte ; sable saturé = boue qui flue |
| **Compaction** (densité relative) | crée l'imbrication mécanique, réduit les vides | le bloc s'affaisse sous son propre poids, cisaillement |
| **Granulométrie / forme des grains** | détermine la friction interne et le nombre de contacts | grains ronds = billes qui roulent ; grains anguleux = grains qui s'accrochent |

---

## 1.1 Les types de sable

### 1.1.1 Classification par origine minéralogique

| Type | Composition dominante | Densité des grains (g/cm³) | Forme typique | Aptitude à la sculpture | Où on le trouve |
|---|---|---|---|---|---|
| **Sable siliceux (quartz)** | SiO₂ 90–99 % | 2.65 | anguleux (carrière) à sub-arrondi (plage) | ★★★★★ (carrière) / ★★★ (plage) | quasi partout, dunes, rivières, carrières |
| **Sable de carrière / de fosse** (*pit sand, quarry sand*) | quartz + feldspaths + fines | 2.6–2.7 | très anguleux, fraîchement fracturé | ★★★★★ | carrières, sablières |
| **Sable de rivière** (*river sand*) | quartz | 2.65 | arrondi, poli par le transport | ★★ | lits de rivière |
| **Sable de plage océanique battue** | quartz | 2.65 | arrondi à très arrondi | ★★ | côtes exposées à la houle (Atlantique, façades ouest) |
| **Sable de plage abritée / golfe** | quartz fin | 2.65 | sub-anguleux, très fin | ★★★★ | Golfe du Mexique, côte ouest de Floride, South Padre Island |
| **Sable corallien / bioclastique** | CaCO₃ (aragonite, calcite) | 2.7–2.9 | grains irréguliers, poreux, coquilles brisées | ★★★ (poreux = absorbe l'eau, casse net) | tropiques, Caraïbes, Pacifique, Bermudes |
| **Sable volcanique (basaltique)** | basalte, olivine, magnétite | 2.9–3.3 | très anguleux, esquilleux | ★★★★ mais très abrasif, très lourd | Islande, Hawaï, Canaries, Sicile |
| **Sable de gypse** | CaSO₄·2H₂O | 2.3 | plaquettes | ★★★★ (White Sands : se cimente en croûte) | White Sands (Nouveau-Mexique) |
| **Sable de dune éolien** | quartz | 2.65 | très arrondi, très bien trié | ★ (le pire) | dunes intérieures, déserts |
| **Sable de maçonnerie lavé** (*mason sand, "dead sand"*) | quartz lavé | 2.65 | anguleux mais **sans fines** | ★★ (« sable mort ») | négoce de matériaux |
| **« Wash-out sand »** (rejet de lavage de carrière) | quartz + limon + argile | 2.65 | anguleux + fines | ★★★★★ **le graal** | résidus de lavage en carrière |

**Point crucial et contre-intuitif** : le meilleur sable de sculpture est un sable **« sale »**. Le sable de maçonnerie lavé, propre selon les normes du bâtiment, est appelé *dead sand* (« sable mort ») par les sculpteurs : on lui a retiré exactement ce qui fait tenir une sculpture — le limon et l'argile qui viennent se loger dans les interstices et verrouiller les grains anguleux entre eux. Le meilleur sable de compétition est souvent le **rejet de lavage** d'une carrière, c'est-à-dire les fines qu'on a justement retirées du sable « propre ».

### 1.1.2 Granulométrie

Échelle de Wentworth (référence universelle en sédimentologie) :

| Classe | Diamètre (mm) | Phi (φ) | Comportement en sculpture |
|---|---|---|---|
| Argile (*clay*) | < 0.004 | > 8 | liant ; en excès → boue plastique qui craquelle en séchant |
| Limon / silt | 0.004 – 0.0625 | 4 – 8 | **liant idéal** : remplit les vides, augmente la cohésion et la tenue des arêtes |
| Sable très fin | 0.0625 – 0.125 | 3 – 4 | excellent pour le détail fin, sèche vite |
| Sable fin | 0.125 – 0.25 | 2 – 3 | **le standard de la sculpture de compétition** |
| Sable moyen | 0.25 – 0.5 | 1 – 2 | bon, arêtes un peu plus grossières |
| Sable grossier | 0.5 – 1.0 | 0 – 1 | arêtes qui s'émiettent, détail impossible |
| Sable très grossier | 1.0 – 2.0 | −1 – 0 | inutilisable pour le détail |
| Gravier | > 2.0 | < −1 | à tamiser impérativement |

**Règles de granulométrie pour le sculpteur :**

- **Plus fin = meilleur**, jusqu'à une limite : sous ~60 µm on entre dans le limon, qui devient collant et fissure en séchant.
- **Polydispersité > monodispersité.** Un sable dont les grains ont des tailles variées se compacte mieux (les petits grains comblent les vides entre les grands) et forme **plus de ponts capillaires par unité de volume**. Un sable trop bien trié (dune, plage battue) est un empilement de billes de même taille : porosité élevée, peu de contacts, faible résistance.
- **Une pincée de fines (5–10 % de limon/argile) transforme un sable médiocre en bon sable.**
- Cible pratique pour un sable de compétition : **D₅₀ ≈ 0.15–0.30 mm**, coefficient d'uniformité Cu = D₆₀/D₁₀ **entre 3 et 8**, teneur en fines 3–10 %.

### 1.1.3 Angularité contre rondeur : le facteur numéro un

C'est l'analogie canonique du milieu :

> **Empiler des grains ronds, c'est empiler des billes. Empiler des grains anguleux, c'est empiler des blocs de Lego cassés.**

Un grain de sable exposé longtemps aux vagues et au vent est **usé, poli, arrondi**. Un grain fraîchement fracturé en carrière est **esquilleux, anguleux, à arêtes vives**. La différence se lit directement dans l'**angle de friction interne** (φ) :

| État des grains | Angle de friction interne φ (état lâche) | φ (état dense) | Angle de repos sec |
|---|---|---|---|
| Grains très arrondis, bien triés | 27–30° | 30–34° | ~30–32° |
| Grains sub-arrondis | 29–32° | 32–36° | ~32–34° |
| Grains sub-anguleux | 31–34° | 35–40° | ~34–36° |
| Grains très anguleux + fines | 33–36° | 38–45° | ~36–40° |

Conséquence de terrain : une même géométrie (une tour, un surplomb) qui tient parfaitement dans un sable de carrière **s'effondre** dans un sable de dune. Les sculpteurs professionnels **choisissent leur sable avant de choisir leur sujet**, et adaptent le design : sur mauvais sable, on fait des formes pyramidales basses, sans grands surplombs ; sur bon sable, on se permet des arches, des découpes traversantes (*cut-throughs*) et des surplombs spectaculaires.

**Géographie du bon sable (savoir de compétiteur) :**
- Côte ouest de Floride / Golfe du Mexique : peu de houle → grains restés anguleux → excellent.
- South Padre Island (Texas) : référence mondiale.
- Côte est de Floride (Atlantique) : houle constante → grains polis → médiocre.
- Plages de la Manche et de l'Atlantique français : variable, souvent bon car sables fins limoneux d'estuaire.
- Les grandes compétitions **importent** leur sable par camions : le World Championship fait acheminer environ **1,2 million de livres (≈ 545 tonnes)** de sable spécialement sélectionné.

### 1.1.4 Test de terrain : la boule (*the ball test*)

Le test universel, à implémenter tel quel dans le jeu :

1. Prendre une poignée de sable humide.
2. Serrer fort dans le poing, puis ouvrir.
3. **Si la boule tient et garde l'empreinte des doigts nette** → sable exploitable pour la grande sculpture.
4. **Si elle s'émiette** → sable trop sec, trop rond ou trop grossier.
5. **Si elle coule entre les doigts** → sable saturé, bon pour le *drip castle* ou le *hand stacking*, pas pour le *pound-up*.
6. Variante « sphère » : si on peut rouler une **sphère lisse et régulière** entre les paumes sans qu'elle se fissure, la granulométrie et les fines sont bonnes.

---

## 1.2 Le ratio eau/sable

### 1.2.1 Les chiffres, et pourquoi ils se contredisent

Il existe **deux vérités** qui coexistent dans la littérature, et il faut comprendre les deux pour simuler correctement.

| Source | Ratio préconisé | En fraction volumique de liquide | Contexte |
|---|---|---|---|
| Règle populaire / Matthew Bennett (Bournemouth) | **1 volume d'eau pour 8 volumes de sable** | ≈ 12.5 % du volume total de sable, soit ~30 % du volume des pores | **construction** : mélanger, verser, tasser |
| Pakpour, Habibi, Møller & Bonn, *Scientific Reports* 2, 549 (2012) | **~1 % de fraction volumique de liquide** | 1 % | **résistance mécanique maximale mesurée** (module élastique) |
| Rupture / effondrement | > ~15 % du volume du tas, soit ~**35 % du volume poreux** | 15 % | **seuil de perte de tenue** |

**Comment réconcilier :** ce ne sont pas les mêmes grandeurs ni les mêmes moments.

- Le **1:8** est un ratio de **mise en œuvre** : il faut *beaucoup* d'eau pour que le mélange soit **manipulable, homogène, et compactable**. L'eau sert alors de **lubrifiant temporaire** permettant aux grains de glisser les uns sur les autres et de trouver leur position la plus dense sous le tassement. Une fois le tassement fait, **l'eau excédentaire draine par gravité** : elle s'en va, elle percole dans le sol, elle s'évapore.
- Le **1 %** est la teneur en eau **résiduelle** qui donne le module élastique maximal une fois le bloc drainé et stabilisé. C'est l'état du bloc **au moment où on le sculpte**.

> **Modèle mental pour le jeu : on construit mouillé, on sculpte humide, on finit presque sec.**

### 1.2.2 Courbe de résistance en fonction de la teneur en eau

C'est **la courbe centrale** de toute la simulation. La résistance en traction (cohésion apparente) d'un sable non saturé suit une courbe en cloche asymétrique :

```
Cohésion / résistance
    ^
    |                _____
    |              /       \
    |            /           \
    |          /               \___
    |        /                      \___
    |      /                             \___
    |    /                                    \__
    |  /                                         \___
    |/________________________________________________\____> teneur en eau
    0%    1%    5%    10%   15%   20%   25%   30%(saturation)
    |     |           |          |            |
   sec  pic       plateau     décroissance  liquéfaction
        (pendulaire) (funiculaire) (capillaire)  (saturé)
```

| Régime | Teneur en eau (fraction volumique) | Saturation des pores | Nom physique | Comportement | Usage sculpteur |
|---|---|---|---|---|---|
| **Sec** | 0 % | 0 % | — | aucune cohésion, angle de repos 30–34° | inutilisable ; c'est ce qu'on souffle à la paille |
| **Pendulaire** | 0.5 – 3 % | 2 – 10 % | ponts capillaires isolés entre paires de grains | **cohésion maximale**, cassant net, arêtes vives | **état idéal de sculpture** |
| **Funiculaire** | 3 – 15 % | 10 – 35 % | ponts fusionnés en amas, poches d'air | cohésion élevée mais plastique, se déforme | état pendant le *pound-up*, coupe « beurre » |
| **Capillaire** | 15 – 25 % | 35 – 95 % | pores presque tous pleins, air en bulles isolées | cohésion **chute**, matériau mou | trop mouillé pour sculpter |
| **Saturé / boue** | > 25 % | 100 % | plus d'interface air-eau | **cohésion nulle**, se comporte en fluide | *drip castle*, *soup*, mortier de réparation |

**Chiffres à retenir pour l'implémentation :**

| Paramètre | Valeur |
|---|---|
| Teneur en eau optimale (résistance max) | **~1 % vol.** (plage utile : 0.5–3 %) |
| Teneur en eau de mise en œuvre (*pound-up*) | **~10–15 % vol.** (1:8 en volume) |
| Seuil de perte de tenue | **~15 % vol. / 35 % de saturation des pores** |
| Saturation totale (porosité) | 30–40 % du volume total |
| Résistance en traction typique d'un sable fin non saturé au pic | **1 – 6 kPa** |
| Résistance en compression simple d'un bloc bien tassé | **20 – 60 kPa** (ordre de grandeur, monte avec les fines) |
| Résistance en compression du sable sec | **~0 kPa** |

### 1.2.3 « Just wet enough » — la formule de terrain

La formule anglo-saxonne consacrée est **« just wet enough »** : *assez mouillé, pas plus*. Mais les professionnels du *pound-up* disent l'exact inverse au moment du remplissage : **« you can never add too much water — feel free to drown it »** (« vous ne pouvez pas mettre trop d'eau, noyez-le »).

Il n'y a pas de contradiction : ce sont **deux phases distinctes**.

| Phase | Consigne | Teneur en eau visée | Aspect |
|---|---|---|---|
| **Remplissage du coffrage** | noyer, saturer, brasser | 20–30 % (au-delà de la saturation) | quelques centimètres d'eau libre en surface |
| **Tassement** | tasser pendant que ça draine | 15–20 % | l'eau remonte puis disparaît |
| **Attente / drainage** | ne rien faire, attendre que l'eau libre disparaisse | 8–12 % | surface mate, plus d'eau libre |
| **Décoffrage** | retirer le coffrage | 8–12 % | le bloc « tient tout seul » |
| **Sculpture** | brumiser pour maintenir | 2–6 % | coupe nette, « comme du beurre froid » |
| **Finition** | laisser sécher légèrement en surface | 0.5–2 % | arêtes vives, croûte naissante |
| **Conservation** | fixateur dilué | — | croûte protectrice |

**Astuce pro souvent citée** : plus vous mettez d'eau au remplissage, **moins vous devez frapper**. Damon Langlois (champion canadien) le formule ainsi : il utilise énormément d'eau pour ne pas avoir à compacter physiquement autant. L'eau fait le travail de lubrification qui permet aux grains de se réarranger.

**Astuce pro inverse** : sur un sable de carrière glaciaire ou fluvial (grains anguleux + fines), on met **très peu d'eau** — juste assez pour que le sable « fasse des mottes » — et on compense par la **force brute** : talons, dame, passes en spirale.

> **Règle d'or : sable de plage = beaucoup d'eau, peu de force. Sable de carrière = peu d'eau, beaucoup de force.**

---

## 1.3 Ponts capillaires et cohésion : la mécanique fine

### 1.3.1 Le pont capillaire

Entre deux grains en contact (ou quasi-contact), une petite quantité d'eau forme un **ménisque annulaire** — le *capillary bridge* ou *pendular bridge*. Ce ménisque a une **courbure concave**. Par la loi de Young-Laplace :

```
Δp = γ · (1/r₁ + 1/r₂)
```

où γ est la tension superficielle de l'eau (**γ ≈ 72 mN/m à 20 °C**, ~70 mN/m dans la littérature sandcastle) et r₁, r₂ les rayons principaux de courbure. Comme la surface est concave vue de l'eau, **la pression dans le pont est inférieure à la pression atmosphérique**. Résultat : les deux grains sont **aspirés l'un contre l'autre**.

La force d'attraction entre deux sphères de rayon R reliées par un pont s'approxime par :

```
F ≈ 2π · R · γ · cos(θ)
```

où θ est l'angle de contact (≈ 0° pour l'eau sur du quartz propre, donc cos θ ≈ 1).

**Ordre de grandeur** : pour un grain de sable fin, R = 100 µm = 1×10⁻⁴ m :

```
F ≈ 2π × 1e-4 × 0.072 ≈ 4.5 × 10⁻⁵ N ≈ 45 µN
```

Le **poids** de ce même grain (quartz, ρ = 2650 kg/m³, volume = 4/3·π·R³) :

```
m ≈ 2650 × 4.19e-12 ≈ 1.1 × 10⁻⁸ kg  →  P ≈ 1.1 × 10⁻⁷ N
```

**Rapport force capillaire / poids ≈ 400 : 1.**

C'est **le** chiffre à comprendre : à l'échelle du grain de sable fin, la capillarité écrase la gravité de deux ordres de grandeur et demi. C'est exactement pourquoi un château de sable existe. Et c'est aussi pourquoi ça **cesse de marcher** avec du gravier : la force capillaire croît en R, le poids croît en R³. Au-delà de ~2–3 mm de diamètre, le poids gagne — **on ne fait pas de château de sable avec des galets**.

### 1.3.2 Les trois états de saturation

Observés par microtomographie X (travaux de Herminghaus et coll.) :

| État | Description microscopique | Effet macroscopique |
|---|---|---|
| **Pendulaire** (*pendular*) | ponts individuels reliant deux grains ; l'air est continu | cohésion maximale et **quasi indépendante de la teneur en eau exacte** dans une large plage — c'est ce qui rend le sable « pardonnant » |
| **Funiculaire** (*funicular*) | les ponts fusionnent en amas reliant 3, 5, 10 grains ; air et eau tous deux continus | cohésion encore bonne mais matériau plus mou, plus plastique |
| **Capillaire** (*capillary*) | les pores sont pleins, l'air ne subsiste qu'en bulles isolées | il n'y a presque plus d'interfaces air-eau → **la dépression capillaire s'effondre** → cohésion en chute libre |
| **Saturé/suspension** | plus d'interface du tout | cohésion nulle, comportement de fluide (Bingham puis newtonien) |

**Fait remarquable** (et bonne nouvelle pour le game design) : dans l'état pendulaire, la cohésion est **presque plate** en fonction de la teneur en eau. Cela signifie qu'entre 1 % et 5 % d'eau, le sable se comporte à peu près pareil. **Le joueur a une fenêtre confortable**, pas un fil du rasoir. Le drame n'arrive qu'aux deux extrémités.

### 1.3.3 Le sel : le liant secret

L'eau de mer contient ~35 g/L de sels dissous. En séchant, ces sels **cristallisent aux points de contact entre grains** et forment de véritables **ponts solides** (cimentation par halite). C'est un mécanisme totalement différent de la capillarité, et il est **permanent tant qu'il ne pleut pas**.

Conséquences :
- Une sculpture faite à l'eau de mer **durcit en séchant** au lieu de s'effriter — les sculpteurs disent que la sculpture « gets harder with time ».
- Une pluie douce **dissout** ces ponts de sel : la surface redevient friable puis se recimente en séchant.
- À l'eau douce (tuyau, borne incendie), on perd ce bonus : la sculpture est plus fragile en surface une fois sèche, d'où l'usage du fixateur.
- Les compétitions en intérieur (sable de carrière + eau du réseau) compensent avec les fines argileuses, qui jouent le même rôle de ciment.

### 1.3.4 Pourquoi le sable sec ne tient rien

- Pas d'eau → pas de ponts → **cohésion c = 0**.
- Le seul mécanisme de résistance est la **friction interne** (critère de Mohr-Coulomb : τ = c + σ·tan φ, avec c = 0).
- Un tas de sable sec ne peut donc adopter qu'**une seule forme d'équilibre : le cône à l'angle de repos** (30–35°).
- Toute pente plus raide déclenche une **avalanche de surface** (les grains de la couche superficielle roulent jusqu'à ce que l'angle revienne à l'angle de repos).
- Un surplomb sec est **strictement impossible** : il n'y a aucune résistance en traction.

### 1.3.5 Pourquoi le sable trop mouillé s'effondre

Trois mécanismes se cumulent :

1. **Disparition des interfaces air-eau** → plus de dépression capillaire → cohésion → 0.
2. **Pression interstitielle positive** : l'eau libre supporte une partie de la charge, ce qui **réduit la contrainte effective** entre grains (σ' = σ − u). Moins de contrainte effective = moins de friction mobilisable = perte de résistance au cisaillement. C'est le mécanisme de la **liquéfaction**.
3. **Poids** : le sable saturé pèse ~2000 kg/m³ contre ~1500 kg/m³ sec ; on charge davantage une structure qui résiste moins.

Le résultat visuel : ce n'est **pas** une cassure nette, c'est un **fluage** — le tas s'étale, s'affaisse, « fond ». Le sculpteur parle de *slumping* ou de *sloughing*.

**Liquéfaction et thixotropie** : le sable saturé est un **fluide non newtonien**. Au repos il paraît solide ; **agité, vibré, cisaillé**, il perd sa viscosité apparente et coule (principe du sable mouvant). D'où deux conséquences opérationnelles majeures :
- **La vibration est votre amie pendant le tassement** (elle permet le réarrangement dense) ;
- **La vibration est votre ennemie une fois la sculpture debout** : des sculptures de compétition se sont effondrées à cause d'une pelleteuse passant à proximité.

### 1.3.6 La dilatance de Reynolds

Phénomène observé par tout le monde sur une plage : **quand on marche sur du sable mouillé, une auréole sèche apparaît autour du pied**.

Explication (Osborne Reynolds, 1885) : un matériau granulaire **dense** ne peut pas se cisailler sans **augmenter de volume** — les grains doivent se chevaucher pour glisser les uns sur les autres. Le volume des vides augmente, l'eau y est aspirée, la surface se draine et paraît sèche.

Conséquences pour la sculpture :
- **Un bloc bien tassé est dilatant** : le cisailler demande de l'énergie supplémentaire (il faut « gonfler » le matériau). C'est une **source de résistance additionnelle**.
- C'est aussi pourquoi un bloc bien tassé **coupe net** au lieu de s'écraser.
- Un bloc lâche (*contractant*) fait l'inverse : il se tasse en se cisaillant, expulse l'eau, monte en pression interstitielle et **liquéfie**. C'est le mécanisme de la rupture par cisaillement d'une sculpture mal tassée.

### 1.3.7 Angle de repos : les chiffres

| Matériau / état | Angle de repos | Angle de talus stable maximal |
|---|---|---|
| Sable sec, grains ronds, bien trié | **30–32°** | 30–32° |
| Sable sec, grains anguleux | **34–36°** | 34–36° |
| Sable sec, très anguleux + fines | 36–40° | 36–40° |
| **Sable humide (pendulaire), non tassé** | **~45°** | 45–60° selon hauteur |
| Sable humide bien tassé (bloc de *pound-up*) | non applicable | **jusqu'à 90° et au-delà (surplombs)** |
| Sable saturé / boue | **≈ 0–15°** | s'étale |

**Le point de bascule conceptuel** : dès qu'il y a cohésion, l'« angle de repos » cesse d'être la bonne variable. Un matériau cohésif peut tenir **verticalement** jusqu'à une hauteur critique :

```
H_critique ≈ 4·c / (γ_sol · √(K_a))     [talus vertical, Rankine]
```

Simplifié pour c = 3 kPa et γ_sol = 18 kN/m³ : **H_critique ≈ 0.7–1.0 m** de paroi verticale non soutenue pour un sable humide bien tassé. Ce qui correspond très bien à l'observation : les blocs de *pound-up* font typiquement **60 cm de haut (2 pieds)** par étage, et au-delà on empile des coffrages successifs plutôt qu'un seul très haut.

---

## 1.4 Compaction et *pound-up* : pourquoi ça marche

### 1.4.1 Ce que fait mécaniquement le tassement

Le tassement (*tamping*, *pounding*) produit **quatre effets simultanés** :

| Effet | Mécanisme | Conséquence |
|---|---|---|
| **1. Réduction de l'indice des vides** | les grains se réarrangent en un empilement plus dense | e passe de ~0.75–0.85 (lâche) à ~0.45–0.55 (dense) ; porosité de ~44 % à ~33 % |
| **2. Augmentation du nombre de coordination** | chaque grain touche plus de voisins | Z passe de ~4–5 à ~6–8 → **plus de ponts capillaires par grain** → cohésion en hausse directe |
| **3. Raccourcissement des ponts capillaires** | les grains sont plus près | rayons de courbure plus petits → **dépression capillaire plus forte** → force par pont en hausse |
| **4. Imbrication mécanique** (*interlocking*) | les grains anguleux s'encastrent | l'angle de friction apparent monte de 30° à 40°+ ; le matériau devient **dilatant** |

Les deux effets 2 et 3 se **multiplient** : c'est pourquoi le gain de résistance apporté par le tassement est **très supérieur** au simple gain de densité. Un bloc tassé peut être 5 à 10 fois plus résistant qu'un tas de même sable simplement versé.

### 1.4.2 Chiffres de compaction

| Grandeur | Sable versé (lâche) | Sable tassé (dense) | Gain |
|---|---|---|---|
| Indice des vides e | 0.75 – 0.85 | 0.45 – 0.55 | −35 % |
| Porosité n | 43 – 46 % | 31 – 36 % | −25 % |
| Masse volumique sèche | 1400 – 1500 kg/m³ | 1750 – 1900 kg/m³ | +25 % |
| Masse volumique humide | 1700 – 1800 kg/m³ | 2000 – 2100 kg/m³ | +18 % |
| Densité relative Dr | 15 – 35 % | 80 – 95 % | ×3 |
| Angle de friction φ | 29 – 32° | 38 – 45° | +30 % |
| Cohésion apparente | 0.5 – 1.5 kPa | 3 – 8 kPa | ×4 |

**Le facteur de réduction de volume observable sur le terrain**, et c'est LE chiffre que tout tutoriel donne :

> **On verse une couche de 6 pouces (15 cm) de sable, on la noie, on la tasse : il en reste 3 pouces (7,5 cm).**
> **Facteur de compaction ≈ 2 : 1** (parfois donné comme 15–20 cm → 7–10 cm).

C'est un excellent paramètre de gameplay : le joueur voit son sable disparaître de moitié. C'est visuel, c'est satisfaisant, c'est pédagogique.

### 1.4.3 Le rôle de l'eau dans la compaction

L'eau joue ici un rôle **opposé** à son rôle cohésif : elle est **lubrifiant**. Elle permet aux grains de glisser les uns sur les autres pour trouver leur configuration la plus dense. C'est exactement le principe de la **courbe Proctor** en géotechnique : la densité sèche atteinte pour une énergie de compactage donnée passe par un **maximum à une teneur en eau optimale** (*OMC, optimum moisture content*).

| Teneur en eau au tassement | Densité obtenue | Pourquoi |
|---|---|---|
| 0 % (sec) | faible-moyenne | friction sèche élevée, blocages en arches |
| 3–5 % | **minimum local (« bulking »)** | la cohésion capillaire fait « foisonner » le sable et l'empêche de se tasser — piège classique |
| 8–15 % | **maximum** | lubrification optimale |
| > 20 % (saturé) | moyenne, avec risque | l'eau ne peut pas s'échapper assez vite ; pression interstitielle ; « matelas » élastique |

Le **bulking** (foisonnement) est un phénomène important et sous-estimé : un sable **légèrement** humide (3–5 %) occupe **jusqu'à 20–30 % de volume en plus** qu'un sable sec ou saturé, car les ponts capillaires créent des voûtes qui résistent au tassement. C'est pourquoi il faut **noyer**, pas humidifier : on traverse le pic de foisonnement pour arriver dans la zone lubrifiée.

### 1.4.4 Vibration vs percussion

Deux modes de compaction, et le sable réagit très différemment :

| Mode | Outil | Efficacité sur sable | Note |
|---|---|---|---|
| **Percussion** (impact) | dame (*tamper*), pieds, poings | bonne | énergie ponctuelle, propage une onde de compression |
| **Vibration** | tapotement de la paroi du coffrage avec le manche de pelle, plaque vibrante | **excellente sur sable** | les sables sans cohésion se densifient bien mieux par vibration que par impact |
| **Piétinement / danse** | pieds, en spirale | bonne et contrôlable | le geste standard du sculpteur en coffrage large |
| **Brassage à la pelle** | pelle en mouvements rapides | indispensable | ce n'est pas de la compaction, c'est de l'**homogénéisation** : chasser les poches d'air et les zones sèches |

> **« Air bubbles no good »** — la formule du milieu. Une poche d'air ou une zone restée sèche dans une couche basse est une **bombe à retardement** : sous la charge des couches supérieures, elle se comprime, crée une discontinuité, et déclenche une **rupture par cisaillement qui peut emporter tout un pan de la sculpture**.

### 1.4.5 La stratigraphie du bloc

Un bloc de *pound-up* n'est pas homogène : c'est un **millefeuille**. Chaque couche tassée a :
- une **base légèrement plus dense** (elle a reçu l'énergie de tassement de sa propre couche **et** de celles au-dessus) ;
- une **interface** avec la couche suivante, qui est le **plan de faiblesse potentiel** si on n'a pas suffisamment mouillé/brassé la jonction.

D'où la règle : **on brasse toujours la nouvelle couche en mordant un peu dans la précédente**, pour souder les deux. Sinon on obtient un feuilletage qui se délamine à la sculpture (les sculpteurs voient apparaître des « strates » horizontales quand ils taillent).

**Gradient naturel** : dans un bloc drainé, l'eau descend. On obtient typiquement :
- **haut du bloc** : plus sec, plus cassant, arêtes plus vives (bon pour le détail fin)
- **bas du bloc** : plus humide, plus mou, plus lourd (bon pour la masse, moins bon pour le détail)

Les sculpteurs exploitent ça : **le détail fin va en haut**, les grandes masses en bas. Ça coïncide heureusement avec la règle de sculpture descendante.

---

## 1.5 Séchage, croûte, érosion

### 1.5.1 La croûte de surface

Quand un bloc sculpté sèche, il ne sèche **pas** de façon homogène. L'évaporation crée un **front de séchage** qui progresse depuis la surface, et l'eau migre par capillarité de l'intérieur vers l'extérieur, **transportant avec elle les sels dissous et les fines**. Ces solutés se déposent en surface : il se forme une **croûte** (*crust*) de 1 à 5 mm.

| Propriété de la croûte | Effet |
|---|---|
| Plus dure que le cœur (cimentation par sel/fines) | protège de l'érosion éolienne |
| Fragile, cassante | s'écaille au moindre choc (*spalling*) |
| Retarde l'évaporation du cœur | la sculpture reste humide à l'intérieur pendant des jours/semaines |
| Se dissout à la pluie et se reforme | cycle de « cicatrisation » |

**Verdict des professionnels** : la croûte est une **alliée**, on cherche à la former et à la préserver. D'où le *finish spray*.

### 1.5.2 Le fixateur (*wind spray*, *sealer*)

Pratique standard en compétition et en événementiel, **autorisée par la plupart des règlements après la fin du temps de sculpture** :

| Recette | Proportions | Usage |
|---|---|---|
| **Colle à bois biodégradable + eau** | **10 % colle / 90 % eau** | standard professionnel événementiel |
| **Colle blanche PVA (type Elmer's) + eau** | **20 % colle / 80 % eau** | usage courant, croûte plus épaisse |
| Colle biodégradable | **1 part colle / 10 parts eau** | anti-vent |
| Eau pure en brumisation | — | pendant la sculpture uniquement |

**Application** : pulvérisateur de jardin à pression, en **brouillard fin**, par passes légères successives, de haut en bas, **jamais en jet** (un jet creuse des cratères). On laisse sécher entre les passes. 2 à 4 passes.

**Ce que le fixateur fait et ne fait pas :**
- ✅ Il forme une **peau** qui empêche le vent d'arracher les grains fins des détails.
- ✅ Il **retient l'humidité à l'intérieur** — c'est peut-être son rôle principal.
- ✅ Il protège de la pluie fine et de l'ensoleillement.
- ❌ Il **ne tient pas** la sculpture. Une sculpture mal tassée ne sera pas sauvée par le fixateur. *« Water and compaction hold it together. »*
- ❌ Il n'est **jamais utilisé pendant** la phase de construction en compétition (ce serait de la triche : on ne doit ajouter que de l'eau).

### 1.5.3 Durées de vie observées

| Contexte | Durée de vie |
|---|---|
| Château de plage soft-pack, sans traitement | **quelques heures à 1 marée** |
| Château de plage bien tassé, hors zone de marée | 2 jours à 1 semaine |
| Sculpture pro extérieure **avec fixateur** | **plusieurs semaines à plusieurs mois** |
| Sculpture pro **en intérieur** (hall, musée) | **des années** |
| Sculpture géante d'exposition (sable de carrière + fines + fixateur) | 6 mois à 2 ans |

### 1.5.4 Les agents d'érosion, par ordre de dangerosité

| Agent | Mécanisme | Dégât typique | Parade |
|---|---|---|---|
| **Vagues / marée** | affouillement de la base, dissolution | **destruction totale en minutes** | choix du site, douves, digues, murs brise-lames |
| **Vent fort + sable sec** | abrasion, arrachage des grains secs des arêtes | perte des détails fins, arrondissement des arêtes | fixateur, brumisation, écrans, bâches |
| **Soleil / évaporation** | assèchement de surface | pulvérulence, effritement des arêtes, *sloughing* | brumisation, travail à l'ombre/tôt le matin, bâches |
| **Pluie forte / grêle** | impact des gouttes | **piqûres** (*speckling*), gouttières, perte de détail | bâches, coffrages remis en place, fixateur |
| **Pluie fine** | — | quasi inoffensif, **renforce même** la sculpture | rien à faire |
| **Vibrations** (engins, foule, musique) | liquéfaction locale, cisaillement | effondrement brutal | périmètre de sécurité |
| **Oiseaux** | perchage, becquetage | trous, fientes, arêtes cassées | **« bird wires » / « butt pokers »** : fils métalliques courts plantés au sommet |
| **Gravité + fluage** | déformation lente | affaissement des surplombs sur plusieurs jours | design conservateur, épaisseurs |
| **Humains** | doigts, ballons, chiens | tout | cordons, barrières |

---

# 2. LES TECHNIQUES DE CONSTRUCTION

## 2.0 Les cinq familles de techniques

Le milieu reconnaît cinq grandes familles. Un jeu ambitieux devrait toutes les proposer, car elles produisent des **esthétiques radicalement différentes**.

| # | Technique EN | Technique FR | Densité obtenue | Hauteur possible | Détail possible | Vitesse |
|---|---|---|---|---|---|---|
| 1 | **Form packing / pound-up / hard pack** | Coffrage et damage | ★★★★★ | ★★★★★ (records : 21 m) | ★★★★★ | ★ (lent) |
| 2 | **Hand stacking / pancaking** | Empilement à la main / galettes | ★★★★ | ★★★★ | ★★★★★ | ★★ |
| 3 | **Soft packing** | Modelage dans la masse | ★★ | ★★ | ★★ | ★★★★★ |
| 4 | **Bucket method / moulding** | Méthode du seau / moulage | ★★★ | ★★ | ★★★ | ★★★★ |
| 5 | **Drip / dribble castle** | Château dégoulinant / *kleckerburg* | ★ | ★★ | ★ (organique) | ★★★★ |

---

## 2.1 Le pound-up / hard packing avec coffrage

> **« Pile it, pound it, sculpt it. »**
> **« 80 % d'une sculpture sur sable, c'est un pound-up solide. »**

C'est **la** technique professionnelle. Le principe : on ne modèle pas le sable, on **fabrique d'abord un bloc de sable artificiellement dense**, une sorte de « grès tendre » de fabrication maison, puis on **le taille comme de la pierre**.

### 2.1.1 Les coffrages (*forms*)

Un coffrage de sculpture est **toujours sans fond** — c'est un cadre ouvert en haut et en bas, qui contient le sable **latéralement** pendant qu'on le tasse verticalement. Il ne porte rien : il empêche seulement l'étalement.

| Type de coffrage | Matériau | Dimensions typiques | Avantages | Inconvénients |
|---|---|---|---|---|
| **Seau de 20 L (5 gallons) sans fond** | polypropylène | Ø ~29 cm × 38 cm | universel, gratuit, biseauter le bord pour le démoulage | petit |
| **Poubelle / bidon sans fond** | plastique/métal | Ø 40–60 cm | tour d'un seul tenant | rigide, difficile à ranger |
| **Caisson en contreplaqué** | **CDX 5/8" (16 mm)**, renforts 2×4 haut et bas | **1,20 m × 1,20 m × 60 cm** (4 pieds carrés = standard) | rigide, réutilisable, on peut monter dessus | lourd, encombrant |
| **Flexi-form / « flexie »** | feuille de polyéthylène (ancienne bâche de piscine, ou **barrière anti-rhizomes**) enroulée | rouleau que l'on cintre au diamètre voulu, serré par des **serre-joints en C** | **le favori des pros** : diamètre variable, léger, roulé pour le transport, donne la fameuse forme « wedding cake » | fuit si mal jointé (→ **ruban adhésif toilé à l'intérieur du joint**) |
| **Formes polygonales** | panneaux assemblés | carrés, losanges, hexagones, octogones — **toujours un nombre pair de côtés** | permet des plans complexes | fabrication |
| **Coffrages modulaires HDPE du commerce** | HDPE | Ø 0,6 / 0,9 / 1,5 m | pros itinérants | coût |

**Chiffres de référence :**
- Le **Crystal Classic** (Siesta Key) utilise **plus de 300 coffrages** pour une seule édition.
- Un coffrage individuel dépasse **rarement 60 cm (2 pieds) de haut**. Au-delà, on **empile** un coffrage plus petit sur le bloc terminé.
- L'empilement progressif de coffrages de diamètres décroissants donne la silhouette classique en **« pièce montée » / « wedding cake »**.
- Sons of the Beach commercialisent des jeux de coffrages de **5 pieds (1,5 m), 3 pieds (0,9 m) et 2 pieds (0,6 m)** de diamètre.

**Étanchéité** : on colle du **ruban adhésif toilé (duct tape) à l'intérieur** des joints du coffrage pour que l'eau ne s'échappe pas latéralement pendant le noyage. C'est un détail de terrain qui change tout.

**Biseautage** : les bords du coffrage (surtout les seaux) sont **biseautés vers l'extérieur** en bas pour faciliter le décoffrage vers le haut.

### 2.1.2 Le cycle de pound-up, couche par couche

**Le cycle canonique, à répéter jusqu'en haut du coffrage :**

| Étape | Geste | Détail technique |
|---|---|---|
| **1. Verser** | pelleter **15 à 20 cm (6–8 pouces)** de sable dans le coffrage | ne jamais dépasser 20 cm : l'énergie de tassement ne descend pas plus bas |
| **2. Niveler** | égaliser grossièrement à la pelle ou au pied | pas de bosse : les creux resteront des zones sous-tassées |
| **3. Noyer** | verser de l'eau **en excès** — seaux entiers | objectif : **2 à 5 cm d'eau libre stagnant en surface** |
| **4. Brasser** | mouvements rapides de la pelle **dans** la couche, jusqu'au contact avec la couche précédente | **c'est l'étape que les débutants sautent**. Elle chasse les poches d'air et soude les couches |
| **5. Tasser** | dame, talons, poings ; **passes en spirale du bord vers le centre**, chaque passe chevauchant la précédente de moitié | commencer par la **périphérie** (le bord est la zone la plus critique et la plus vite ramollie) |
| **6. Re-tasser les mous** | repérer les zones qui « rebondissent » et les retasser | le sable bien tassé fait un bruit sourd ; le sable mou fait un bruit mat et s'enfonce |
| **7. Contrôler** | la couche est passée de 15 cm à **~7,5 cm** | **facteur 2:1**. Si elle n'a pas réduit de moitié, elle n'est pas tassée. |
| **8. Recommencer** | couche suivante | jusqu'au ras du coffrage |

**Outils de tassement et leurs cibles :**

| Outil | Surface de contact | Usage |
|---|---|---|
| **Dame (tamper)** — plaque métallique lourde sur long manche | **15 à 20 cm (6–8 pouces) de côté** | grands coffrages ; on la laisse tomber entre ses pieds |
| **Pieds / talons** | ~10 cm² efficaces | coffrages moyens ; le geste le plus universel |
| **Poings** | petits | seaux, petits coffrages, retouches de bord |
| **Manche de pelle contre la paroi** | — | **vibration** : fait remonter l'eau, densifie, décolle le coffrage |
| **Plaque vibrante** (événementiel) | 40×50 cm | sculptures géantes de plusieurs dizaines de tonnes |

### 2.1.3 L'empilement (*stacking*) et le drainage

- Une fois le coffrage plein et tassé au ras, on **pose le coffrage suivant** (plus petit, centré ou décentré selon le design) **sur le bloc**, et on recommence le cycle.
- **Ne jamais poser un coffrage supérieur avant que la couche du dessous ait drainé.** Sinon on charge un matériau saturé qui n'a pas encore repris de résistance.
- **On monte toujours plus haut que le sujet fini** : on prévoit 10–20 % de marge, car on va **descendre** en sculptant.
- Sur les gros chantiers, on laisse **reposer une nuit** (*curing*) entre le pound-up et la sculpture. Le drainage et la légère cimentation par le sel/les fines rendent le bloc nettement plus agréable à tailler.

### 2.1.4 Le décoffrage : LA règle du haut vers le bas

> **On retire les coffrages EN COMMENÇANT PAR LE HAUT, un ou deux à la fois, jamais tous d'un coup.**

Trois raisons, toutes importantes :

1. **Structurelle** : tant que les coffrages du bas sont en place, ils **confinent latéralement** la base. On peut donc tailler le haut agressivement sans que la base, encore chargée et encore un peu molle, ne s'étale ou ne cisaille. Le poids que supporte la base **diminue** au fur et à mesure qu'on sculpte le haut ; quand on arrive en bas, la base est déchargée et peut être décoffrée sans risque.
2. **Logistique** : les coffrages du bas restent en place et servent d'**échafaudage** — le sculpteur monte et descend dessus. C'est explicitement mentionné par les pros (Carl Jara).
3. **Propreté** : les chutes du haut tombent sur des surfaces encore brutes, pas sur du détail fini.

**Gestes de décoffrage :**
- Attendre la **disparition de l'eau libre** en surface.
- **Tapoter les parois** avec la main ou le manche de pelle pour rompre l'adhérence.
- **Desserrer les serre-joints** progressivement.
- **Lever tout droit**, vertical, sans basculer ni tourner — un basculement arrache la peau du bloc.
- Sur un seau : tapoter, puis **lever d'un mouvement franc et rectiligne**.

---

## 2.2 Le hand stacking / méthode des galettes (*pancake method*)

Popularisée par les **Sons of the Beach** (Fort Myers Beach, Floride), c'est **la technique de plage sérieuse sans matériel**. Elle produit des tours et des arches impressionnantes **sans un seul coffrage**.

### 2.2.1 Principe

On prend des poignées de sable **complètement saturé** (consistance de « pâte à crêpe épaisse », pas de soupe), on les **pose** l'une sur l'autre en les **aplatissant en galettes**, et on laisse l'eau remonter avant de retirer la main.

### 2.2.2 Le geste exact — à animer fidèlement dans le jeu

| Étape | Geste | Signal sensoriel |
|---|---|---|
| 1 | Puiser une **grosse poignée à deux mains** dans le trou d'eau ou le seau, sable saturé | ça dégouline |
| 2 | **Poser** (« plop ») la poignée à plat sur le sommet de la pile | bruit de « splat » mouillé |
| 3 | **Tapoter doucement** le dessus avec la paume pour l'étaler en galette de 2–4 cm d'épaisseur | — |
| 4 | **Vibrer / secouer légèrement** (« jiggle ») pendant que l'eau excédentaire s'échappe par les côtés | **on voit un anneau d'eau brillant remonter en surface** |
| 5 | **Retirer la main au moment précis où l'eau vient d'affleurer** | c'est LE timing : trop tôt = la galette n'est pas fusionnée ; trop tard = elle a durci en surface et ne fusionnera pas avec la suivante |
| 6 | Galette suivante, **légèrement décalée** selon la forme voulue | — |

> **Le timing du « jiggle » est la compétence-clé du hand stacking.** C'est la vibration au moment où l'eau s'échappe qui **fusionne** la nouvelle galette avec la précédente. Sans elle, on obtient un empilement feuilleté qui se délamine.

### 2.2.3 Géométrie et hauteur

- **Le diamètre de la base détermine la hauteur atteignable.** Règle empirique cohérente avec la physique : la hauteur maximale croît comme **R^(2/3)** (voir §2.9).
- Chaque galette est **légèrement plus petite** que la précédente si on veut un cône, **de même taille** si on veut un cylindre, **décalée** si on veut une inclinaison.
- Une pile de galettes bien faite fait couramment **1,20 m (48 pouces)** de haut sur une base de 60–80 cm.
- On peut **relier deux piles** par une galette-passerelle pour faire un pont/arche : c'est le classique du hand stacking.

### 2.2.4 Usages complémentaires

Le hand stacking sert aussi, **en complément du pound-up**, à :
- **rajouter de la matière** (une tour supplémentaire, un pinacle) sur un bloc déjà taillé ;
- **réparer** une zone effondrée (voir §2.12) ;
- fabriquer des éléments fins que le coffrage ne permet pas.

---

## 2.3 Le soft packing (modelage dans la masse)

C'est la technique du **99 % des châteaux de plage**. Elle est **méprisée** par les compétiteurs, mais elle a sa place.

**Principe** : on pellette rapidement un gros tas, on **ne compacte que la surface extérieure** à la main ou à la truelle, et on sculpte dans cette peau. L'intérieur reste lâche.

| Avantage | Inconvénient |
|---|---|
| **Très rapide** — un gros volume en quelques minutes | densité faible → **pas de surplomb, pas d'arche profonde, pas de découpe traversante** |
| Pas de matériel | hauteur limitée (~50–80 cm) |
| Idéal pour les **grandes masses de paysage** (dunes, terrain, socle) | s'effondre si on creuse trop |
| Utile pour boucher un grand vide | détail grossier |

**Usage professionnel légitime** : les pros font du soft pack pour les **parties non sculptées** — le socle, le terrain, les remblais, la « scène » autour de la pièce principale. On concentre le pound-up là où on va tailler.

---

## 2.4 La méthode du seau (*bucket method*) et les moules

C'est la porte d'entrée de tout le monde, et c'est aussi une technique **parfaitement valable** quand elle est bien faite. Elle mérite un traitement sérieux dans un jeu réaliste.

### 2.4.1 Le protocole complet

| # | Étape | Détail précis | Erreur classique |
|---|---|---|---|
| 1 | **Choisir le seau** | seau **droit ou légèrement conique**, sans arête intérieure ; les seaux de peinture de 20 L sont parfaits ; les seaux-jouets à fond décoré donnent une empreinte | seau trop conique → le sable glisse à l'intérieur pendant le démoulage |
| 2 | **Mouiller l'intérieur** | rincer le seau à l'eau avant remplissage | intérieur sec → le sable adhère |
| 3 | **Remplir par tiers** | verser un tiers de sable | remplir d'un coup → tassement inégal |
| 4 | **Noyer** | ajouter de l'eau jusqu'à ce qu'elle stagne au-dessus | — |
| 5 | **Tasser au poing** | poing ou pilon, en tournant, en insistant sur le **pourtour** | ne tasser qu'au centre → bord friable, effondrement du bord au démoulage |
| 6 | **Vibrer** | **tapoter les parois avec le manche de la pelle** ou la paume, tout autour | — |
| 7 | **Répéter** pour les deux tiers suivants | — | — |
| 8 | **Araser** | égaliser le dessus à la truelle | dessus bombé = base bancale |
| 9 | **Attendre le drainage** | **attendre que l'eau libre au-dessus ait disparu** | démouler trop tôt = la tour s'affaisse |
| 10 | **Retourner** | poser la surface d'accueil, retourner d'un geste **franc et continu**, sans à-coup | retournement hésitant = décollement interne |
| 11 | **Tapoter le fond et les côtés** | tapoter tout autour pour rompre l'adhérence | — |
| 12 | **Démouler** | **lever bien droit, vertical, lentement mais sans arrêt** | lever de travers = la tour se casse en deux |
| 13 | **Fondre la base** | ajouter un cordon de sable saturé à la jonction avec le sol et lisser | tour posée « à sec » sur la base = joint fragile |

### 2.4.2 Empilement de seaux

- On peut empiler des cylindres démoulés pour faire une tour composite — mais **chaque joint est un plan de faiblesse**.
- Truc de pro : **maroufler chaque joint** avec du sable saturé à la truelle (voir *buttering*, §2.11.1), pour souder les cylindres entre eux.
- Le **jeu de diamètres décroissants** (grand seau, moyen, petit, gobelet) est le moyen le plus rapide d'obtenir une silhouette de tour crédible.

### 2.4.3 Les moules du commerce

| Moule | Effet | Note |
|---|---|---|
| Seau crénelé | tour à créneaux prêts | pratique, mais très « jouet » — les créneaux sont trop réguliers |
| Moule pyramide / cône | toit conique | à utiliser comme **ébauche**, puis retailler |
| Moule à briques | mur en appareillage | rapidement répétitif |
| **Gobelet, verre, pot de yaourt** | petites tourelles, poivrières, colonnes | **plus utile que les moules à château**, car neutre |
| **Tube de plomberie (PVC Ø 50–100 mm)** | colonne parfaite, cheminée | outil pro (mentionné dans le kit de Carl Jara) |
| Entonnoir | cône lisse, toit de tourelle | — |

---

## 2.5 Le drip castle / dribble castle (*kleckerburg*)

Nom français : **château dégoulinant**. En Allemagne : **Kleckerburg**. Anglais : *drip castle, drippy castle, dribble castle, drizzle castle*.

### 2.5.1 Principe et physique

On utilise du **sable en suspension** — une **soupe**, un slurry — c'est-à-dire du sable **au-delà de la saturation**, dans le régime où il n'y a plus aucune cohésion capillaire. On le laisse **couler goutte à goutte** ; chaque coulée s'étale un peu, l'eau percole immédiatement dans la coulée précédente et **la nouvelle goutte se fige presque instantanément** parce qu'en perdant son eau elle repasse dans le régime funiculaire/pendulaire.

C'est **exactement le mécanisme d'une stalagmite**, à ceci près que le liant est capillaire et non calcaire. Le résultat visuel est **organique, noueux, fondu** — l'esthétique « Gaudí » / « château de conte de fées » / « termitière ».

### 2.5.2 Le protocole

| # | Étape | Détail |
|---|---|---|
| 1 | **Préparer la soupe** | creuser un trou jusqu'à la nappe, ou remplir un seau : **il faut au moins 2–3 cm d'eau libre au-dessus du sable** |
| 2 | **Malaxer** | remuer jusqu'à obtenir une consistance qui « coule facilement entre les doigts » — plus liquide qu'une pâte à crêpe |
| 3 | **Puiser** | prendre une poignée pleine, la sortir en la laissant s'égoutter légèrement | 
| 4 | **Dégouliner** | tenir la main **au-dessus** du point de dépôt (5–15 cm) et **ouvrir progressivement le poing** ; ou faire un poing pouce en l'air et laisser filer par le bas ; ou laisser filer entre les doigts |
| 5 | **Empiler** | déposer sur le dépôt précédent, en tournant lentement la main | 
| 6 | **Sécher** | laisser 5–20 s entre les couches pour laisser percoler | 
| 7 | **Monter** | jusqu'à ce que la structure devienne trop fine et vacille |

### 2.5.3 Variables et effets

| Paramètre | Effet visuel |
|---|---|
| **Hauteur de la main** au-dessus du dépôt | haute → coulées fines, élancées, « stalagmite » ; basse → amas trapu et lisse |
| **Débit** (ouverture du poing) | filet fin → détail dentelé ; gros débit → grosse boursouflure |
| **Teneur en eau de la soupe** | plus liquide → étalement, aspect fondu ; moins liquide → grumeaux, aspect noueux |
| **Rotation de la main** | permet des spirales, des tours vrillées |
| **Granulométrie** | sable très fin → coulées régulières ; sable grossier → coulées granuleuses qui s'effondrent |

### 2.5.4 Combinaison avec les autres techniques

L'usage professionnel du drip est **décoratif, pas structurel** :
- **Toits de tours** organiques posés sur des tours taillées ;
- **Arbres, buissons, coraux, algues** (le sable dégouliné mime parfaitement le végétal) ;
- **Chevelures, barbes, fourrure** sur les sculptures figuratives ;
- **Encroûtements** sur un mur pour un effet « ruine envahie » ;
- **Bordure de douve** au bord d'un château taillé.

---

## 2.6 Fondation, plateforme, gestion de l'eau, choix du site

### 2.6.1 Choisir l'emplacement — les cinq critères

| Critère | Cible | Pourquoi |
|---|---|---|
| **1. Marée** | construire quand la marée **descend** ; se placer au-dessus de la laisse de haute mer si on veut durer | une marée montante détruit tout en quelques minutes |
| **2. Distance à l'eau** | assez près pour la logistique (transport de l'eau), assez loin pour la survie ; classiquement **au-dessus de la ligne de sable humide** | compromis effort/durée de vie |
| **3. Planéité** | **surface plane et régulière** | une base inclinée introduit une composante de cisaillement permanente |
| **4. Qualité du sable** | sable **fin, humide, compact**, pas de coquillages/gravier | déterminera la hauteur et le détail possibles |
| **5. Nappe (water table)** | assez près de la surface pour creuser un trou d'eau à 40–80 cm | sinon il faut transporter l'eau au seau, ce qui triple le temps |

### 2.6.2 Le trou d'eau (*water hole*)

C'est **le premier geste de tout chantier sérieux**, avant même de penser à la forme.

| # | Geste | Détail |
|---|---|---|
| 1 | Choisir l'emplacement du trou **du côté mer** du chantier | on ne veut pas de trou en amont, qui draine la base |
| 2 | Creuser jusqu'à ce que l'eau **monte toute seule** (nappe phréatique de plage) | typiquement **40 à 100 cm** selon la marée et la distance à l'eau |
| 3 | **Élargir** le trou en cuvette | pour pouvoir y plonger seau et mains |
| 4 | **Empiler le sable extrait du côté dune**, pas du côté mer | ce tas devient le stock de matière première |
| 5 | Y brasser le sable pour préparer galettes et soupe | le trou est à la fois **puits, malaxeur et réserve** |

⚠️ **Sécurité et civisme** : les trous profonds sur la plage sont **mortels** (effondrement, ensevelissement) et **piègent les tortues marines**. La règle universelle, à intégrer dans le jeu comme geste de fin de session : **on rebouche son trou avant de partir.**

### 2.6.3 Fondation et plateforme

- **Décaper la couche sèche superficielle** (5–15 cm) pour atteindre le sable humide en place. On ne construit **jamais** sur du sable sec.
- **Damer la plateforme** avant tout : la première chose qu'on tasse, c'est **le sol**, pas le château.
- **Élargir la base** : la règle universelle est que la base doit être **nettement plus large que ce qu'on pense**. Formule pratique : **base ≥ 1,5 × la plus grande dimension horizontale de la structure** ; pour une tour, **diamètre de base ≥ hauteur / 2**.
- **Plinthe / socle (plinth)** : les compétiteurs partent presque toujours d'un **socle plat et net**, plus grand que la sculpture. Il joue trois rôles : répartir la charge, protéger de l'affouillement, et **cadrer visuellement** l'œuvre (critère de jugement : *« utilisation du site »*).
- **Nettoyer et ratisser le pourtour** : un pourtour ratissé, sans traces de pas, fait partie de la présentation en compétition.

### 2.6.4 Drainage et gestion de l'eau

| Élément | Fonction | Réalisation |
|---|---|---|
| **Douve (moat)** | recueillir l'eau de ruissellement et l'eau des vagues, éloigner l'affouillement de la base | tranchée circulaire à **30–60 cm** de la base, **20–40 cm** de profondeur, fond **damé** |
| **Canal d'évacuation** | conduire l'eau de la douve loin de la structure, côté mer | rigole en pente descendante |
| **Digue / levée (berm, dike)** | dévier les nappes de vagues | bourrelet de sable damé côté mer, en arc |
| **Brise-lames (breakwater)** | casser l'énergie des vagues avant la digue | monticule ou muret placé **en amont** dans le sens des vagues, souvent en V pointé vers la mer |
| **Mur de protection (seawall)** | dernière ligne | mur damé, face mer **inclinée** (une face inclinée dissipe mieux qu'une face verticale) |
| **Fossé de drainage périphérique** | éviter que l'eau de brumisation ne ramollisse le pied | rigole discrète |

**Vérité physique à faire ressentir au joueur** : ces ouvrages ne « battent » jamais la mer. Ils **achètent du temps** — une, deux, cinq vagues. Contre une marée montante, ils sont **tous** perdants. C'est une magnifique mécanique de jeu (voir §7).

---

## 2.7 La sculpture soustractive : du haut vers le bas, toujours

> **RÈGLE ABSOLUE ET NON NÉGOCIABLE : ON SCULPTE DE HAUT EN BAS.**

C'est LA règle du métier, énoncée par tous les professionnels sans exception. Elle a **cinq justifications distinctes**, et il faut les connaître toutes pour la traduire correctement en gameplay :

| # | Raison | Explication |
|---|---|---|
| **1. Les chutes tombent** | Le sable retiré en haut tombe sur ce qui est en dessous. Si le dessous est déjà fini, il est **détruit ou souillé**. Un escalier fini sur lequel tombent des chutes est « souvent ramolli, voire ruiné » — car pour retirer les chutes, il faut toucher l'escalier. | pratique |
| **2. Décharge progressive** | En sculptant le haut, on **enlève du poids** à la base. La base est donc de moins en moins sollicitée au fur et à mesure. À l'inverse, sculpter le bas d'abord **amincit la base sous une charge maximale** → cisaillement, effondrement. | structurelle |
| **3. Gradient d'humidité** | Le haut du bloc est plus sec et plus cassant (meilleur pour le détail) ; le bas est plus humide. Le haut sèche vite : il faut le tailler **tant qu'il est encore bon**. | matériau |
| **4. Vibration** | Chaque coup d'outil transmet des vibrations vers le bas. Un détail fini en bas est **fragilisé** par tout le travail effectué au-dessus. | dynamique |
| **5. Coffrages / échafaudage** | Les coffrages inférieurs restent en place et servent d'appui et de confinement. | logistique |

### 2.7.1 La progression du grossier au fin

| Phase | Nom EN | Outils | Volume retiré par geste | Objectif |
|---|---|---|---|---|
| **Ébauche / dégrossissage** | *roughing out, blocking in* | pelle, truelle de maçon, gros couteau | grand | établir la silhouette générale, les grandes masses, les axes |
| **Mise en forme** | *shaping* | truelle, spatule large, main | moyen | volumes secondaires : tours, corps de logis, toitures |
| **Détaillage** | *detailing* | couteau à palette, mirette, petit couteau | petit | ouvertures, créneaux, moulures, escaliers |
| **Texturation** | *texturing* | peigne, fourchette, brosse, truelle dentée | superficiel | brique, pierre, bois, tuile |
| **Finition** | *finishing* | pinceau, paille, brumisateur | quasi nul | nettoyage, arêtes, suppression des grains libres |

**Principe d'or du dégrossissage** : *« retirez le sable AUTOUR de votre dessin, pas votre dessin »*. Ce basculement mental — voir le vide, pas le plein — est ce qui sépare le débutant de l'intermédiaire.

**Principe de prudence** : *« on ne peut pas remettre de sable »* (au sens strict c'est faux, mais toute réparation se voit). D'où la règle : **enlever peu, souvent**. Prendre trop d'un coup, c'est risquer la pièce entière.

### 2.7.2 Le geste de coupe

| Type de coupe | Geste | Résultat |
|---|---|---|
| **Coupe continue** | mouvement **fluide et continu** le long d'une courbe, outil incliné à 15–30° de la surface | surface lisse, courbe pure |
| **Coupe stop-and-start** | attaques successives à l'outil tenu **comme un ciseau**, perpendiculaire | arêtes vives, angles nets, méplats |
| **Raclage** | outil presque parallèle à la surface, traction | aplanissement, retrait fin |
| **Gougeage** | mirette ou cuillère, mouvement de creusement en rotation | cavités, fenêtres, niches |
| **Lissage/tirage** | truelle ou patin, pression modérée, passes longues | surface polie, « plâtre » |
| **Frappe** | à proscrire | **« ne jamais piquer, poignarder, ni hacher »** — on **taille et on rase** |

### 2.7.3 Le contre-dépouille (*undercut*)

L'**undercut** — tailler **sous** un volume, de sorte que la matière soit en surplomb — est **le geste le plus spectaculaire et le plus risqué** de la sculpture sur sable. C'est un des critères explicites de notation en compétition (*« surplombs impossibles, découpes traversantes »*).

| Facteur | Effet sur la profondeur d'undercut possible |
|---|---|
| Qualité du sable (angularité, fines) | **déterminant** — un sable rond ne supporte quasiment aucun undercut |
| Qualité du pound-up | **déterminant** |
| Épaisseur de la dalle en surplomb | plus épaisse = plus lourde mais plus rigide ; il existe un optimum |
| Humidité au moment de la coupe | trop sec = casse net pendant la coupe ; trop humide = flue |
| Charge au-dessus | **plus de poids au-dessus = plus stable** (compression → résistance) |
| Vibrations | fatal |

**Règles empiriques de terrain** (à calibrer dans le jeu) :
- Sur bon sable pound-up : undercut jusqu'à **20–30 cm** de profondeur pour une dalle de **8–15 cm** d'épaisseur.
- Sur sable de plage moyen : **5–10 cm** maximum.
- Sur soft pack : **0** — tout undercut s'effondre.
- Le **danger n'est pas au moment de la coupe** mais **quelques minutes après**, quand la contrainte se redistribue et que le fluage opère.

**Le fait physique qui contredit l'intuition** : **le poids au-dessus RENFORCE** une structure de sable, il ne l'affaiblit pas — tant qu'on reste en compression. C'est le mécanisme découvert dans l'étude des arches de grès naturelles (*Nature Geoscience*, 2014) : des cubes de sable de 10 cm chargés d'un poids de 1 kg, soumis à l'érosion par l'eau, se sont érodés en piliers en sablier **plus résistants que le cube d'origine**. La compression verrouille les grains et supprime les modes de rupture par traction. C'est exactement pourquoi les arches naturelles tiennent des milliers d'années.

> **Traduction gameplay : dans un moteur de sable réaliste, la contrainte de compression verticale doit AUGMENTER localement la cohésion effective. C'est contre-intuitif et c'est ce qui rendra la physique crédible.**

---

## 2.8 Les détails architecturaux : catalogue technique complet

C'est la partie la plus directement exploitable pour un jeu : chaque élément est une **primitive de construction** avec sa géométrie, son outil, son geste et sa contrainte de faisabilité.

### 2.8.1 Les tours

| Type | Réalisation | Contraintes | Outils |
|---|---|---|---|
| **Tour cylindrique (ronde)** | coffrage rond / seau / hand stack ; puis on **régularise** le cylindre en tournant autour avec une truelle tenue verticale | la plus stable ; élancement max ≈ **H/D = 3 à 5** en bon sable | truelle, patin, gabarit |
| **Tour carrée / rectangulaire** | coffrage carré ; on tire chaque face au patin, puis on **fait les arêtes en dernier** | les **arêtes verticales** sont les zones les plus fragiles | truelle à angle, couteau à enduire, règle |
| **Tour polygonale** (hexa/octogonale) | tracer les pans au sommet, descendre chaque pan à la règle | difficile : demande de la rigueur géométrique | règle, fil à plomb |
| **Tour fuselée / effilée** | superposition de coffrages décroissants | la classique « wedding cake » | — |
| **Tour vrillée / torsadée** | coupes hélicoïdales successives | virtuose | couteau, gabarit hélicoïdal |
| **Échauguette / poivrière (*bartizan, turret*)** | petite tourelle en encorbellement à l'angle d'un mur | **undercut** obligatoire au niveau des corbeaux | mirette, petit couteau |
| **Donjon (*keep, donjon*)** | tour maîtresse, la plus massive, souvent au centre | doit être **la première coffrée et la plus haute** | tous |

**Séquence de finition d'une tour ronde** (geste réel) :
1. Faire le tour en **rasant** avec une truelle tenue **verticale**, en tournant autour de la tour ;
2. Contrôler la verticalité **en reculant** (l'œil de loin, jamais de près) ;
3. Corriger par passes fines ;
4. **Créneaux et corniches en dernier**, une fois le fût parfait.

### 2.8.2 Créneaux, merlons, remparts

Vocabulaire précis (français d'abord, anglais entre parenthèses) :

| Terme FR | Terme EN | Définition |
|---|---|---|
| **Crénelage / crénelure** | *crenellation, battlement* | l'alternance régulière de pleins et de vides au sommet d'un mur |
| **Merlon** | *merlon* | la **partie pleine**, le bloc dressé |
| **Créneau** | *crenel, embrasure, crenelle* | le **vide** entre deux merlons |
| **Chemin de ronde** | *wall-walk, allure, wall walk* | passage praticable derrière le parapet |
| **Parapet** | *parapet* | le muret extérieur du chemin de ronde |
| **Archère / meurtrière** | *arrow slit, arrow loop, loophole* | fente verticale étroite pour le tir |
| **Ébrasement** | *embrasure (splay)* | élargissement intérieur d'une ouverture |
| **Mâchicoulis** | *machicolation* | ouverture au sol d'un encorbellement, entre les corbeaux, pour tirer/jeter à la verticale |
| **Corbeau** | *corbel* | pierre en saillie supportant l'encorbellement |
| **Hourd** | *hoarding, brattice* | galerie **en bois** en surplomb (version temporaire du mâchicoulis) |
| **Courtine** | *curtain wall* | mur reliant deux tours |
| **Contrefort** | *buttress* | renfort maçonné perpendiculaire au mur |
| **Talus / fruit** | *batter, talus* | épaississement incliné du pied de mur |

**Technique de réalisation des créneaux — la méthode « diviser pour régner » :**

1. Aplanir parfaitement le sommet du mur.
2. **Tracer légèrement** la ligne du parapet (fil, règle, ou pointe légère).
3. **Marquer le milieu**, puis les quarts, puis les huitièmes — **on divise, on ne mesure pas**. C'est ainsi qu'on obtient une régularité crédible sans instrument.
4. **Découper les créneaux (les vides)** à la verticale au couteau à palette, en deux passes : une incision de chaque côté, puis on **soulève le bloc de sable** (il sort en un morceau si le sable est bon).
5. **Nettoyer le fond de créneau** à plat, à la petite spatule.
6. **Chanfreiner ou arrondir légèrement** le haut des merlons — un merlon parfaitement anguleux fait « carton », un merlon très légèrement adouci fait « pierre ».
7. **Souffler à la paille** pour dégager les grains libres.

**Ratios crédibles** (issus de l'architecture réelle, à respecter pour que ça « fasse château ») :

| Rapport | Valeur historique | Note |
|---|---|---|
| Largeur merlon / largeur créneau | **1.5 : 1 à 2.5 : 1** | le merlon protège un homme, le créneau permet de tirer |
| Hauteur merlon / largeur merlon | 1 : 1 à 1.5 : 1 | |
| Hauteur du parapet / hauteur d'homme | ~1.2 à 1.8 m réel | à l'échelle 1:20 → 6–9 cm |
| Nombre de créneaux sur une tour ronde | 6 à 12 | pair de préférence |

### 2.8.3 Portes, arches, fenêtres

**Les types d'arcs, par difficulté croissante en sable :**

| Arc | Forme | Faisabilité en sable | Note |
|---|---|---|---|
| **Linteau droit** | horizontal | ★★★★★ | le plus simple, mais le linteau est en **traction** → c'est le point faible |
| **Arc en encorbellement (*corbel arch*)** | assises en escalier se rejoignant | ★★★★★ | **le plus adapté au sable** — pas de traction, uniquement de la compression et du frottement |
| **Arc en plein cintre (*round/Romanesque arch*)** | demi-cercle | ★★★★ | l'archétype du château |
| **Arc brisé (*pointed/Gothic arch*)** | ogive | ★★★★ | plus stable qu'il n'y paraît : la poussée est plus verticale |
| **Arc en tiers-point, arc surhaussé** | variantes | ★★★ | |
| **Arc surbaissé / anse de panier** | aplati | ★★ | poussée horizontale forte → écarte les piédroits |
| **Arc outrepassé (fer à cheval)** | > demi-cercle | ★ | **undercut aux reins** → très risqué |

**Le geste de l'arche — protocole exact :**

1. **Dessiner** l'arc au doigt ou à la pointe, légèrement, sur la face du mur. Utiliser un **compas improvisé** (un bout de ficelle et un doigt-pivot, ou deux doigts écartés) pour un demi-cercle propre.
2. **Inciser le contour** au couteau à palette, sur 5–10 mm de profondeur, tout autour.
3. **Évider le centre rapidement** à la cuillère ou à la mirette, **du centre vers les bords, jamais l'inverse**.
4. **Attaquer depuis les deux côtés vers le milieu** — c'est la consigne explicite des tutoriels : on scoope depuis chaque piédroit vers la clef, symétriquement.
5. **Ne jamais dégager la clef en premier** : la clef est la dernière matière à retirer, sinon l'arc perd son sommet.
6. **Traverser** (pour une découpe traversante / *cut-through*) : percer le fond en dernier, depuis les deux faces si possible.
7. **Nettoyer l'intrados** (la face intérieure de l'arc) à la petite spatule courbe.
8. **Souffler**.

**Épaisseurs minimales (règle empirique de terrain) :**

| Élément | Épaisseur minimale, bon sable pound-up | Épaisseur minimale, sable de plage |
|---|---|---|
| Voûte d'arche (au-dessus de la clef) | **≥ 1/4 de la portée**, jamais < 4 cm | ≥ 1/3 de la portée, jamais < 8 cm |
| Piédroit d'arche | ≥ 1/3 de la hauteur de l'arche | ≥ 1/2 |
| Mur mince (courtine) | 3–5 cm | 8–12 cm |
| Dalle de pont | 4–6 cm pour 20 cm de portée | non réalisable |
| Colonne libre | Ø ≥ 1/8 de sa hauteur | Ø ≥ 1/5 |

**Fenêtres :**
- **Petites fenêtres carrées** : deux incisions verticales + deux horizontales au couteau, puis on **fait sauter le bloc**.
- **Meurtrières** : une seule incision verticale, très fine, **avec la pointe du couteau à palette ou une lame de scie à métaux**.
- **Fenêtre à ébrasement** : on élargit vers l'intérieur à la mirette → l'ombre portée devient profonde et l'illusion de profondeur est spectaculaire (crucial en sable, voir §2.10).
- **La cuillère à melon (*melon baller*)** est l'outil canonique pour portes et fenêtres arrondies : un simple appui-rotation produit une niche hémisphérique parfaite.

**Le rôle capital de l'ombre** : en sculpture sur sable, **il n'y a qu'une seule couleur**. Toute la lisibilité vient de la **profondeur des creux et de l'orientation des surfaces**. Une fenêtre de 2 mm de profondeur est invisible ; une fenêtre de 15 mm avec ébrasement est noire et lit à 20 mètres. **Il faut donc surcreuser** par rapport à ce que la logique architecturale imposerait.

### 2.8.4 Escaliers

L'escalier est **la signature du sculpteur avancé** : c'est répétitif, fragile, et impitoyable sur la régularité.

**Méthode de l'escalier droit :**
1. Tailler d'abord une **rampe lisse** (un plan incliné parfait) à la truelle. **Tout l'escalier sort de cette rampe.**
2. Partir **du haut**.
3. Faire une **coupe horizontale** (la contremarche : on descend de X) puis une **coupe verticale** (le giron : on rentre de X) — la formule des tutoriels est : **« un demi-pouce vers le bas, puis un demi-pouce vers l'intérieur »**, soit **~12 mm × 12 mm**, répété.
4. Descendre marche après marche, sans jamais revenir en arrière.
5. **Nettoyer chaque marche à la paille immédiatement** — un grain tombé sur une marche finie oblige à toucher la marche, ce qui l'abîme.

**Ratios crédibles** : giron ≈ contremarche pour un escalier « de château » raide (45°) ; giron = 1.5 × contremarche pour un escalier d'apparat.

**Escalier hélicoïdal / en colimaçon** :
- On part d'un **cône ou d'un cylindre** parfaitement régulier.
- On trace l'hélice avec **une ficelle enroulée** ou en marquant des points à intervalles réguliers sur des génératrices.
- On taille la ligne d'hélice au couteau, puis on **dégage la marche par en dessous** — c'est un **undercut permanent** : réservé au très bon sable.
- Variante prudente : escalier **en creux** (rampe hélicoïdale gravée dans la tour, sans surplomb) — beaucoup plus solide, presque aussi joli.

### 2.8.5 Ponts, arcs-boutants, passerelles

| Élément | Technique |
|---|---|
| **Pont entre deux tours** | **hand stacking** : on monte les deux culées, puis on pose des galettes en encorbellement de chaque côté qui se rejoignent au milieu. **Jamais taillé dans la masse** sauf si les deux tours sont issues du même bloc. |
| **Pont-levis (*drawbridge*)** | dalle inclinée appuyée contre la porte, ou dalle relevée à 45° soutenue par deux « chaînes » de sable dégouliné. Les chaînes sont **décoratives** — la dalle repose en réalité sur la porte. |
| **Herse (*portcullis*)** | grille gravée en creux dans le fond d'un porche (jamais en relief libre) : quadrillage à la pointe |
| **Arc-boutant (*flying buttress*)** | le geste le plus difficile : deux culées + arc mince en surplomb. Réalisation en **encorbellement depuis les deux côtés**, ou en dégouliné consolidé |
| **Passerelle / coursive** | dalle en encorbellement, épaisseur ≥ 1/4 de la portée |

### 2.8.6 Toitures

| Type de toit | Réalisation | Texture |
|---|---|---|
| **Toit conique (poivrière)** | tailler un cône depuis un cylindre, ou mouler avec un entonnoir | tuiles en écailles |
| **Toit conique à débord** | cône + **undercut** au niveau de l'avant-toit → l'ombre sous le débord fait toute la crédibilité | idem |
| **Toit à deux pentes (bâtière)** | deux plans inclinés, faîtage taillé en dernier | tuiles plates ou chaume |
| **Toit en pavillon (4 pentes)** | quatre plans, arêtiers en dernier | — |
| **Coupole / dôme** | sphère tronquée, taillée en tournant | écailles ou lisse |
| **Flèche (*spire*)** | cône très élancé, souvent en **dégouliné** consolidé | — |
| **Chaume** | surface ébouriffée à la brosse dure ou au peigne, mèches irrégulières | — |

**Technique des tuiles (écailles)** — le geste le plus payant en rapport temps/effet :
1. Tracer des **lignes de rang** parallèles (horizontales) à la pointe ou au fil, espacées de 5–15 mm.
2. Sur chaque rang, faire des **encoches en demi-lune** avec l'angle d'une petite spatule ou une **mirette ronde**, en **décalant d'une demi-tuile** par rapport au rang du dessous (appareillage en quinconce).
3. Travailler **du bas du toit vers le haut** (contrairement à la règle générale !) — car chaque rang doit **recouvrir** le précédent, et parce qu'ici les chutes tombent sur du non-fini.
   → **C'est la seule exception documentée à la règle « du haut vers le bas »**, et elle est locale (à l'intérieur d'un même élément).
4. Souffler à la paille à la fin de chaque rang.

### 2.8.7 Appareillage : briques et pierres

**Brique** :
- Tracer les **lits horizontaux** (joints horizontaux) d'abord, régulièrement espacés, avec **une règle et une pointe** ou avec le **coin d'une truelle margée**.
- Puis les **joints verticaux (boutisses)**, **décalés d'une demi-brique** d'un rang à l'autre (appareil à joints croisés / *running bond*).
- Profondeur du joint : **1–3 mm suffisent** si l'éclairage est rasant ; **3–5 mm** pour une lecture de loin.
- Outil idéal : **truelle dentée demi-lune** (on tire une seule fois et on obtient tout un rang de joints parallèles), ou **peigne** (curry comb).

**Pierre de taille (appareil régulier)** :
- Blocs plus grands que les briques, joints plus larges (3–6 mm), et **on casse la régularité** : quelques pierres plus grandes, quelques joints décalés.
- **Chanfreiner très légèrement chaque bloc** (arête adoucie) pour l'effet « pierre usée ».

**Moellons / pierre brute (*rubble*)** :
- Dessiner un réseau de **polygones irréguliers** au couteau, puis **creuser les joints** à la pointe.
- C'est plus rapide et **plus pardonnant** que l'appareil régulier : les irrégularités passent pour du style.

**Pierre en bossage (*rustication*)** :
- Après avoir tracé les joints, **bomber légèrement** le centre de chaque bloc au dos d'une cuillère.

### 2.8.8 Autres éléments architecturaux

| Élément FR | EN | Technique |
|---|---|---|
| **Corniche / bandeau** | *cornice, string course* | une seule passe horizontale de truelle margée ou de couteau à enduire, tenu à 45°, tout autour du bâtiment. Effet immédiat et énorme. |
| **Colonne** | *column* | tube PVC comme coffrage, ou taillée dans la masse. Cannelures : incisions verticales à la mirette |
| **Chapiteau** | *capital* | élargissement en haut, gougé à la mirette |
| **Arcade / galerie** | *arcade* | série d'arcs identiques : **tracer TOUS les arcs avant d'en creuser un seul** |
| **Barbacane** | *barbican* | ouvrage avancé devant la porte : deux petites tours + passage étranglé |
| **Poterne** | *postern* | petite porte dérobée dans la courtine |
| **Basse-cour** | *bailey, ward* | enceinte intérieure : simple délimitation par une courtine basse |
| **Fossé sec / douve sèche** | *dry ditch* | tranchée sans eau, fond en V ou plat |
| **Palissade** | *palisade* | rang de petits cylindres pointus, faits au tube ou dégoulinés |
| **Girouette, oriflamme** | *weather vane, banner* | souvent réalisée en matériau **non-sable** — interdit en compétition stricte |
| **Contrefort** | *buttress* | prisme triangulaire appliqué au mur ; **structurellement utile en sable aussi** |
| **Cheminée** | *chimney* | petit cylindre au tube PVC |
| **Spirale / volute** | *spiral, volute* | tracée puis creusée à la mirette, ou faite en dégouliné |

---

## 2.9 Limites structurelles : combien de hauteur ?

### 2.9.1 La loi d'échelle des colonnes de sable

Résultat majeur de **Pakpour, Habibi, Møller & Bonn, *Scientific Reports* 2:549 (2012)** :

> **La hauteur maximale d'une colonne de sable humide croît comme la puissance 2/3 du rayon de sa base.**

```
H_max = C · R^(2/3)
```

Le mécanisme limitant n'est **pas** l'écrasement : c'est le **flambement élastique sous poids propre** (instabilité d'Euler pour une colonne pesante). La colonne « part de côté » avant d'être écrasée.

**Conséquence directe et très concrète :**

> **Pour doubler la hauteur, il faut multiplier le rayon de base par 2^(3/2) = √8 ≈ 2,83.**

| Rayon de base | Hauteur max relative | Volume relatif |
|---|---|---|
| R | H | V |
| 2.83 R | 2 H | ≈ 16 V |
| 8 R | 4 H | ≈ 256 V |

C'est **exactement** pourquoi le record du monde (**21,16 m — Blokhus, Danemark, 2 juillet 2021**) a nécessité une base de **plus de 30 m** et **environ 5 000 tonnes (6 400 short tons) de sable**. La croissance du volume est brutale.

**Ordres de grandeur pour le calibrage du jeu :**

| Base (rayon) | Hauteur atteignable, sable de plage soft pack | Hauteur, hand stacking | Hauteur, pound-up bon sable |
|---|---|---|---|
| 10 cm | 15 cm | 25 cm | 35 cm |
| 25 cm | 30 cm | 60 cm | 90 cm |
| 50 cm | 45 cm | 1,0 m | 1,6 m |
| 1 m | 70 cm | 1,6 m | 2,5 m |
| 2 m | — | 2,5 m | 4 m |
| 5 m | — | — | 7–9 m |
| 15 m | — | — | 21 m (record) |

### 2.9.2 Les paramètres du modèle théorique

Le modèle de Bonn et coll. fait intervenir :

```
G = 0.054 · a^(−1/3) · E^(2/3) · γ^(1/3)
```

avec :
| Symbole | Signification | Valeur utilisée |
|---|---|---|
| a | rayon des grains | **100 µm** |
| E | module d'Young du matériau des grains (quartz) | **30 GPa** |
| γ | tension superficielle du liquide | **70 mN/m** |
| G | module de cisaillement effectif du sable humide | — |

Ce qu'on apprend pour le game design :
- La résistance dépend de **γ^(1/3)** → changer de liquide change peu (eau salée ~ eau douce).
- Elle dépend de **a^(−1/3)** → **plus les grains sont petits, plus c'est fort**. Diviser la taille des grains par 8 multiplie la rigidité par 2. **La granulométrie est un vrai levier de gameplay.**
- Elle dépend de **E^(2/3)** → le matériau des grains compte : basalte > quartz > calcaire tendre.

### 2.9.3 Modes de rupture

| Mode | Déclencheur | Signature visuelle | Prévention |
|---|---|---|---|
| **Flambement (*buckling*)** | élancement excessif | la colonne s'incline puis casse à mi-hauteur | élargir la base |
| **Cisaillement (*shear failure*)** | zone sèche ou mal tassée en bas, chargée | **un pan entier part d'un coup**, plan de rupture net à ~45–60° | noyer et brasser chaque couche |
| **Poinçonnement (*punching*)** | charge concentrée sur base molle | la structure s'enfonce, bourrelet autour | damer le sol d'assise |
| **Fluage / affaissement (*slumping*)** | trop d'eau, ou charge sur surplomb | déformation lente, la forme « fond » | drainer, alléger |
| **Effritement (*sloughing, crumbling*)** | dessèchement de surface | perte des arêtes, poudre qui coule | brumiser |
| **Écaillage (*spalling*)** | croûte sèche sur cœur humide | plaques qui se détachent | brumiser régulièrement |
| **Délamination** | couches de pound-up mal soudées | fissures **horizontales** régulières | brasser en mordant dans la couche précédente |
| **Rupture d'undercut** | surplomb trop long/mince | la dalle casse en traction à son encastrement | épaissir, raccourcir, charger au-dessus |
| **Affouillement (*scouring*)** | eau à la base | la base est creusée, le tout bascule | douve, digue, éloignement |
| **Liquéfaction** | vibration + saturation | effondrement instantané en flaque | pas de vibration, drainage |

---

## 2.10 Le principe de l'ombre : la seule « couleur » du sable

C'est un principe artistique fondamental, énoncé par les sculpteurs eux-mêmes :

> **« Toute la couleur doit être indiquée par des différences de texture : les textures profondes rendent les choses plus sombres ou ombrées, les surfaces lisses apparaissent plus claires ou en pleine lumière. »**

Conséquences pratiques, toutes exploitables comme mécaniques de jeu :

| Effet recherché | Moyen |
|---|---|
| **Noir / sombre** | creux profond, ébrasement, undercut, texture rugueuse |
| **Blanc / clair** | surface lisse, polie, plane, orientée vers le soleil |
| **Gris moyen** | texture fine régulière |
| **Contraste maximal** | surface lisse **adjacente** à un creux profond |
| **Illusion de profondeur** | ébrasement des ouvertures |
| **Illusion de légèreté** | découpes traversantes (*cut-throughs*) qui laissent voir le ciel |

**L'heure du jour compte** : un sculpteur professionnel juge sa pièce **en lumière rasante** (matin ou fin d'après-midi), car c'est là que les textures se lisent. À midi, tout est plat. Une mécanique de jeu peut exploiter ça (« revenez au coucher du soleil pour la photo »).

---

## 2.11 Ajouter de la matière : les techniques additives

Contrairement à ce qu'on croit, la sculpture sur sable **n'est pas purement soustractive**. Le vocabulaire même en témoigne : les professionnels distinguent **carving** (retrait uniquement) de **sculpting** (retrait + ajout).

### 2.11.1 Le *buttering* (beurrage / marouflage)

**Geste** : appliquer une **fine couche de sable saturé** à la truelle sur une surface, comme on beurre une tartine ou comme un plâtrier lisse un mur.

| Usage | Détail |
|---|---|
| **Lisser** une surface irrégulière | on comble les micro-défauts |
| **Souder** deux éléments (une tour posée sur une base) | le cordon de raccord |
| **Restaurer** une arête cassée | on refait de la matière puis on retaille |
| **Créer une peau fine** sur une zone friable | consolidation |

**Limite** : une couche beurrée **n'adhère jamais aussi bien** que le matériau d'origine. Elle **se décolle** en séchant si elle est trop épaisse (> ~5 mm) ou si le support était sec. Règle : **mouiller le support avant de beurrer**, et beurrer **fin**.

### 2.11.2 Le seau à boue (*mud bucket, slurry bucket*)

Tout sculpteur professionnel a en permanence à côté de lui **un seau de mélange sable+eau** en consistance de mortier. C'est son **stock de réparation**. Il sert à :
- rattraper une zone sur-taillée ;
- ajouter un petit élément (une cheminée, un pinacle) ;
- combler une fissure ;
- fabriquer des textures dégoulinées (végétation).

### 2.11.3 Le *feathering* (estompage)

**Geste** : passes très légères d'un pinceau souple ou du plat d'une spatule pour **fondre** une transition entre deux surfaces. C'est le geste de finition qui fait passer une pièce de « bien taillée » à « sculptée ».

---

## 2.12 Réparations, colmatage, consolidation

| Problème | Diagnostic | Réparation |
|---|---|---|
| **Petite fissure de retrait** | dessèchement de surface | brumiser, **tapoter** doucement pour refermer, laisser reprendre |
| **Fissure profonde** | plan de faiblesse structurel | ⚠️ souvent irréparable ; on peut **injecter de la boue** dans la fissure et charger, mais la zone reste faible |
| **Arête ébréchée** | choc ou dessèchement | mouiller, **beurrer** un cordon, laisser raffermir 2–5 min, retailler l'arête |
| **Trou / cratère** | chute de matière | remplir de sable saturé **en tassant au pouce**, laisser drainer, retailler |
| **Zone effondrée (petite)** | sous-tassement local | **hand stacking** : reconstruire par galettes, laisser prendre, retailler |
| **Zone effondrée (grande)** | rupture structurelle | remonter un mini-coffrage sur place et **refaire un pound-up local** |
| **Surface pulvérulente** | dessèchement | brumiser en brouillard **fin**, plusieurs passes ; jamais en jet |
| **Surface trop humide / molle** | sur-brumisation, pluie | **attendre**. Ne surtout pas travailler dessus : on écrase la structure |
| **Détail perdu (créneau cassé)** | — | beurrer un bloc de sable saturé, laisser prendre **5–10 minutes**, puis retailler entièrement |
| **Base affouillée par l'eau** | vague/ruissellement | détourner l'eau (rigole), puis **remblayer et damer** le pied |
| **Pattes d'oiseaux / trous** | oiseaux | reboucher à la boue, planter des **bird wires** |

**Règle universelle de la réparation** : *une réparation doit toujours être suivie d'un temps de prise avant retaille*. Le sable ajouté est saturé ; il faut qu'il draine et revienne en régime pendulaire (2 à 15 minutes selon l'épaisseur et la température) avant de pouvoir être taillé proprement. **Retailler trop tôt arrache la réparation.**

**Règle de compétition** : on ne peut ajouter **que du sable et de l'eau**. Aucun liant, aucune armature, aucun élément extérieur (sauf fixateur après la fin du temps). Les armatures internes (bambou, fil de fer) mentionnées dans certains contextes commerciaux sont **interdites en compétition pure**.

---

# 3. LES OUTILS

## 3.0 Philosophie de l'outillage

Fait fondamental du milieu, à comprendre avant de concevoir l'interface d'un jeu :

> **Il n'existe pas d'outillage professionnel standard de sculpture sur sable. Deux sculpteurs professionnels n'ont jamais la même caisse à outils.**

Les outils viennent de trois mondes :
1. **Le bâtiment** (maçonnerie, plâtrerie) : truelles, couteaux à enduire, dames, règles ;
2. **La cuisine et la pâtisserie** : spatules à glaçage, cuillères, cuillères à melon, fourchettes, couteaux à beurre, pailles ;
3. **La poterie et la sculpture** : mirettes, ébauchoirs, estèques, couteaux à palette.

Plus une quatrième catégorie : les **outils fabriqués maison**, taillés dans du bois ou du plastique, propres à chaque artiste.

**Conséquence gameplay** : un jeu réaliste devrait présenter une **caisse à outils hétéroclite et personnalisable**, pas un « menu d'outils de château ». La collecte et la personnalisation des outils est en soi un axe de progression très fidèle à la réalité.

---

## 3.1 Outils de terrassement et de masse

| Outil | Description précise | Geste | Effet sur le sable |
|---|---|---|---|
| **Pelle ronde / pelle de terrassier (*spade shovel*)** | lame arrondie, manche long | pelleter, creuser | **déplacement de volume**. Sert au creusement du trou d'eau et au remplissage du coffrage |
| **Pelle carrée (*square/scoop shovel*)** | lame plate rectangulaire | racler, ramasser | ramassage sur surface dure, nivellement, **brassage** de la couche |
| **Pelle de tranchée (*trenching shovel*)** | lame étroite et pointue | creuser étroit | douves, canaux, tranchées. **Deuxième pelle indispensable** du kit pro |
| **Pelle-jouet / pelle d'enfant** | plastique, petite | tout | étonnamment efficace pour les petits volumes ; le bord droit sert de racle |
| **Truelle de jardin (*garden trowel*)** | métal, main | creuser, lisser, tailler | polyvalente : creuse, taille les arêtes, aplanit les plans |
| **Râteau** | dents espacées | ratisser | **nivellement du terrain, effacement des traces de pas**, texture « champ labouré » |
| **Dame / demoiselle (*tamper*)** | plaque métallique de **15–20 cm** de côté, manche long, 3–8 kg | on la **lâche verticalement entre ses pieds** | **compaction** : l'outil du pound-up sur grands coffrages |
| **Pilon manuel** | version courte de la dame | frapper à la main | compaction dans les seaux et petits coffrages |
| **Plaque vibrante** | machine à moteur | vibration | compaction des sculptures géantes (événementiel) |
| **Brouette** | — | transporter | logistique du sable |

---

## 3.2 Contenants et coffrages

| Outil | Spécification | Usage |
|---|---|---|
| **Seau 20 L (5 gal)** de peinture | polypropylène, anse métal | **le contenant universel** : transport d'eau, coffrage (fond découpé), malaxeur, réserve de boue |
| **Seau à fond percé** | trous de 5 mm au fond | **mélange à égouttage contrôlé** : on obtient une consistance constante |
| **Seau-jouet crénelé** | plastique | tour à créneaux moulée |
| **Gobelets, pots, verres, boîtes** | tout récipient | **petites tourelles et colonnes** — le vrai outil de détail |
| **Entonnoir** | plastique | cônes, toits de tourelles |
| **Tube PVC (Ø 50–100 mm)** | tube de plomberie | colonnes, cheminées, **coffrage de précision pour élément vertical** |
| **Coffrage contreplaqué** | **CDX 5/8" (16 mm)** + 2×4, **1,2 × 1,2 m × 0,6 m** | le coffrage professionnel classique |
| **Flexi-form** | feuille PE / barrière anti-rhizomes, hauteur 30–60 cm, longueur 3–6 m | **le coffrage pro moderne**, cintré au diamètre voulu |
| **Serre-joints en C (*C-clamps*)** | petits, ×4 à ×8 | fermer les flexi-forms, **haut ET bas** |
| **Sangles à cliquet** | — | ceinturer les grands coffrages |
| **Ruban adhésif toilé (*duct tape*)** | — | **étanchéité des joints, à l'intérieur du coffrage** |
| **Bâche / film plastique** | — | protection pluie/soleil, transport, sol de travail |
| **Tamis / passoire (*sieve, riddle*)** | maille 2–5 mm | **retirer coquillages, cailloux, algues, mégots**. Indispensable pour le détail fin |
| **Passoire de cuisine** | maille fine | tamisage fin pour les toutes dernières couches |

---

## 3.3 Outils de taille — le cœur du métier

### 3.3.1 Les truelles (maçonnerie / plâtrerie)

| Outil | Dimension type | Geste | Effet |
|---|---|---|---|
| **Truelle langue de chat / à briqueter (*pointing trowel*)** — **Marshalltown 7" × 3"** est la référence citée | 18 × 7,5 cm | tenue à plat pour lisser, sur la tranche pour couper | **l'outil polyvalent numéro un** : dégrossit, coupe, lisse, tire les plans |
| **Truelle margée (*margin trowel*)** | lame rectangulaire étroite, 12–15 × 4 cm | tirer des lignes droites, tailler des méplats | **« l'outil à tout faire »** de plusieurs pros : coupe droite nette, corniches, bandeaux, joints |
| **Couteau à enduire / couteau de plaquiste (*drywall/mud knife*)** | lame souple 5–25 cm | tirer, lisser, rentrer dans les angles | **angles intérieurs nets**, grandes surfaces planes |
| **Truelle d'angle (*corner trowel*)** | interne ou externe | passer dans un angle | arêtes rentrantes et sortantes propres |
| **Truelle arrondie / de finition** | bords arrondis | lisser | surfaces courbes |
| **Truelle dentée demi-lune (*half-moon serrated trowel*)** | dents régulières | **tirer en travers de la surface**, à angle variable | **texture instantanée** : joints de brique, ondulations, écailles, bois |
| **Platoir / taloche** | large plaque | lisser à plat | grands plans |

### 3.3.2 Les couteaux et spatules de sculpteur

| Outil | Description | Usage précis |
|---|---|---|
| **Couteau à palette (*palette knife*)** — marque **Liquitex** souvent citée, **jeux de 16+** | lame fine, souple, en losange/goutte/langue | **l'outil de détail principal** : incisions, découpes de créneaux, arêtes, ouvertures |
| **Spatule à glaçage / à pâtisserie (*icing spatula*)** — **Ateco #1385** cité nommément | lame longue, souple, bout rond | lisser les grandes surfaces courbes, tirer les plans, glisser sous une chute |
| **Couteau à beurre** | plat, sans tranchant | découpe douce, détails, jouet efficace |
| **Couteau de cuisine / cutter** | tranchant | incisions nettes, à manier avec précaution |
| **Lame de scie à métaux (*hacksaw blade*)** | lame nue, dents fines | **traits fins très longs et parfaitement droits** : joints, marches, fentes de meurtrières |
| **Mirettes / boucles (*loop tools, clay loops*)** | anneau ou boucle métallique sur manche | **creusement contrôlé** : niches, fenêtres, cavités, ébrasements, chapiteaux |
| **Ébauchoir** | outil de potier en bois ou métal, double extrémité | modeler, marquer, arrondir |
| **Estèque** | plaquette souple (bois, métal, caoutchouc) | racler et lisser les courbes |
| **Pointeau / pointe métallique** (« l'outil à manche rouge ») | pointe fine | **le détail ultime** : yeux, coutures, lettrages, joints microscopiques |
| **Cuillère à melon (*melon baller*)** | demi-sphère sur manche | **portes, fenêtres arrondies, niches hémisphériques** — un appui-rotation et c'est fait |
| **Cuillère à soupe / à café** | — | gougeage, arches, creusement |
| **Cuillère à glace ancienne en aluminium** | avec racleur | **retirer le sable dans les espaces intérieurs étroits** (mentionnée par les pros) |
| **Fourchette** | — | **texture** : herbe, bois, cheveux, pierre brute ; joints multiples d'un coup |
| **Bâtonnets, cure-dents, chopsticks, brochettes** | bois | micro-détails, tracés préparatoires, perçages |
| **Peigne à cheval (*curry comb*)** | peigne à dents rondes | **texture régulière sur grandes surfaces planes** |
| **Peignes maison** | bois taillé en dents | textures personnalisées |
| **Patins de meuble (*furniture sliders*)** | disques plastiques lisses | **lissage ultra-fin de grandes surfaces** — donne un fini quasi poli |

### 3.3.3 Nettoyage et finition

| Outil | Description | Geste | Effet |
|---|---|---|---|
| **Paille (*drinking straw, blowing straw*)** | paille rigide, ou **tube de plomberie fin** | souffler un jet d'air précis à 2–5 cm | **retire les grains libres sans toucher la surface**. LE geste de finition |
| **Soufflette / poire à air** | poire en caoutchouc, soufflet | souffler | grandes zones, moins précis |
| **Pinceau plat large (2–5 cm)** | soies souples | balayer et lisser | **retire les grains ET adoucit la surface** |
| **Pinceau rond fin** | — | détail | dépoussiérage précis |
| **Brosse à dents** | — | texture fine, nettoyage | joints de brique |
| **Pinceau à maquillage / blaireau** | ultra-souple | **épousseter sans altérer le détail** — mentionné explicitement par les pros | finition finale |
| **Brosse dure / brosse à récurer** | soies raides | texture rugueuse | chaume, écorce, roche |
| **Plume** | — | le plus doux qui soit | ultime finition |

---

## 3.4 Gestion de l'eau

| Outil | Spécification | Usage |
|---|---|---|
| **Pulvérisateur à main (*spray bottle*)** | 0,5–1 L, **buse réglable en brouillard fin** | **maintien de l'humidité pendant la sculpture**. ⚠️ toujours en brouillard, jamais en jet |
| **Pulvérisateur à pression de jardin** | 5–8 L, à pomper | grandes surfaces, **application du fixateur** |
| **Arrosoir à pomme** | — | arrosage doux d'une zone |
| **Seau** | 20 L | noyage des couches |
| **Pompe immergée + tuyau** | événementiel | alimentation continue depuis un trou ou la mer |
| **Bidon / jerrican** | 10–20 L | réserve d'eau douce loin de l'eau |
| **Aspirateur à eau** | événementiel | **retirer l'eau excédentaire** d'une zone sans la toucher |
| **Éponge** | — | absorber une flaque locale |

---

## 3.5 Mesure, guidage et géométrie

| Outil | Usage |
|---|---|
| **Ficelle / cordeau** | tracer un cercle (compas improvisé : un doigt au centre, la ficelle tendue), aligner un mur, marquer une hélice |
| **Piquets** | fixer les cordeaux, délimiter le chantier |
| **Fil à plomb** (une ficelle + un caillou) | **contrôler la verticalité d'une tour** — indispensable, l'œil se trompe |
| **Niveau à bulle** | horizontalité des assises et des chemins de ronde |
| **Niveau laser** | pros, grandes pièces |
| **Règle / règle de maçon (règle alu)** | tirer un plan parfaitement droit, tracer les lits de brique |
| **Équerre** | angles droits |
| **Compas improvisé** (deux bâtons + ficelle, ou deux doigts écartés) | arcs, cercles, répétition d'une même dimension |
| **Gabarit / calibre en carton ou plastique** | reproduire un profil (moulure, arc, tuile) à l'identique plusieurs fois |
| **Photo de référence imprimée** | **standard professionnel** : les pros travaillent d'après image, jamais de mémoire |
| **Mètre ruban** | proportions |
| **Marqueurs / repères** (bâtonnets plantés) | matérialiser les hauteurs clés, garder les proportions pendant le dégrossissage |

---

## 3.6 Confort, sécurité et présentation

| Outil | Raison |
|---|---|
| **Genouillères / tapis de genoux** | une session dure 4 à 8 heures, à genoux |
| **Parasol / tonnelle** | protège le sculpteur **et le sable** du dessèchement |
| **Chapeau, crème solaire, lunettes** | réverbération sur le sable = brûlures |
| **Gants** | le sable humide + le sel = mains détruites en une journée |
| **Escabeau / échelle / échafaudage** | sculptures de plus de 2 m |
| **Bâches de protection** | pluie, vent, nuit |
| **Fils métalliques courts (*bird wires* / *butt pokers*)** | plantés au sommet pour **empêcher les oiseaux de se poser** |
| **Cordon / barrières** | tenir le public à distance |
| **Râteau de finition** | ratisser le pourtour pour la photo/le jury |

---

## 3.7 Tableau récapitulatif : outil → geste → effet

| Outil | Geste (verbe) | Effet sur le sable | Volume affecté | Phase |
|---|---|---|---|---|
| Pelle ronde | pelleter | déplacer | 3–8 L | terrassement |
| Pelle carrée | brasser | homogénéiser, chasser l'air | couche entière | pound-up |
| Dame | frapper | compacter | 20×20 cm × 15 cm | pound-up |
| Pieds | piétiner | compacter | 10×25 cm | pound-up |
| Manche de pelle | tapoter la paroi | vibrer, faire remonter l'eau | coffrage entier | pound-up |
| Truelle de maçon | trancher / tirer | dégrossir, aplanir | 50–500 cm³ | ébauche |
| Truelle margée | tirer droit | méplat, arête, corniche | 5–50 cm³ | mise en forme |
| Couteau à enduire | tirer à plat | lisser un plan | surface | mise en forme |
| Couteau à palette | inciser / trancher | découper, arête vive | 1–20 cm³ | détail |
| Mirette | gouger en rotation | creuser une cavité | 0,5–10 cm³ | détail |
| Cuillère à melon | appuyer-tourner | niche hémisphérique | 1–5 cm³ | détail |
| Lame de scie | rayer | trait fin, long, droit | ~0 | détail |
| Pointeau | piquer / rayer | micro-détail | ~0 | finition |
| Fourchette | rayer en parallèle | texture linéaire multiple | surface | texture |
| Truelle dentée | tirer en travers | texture régulière | surface | texture |
| Peigne | peigner | texture régulière large | surface | texture |
| Brosse dure | brosser | texture rugueuse | surface | texture |
| Pinceau souple | balayer | nettoyer + adoucir | surface | finition |
| Pinceau maquillage | épousseter | nettoyer sans altérer | surface | finition |
| Paille | souffler | retirer les grains libres | ~0 | finition |
| Patin de meuble | frotter à plat | polir | surface | finition |
| Pulvérisateur | brumiser | réhumidifier | surface + 2 mm | continu |
| Seau de boue + truelle | beurrer | **ajouter** de la matière | 5–200 cm³ | réparation |
| Main (galette) | plaquer + vibrer | **ajouter** un volume | 0,5–2 L | hand stacking |
| Main (dégouliné) | laisser couler | **ajouter** organique | 20–200 cm³ | drip |

---

# 4. VOCABULAIRE ET GLOSSAIRE FR/EN

> Le milieu de la sculpture sur sable travaille **en anglais**. Les termes anglais sont donc les termes de référence ; les équivalents français sont donnés (et parfois forgés, faute d'usage établi). Un jeu francophone crédible devrait afficher les deux, au moins dans les infobulles.

## 4.1 Techniques et procédés

| Terme EN | Terme FR | Définition précise |
|---|---|---|
| **Pound-up** | **Damage / montage par damage** | Le processus complet de remplissage et de compaction d'un coffrage pour fabriquer un bloc de sable dense. *« 80 % d'une sculpture est dans un bon pound-up. »* |
| **Hard pack / hard packing** | **Sable damé / compaction dure** | Sable comprimé dans un coffrage avant taille. Le seul état permettant surplombs, arches et découpes traversantes. |
| **Soft pack / soft packing** | **Modelage dans la masse** | Gros tas pelleté rapidement dont seule la peau extérieure est tassée à la main. 99 % des châteaux de plage. Densité faible, pas de surplomb possible. |
| **Form packing** | **Coffrage** | Technique du pound-up avec coffrage rigide ou souple. |
| **Hand stacking** | **Empilement à la main** | Empilement de poignées de sable saturé, fusionnées par vibration. |
| **Pancaking / pancake method** | **Méthode des galettes** | Variante d'empilement où chaque poignée est aplatie en galette avant fusion. |
| **Plopping** | **Plaquer** | Le geste de poser une poignée de sable saturé (« plop »). |
| **Jiggling** | **Vibrer / faire trembler** | Vibration de la main sur une galette pendant que l'eau s'échappe : c'est ce qui **fusionne** les couches. |
| **Drip castle / dribble castle / drizzle castle** | **Château dégoulinant** | Structure faite en laissant couler du sable en suspension, formant des stalagmites organiques. |
| **Kleckerburg** | *(allemand)* | Nom allemand du drip castle. |
| **Bucket method / moulding** | **Méthode du seau / moulage** | Remplir, tasser, retourner, tapoter, démouler. |
| **Volcano method** | **Méthode du volcan** | Faire un anneau de sable humide, verser l'eau au centre, malaxer comme du ciment, puis remonter le sable détrempé sur les flancs. |
| **Carving** | **Taille (soustractive)** | Ne retirer que de la matière. Techniquement, une sculpture hard-pack est « taillée », pas « sculptée ». |
| **Sculpting** | **Sculpture (additive + soustractive)** | Retirer **et** ajouter. |
| **Carve down / top-down carving** | **Tailler de haut en bas** | La règle absolue : on ne sculpte jamais du bas vers le haut. |
| **Roughing out / blocking in** | **Dégrossissage / ébauche** | Première passe : établir les grandes masses. |
| **Detailing** | **Détaillage** | Deuxième phase : ouvertures, moulures, escaliers. |
| **Texturing** | **Texturation** | Application des motifs de surface (brique, tuile, bois). |
| **Undercut** | **Contre-dépouille / dégagement** | Tailler **sous** un volume pour créer un surplomb. Spectaculaire et risqué ; critère de jugement en compétition. |
| **Overhang** | **Surplomb / encorbellement** | Volume en porte-à-faux. |
| **Cut-through** | **Découpe traversante / ajour** | Percement complet laissant voir le ciel à travers la sculpture. Très valorisé en compétition. |
| **Buttering** | **Beurrage / marouflage** | Appliquer une fine couche de sable saturé à la truelle pour lisser, souder ou réparer. |
| **Feathering** | **Estompage** | Passes très légères pour fondre une transition. |
| **Slurry / soup / mud** | **Barbotine / soupe / boue** | Mélange sable+eau au-delà de la saturation, sans cohésion. |
| **Mud bucket / slurry bucket** | **Seau de boue** | Réserve de mélange de réparation, en permanence à côté du sculpteur. |
| **Tamping / pounding** | **Damage / tassement** | Compaction par percussion. |
| **Curing** | **Prise / repos** | Temps de repos (souvent une nuit) entre le pound-up et la taille, pour drainage et raffermissement. |
| **Drowning the sand** | **Noyer le sable** | Mettre volontairement de l'eau en excès dans une couche de coffrage. |
| **Sifting** | **Tamisage** | Retirer coquillages, cailloux et débris. |
| **Blowing (with a straw)** | **Soufflage à la paille** | Retirer les grains libres par un jet d'air ciblé. |
| **Misting** | **Brumisation** | Réhumidifier en brouillard fin. |
| **Finish spray / wind spray / sealer** | **Fixateur** | Colle diluée (10 % colle à bois / 90 % eau, ou 20/80 PVA) pulvérisée en fin de travail. |
| **Stacking forms** | **Empilement de coffrages** | Poser un coffrage plus petit sur un bloc terminé pour monter. |
| **Wedding cake** | **Pièce montée** | Silhouette étagée typique de l'empilement de coffrages décroissants. |
| **De-forming / stripping forms** | **Décoffrage** | Retrait des coffrages, **toujours du haut vers le bas**. |
| **Site prep** | **Préparation du site** | Décapage, damage du sol, creusement du trou d'eau. |

## 4.2 Le matériau et sa physique

| Terme EN | Terme FR | Définition |
|---|---|---|
| **Sand-to-water ratio** | **Ratio sable/eau** | Classiquement 8 volumes de sable pour 1 d'eau à la mise en œuvre. |
| **Capillary bridge / pendular bridge** | **Pont capillaire / pont pendulaire** | Ménisque d'eau reliant deux grains, générant une force d'attraction par dépression de Laplace. |
| **Surface tension** | **Tension superficielle** | γ ≈ 72 mN/m pour l'eau à 20 °C. |
| **Capillary pressure / suction** | **Pression capillaire / succion** | Dépression à l'intérieur du ménisque, cause réelle de la cohésion. |
| **Pendular / funicular / capillary regime** | **Régimes pendulaire / funiculaire / capillaire** | Les trois états de saturation d'un granulaire humide. |
| **Cohesion (apparent)** | **Cohésion (apparente)** | Résistance au cisaillement à contrainte normale nulle. 0 pour le sable sec, 1–8 kPa humide. |
| **Angle of repose** | **Angle de repos / de talus naturel** | Pente maximale d'un tas libre : 30–34° sec, ~45° humide. |
| **Angle of internal friction (φ)** | **Angle de frottement interne** | 29–32° (lâche) à 38–45° (dense, anguleux). |
| **Liquefaction** | **Liquéfaction** | Perte de résistance d'un sable saturé sous vibration : le solide devient fluide. |
| **Dilatancy (Reynolds)** | **Dilatance** | Un granulaire dense doit augmenter de volume pour se cisailler. Cause de l'auréole sèche sous le pied. |
| **Bulking** | **Foisonnement** | Augmentation de volume (jusqu'à +30 %) d'un sable légèrement humide, qui résiste au tassement. |
| **Void ratio (e)** | **Indice des vides** | Volume des vides / volume des solides. 0.75–0.85 lâche, 0.45–0.55 dense. |
| **Porosity (n)** | **Porosité** | Vides / volume total. 43–46 % lâche, 31–36 % dense. |
| **Relative density (Dr)** | **Densité relative / indice de densité** | Position entre l'état le plus lâche et le plus dense possible. |
| **Coordination number (Z)** | **Nombre de coordination** | Nombre de contacts par grain. 4–5 lâche, 6–8 dense. |
| **Angularity / roundness** | **Angularité / rondeur** | Forme des grains. Anguleux = accroche ; rond = roule. |
| **Sorting / polydispersity** | **Classement / polydispersité** | Un sable mal trié (tailles variées) se compacte mieux. |
| **Grain size (D50)** | **Diamètre médian** | 0.15–0.30 mm pour un sable de sculpture. |
| **Silt / clay / fines** | **Limon / argile / fines** | Particules < 62 µm : le **liant naturel** du bon sable de sculpture. |
| **Dead sand** | **Sable mort** | Sable de maçonnerie lavé, débarrassé de ses fines : ne tient pas. |
| **Wash-out sand** | **Sable de rejet de lavage** | Le sable le plus recherché : anguleux + fines. |
| **Quarry / pit sand** | **Sable de carrière / de fosse** | Grains fraîchement fracturés, très anguleux. Le meilleur. |
| **Water table** | **Nappe phréatique** | Niveau d'eau atteint en creusant sur la plage. |
| **Effective stress (σ')** | **Contrainte effective** | σ' = σ − u. C'est elle qui gouverne la résistance. |
| **Pore pressure (u)** | **Pression interstitielle** | Pression de l'eau entre les grains. Positive = danger. |
| **Salt cementation** | **Cimentation par le sel** | Les sels de l'eau de mer cristallisent en séchant et cimentent les contacts. |

## 4.3 Modes de rupture et pathologies

| Terme EN | Terme FR | Définition |
|---|---|---|
| **Blowout** | **Éclatement / départ de pan** | Rupture soudaine où un pan entier de sculpture se détache et part. |
| **Shear failure** | **Rupture par cisaillement** | Plan de rupture net (45–60°) causé par une zone basse mal mouillée/tassée. Le mode de rupture le plus destructeur. |
| **Buckling** | **Flambement** | Une colonne trop élancée s'incline puis casse sous son propre poids. |
| **Slumping** | **Affaissement / fluage** | Déformation lente d'un sable trop humide qui « fond ». |
| **Sloughing** | **Délitement / effritement de surface** | La surface glisse ou s'écoule par manque d'humidité ou de compaction. |
| **Spalling** | **Écaillage** | Détachement de la croûte sèche du cœur humide. |
| **Crumbling** | **Émiettement** | Perte de matière granulaire (sable trop sec ou trop rond). |
| **Delamination** | **Délamination / feuilletage** | Séparation entre deux couches de pound-up mal soudées. Fissures horizontales régulières. |
| **Scouring** | **Affouillement** | Creusement de la base par l'eau courante. |
| **Punching** | **Poinçonnement** | Enfoncement d'une charge concentrée dans un sol mou. |
| **Speckling** | **Piquage / grêlage** | Petits cratères causés par les gouttes de pluie. |
| **Shrinkage cracking** | **Fissuration de retrait** | Fissures fines dues au séchage, surtout si trop d'argile. |
| **Wash-out** | **Ravinement** | Sillon creusé par un ruissellement. |
| **Crust** | **Croûte** | Peau durcie de 1–5 mm formée par migration et dépôt des sels et fines en surface. |

## 4.4 Architecture castrale

### 4.4.1 Défenses hautes

| FR | EN | Définition |
|---|---|---|
| **Crénelage / créneaux (l'ensemble)** | *crenellation, battlement* | L'alternance de merlons et de créneaux au sommet d'un mur. |
| **Merlon** | *merlon* | La partie **pleine** dressée entre deux créneaux. |
| **Créneau** | *crenel, crenelle, embrasure* | Le **vide** entre deux merlons. |
| **Parapet** | *parapet* | Le muret protégeant le chemin de ronde. |
| **Chemin de ronde** | *wall-walk, allure* | Passage praticable au sommet d'un mur. |
| **Archère / meurtrière / arbalétrière** | *arrow slit, arrow loop, loophole* | Fente verticale étroite de tir. |
| **Ébrasement** | *splay, embrasure* | Élargissement de l'ouverture vers l'intérieur (permet le débattement de l'archer). |
| **Mâchicoulis** | *machicolation* | Ouverture au sol d'un encorbellement, entre corbeaux, pour le tir vertical. |
| **Corbeau** | *corbel* | Pierre en saillie portant un encorbellement. |
| **Encorbellement** | *corbelling* | Construction en surplomb portée par des corbeaux. |
| **Hourd** | *hoarding, brattice* | Galerie de bois temporaire en surplomb (ancêtre du mâchicoulis). |
| **Bretèche** | *bretèche* | Petit encorbellement local au-dessus d'une porte. |
| **Échauguette / poivrière** | *bartizan, turret* | Petite tourelle en encorbellement à un angle. |
| **Tour de guet** | *watchtower* | Tour d'observation. |

### 4.4.2 Murs et enceintes

| FR | EN | Définition |
|---|---|---|
| **Courtine** | *curtain wall* | Mur reliant deux tours. |
| **Enceinte** | *enceinte, ring wall* | L'ensemble des murs de défense. |
| **Basse-cour / baile** | *bailey, ward* | Cour close à l'intérieur de l'enceinte. |
| **Chemise** | *chemise, mantlet wall* | Muret entourant un donjon. |
| **Château concentrique** | *concentric castle* | Deux enceintes emboîtées. |
| **Contrefort** | *buttress* | Renfort vertical perpendiculaire au mur. |
| **Arc-boutant** | *flying buttress* | Contrefort déporté relié par un arc. |
| **Talus / fruit / glacis** | *batter, talus, glacis* | Épaississement incliné du pied de mur. |
| **Cordon / larmier / bandeau** | *string course, drip course, cornice* | Moulure horizontale saillante. |
| **Parement / appareil** | *facing, bond, ashlar* | Mise en œuvre visible des pierres. |
| **Bossage** | *rustication* | Pierre au centre bombé et aux joints creusés. |
| **Chaîne d'angle / harpe** | *quoins* | Grosses pierres alternées à l'angle d'un mur. |
| **Assise / lit** | *course, bed joint* | Rangée horizontale de pierres. |
| **Boutisse / panneresse** | *header / stretcher* | Pierre posée en travers / en long. |
| **Revêtement de talus** | *revetment* | Habillage maçonné d'un talus ou d'une berge. |
| **Plinthe / socle / soubassement** | *plinth, base course* | Base élargie d'un mur ou d'une sculpture. |

### 4.4.3 Ouvertures et circulations

| FR | EN | Définition |
|---|---|---|
| **Porterie / châtelet d'entrée** | *gatehouse* | Entrée fortifiée. |
| **Barbacane** | *barbican* | Ouvrage avancé protégeant la porte. |
| **Herse** | *portcullis* | Grille coulissante verticale. |
| **Pont-levis** | *drawbridge* | Passerelle relevable. |
| **Assommoir** | *murder hole* | Trou au plafond d'un passage d'entrée. |
| **Poterne** | *postern, sally port* | Petite porte dérobée. |
| **Arc en plein cintre** | *round arch, Romanesque arch* | Demi-cercle. |
| **Arc brisé / ogive** | *pointed arch, Gothic arch* | Deux arcs de cercle se rencontrant en pointe. |
| **Arc en encorbellement** | *corbel arch* | Assises en surplomb progressif ; **le plus adapté au sable**. |
| **Arc outrepassé** | *horseshoe arch* | Plus qu'un demi-cercle. |
| **Clef de voûte** | *keystone* | Pierre sommitale d'un arc. |
| **Voussoir** | *voussoir* | Chaque pierre d'un arc. |
| **Piédroit** | *jamb, pier* | Montant vertical portant l'arc. |
| **Intrados / extrados** | *intrados / extrados* | Face intérieure / extérieure d'un arc. |
| **Naissance / reins** | *springing / haunch* | Zones de l'arc. |
| **Linteau** | *lintel* | Traverse droite au-dessus d'une ouverture. |
| **Tympan** | *tympanum* | Panneau au-dessus d'une porte, sous l'arc. |
| **Escalier en vis** | *spiral staircase, newel stair* | Escalier hélicoïdal autour d'un noyau. |
| **Giron / contremarche** | *tread / riser* | Profondeur / hauteur d'une marche. |
| **Garde-corps / balustrade** | *balustrade, handrail* | — |
| **Fenêtre à meneaux** | *mullioned window* | Fenêtre divisée par des montants. |
| **Oculus / rosace** | *oculus / rose window* | Ouverture circulaire. |

### 4.4.4 Défenses basses et abords

| FR | EN | Définition |
|---|---|---|
| **Douve** | *moat* | Fossé en eau entourant le château. |
| **Fossé sec** | *dry ditch, dry moat* | Fossé sans eau. |
| **Contrescarpe / escarpe** | *counterscarp / scarp* | Talus extérieur / intérieur d'un fossé. |
| **Levée / berme / digue** | *berm, dike, levee* | Bourrelet de terre. |
| **Brise-lames** | *breakwater* | Ouvrage cassant l'énergie des vagues. |
| **Épi** | *groyne* | Ouvrage perpendiculaire au rivage. |
| **Palissade** | *palisade* | Clôture de pieux. |
| **Motte** | *motte* | Tertre artificiel portant le donjon. |
| **Motte castrale** | *motte-and-bailey* | Le type primitif : motte + basse-cour. |
| **Lice** | *lists* | Espace entre deux enceintes. |

### 4.4.5 Corps de bâtiment et toitures

| FR | EN | Définition |
|---|---|---|
| **Donjon** | *keep, donjon, great tower* | Tour maîtresse, dernier réduit. |
| **Logis seigneurial / grande salle** | *great hall* | Bâtiment d'habitation. |
| **Chapelle** | *chapel* | — |
| **Flèche** | *spire* | Toit très élancé. |
| **Coupole / dôme** | *dome, cupola* | — |
| **Toit conique** | *conical roof, candle-snuffer roof* | Le toit de tourelle classique. |
| **Faîtage / arêtier / noue** | *ridge / hip / valley* | Lignes de toiture. |
| **Avant-toit / débord** | *eaves, overhang* | Le débord dont l'ombre fait toute la crédibilité. |
| **Tuiles / écailles / ardoises / chaume** | *tiles / scales / slate / thatch* | Textures de couverture. |
| **Arête / arris** | *arris* | L'arête vive entre deux surfaces — le critère de qualité ultime en sable. |

## 4.5 Compétition et milieu

| Terme EN | Terme FR | Définition |
|---|---|---|
| **Master Sand Sculptor** | **Maître sculpteur sur sable** | Statut requis pour les championnats du monde : avoir concouru en catégorie Masters à Québec, South Padre Island, Virginia Beach, Fort Myers ou Imperial Beach. |
| **Solo / Doubles** | **Solo / Duo** | Catégories de compétition, jugées séparément. |
| **Speed carve / sculpt-off** | **Épreuve de rapidité** | Format court (1–2 h). |
| **Sand allotment** | **Quota de sable** | Nombre de tonnes attribuées à chaque sculpteur. |
| **Degree of difficulty** | **Difficulté technique** | Critère de notation : surplombs impossibles, ajours, hauteur, évidements, arches, éléments fins, maîtrise du sable. |
| **Wow factor** | **Effet « wow »** | Critère d'impact au premier regard. |
| **Use of site** | **Utilisation du site** | Critère : occupation de l'espace, propreté du pourtour. |
| **Continuity of theme** | **Continuité du thème** | Critère : cohérence de qualité sur toute la pièce. |
| **People's choice** | **Prix du public** | Vote du public. |
| **Bird wires / butt pokers** | **Fils anti-oiseaux** | Fils métalliques plantés au sommet contre les oiseaux. |
| **Ephemeral art** | **Art éphémère** | La catégorie artistique. |

---

# 5. LES ERREURS CLASSIQUES ET LES PIÈGES

## 5.1 Les dix erreurs fatales, par ordre de fréquence

### 1. Pas assez d'eau — surtout à la base
**C'est LA cause numéro un d'effondrement.** Une petite zone de la couche du bas restée sèche ou insuffisamment tassée va se comprimer sous la charge, créer une discontinuité, et déclencher un **cisaillement qui peut emporter tout un côté de la sculpture**. Le pire : le sculpteur ne le voit pas venir — la faute a été commise deux heures plus tôt et se révèle quand la sculpture est presque finie.
- **Symptôme précurseur** : une fissure horizontale ou oblique, ou un léger bourrelet qui apparaît au pied.
- **Prévention** : noyer chaque couche, brasser à la pelle, et **ne jamais négliger la première couche**, qui supportera tout le reste.

### 2. Trop d'eau au mauvais moment
Le corollaire. Noyer pendant le remplissage : oui. Continuer à arroser un bloc déjà en cours de taille : non. Un bloc sur-humidifié flue, perd ses arêtes, et devient impossible à détailler.
- **Symptôme** : la truelle « laboure » au lieu de couper ; la surface reste brillante ; les créneaux s'arrondissent tout seuls.
- **Prévention** : brumisation **en brouillard**, jamais en jet ; laisser sécher 10 minutes avant de reprendre.

### 3. Décoffrer trop tôt
L'eau libre est encore visible en surface, le sculpteur est impatient, il lève le coffrage : le bloc s'affaisse. Il faut **attendre que l'eau ait disparu** — de 2 minutes (petit seau) à 30–60 minutes (grand coffrage), voire une nuit pour du très gros.

### 4. Décoffrer de bas en haut
Retirer les coffrages du bas d'abord, ou tous en même temps, expose la base — encore molle et chargée du poids total — à l'étalement. **Toujours du haut vers le bas, un ou deux coffrages à la fois.**

### 5. Sculpter de bas en haut
Erreur de débutant absolue. Les chutes détruisent le travail fini, la base s'amincit sous charge maximale, et les vibrations du travail supérieur détruisent le détail inférieur. **La règle est absolue.**

### 6. Sable non tamisé
Un coquillage, un caillou ou un morceau de bois dans le bloc, et le couteau à palette **accroche** au moment précis où l'on découpe un créneau : l'outil dérape, l'arête part. Sur un détail fin, c'est irréparable.
- **Prévention** : tamiser au moins le sable des couches supérieures (celles qui recevront le détail).

### 7. Base trop étroite
Le débutant sous-estime systématiquement la largeur de base nécessaire. Rappel : **H_max ∝ R^(2/3)** — doubler la hauteur exige **2,83×** le rayon.
- **Prévention** : partir plus large que « nécessaire ». Il est facile de rétrécir une base, impossible de l'élargir.

### 8. Undercut trop agressif
Le surplomb tient au moment de la coupe... et cède trois minutes plus tard, quand la contrainte s'est redistribuée et que le fluage a opéré. Ou bien il tient toute la journée et cède au séchage.
- **Prévention** : y aller par étapes, attendre entre deux passes, épaissir, et **tester la sonorité** (un sable bien tassé sonne « plein » quand on le tapote).

### 9. Construire trop près de l'eau
Le plus cruel : cinq heures de travail effacées par une seule vague. La marée montante ne se négocie pas.
- **Prévention** : consulter l'horaire de marée, construire **quand la mer descend**, se placer au-dessus de la laisse de haute mer.

### 10. Ignorer le vent et le soleil
Un vent de 30 km/h sur du sable qui sèche arrache les arêtes en une heure. Le soleil de midi assèche la surface plus vite qu'on ne peut sculpter.
- **Prévention** : parasol, brumisation régulière, travailler tôt le matin ou en fin d'après-midi, fixateur en fin de session.

## 5.2 Les erreurs de second ordre

| Erreur | Conséquence | Correction |
|---|---|---|
| **Sauter le brassage** de la couche dans le coffrage | poches d'air, zones sèches, cisaillement à retardement | brasser à la pelle jusqu'à mordre dans la couche précédente |
| **Couches trop épaisses** (> 20 cm) | seul le haut de la couche est compacté | 15–20 cm maximum |
| **Ne tasser qu'au centre** | bord friable, effondrement des flancs au décoffrage | tasser en **spirale du bord vers le centre**, insister sur la périphérie |
| **Ne pas étanchéifier le coffrage** | l'eau fuit latéralement, la couche ne se sature pas | ruban adhésif toilé à l'intérieur des joints |
| **Retirer le coffrage en le basculant** | on arrache la peau du bloc | lever **strictement vertical** |
| **Tailler avec un outil sale** (sable sec collé) | rayures parasites | essuyer et mouiller l'outil régulièrement |
| **Piquer / poignarder au lieu de raser** | éclats, cratères | **« ne jamais piquer, poignarder ni hacher »** — on taille et on rase |
| **Enlever trop de matière d'un coup** | risque de perdre la pièce entière | petites passes, souvent |
| **Ne pas reculer pour regarder** | proportions fausses (l'œil de près ment) | reculer toutes les 10 minutes, regarder de tous les angles |
| **Détail trop peu profond** | invisible à 3 m (une seule couleur !) | surcreuser par rapport à la logique architecturale |
| **Marcher autour de la pièce** | vibrations, traces, affaissement du sol d'assise | définir un chemin, ratisser à la fin |
| **Poser des outils sur la sculpture** | empreintes, casse | plateau ou seau dédié |
| **Oublier le seau de boue** | aucune réparation possible | toujours en avoir un |
| **Ne pas prévoir de marge de hauteur** | on finit plus bas que prévu | monter 10–20 % plus haut que le sujet |
| **Confondre « lisse » et « fini »** | pièce plate, sans lecture | contraste texture / lissage |
| **Faire les créneaux avant que le fût soit droit** | il faudra toucher au fût, donc aux créneaux | **fût d'abord, créneaux ensuite** |
| **Utiliser de l'eau douce quand la mer est à 20 m** | on perd la cimentation par le sel | eau de mer si possible |
| **Ne pas reboucher son trou en partant** | danger mortel + piège à tortues | rebouchage obligatoire |

## 5.3 Tableau de diagnostic express

| Symptôme observé | Cause probable | Action immédiate |
|---|---|---|
| La surface **poudre** et coule | trop sec | brumiser en brouillard fin |
| L'outil **laboure** au lieu de couper | trop humide | attendre 10–15 min |
| L'outil **accroche** puis dérape | corps étranger | tamiser à l'avenir ; extraire délicatement |
| Fissures **horizontales régulières** | délamination des couches | structure compromise ; alléger le haut |
| Fissure **oblique** à la base | cisaillement naissant | **danger immédiat** : ne plus rien enlever en bas, alléger le sommet |
| La pièce **s'incline** lentement | flambement ou base molle | alléger, contreforter, remblayer le pied |
| Les arêtes **s'arrondissent** toutes seules | vent + dessèchement | brumiser, écran, fixateur |
| **Petits cratères** sur la surface | pluie | bâcher |
| La base est **creusée** | affouillement | rigole de dérivation, remblai, damage |
| **Écailles** qui se détachent | croûte sèche sur cœur humide | brumiser légèrement et souvent |
| **Trous ronds** au sommet | oiseaux | bird wires |
| Effondrement **soudain et total** | liquéfaction / cisaillement / vibration | rien à faire — recommencer, et noyer/tasser mieux |

---

# 6. PROGRESSION / RITUEL D'UN BUILD COMPLET

## 6.1 Le déroulé d'une session sérieuse (journée sur la plage, 4 à 6 h)

### Phase 0 — Avant de partir (J−1)
- Consulter les **horaires de marée** : viser une marée descendante ou basse.
- Consulter la **météo** : vent < 20 km/h idéalement, ciel voilé plutôt que grand soleil.
- Préparer la **caisse à outils**, remplir les bidons d'eau douce si la mer est loin.
- Choisir un **sujet** et emporter une **image de référence imprimée** (pratique professionnelle standard : les pros ne travaillent jamais de mémoire).

### Phase 1 — Repérage et choix du site (0:00 → 0:15)
1. Marcher la plage, **tester le sable à la main** (test de la boule).
2. Repérer la **laisse de haute mer** (ligne de débris) : limite absolue.
3. Choisir une **zone plane**, sans pente, sans passage.
4. Vérifier la profondeur de la **nappe** en creusant un trou test de 30 cm.
5. Orienter le chantier : la **face principale vers le soleil de fin d'après-midi** (lumière rasante = meilleure lecture des textures).

### Phase 2 — Le trou d'eau et la logistique (0:15 → 0:35)
1. Creuser le **trou d'eau**, côté mer, à 2–4 m du futur château.
2. Descendre jusqu'à ce que l'eau monte seule (40–100 cm).
3. **Élargir en cuvette**, empiler le déblai **côté dune** : c'est le stock de sable.
4. Installer le **poste de travail** : seaux, outils, parasol, seau de boue.
5. Poser les **limites du chantier** au cordeau ou au pied.

### Phase 3 — Préparation de la plateforme (0:35 → 0:50)
1. **Décaper** la couche sèche superficielle sur toute l'emprise (5–15 cm).
2. **Niveler** au râteau.
3. **Damer** le sol d'assise : c'est la fondation, on la traite comme telle.
4. **Tracer** l'emprise de la sculpture au doigt ou au cordeau.

### Phase 4 — Le pound-up (0:50 → 2:30) — la phase la plus longue et la plus ingrate
Pour chaque coffrage, de bas en haut :
1. Poser et **serrer** le coffrage, ruban adhésif aux joints.
2. **Cycle de couche** ×3 à ×5 : verser 15–20 cm → noyer → brasser → tasser → contrôler la réduction 2:1.
3. Araser au ras du coffrage.
4. Poser le coffrage suivant (plus petit) et recommencer.
5. Répéter jusqu'à **10–20 % au-dessus** de la hauteur finale visée.
6. **Laisser drainer** (15 min à 1 h selon la taille).

> C'est ici que se joue tout. **80 % de la qualité finale est décidée pendant cette phase**, où l'on ne voit encore rien du résultat.

### Phase 5 — Décoffrage progressif et dégrossissage (2:30 → 3:15)
1. Attendre la disparition de l'eau libre.
2. Tapoter, desserrer, **lever le coffrage du haut**, strictement vertical.
3. **Tracer** au doigt les grands axes et les repères de proportion.
4. **Dégrossir le volume supérieur** à la pelle et à la truelle.
5. Ne descendre au coffrage suivant qu'une fois le niveau supérieur dégrossi.
6. Répéter niveau par niveau.

### Phase 6 — Mise en forme (3:15 → 4:15)
1. Définir les **volumes secondaires** : tours individualisées, corps de logis, toitures ébauchées.
2. **Régulariser les fûts** (verticalité au fil à plomb, tour au patin).
3. Établir les **plans horizontaux** (chemins de ronde, terrasses, corniches).
4. Reculer, vérifier, corriger.

### Phase 7 — Détaillage (4:15 → 5:15)
Ordre recommandé, du haut vers le bas :
1. **Toitures** (cônes, faîtages) — texture de tuiles du bas du toit vers le haut.
2. **Créneaux et parapets**.
3. **Corniches et bandeaux** (une passe qui change tout).
4. **Ouvertures** : portes, arches, fenêtres, meurtrières (contour → évidement → intrados → ébrasement).
5. **Escaliers** (rampe → marches du haut vers le bas).
6. **Ponts et passerelles**.
7. Nettoyage à la paille **après chaque élément**, pas à la fin.

### Phase 8 — Texturation (5:15 → 5:45)
1. **Appareillage** : lits horizontaux d'abord, joints verticaux ensuite, en quinconce.
2. **Textures de matériaux** : bois, chaume, végétation, roche.
3. **Terrain environnant** : dunes, chemins, végétation dégoulinée.
4. Alterner **surfaces lisses** et **zones texturées** pour le contraste.

### Phase 9 — Finitions (5:45 → 6:05)
1. **Souffler** à la paille tous les grains libres, de haut en bas.
2. **Épousseter** au pinceau souple.
3. **Reprendre les arêtes** qui se sont adoucies.
4. **Brumiser** légèrement l'ensemble.
5. **Ratisser le pourtour**, effacer toutes les traces de pas.
6. Creuser la **douve** et les **canaux** — **en dernier**, car ils fragilisent la base.

### Phase 10 — Protection et présentation (6:05 → 6:20)
1. **Fixateur** au pulvérisateur (10 % colle à bois / 90 % eau), 2–4 passes légères, de haut en bas.
2. Planter les **bird wires** au sommet.
3. **Photographier en lumière rasante**, appareil à hauteur de la sculpture.
4. **Reboucher le trou d'eau**.

## 6.2 Le déroulé d'une pièce de compétition (3 jours)

| Jour | Plage horaire | Activité |
|---|---|---|
| **J−1** | — | Livraison du sable, montage des coffrages, **pound-up assisté** (souvent réalisé par l'organisation, avec pelleteuses et plaques vibrantes). Une pièce de 20–30 t est montée en 4–8 h. |
| **J1 matin** | 8 h – 12 h | Décoffrage progressif, **dégrossissage** de la masse : composition générale. Le plus gros volume retiré. |
| **J1 après-midi** | 13 h – 18 h | Mise en forme des volumes principaux. **Bâchage pour la nuit**. |
| **J2** | 8 h – 18 h | Détaillage. La journée la plus longue et la plus fine. Brumisation permanente. |
| **J3 matin** | 8 h – 12 h | Détail final, texture, finition. |
| **J3 après-midi** | 13 h – 15 h | **Fin du temps de sculpture** (outils posés). |
| **J3** | 15 h – 16 h | **Fixateur** autorisé, ratissage du site, bird wires. |
| **J3 soir** | — | Jugement, puis exposition publique pendant des semaines. |

**Chiffres d'échelle** :
- Pièce solo de compétition : **7 à 30 tonnes** de sable ; ~2 jours pour 7 t par un sculpteur seul.
- Championnat du monde : **~545 tonnes (1,2 million de livres)** de sable importé, sculpteurs de 13 pays, ~16 000 $ de dotation.
- Hauteurs de compétition : jusqu'à **4,3 m (14 pieds)**.
- Record du monde : **21,16 m**, Blokhus (Danemark), 2 juillet 2021, base > 30 m, ~5 000 t de sable.

## 6.3 Check-list de session (utilisable telle quelle comme UI de jeu)

```
[ ] Maree verifiee, fenetre horaire connue
[ ] Site plat, au-dessus de la laisse de haute mer
[ ] Test de la boule concluant
[ ] Trou d'eau creuse, cote mer
[ ] Deblai empile cote dune
[ ] Plateforme decapee, nivelee, damee
[ ] Coffrages etancheifies
[ ] Chaque couche : 15-20 cm -> noyee -> brassee -> tassee -> reduite de moitie
[ ] Hauteur montee a +15 % du sujet
[ ] Drainage attendu (plus d'eau libre)
[ ] Decoffrage du haut vers le bas, vertical
[ ] Reperes de proportion traces
[ ] Sculpture du haut vers le bas, grossier -> fin
[ ] Recule et verifie toutes les 10 min
[ ] Seau de boue disponible
[ ] Brumisation reguliere
[ ] Textures : lits d'abord, joints ensuite, quinconce
[ ] Soufflage a la paille apres chaque element
[ ] Douve et canaux en dernier
[ ] Fixateur, 2-4 passes legeres
[ ] Bird wires plantes
[ ] Pourtour ratisse, traces effacees
[ ] Photo en lumiere rasante
[ ] Trou rebouche
```

## 6.4 Courbe de progression d'un sculpteur (utile pour concevoir le tutoriel du jeu)

| Niveau | Ce qu'il sait faire | Ce qui le bloque |
|---|---|---|
| **Débutant (jour 1)** | Seau retourné, tour unique, douve | Le sable est trop sec ; il tape sur la structure ; il sculpte de bas en haut |
| **Amateur (quelques sessions)** | Empilement de seaux, créneaux au couteau, fenêtres | Base trop étroite ; il n'a pas de seau de boue ; ses arêtes s'effritent |
| **Intermédiaire (une saison)** | Hand stacking, arches simples, escaliers, textures de brique | Il ne sait pas encore décoffrer proprement ; ses proportions dérivent |
| **Avancé** | Pound-up avec coffrages, undercuts modérés, arches profondes, escaliers en vis | Le temps ; la gestion de l'humidité sur une journée entière |
| **Compétiteur** | Ajours, surplombs extrêmes, figures, compositions narratives multi-blocs | Le sable disponible ; la météo ; le jury |
| **Maître** | Conçoit en fonction du sable disponible ; anticipe les modes de rupture ; sculpte à l'échelle de 30 t | — |

---

# 7. IMPLICATIONS POUR LE GAMEPLAY

> Section d'opinion argumentée. Tout ce qui précède est factuel ; ce qui suit est une proposition de traduction ludique, fondée sur ce que la matière réelle a d'intéressant.

## 7.0 La thèse centrale

Ce qui rend la sculpture sur sable fascinante n'est **pas** la construction en tant que telle. C'est le fait que :

1. **Le matériau se dégrade en permanence** (séchage, vent, marée) — il y a une horloge intégrée ;
2. **La qualité du résultat est décidée bien avant qu'on la voie** (le pound-up) — il y a une dette technique ;
3. **On ne peut qu'enlever** (à 90 %) — chaque geste est irréversible ;
4. **Tout finira détruit** — l'œuvre est éphémère par nature, ce qui déplace la valeur de l'objet vers le geste et la photo.

Un jeu qui ne modélise que « poser des blocs de sable » rate tout. Un jeu qui modélise **humidité, compaction et irréversibilité** tient un sujet unique.

> **Le pitch en une phrase : un jeu de sculpture soustractive où le matériau lui-même est un compte à rebours.**

## 7.1 Le modèle physique à exposer

### 7.1.1 Les trois champs scalaires

Chaque voxel / chaque cellule du volume de sable devrait porter **trois valeurs** :

| Champ | Symbole | Plage | Signification | Évolution dans le temps |
|---|---|---|---|---|
| **Humidité** | `w` | 0.0 – 1.0 (0 = sec, 0.35 ≈ saturation) | teneur en eau volumique normalisée | **décroît** par évaporation (fonction du soleil, du vent, de la profondeur sous la surface) ; **augmente** par arrosage, pluie, remontée capillaire depuis la nappe ; **percole** vers le bas |
| **Compaction** | `d` | 0.0 – 1.0 (0 = versé, 1 = damé au max) | densité relative | **augmente** par tassement, vibration, charge au-dessus ; **ne décroît jamais spontanément** (sauf liquéfaction) |
| **Granulométrie / qualité** | `q` | 0.0 – 1.0 | angularité + fines + finesse ; propriété du **type de sable**, pas de la cellule individuelle | constante par gisement ; modifiée par tamisage (+q) |

### 7.1.2 La fonction de cohésion

La grandeur dérivée qui gouverne tout :

```
cohesion(w, d, q) = C_max · f_w(w) · f_d(d) · f_q(q)

f_w(w)  = courbe en cloche asymétrique :
             0            si w = 0
             monte vite   de w=0 à w=0.03
             plateau      de w=0.03 à w=0.15   <-- fenêtre confortable
             chute        de w=0.15 à w=0.30
             0            si w > 0.30          <-- liquéfié

f_d(d)  = 0.15 + 0.85·d^1.5     (le tassement est super-linéaire)

f_q(q)  = 0.4 + 0.6·q
```

**Décision de design importante** : garder le **plateau large** entre 3 % et 15 %. C'est physiquement exact (régime pendulaire) **et** c'est bon pour le joueur : il ne doit pas se battre en permanence avec un curseur d'humidité. La punition doit venir des **extrémités**, pas du réglage fin.

### 7.1.3 Le critère de rupture

Un modèle Mohr-Coulomb simplifié suffit et donne des comportements très crédibles :

```
resistance_au_cisaillement = cohesion + σ_normale · tan(φ(d, q))
```

avec un point clé, **contre-intuitif mais crucial** :

> **La contrainte de compression verticale doit AUGMENTER la résistance locale.**

C'est physiquement vrai (les arches de grès naturelles tiennent grâce au poids qu'elles portent) et c'est ludiquement génial : le joueur découvre qu'**alléger un surplomb peut le faire tomber**, et que **charger le dessus d'une arche la solidifie**. C'est le genre de contre-intuition qui fait la réputation d'un jeu de physique.

### 7.1.4 Les modes de rupture à implémenter (par ordre de priorité)

| Priorité | Mode | Déclencheur | Rendu |
|---|---|---|---|
| **P0** | **Effritement de surface** | `w < seuil_sec` en surface | grains qui coulent, arêtes qui s'arrondissent en temps réel |
| **P0** | **Effondrement par angle** | pente locale > angle_stable(cohesion) | avalanche de surface, le sable coule jusqu'à retrouver l'angle |
| **P0** | **Rupture de surplomb** | moment fléchissant > résistance en traction | la dalle casse à son encastrement et tombe d'un bloc |
| **P1** | **Cisaillement de masse** | zone basse de faible `d`·`w` sous forte charge | **plan de rupture net à 45–60°**, un pan entier glisse et part |
| **P1** | **Flambement** | élancement H/R > seuil(cohesion) | la colonne s'incline puis casse à mi-hauteur |
| **P1** | **Fluage** | `w > 0.20` sous charge | déformation lente et continue, la forme « fond » |
| **P2** | **Délamination** | interface entre deux couches de pound-up mal soudées | fissures horizontales, glissement d'un étage |
| **P2** | **Liquéfaction** | `w > 0.28` + événement vibratoire | effondrement instantané en flaque |
| **P2** | **Affouillement** | eau courante au contact de la base | la base est creusée, la structure bascule |

## 7.2 La traduction des techniques en mécaniques

| Technique réelle | Mécanique de jeu proposée |
|---|---|
| **Pound-up** | Mode « coffrage » : le joueur pose un coffrage (forme + diamètre + hauteur), puis répète un **cycle en 4 temps** : pelleter → noyer → brasser → damer. Chaque étape a son mini-geste. Le volume **visiblement diminue de moitié** à chaque damage. Une **jauge de qualité par couche** (invisible plus tard) est mémorisée : les défauts se paieront à la sculpture. |
| **Hand stacking** | Mini-jeu de timing : le joueur pose une galette, une **jauge d'eau** remonte visuellement en anneau brillant ; il doit relâcher **dans la fenêtre optimale**. Trop tôt = liaison faible (mémorisée) ; trop tard = liaison faible aussi. Un « perfect » donne un joint invisible et solide. |
| **Soft pack** | Outil de sculpture « rapide » : gros volume instantané, mais `d` faible → aucun surplomb possible. Sert au terrain et aux socles. |
| **Méthode du seau** | Enchaînement contextuel : remplir (maintenir), tasser (rythme), retourner (geste de souris/stick), tapoter, lever **droit** (précision du geste vertical mesurée). Un lever de travers casse la tour. |
| **Drip castle** | Le joueur maintient un bouton ; le sable coule. **La hauteur de la main** et **le débit** sont contrôlés en continu et changent la forme. Mécanique très « cozy », très satisfaisante, sans échec possible. Parfaite comme respiration entre deux phases exigeantes. |
| **Décoffrage** | Un geste **vertical** à faire proprement, avec un feedback haptique/sonore. Le joueur doit d'abord **tapoter** (rompre l'adhérence), sinon la peau du bloc s'arrache. **Le jeu doit refuser** ou pénaliser le décoffrage du bas avant le haut. |
| **Taille de haut en bas** | **Ne pas l'imposer par une règle artificielle : la faire émerger de la simulation.** Les chutes tombent réellement et abîment le détail en dessous ; la base réellement amincie sous charge cisaille. Le joueur *découvre* la règle. C'est infiniment mieux qu'un message d'erreur. |
| **Undercut** | Outil dédié avec **prévisualisation du risque** (surbrillance de la zone de traction). L'effondrement doit arriver **avec un délai de quelques secondes** — le suspense est la moitié du plaisir. |
| **Buttering / réparation** | Le joueur puise dans son **seau de boue** (ressource consommable qu'il doit recharger au trou d'eau) et applique de la matière. La réparation a un **temps de prise** pendant lequel elle n'est pas taillable : une vraie contrainte de rythme. |
| **Brumisation** | Outil toujours accessible (un bouton dédié, pas un menu). Effet visuel immédiat : la surface fonce, les arêtes redeviennent nettes. |
| **Souffler à la paille** | Micro-action extrêmement satisfaisante : un souffle, les grains libres s'envolent, l'arête apparaît nette. **À rendre gratuite, rapide et sonore** — ce sera l'action la plus utilisée du jeu. |
| **Tamisage** | Choix stratégique en amont : tamiser coûte du temps mais augmente `q` → permet plus de détail. Belle décision économique. |
| **Fixateur** | Action de fin de session : arrête la dégradation, verrouille l'état, déclenche le mode photo. **Rituel de clôture.** |

## 7.3 Les paramètres à exposer au joueur — et comment

**Principe directeur : ne jamais montrer un nombre là où une texture suffit.**

| Paramètre | Exposition recommandée | Anti-pattern à éviter |
|---|---|---|
| **Humidité** | **Couleur et brillance du sable** : sec = beige clair mat et poudreux ; humide = brun foncé mat ; saturé = brun brillant avec reflet spéculaire ; en flaque = miroir. Le joueur lit l'humidité **d'un coup d'œil**, comme dans la vraie vie. | une barre de progression « Humidité : 42 % » |
| **Compaction** | **Le son**, avant tout : le sable lâche fait un bruit mat et sourd, le sable damé un bruit sec et « plein ». Plus : le **niveau du sable qui descend** pendant le damage, et un léger changement de grain de la surface. | un pourcentage |
| **Qualité du sable** | **Le test de la boule** comme geste diégétique disponible partout. Plus le grain visuel de la texture. | une fiche technique |
| **Stabilité / risque** | **Micro-signaux** : de fines fissures apparaissent, quelques grains coulent, un léger craquement se fait entendre 2–4 secondes avant la rupture. Le joueur expérimenté apprend à les lire. | une jauge rouge « INSTABLE » |
| **Angle de repos** | Visible naturellement : le sable **coule** quand on dépasse la pente. | — |
| **Temps restant / marée** | **Diégétique** : le niveau de l'eau, la position du soleil, la longueur des ombres, le bruit des vagues qui se rapproche. | un timer numérique |
| **Vent** | Les grains secs qui filent en surface, le drapeau, le son. | — |

**Mode « expert » optionnel** : un overlay de debug/analyse qui affiche les champs `w`, `d`, et les contraintes en fausses couleurs. Les joueurs hardcore adoreront, et c'est gratuit à faire puisque les données existent.

## 7.4 Rendre le pound-up intéressant — le vrai défi de design

**Problème** : dans la réalité, le pound-up c'est **40 % du temps total** et c'est physiquement épuisant et visuellement ingrat. Un jeu ne peut pas demander 40 minutes de pelletage.

**Solutions, par ordre de préférence :**

1. **Compression temporelle avec engagement rythmique.** Le cycle « verser → noyer → brasser → damer » devient une **boucle rythmique de 15–25 secondes** par couche, avec un feedback tactile fort (le bruit sourd du damage, l'eau qui remonte, le sable qui descend). Répétée 4 à 6 fois, c'est un **rituel**, pas une corvée — comparable au bruit du ponçage dans *PowerWash Simulator* ou du versement dans un jeu de café.
2. **Qualité mémorisée, révélée plus tard.** Chaque couche stocke sa qualité. Une couche bâclée devient une **zone de faiblesse invisible** qui se manifestera 20 minutes plus tard par un cisaillement spectaculaire. C'est la mécanique la plus fidèle à la réalité **et** la plus dramatique. Le joueur qui a triché **le sait** et le redoute.
3. **Automatisation progressive.** Comme dans la réalité (où l'organisation monte le bloc pour les compétiteurs), le joueur débloque des outils qui accélèrent : dame → dame lourde → plaque vibrante → équipe d'assistants. **La progression du jeu, c'est passer de moins en moins de temps sur le pound-up.**
4. **Le rendre optionnel selon l'ambition.** Un petit château au seau ne demande pas de pound-up. Seule l'ambition (hauteur, ajours, surplombs) l'exige. Le joueur choisit sa dette.

## 7.5 Feedbacks sensoriels : la crédibilité passe par là

### 7.5.1 Son — probablement le levier le plus fort

| Événement | Son |
|---|---|
| Pelle qui entre dans le sable sec | crissement granuleux aigu, court |
| Pelle qui entre dans le sable humide | son mat, lourd, « pfff » sourd |
| Pelle qui entre dans le sable saturé | succion, « schlop » liquide |
| Eau versée d'un seau | glouglou puis absorption progressive qui **change de timbre** à mesure que la couche se sature — le son dit au joueur quand arrêter |
| Damage sur sable lâche | **« pouf »** mat, résonance courte |
| Damage sur sable dense | **« poc »** sec, claquant, aigu — **le son du succès** |
| Tapotement de la paroi du coffrage | résonance métallique/plastique, avec la vibration visible de l'eau |
| Décoffrage réussi | frottement + « schlick » de décollement |
| Couteau qui entre dans du sable idéal | **le son crucial** : un « chhh » net, court, satisfaisant. Comparable au couteau dans du beurre froid. C'est le son signature du jeu. |
| Couteau dans du sable trop sec | grattement, crissement, chute de grains |
| Couteau dans du sable trop humide | son mou, ventouse, « schplok » |
| Couteau qui accroche un coquillage | **« crk »** sec et dissonant + micro-tremblement de la caméra |
| Souffle à la paille | souffle court + tintement des grains qui roulent |
| Pinceau | balayage doux |
| Micro-fissure qui se forme | **craquement à peine audible** — l'avertissement |
| Effondrement partiel | glissement + « fwoosh » |
| Effondrement total | grondement sourd, puis silence |
| Vague qui atteint la douve | clapotis |
| Vague qui atteint la base | sifflement de succion, sable qui se dissout |
| Ambiance | mouettes, ressac, vent dans le parasol |

### 7.5.2 Visuel

| Élément | Traitement |
|---|---|
| **Humidité** | rampe de couleur + rugosité + spéculaire (voir 7.3). Le **front de séchage** doit être visible et progresser lentement sur les surfaces exposées |
| **Arêtes** | **le critère de qualité visuel n°1**. Une arête nette doit produire une ligne de lumière franche. Un système de « netteté d'arête » qui se dégrade avec le séchage et les vibrations serait un excellent indicateur |
| **Grains libres** | quelques centaines de grains individuels visibles sur les surfaces fraîchement taillées, qui disparaissent au souffle. Détail minuscule, effet énorme |
| **Chutes** | le sable retiré **tombe réellement** et s'accumule en cône au pied. Il faut le déblayer. C'est un rappel constant de la règle du haut vers le bas |
| **Ombres** | **éclairage rasant obligatoire** au moins à certains moments. Sans ombres portées, une sculpture de sable est illisible. Prévoir un cycle jour/nuit et un mode photo au soleil bas |
| **Traces** | empreintes de pas, traces d'outils, marques de coffrage sur les faces du bloc (les vraies sculptures gardent la marque des joints du coffrage !) |
| **Ruissellement** | l'eau versée doit **percoler visiblement**, foncer le sable en descendant, et former des flaques |
| **Micro-fissures** | apparaissent avant la rupture, se propagent |
| **Effondrement** | le sable qui tombe doit se comporter comme du sable : il coule, il forme un cône, il ne rebondit pas |
| **Croûte** | après séchage, un très léger changement de teinte et de rugosité |

### 7.5.3 Haptique (manette)

| Événement | Retour |
|---|---|
| Damage | impact fort, court, avec une résonance qui **change selon la densité** |
| Coupe dans du bon sable | vibration continue légère, régulière |
| Coupe dans du sable sec | vibration granuleuse irrégulière |
| Outil qui accroche | à-coup net |
| Micro-fissure | pulsation très faible — l'avertissement subliminal |
| Effondrement | grondement long |
| Gâchettes adaptatives (DualSense) | **résistance proportionnelle à la densité du sable** pendant la coupe : c'est LE cas d'usage idéal de cette technologie |

## 7.6 Progression et objectifs

### 7.6.1 Axes de progression (aucun n'est un arbre de compétences classique)

| Axe | Contenu |
|---|---|
| **Outils** | Collecte progressive d'outils hétéroclites — fidèle à la réalité où chaque sculpteur bricole sa caisse. On commence avec une pelle-jouet et une cuillère ; on finit avec 40 outils dont une truelle Marshalltown, un jeu de 16 couteaux à palette et une cuillère à glace en aluminium chinée. **Chaque outil ouvre un geste, pas un bonus de stat.** |
| **Coffrages** | Seau → seau sans fond → bidon → flexi-form → coffrages contreplaqué → coffrages modulaires. Débloque la hauteur et la géométrie. |
| **Sables / lieux** | Chaque plage a **son sable**, avec ses valeurs de `q`. Débloquer un nouveau lieu, c'est débloquer un nouveau matériau, donc de nouvelles possibilités **et** de nouvelles limites. Une plage à sable rond force un design pyramidal ; une carrière permet les ajours. **C'est le meilleur système de progression possible pour ce jeu.** |
| **Savoir-faire** | Un carnet/manuel qui se remplit à mesure que le joueur découvre les techniques, avec les vraies explications physiques. Le savoir est le vrai déblocage. |
| **Références** | Bibliothèque d'images de référence (styles de châteaux, régions, époques) à débloquer, qui servent de guides de construction optionnels. |

### 7.6.2 Modes de jeu

| Mode | Description | Public |
|---|---|---|
| **Bac à sable libre (*sandbox*, littéralement)** | Pas de marée, pas de timer, sable parfait, tous les outils. Pour créer sans pression. | tous |
| **Journée à la plage (cozy)** | Une session de 4–6 h compressée, marée basse, météo clémente. Objectif : finir avant le coucher du soleil, prendre la photo. | cœur de cible |
| **Course contre la marée** | La marée monte. Le joueur doit choisir : monter plus haut, ou construire des digues et des douves pour gagner des vagues. **Aucune victoire finale possible** — le score est le nombre de vagues survécues et la qualité atteinte. Mélancolique, magnifique, et parfaitement fidèle. | ceux qui veulent de la tension |
| **Compétition** | Sujet imposé, temps imposé (3 « jours »), quota de sable, jury notant selon les **vrais critères** : difficulté technique (surplombs, ajours, hauteur), exécution artistique, originalité, continuité du thème, utilisation du site, effet « wow ». | compétiteurs |
| **Speed carve** | 1 heure, bloc déjà monté. Pure sculpture. | sessions courtes |
| **Restauration** | On donne au joueur une sculpture abîmée (pluie, oiseaux, vandalisme) à réparer. Enseigne le beurrage et la réparation. | variation |
| **Coopératif (doubles)** | Deux joueurs sur la même pièce, comme les catégories « doubles » réelles. Un fait le pound-up pendant que l'autre sculpte. | social |
| **Photo / galerie** | Le mode photo n'est pas un extra : c'est **la seule forme de permanence** dans un art éphémère. Il doit être excellent — lumière, heure, angle, profondeur de champ — et la galerie partageable. |

### 7.6.3 Défis et objectifs (exemples concrets)

- **« Le test de la boule »** — identifier le bon sable sur une plage inconnue avant de commencer.
- **« Deux fois plus haut »** — comprendre par l'expérience qu'il faut 2,83× le rayon. Objectif : doubler la hauteur de sa tour précédente.
- **« Ajour »** — réaliser une découpe traversante qui laisse voir le ciel.
- **« Sans coffrage »** — atteindre 1,20 m en hand stacking pur.
- **« Zéro réparation »** — finir une pièce sans jamais utiliser le seau de boue.
- **« Marée haute »** — faire survivre une sculpture à une marée complète grâce aux ouvrages de protection.
- **« Sable pourri »** — réussir une belle pièce sur la pire plage du jeu (contrainte créative).
- **« Une seule couleur »** — réaliser une pièce jugée uniquement sur la lisibilité de ses textures en lumière rasante.
- **« Le donjon »** — reproduire un château historique réel d'après plan.
- **« L'escalier en vis »** — la pièce de virtuosité.

## 7.7 Ce qu'il faut absolument éviter

| Anti-pattern | Pourquoi c'est mortel |
|---|---|
| **Le sable comme matériau de construction type Minecraft** | Le sable de château n'est pas un bloc empilable. Toute la matière du sujet est dans la **continuité** du volume et dans la **soustraction**. |
| **Des « pièces prédéfinies » à poser (tour, mur, porte)** | Ça supprime le geste, qui est tout. À la limite : des **coffrages** de formes variées, jamais des bâtiments prêts. |
| **Un undo illimité** | L'irréversibilité *est* le sujet. Proposer au maximum **un** undo court (« oups »), ou pas du tout hors mode libre. La réparation par beurrage est le vrai undo, et elle coûte. |
| **Une jauge d'humidité numérique** | Casse la lecture sensorielle. |
| **Une fenêtre d'humidité étroite** | Physiquement faux (le plateau pendulaire est large) et frustrant. |
| **Un pound-up sauté ou entièrement automatisé dès le début** | On perd le cœur de la pratique et la dette technique. |
| **Un sable qui ne sèche jamais** | Supprime l'horloge, donc la tension. |
| **Des effondrements aléatoires** | Chaque effondrement doit être **causalement traçable** à une décision du joueur. Sinon c'est de l'injustice, pas de la difficulté. |
| **Un effondrement sans avertissement** | Il faut toujours 2–4 secondes de micro-signaux (fissures, craquement, grains qui coulent). |
| **Une seule plage / un seul sable** | Le sable *est* la variable de contenu la plus riche du jeu. |
| **Punir l'échec par une perte de progression** | L'échec fait partie du métier : les pros perdent des pièces régulièrement. L'échec doit être **spectaculaire et instructif**, pas punitif. |

## 7.8 Notes d'implémentation technique

| Sujet | Recommandation |
|---|---|
| **Représentation du volume** | Grille de voxels avec extraction de surface (Surface Nets ou Dual Contouring plutôt que Marching Cubes : bien meilleures **arêtes vives**, ce qui est exactement le critère de qualité du sable). Résolution suggérée : **2–4 mm par voxel** pour une pièce de 1–2 m → 500³ à 1000³ ; envisager un **octree** ou des chunks avec raffinement local sur les zones sculptées. |
| **Champs `w` et `d`** | Stockés par voxel, en 8 bits chacun. Diffusion/percolation calculée sur GPU (compute shader), à basse fréquence (5–10 Hz suffisent). |
| **Stabilité** | Ne pas tenter une simulation FEM complète. Une approche **cellulaire** suffit et donne d'excellents résultats : pour chaque voxel de surface, calculer la charge portée (somme au-dessus), l'angle local, et comparer à la résistance locale. Propagation itérative des ruptures. |
| **Avalanches** | Automate cellulaire classique de tas de sable (comparaison de pente au seuil, transfert de matière). Très peu coûteux, très crédible. |
| **Chutes / débris** | Convertir la matière effondrée en **particules** puis la réintégrer dans la grille au repos. |
| **Grains libres de surface** | Système de particules purement cosmétique, sur les faces fraîchement taillées. Effacé par le souffle/le pinceau. |
| **Outils** | Chaque outil = un **volume de coupe** (SDF : sphère, capsule, prisme, disque, plan) + un profil de retrait + un profil de lissage + un profil de texture. Le geste du joueur balaie ce volume le long d'un chemin. |
| **Textures gravées** | Ne pas les faire en géométrie voxel (trop fin) : les appliquer comme **déplacement/normal map procédural projeté** sur la surface, avec un vrai déplacement de quelques voxels uniquement pour les joints les plus profonds. |
| **Marques de coffrage** | Petit détail à ne pas oublier : les faces décoffrées portent les marques des joints du coffrage. Gratuit visuellement, énorme pour la crédibilité. |
| **Sauvegarde** | La compression RLE/octree d'un volume de sable est très efficace (grandes zones homogènes). |
| **Photo mode** | Rendu haute qualité avec SSAO fort et lumière rasante — c'est là que le travail du joueur devient visible. |

## 7.9 Le ton : cozy, mais pas mou

La bonne cible émotionnelle n'est pas « détente sans enjeu ». C'est :

> **La concentration paisible d'un artisan qui sait que son travail sera détruit ce soir.**

Cela veut dire :
- Un rythme **lent**, des gestes **longs**, un son **riche** ;
- Une **pression réelle** mais jamais anxiogène (la marée, le soleil, le vent) ;
- Une **acceptation de la perte** intégrée à la boucle : la photo, la galerie, le carnet ;
- Et surtout : **la satisfaction du geste juste** — le couteau qui entre net dans un sable parfaitement humide, l'arête qui apparaît, la paille qui souffle les derniers grains. Si ce micro-moment est parfait, le jeu est réussi.

---

# 8. SOURCES

## 8.1 Sculpteurs professionnels et ressources techniques du milieu

- **Sandscapes** — *Sand Sculpture Basics* et *Intermediate Sand Sculpture* : http://www.sandscapes.com/how_to/ (référence historique sur les coffrages 4 pieds, le contreplaqué CDX 5/8", les formes polygonales, « toutes les sables ne se valent pas »)
- **Carl Jara / artcleveland** — *Process* : https://www.artcleveland.com/process (les trois méthodes de packing, couches de 5 pouces, tampage en spirale, liste d'outils : deux pelles, Marshalltown 52, couteau à palette, tube de plomberie ; coffrages inférieurs laissés comme échafaudage)
- **Broken Glass Sand Sculptures** — *Sand Sculpting 101* : https://www.bgsandsculptures.com/sand-sculpting-101 (flexie forms, seaux 5 gallons sans fond, serre-joints en C, duct tape, couches de 6 pouces, « you can never add too much water », Ateco #1385, distinction carving/sculpting)
- **Broken Glass Sand Sculptures** — *Good sand vs. evil sand* : https://www.bgsandsculptures.com/blog/good-sand-vs-evil-sand (angularité, wash-out sand, dead sand, échelle de Wentworth, Golfe vs Atlantique)
- **Broken Glass Sand Sculptures** — *Let's collapse that sand sculpture* : https://www.bgsandsculptures.com/blog/want-to-learn-how-to-collapse-your-sand-sculpture-lets-do-it (modes de rupture : eau insuffisante à la base, cisaillement, vibrations, design trop ambitieux)
- **Broken Glass Sand Sculptures** — *FAQ* : https://www.bgsandsculptures.com/faqs-1 (durées de vie, colle à bois 10/90, sable de carrière vs plage, liste d'outils, pluie)
- **Siesta Sand** — *got sand? Pile it, Pound it, Sculpt it* : https://siestasand.us/sand-sculpting-6-14/ (« pile it, pound it, sculpt it », 300+ coffrages au Crystal Classic, barrière anti-rhizomes, dame de 6–8 pouces, réduction 6→3 pouces, coffrages ≤ 2 pieds)
- **Siesta Sand** — *Tools, to Each His Own* (Brian Wigglesworth) : https://siestasand.us/sand-sculpting-7-14/ (Marshalltown 7×3, couteaux Liquitex par jeux de 16, truelle margée, truelle dentée demi-lune, cuillère à glace aluminium, curry comb, patins de meuble, pinceau à maquillage, Willy Spheres de Wilfred Stijger)
- **Siesta Sand** — *Got Sand?* : https://siestasand.us/sansculpting-9-14/ (coffrages de 2 pieds empilés, retrait du haut, bird wires / butt pokers, cisaillement dû à une zone mal mouillée en base, « sculpting is much easier, the sand will cut smoothly when very wet »)
- **Just Sand and Water** — *How to make a sand sculpture* : https://www.justsandandwater.com/799904201174/ (sable tamisé avec limon/argile, couches de 6–8 pouces, « retirez le sable autour de votre dessin », seau de réparation)
- **Sand Castle Lessons (South Padre Island)** — *Sand Castle Science* : https://sandcastlelessons.com/sandcastlescience/ (les cinq techniques : soft packing, drip castling, hand stacking, forming, wet packing ; « l'eau n'est PAS la colle » ; test de la sphère)
- **Sons of the Beach / Sandcastle Central** — *Sandcastles Made Simple*, technique du hand stacking : https://kk.org/cooltools/sandcastles-mad/ et http://www.sandcastlecentral.com/ (le « jiggle » au moment où l'eau s'échappe, coffrages 5/3/2 pieds)
- **Port Aransas** — *Sandcastle Building Tips* : https://www.portaransas.org/beach/sandcastle-building/ (trou jusqu'à la nappe, déblai côté dune, méthode des galettes détaillée, « ne jamais piquer, poignarder, hacher »)
- **The Bermudian** — *Learn to Build an Incredible Sandcastle* : https://www.thebermudian.com/culture/how-to/learn-to-build-an-incredible-sandcastle/ (ratio 1:8, méthode du volcan, arches attaquées des deux côtés, escaliers ½ pouce × ½ pouce, cuillère à melon)
- **Santa Cruz Parent** — *Sand Sculpting 101* : https://santacruzparent.com/sand-sculpting-101/ (buttering, feathering, undercut, sloughing, liste d'outils, texturation au peigne et à la paille)
- **Everything Beaches** — *Essential Tools and Tips for Sand Sculpting Like a Pro* : https://everythingbeaches.com/essential-tools-and-tips-for-sand-sculpting-like-a-pro/ (couches de 3 pouces après tassement, fixateur ~1 an, tableau d'outils)
- **SandRate** — *Mastering the Art of Sand Sculpting* : https://www.sandrate.com/blog/mastering-the-art-of-sand-sculpting-techniques-tools-and-tips-from-expert-practitioners/ (repères de proportion, mouvement continu vs stop-and-start, curing, bâches anti-vent)
- **CBC Race Against the Tide** — *Expert tips to take your sand sculptures to the next level* (Damon Langlois : beaucoup d'eau pour moins compacter ; margin trowel comme « everything tool »)
- **Adventure Aquarium** — *6 Tips for Sand Sculpting (from a professional)* : https://www.adventureaquarium.com/blog/6-tips-for-sand-sculpting-from-a-professional/
- **Instructables** — *Dribble Castle Sandcastle*, *Drizzle Castles*, *Ultra-Portable Sand Sculpture Forms*
- **The Kid Should See This** — *Drip Castles: making sand-slurry towers in real time* : https://thekidshouldseethis.com/post/drip-sandcastle-tidal-island-realtime

## 8.2 Physique et science du sable

- **Pakpour M., Habibi M., Møller P., Bonn D.** — *How to construct the perfect sandcastle*, **Scientific Reports 2, 549 (2012)** : https://www.nature.com/articles/srep00549 (fraction volumique optimale ~1 %, hauteur max ∝ R^(2/3), flambement élastique, G = 0.054·a^(−1/3)·E^(2/3)·γ^(1/3) avec a = 100 µm, E = 30 GPa, γ = 70 mN/m)
- **Physics World** — *Top tips for super sandcastles: explore the weird world of sand* : https://physicsworld.com/a/top-tips-for-super-sandcastles-explore-the-weird-world-of-sand/ (ratio 8:1 de Matthew Bennett, seuil de rupture à ~15 % du volume / 35 % des pores, microtomographie X de Herminghaus, quicksand, angularité, polydispersité, cimentation par le sel)
- **Physics World** — *Secret of sandcastle building revealed*
- **Mitarai N. & Nori F.** — *Wet granular materials*, **Advances in Physics 55, 1–45 (2006)**, arXiv:cond-mat/0601660 (régimes pendulaire, funiculaire, capillaire ; forces capillaires ; cohésion)
- **Lu N., Wu B., Tan C.P.** — *Tensile Strength of Unsaturated Sand* : https://www.pc-progress.com/Images/Personal/NLu/Publications/NLJ54200904.pdf (résistance en traction : croissance en régime pendulaire, pic en funiculaire, décroissance en capillaire)
- **Experimental models for cohesive granular materials: a review**, arXiv:2501.10830
- **Micro-mechanical Failure Analysis of Wet Granular Matter**, arXiv:1604.06881
- ***Nature Geoscience*, juillet 2014** — étude sur le rôle de la **gravité** dans la stabilité des arches et piliers de grès, vulgarisée par **Science News Explores** : https://www.snexplores.org/article/bracing-sand-sculptures-gravity (cubes de 10 cm chargés de 1 kg → piliers en sablier **plus résistants** que le cube d'origine ; la compression protège de l'érosion)
- **Wikipedia** — *Angle of repose* : https://en.wikipedia.org/wiki/Angle_of_repose (sable sec ~34°, sable humide ~45°)
- **Wikipedia** — *Dilatancy (granular material)* : https://en.wikipedia.org/wiki/Dilatancy_(granular_material) (dilatance de Reynolds)
- **Encyclopédie de l'Environnement** — *Qu'est-ce que la dilatance du sable ?* : https://www.encyclopedie-environnement.org/en/zoom/what-is-sand-expansion/
- **ABC Science** — *Dry footprints on wet sand* : https://www.abc.net.au/science/articles/2013/10/14/3868363.htm
- **Practical Engineering** — *Why Are Beach Holes So Deadly?* : https://practical.engineering/blog/2025/4/1/... (sécurité des trous de plage)
- **Scientific American** — *How to Build the Perfect Sandcastle — According to Science*
- **PBS North Carolina** — *The Science of Sandcastles* : https://www.pbsnc.org/blogs/science/the-science-of-sandcastles/
- **Australian Academy of Science (Curious)** — *How to make the perfect sandcastle* : https://curious.science.org.au/technology-future/how-make-perfect-sandcastle
- **Certified MTP** — *Density of Sand: Bulk, Dry, Wet* : https://blog.certifiedmtp.com/density-of-sand-a-guide-for-practical-applications/ (1442–1602 kg/m³ sec, jusqu'à 1900 kg/m³ compacté ; indices des vides typiques)

## 8.3 Compétition, règlements et records

- **Harrisand — World Championships of Sand Sculpture** : https://harrisand.org/ (critères d'éligibilité Master Sand Sculptor)
- **US Sand Sculpting — World Masters** : https://ussandsculpting.com/the-art/the-sculptors/world-masters/
- **Neptune Festival — International Sand Sculpting Championship** (Virginia Beach) : https://www.neptunefestival.com/events/international-sand-sculpting-championship/ (22 sculptures, 12 solos + 10 duos, 3 jours, colle à bois 10 % / eau 90 %)
- **Parksville Beach Festival — Rules & Judging** : https://www.parksvillebeachfest.ca/sculptors/rules-judging/ (critères : difficulté technique, surplombs, ajours, hauteur, évidements, arches, contrôle du sable)
- **Cannon Beach Sandcastle Contest — Rules and Judging** : https://www.cannonbeach.org/events-and-festivals/sandcastle-contest/sandcastle-contest-rules-and-judging/
- **Leap Sandcastle Classic — Judging Rubric & Build Rules** : https://leapsandcastleclassic.org/rubric-and-rules/
- **Hampton Beach Master Sand Sculpting Classic** : https://hamptonbeach.org/events/sand-sculpture-event/
- **Matanzas Inn** — *The Ultimate Guide to the Sand Sculpting Championship* (Fort Myers / American Sand Sculpting Championship)
- **Guinness World Records** — *Tallest sandcastle* : https://www.guinnessworldrecords.com/world-records/tallest-sandcastle (**21,16 m / 69 ft 5 in**, Skulpturparken Blokhus, Danemark, 2 juillet 2021 ; base > 30 m ; > 6 400 tonnes courtes de sable)
- **Panama Jack** — *6 of the World's Best Sand Sculpting Competitions*
- **Wikipédia** — *Sand festival* : https://en.wikipedia.org/wiki/Sand_festival

## 8.4 Architecture castrale

- **World History Encyclopedia** — *An Illustrated Glossary of Castle Architecture* : https://www.worldhistory.org/article/1233/an-illustrated-glossary-of-castle-architecture/
- **Great Castles** — *Castle Glossary* : https://www.great-castles.com/glossary.html
- **Wikipedia** — *Merlon*, *Embrasure*, *Machicolation*, *Curtain wall (fortification)*, *Concentric castle*, *Corbel arch*
- **Kastra.eu** — *Castles Nomenclature* : https://www.kastra.eu/infnamen.php
- **University of Mississippi** — *Castle & Siege Terminology* : https://home.olemiss.edu/~tjray/medieval/castle.htm

## 8.5 Divers / vulgarisation

- **Wikipédia** — *Sand art and play* : https://en.wikipedia.org/wiki/Sand_art_and_play (drip castles, kleckerburg, techniques, fixateurs autorisés en compétition)
- **Wikipédia (fr)** — *Château de sable* : https://fr.wikipedia.org/wiki/Château_de_sable (soft packing / hand stacking / moulage en français)
- **Wellness Mama** — *How to Build a Sandcastle Like a Pro*
- **Cottage Life** — *5 sand-sculpting tips from an expert*
- **Rhythms of Play** — *How to Build a Sandcastle: Three Easy Methods*
- **Gulf Shores & Orange Beach** — *Six tips for sandcastle building*

---

## ANNEXE A — Tableau de synthèse des valeurs numériques

| Grandeur | Valeur | Unité | Source / §|
|---|---|---|---|
| Ratio sable:eau de mise en œuvre | 8 : 1 | volume | §1.2.1 |
| Fraction volumique de liquide optimale (résistance max) | ~1 (0.5–3) | % vol. | §1.2.2 |
| Seuil de perte de tenue | ~15 % vol. / 35 % des pores | — | §1.2.2 |
| Tension superficielle de l'eau | 72 (≈70) | mN/m | §1.3.1 |
| Rayon de grain de référence | 100 | µm | §2.9.2 |
| Module d'Young du quartz | 30 | GPa | §2.9.2 |
| Force capillaire par pont (grain 100 µm) | ~45 | µN | §1.3.1 |
| Rapport force capillaire / poids du grain | ~400 : 1 | — | §1.3.1 |
| Angle de repos sable sec | 30–34 | ° | §1.3.7 |
| Angle de repos sable humide | ~45 | ° | §1.3.7 |
| Angle de friction interne, lâche | 29–32 | ° | §1.1.3 |
| Angle de friction interne, dense anguleux | 38–45 | ° | §1.1.3 |
| Indice des vides, lâche → dense | 0.75–0.85 → 0.45–0.55 | — | §1.4.2 |
| Porosité, lâche → dense | 43–46 % → 31–36 % | — | §1.4.2 |
| Masse volumique sèche, lâche → dense | 1400–1500 → 1750–1900 | kg/m³ | §1.4.2 |
| Nombre de coordination, lâche → dense | 4–5 → 6–8 | — | §1.4.1 |
| Cohésion apparente, lâche → dense | 0.5–1.5 → 3–8 | kPa | §1.4.2 |
| Résistance en compression d'un bloc damé | 20–60 | kPa | §1.2.2 |
| Épaisseur de couche versée | 15–20 (6–8 po) | cm | §2.1.2 |
| Épaisseur après tassement | 7–10 (3 po) | cm | §2.1.2 |
| Facteur de compaction observable | 2 : 1 | — | §1.4.2 |
| Foisonnement du sable légèrement humide | +20 à +30 | % vol. | §1.4.3 |
| Hauteur max d'un coffrage individuel | 60 (2 pieds) | cm | §2.1.1 |
| Coffrage bois standard | 1,2 × 1,2 × 0,6 m, CDX 5/8" | — | §2.1.1 |
| Plaque de dame | 15–20 (6–8 po) | cm de côté | §2.1.2 |
| Loi de hauteur maximale | H ∝ R^(2/3) | — | §2.9.1 |
| Facteur de rayon pour doubler la hauteur | 2.83 (= √8) | — | §2.9.1 |
| Épaisseur min. de voûte d'arche (bon sable) | ≥ 1/4 de la portée, ≥ 4 cm | — | §2.8.3 |
| Undercut max, bon sable damé | 20–30 | cm | §2.7.3 |
| Undercut max, sable de plage | 5–10 | cm | §2.7.3 |
| Marche d'escalier (tutoriels) | ~12 × 12 (½ × ½ po) | mm | §2.8.4 |
| Ratio merlon : créneau | 1.5–2.5 : 1 | — | §2.8.2 |
| Profondeur de joint de brique | 1–5 | mm | §2.8.7 |
| Fixateur colle à bois | 10 % colle / 90 % eau | — | §1.5.2 |
| Fixateur PVA | 20 % colle / 80 % eau | — | §1.5.2 |
| Épaisseur de la croûte de séchage | 1–5 | mm | §1.5.1 |
| Profondeur du trou d'eau | 40–100 | cm | §2.6.2 |
| Durée de vie avec fixateur, extérieur | semaines à mois | — | §1.5.3 |
| Sable d'un championnat du monde | ~545 (1,2 M lb) | tonnes | §6.2 |
| Pièce solo de compétition | 7–30 | tonnes | §6.2 |
| Record du monde de hauteur | 21,16 (base > 30 m, ~5000 t) | m | §2.9.1 |

## ANNEXE B — Ordre canonique des opérations (résumé d'une page)

```
SITE
  1. Vérifier la marée -> construire à marée descendante
  2. Tester le sable (test de la boule)
  3. Choisir un terrain plat au-dessus de la laisse de haute mer
  4. Creuser le trou d'eau côté mer ; déblai côté dune

FONDATION
  5. Décaper le sable sec (5-15 cm)
  6. Niveler
  7. Damer le sol d'assise
  8. Base large : diamètre >= hauteur / 2

POUND-UP (répéter par coffrage, de bas en haut)
  9.  Poser le coffrage, étanchéifier les joints
  10. Verser 15-20 cm de sable
  11. NOYER (2-5 cm d'eau libre en surface)
  12. BRASSER à la pelle jusqu'à mordre dans la couche précédente
  13. TASSER en spirale, du bord vers le centre
  14. Vérifier la réduction 2:1
  15. Répéter 11-14 jusqu'au ras
  16. Coffrage suivant, plus petit, par-dessus
  17. Monter à +10-20 % de la hauteur visée
  18. LAISSER DRAINER

SCULPTURE (toujours du HAUT vers le BAS)
  19. Décoffrer le coffrage LE PLUS HAUT (tapoter, lever vertical)
  20. Tracer les repères de proportion
  21. Dégrossir (pelle, truelle) : silhouette
  22. Décoffrer le niveau suivant, dégrossir
  23. Mettre en forme (verticalité au fil à plomb, plans horizontaux)
  24. Détailler du haut vers le bas :
        toitures -> créneaux -> corniches -> ouvertures -> escaliers -> ponts
  25. Souffler à la paille APRÈS CHAQUE ÉLÉMENT
  26. Brumiser en permanence
  27. Reculer et vérifier toutes les 10 min

TEXTURE
  28. Lits horizontaux -> joints verticaux -> quinconce
  29. Tuiles : du bas du toit vers le haut (seule exception)
  30. Alterner lisse et texturé

FINITION
  31. Douve et canaux EN DERNIER
  32. Souffler, épousseter, reprendre les arêtes
  33. Ratisser le pourtour, effacer les traces
  34. Fixateur : 2-4 passes légères, brouillard fin, de haut en bas
  35. Bird wires
  36. Photo en lumière rasante
  37. Reboucher le trou
```

---

*Fin du document. Version 1.0.*
