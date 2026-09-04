# RECHERCHE — SYSTÈME DE VAGUES

*Hydrodynamique côtière appliquée à la sandbox `Sandcastle`.
Domaine 10,24 × 10,24 m, grille 256 × 256 à 4 cm, solveur « pipe » de Mei et al.
Cible : des vagues individuelles qui arrivent du large, gonflent, déferlent, courent
sur le sable, sapent les murs et se retirent — avec deux molettes pour le joueur :
**hauteur** et **agitation**.*

---

## 0. RÉSUMÉ EXÉCUTIF — les six décisions

| # | Décision | Pourquoi |
|---|---|---|
| **D1** | **Corriger la célérité du solveur.** Le modèle pipe tel qu'il est écrit propage les ondes à `√(g·Δx) = 0,63 m/s`, indépendamment de la profondeur. C'est la raison pour laquelle le ressac actuel est une bouillie : **sans dépendance à la profondeur, il n'y a pas de levée (shoaling), donc pas de déferlement possible.** Remplacer `k = dt·A·g/L` par `k = dt·g·h̄_face`. | §2.2 |
| **D2** | **Modèle (a) : générateur au large + solveur.** Le déferlement, le ressaut, le jet de rive et le retrait sortent tout seuls des équations de Saint-Venant. Surtout : les constructions du joueur modifient la bathymétrie, donc modifient *où* les vagues déferlent. Aucune des trois autres options ne donne ça. | §2.3 |
| **D3** | **Zone de relaxation, pas de Dirichlet.** L'actuel `h[c] = level - terrain` est un mur parfaitement réfléchissant. Il faut une bande de relaxation de 20 cellules qui génère *et* absorbe (invariant de Riemann `u = η√(g/h)`). | §2.5 |
| **D4** | **Sapement par encoche, pas par rabotage.** `dig()` retire du sable au *sommet* d'une colonne : ça ne peut produire qu'un aplanissement doux. Le sapement demande une fonction `notch()` qui mord dans la **tranche d'altitude de la surface libre**. Le surplomb, la contrainte différée et l'effondrement d'un coup sont ensuite fournis gratuitement par `Granular.checkSupport` / `stress` / `STRESS_BREAK`. | §5.3 |
| **D5** | **Recalibrer `COHESION_RESIST` de 30 à 600.** Avec 30, un mur en pound-up résiste à 5 Pa alors que le jet de rive le plus modeste en délivre 34 : tout part, quelle que soit la qualité de la construction. Avec 600, la table de résistance recoupe exactement la table des six niveaux de houle — chaque niveau bat un cran de qualité de construction. C'est là que se joue la boucle de jeu. | §5.2 |
| **D6** | **Deux réglages, six niveaux nommés, et un écrêtage par la marée.** `Hs_eff = min(Hs · (1 − k_T · max(0, marée)), 0,60 · h_gen)`. Sans écrêtage, « Tempête » à pleine mer noie le domaine entier — y compris l'arrière-plage. | §7.2 |

---

# 1. CE QUI SE PASSE VRAIMENT QUAND UNE VAGUE ARRIVE SUR UNE PLAGE

## 1.1 La chaîne physique et son vocabulaire

Une vague qui va mourir sur une plage traverse six régimes successifs. Chacun a un
nom, une signature mesurable, et — c'est le point — une conséquence visuelle et une
conséquence sur le sable.

```
    LARGE                    HAUT-FOND              DÉFERLEMENT      ESTRAN
    ─────                    ─────────              ───────────      ──────

    houle             levée / shoaling            déferlante      ressaut
  (swell)           (wave shoaling)              (breaker)        (bore)
      │                     │                        │               │
      │  h > L/2            │  h < L/20              │  H ≈ 0,78 h   │  Fr > 1
      │  c = gT/2π          │  c = √(gh)             │               │
      │  crête ronde        │  crête se cambre       │  lèvre plonge │  front vertical
      │                     │  creux s'aplatit       │  panache      │  écume dense
      ▼                     ▼                        ▼               ▼

                                          jet de rive (uprush / swash)
                                          ────────────────────────────
                                          nappe fine, rapide, courte
                                          τ élevé, transport ONSHORE
                                                    │
                                                    ▼
                                          nappe de retrait (backwash)
                                          ───────────────────────────
                                          lente, longue, laminaire
                                          transport OFFSHORE
                                                    │
                                                    ▼
                                          courant de retour (undertow)
                                          ────────────────────────────
                                          rappel de masse vers le large
```

**1. Houle du large (swell).** En eau profonde (`h > L/2`) la célérité vaut
`c₀ = gT/(2π)` et ne dépend que de la période. Chaque particule d'eau décrit un
cercle qui se referme : l'eau n'avance pas, seule l'énergie avance. Longueur d'onde
`L₀ = gT²/(2π)` — soit **6,2 m pour T = 2 s**, **15,0 m pour T = 3,1 s**.

**2. Levée (shoaling).** Dès que `h < L/2`, le fond commence à se faire sentir. En
eau peu profonde (`h < L/20`) la célérité devient `c = √(gh)` : elle ne dépend plus
que de la profondeur. La période, elle, ne change pas. Donc la longueur d'onde
`L = cT` se raccourcit, et comme le flux d'énergie `E·c_g` se conserve, l'amplitude
**monte**. C'est la loi de Green :

```
    a(h) = a₀ · (h₀ / h)^(1/4)                     (loi de Green, ondes longues)
```

Concrètement chez nous : une vague de 12 cm dans 90 cm de fond fait
`12 × (0,90/0,20)^0,25 = 17,5 cm` quand elle arrive dans 20 cm de fond. **+46 % de
hauteur, et une crête qui se raidit** — c'est le gonflement que le joueur doit voir.

Les orbites circulaires s'aplatissent en ellipses puis en va-et-vient horizontal
au fond : c'est ce va-et-vient qui commence à remuer le sable bien avant le
déferlement.

**3. Déferlement (breaking).** Deux critères concurrents.
- *Limitation par la cambrure* (Miché) : `(H/L)_max = 0,142 · tanh(kh)`, soit
  `H/L ≤ 1/7` au large.
- *Limitation par la profondeur* (McCowan, théorie de l'onde solitaire) :
  `H_b = γ · h_b` avec **γ ≈ 0,78**.

Sur une plage, c'est presque toujours le second qui mord. Le γ observé n'est pas
constant : `0,6–0,8` pour un déferlement glissant, `0,8–1,2` pour un plongeant.
Battjes (1974) le relie au nombre d'Iribarren : `γ_b = 1,06 + 0,14 · ln ξ_b`.

**4. Ressaut (bore).** Après déferlement, la vague n'est plus une onde : c'est un
**ressaut hydraulique mobile**, un front d'eau turbulent à Froude supérieur à 1 qui
se propage vers la côte en dissipant son énergie. C'est le régime que les équations
de Saint-Venant décrivent *exactement* — et c'est notre chance : le solveur pipe,
qui est un schéma d'ondes longues sans dispersion, produit naturellement des chocs.
Ce qui est un défaut avant déferlement (les ondes « raidissent » toutes seules même
sur fond plat) devient la bonne physique après.

**5. Jet de rive (uprush / swash).** Le ressaut atteint la ligne d'eau et
« s'effondre » (*bore collapse*). Ho & Meyer (1962) et Shen & Meyer (1963) ont
montré que ce qui suit est une **balistique pure** : une lame mince est projetée
sur la pente et décélère sous l'effet de `g·β`. La solution analytique donne, en
négligeant le frottement :

```
    R    = u₀² / (2g)                    (run-up vertical)
    ℓ    = u₀² / (2 g β)  =  R / β       (excursion horizontale)
    t_up = u₀ / (g β)                    (durée de la montée)
```

où `u₀` est la vitesse de la ligne d'eau au moment de l'effondrement du ressaut.

**6. Nappe de retrait (backwash).** L'eau redescend sous son propre poids. Elle est
plus lente, plus mince, plus longue en durée, et surtout **laminaire** là où le jet
était turbulent. Une partie de l'eau ne revient jamais : elle s'infiltre (chez nous :
`infiltrate()`), ce qui affaiblit encore le retrait et explique le transport net
vers la terre qui construit la berme.

**7. Courant de retour (undertow).** Le déferlement pousse en permanence de la masse
d'eau vers la côte ; la surélévation qui en résulte (le *set-up*) refoule cette masse
vers le large **par le fond**. Sur une plage rectiligne c'est un undertow diffus ; si
la bathymétrie est irrégulière — un château, une digue, une brèche dans une douve —
ça se concentre en **courant d'arrachement (rip)**. Chez nous ce courant sortira tout
seul du solveur, et il creusera des chenaux dans les brèches : c'est un cadeau
émergent qu'il ne faut surtout pas contrarier.

## 1.2 Set-up et set-down

Avant déferlement, le gradient de tension de radiation `S_xx` **abaisse** le plan
d'eau moyen : c'est le *set-down*, faible (quelques % de H). Après déferlement, il le
**relève** : c'est le *set-up*, et il n'est pas négligeable du tout.

```
    dη̄/dx = − (1/(ρ g (h+η̄))) · dS_xx/dx
    S_xx  = (2n − 1/2) E,   E = ⅛ ρ g H²
```

En surf zone saturée (`H = γ(h+η̄)`) on intègre analytiquement :

```
    dη̄/dx = − K · dh/dx     avec K = 1 / (1 + 8/(3γ²))
    η̄_rivage ≈ 0,15 à 0,20 · H_b        (règle de pouce)
```

Paramétrisation de Stockdon : `η̄ = 0,35 · β · √(Hs·L₀)`.

**Pourquoi ça compte pour le jeu :** le set-up est une élévation *permanente* du plan
d'eau tant que la houle dure. Pour « Grosse houle » chez nous il vaut **15,6 cm** —
soit un tiers de l'amplitude de marée. Une houle qui s'installe, c'est une marée
supplémentaire silencieuse. C'est aussi ce qui fait que le rivage moyen recule
visiblement dès qu'on monte la molette « hauteur », avant même qu'une seule vague
n'ait touché un mur. Excellent retour visuel : **le joueur voit la mer avancer quand
il augmente la houle.**

## 1.3 Nombre d'Iribarren et les trois types de déferlement

Le nombre d'Iribarren (ou paramètre de similitude de déferlement, *surf similarity
parameter*) compare la raideur de la plage à la cambrure de la vague :

```
    ξ₀ = tan β / √(H₀ / L₀)        (forme « au large », la plus utilisée)
    ξ_b = tan β / √(H_b / L₀)      (forme « au déferlement »)
    L₀ = g T² / (2π)
```

| ξ₀ | Type | Nom français | Description | Énergie réfléchie |
|---|---|---|---|---|
| **< 0,4** | *spilling* | **glissant** (ou déversant) | la crête moutonne sur 6 à 7 longueurs d'onde, l'écume déborde par-dessus la face. Plages plates, houle cambrée. | < 2 % |
| **0,4 – 2,0** | *plunging* | **plongeant** | la lèvre s'enroule, forme un tube, et s'écrase devant la vague en projetant un panache. Le plus spectaculaire, le plus érosif localement. | 2 – 20 % |
| **2,0 – 3,3** | *collapsing* | **frontal** (s'écroulant) | la face devient verticale, la base s'écroule, pas de tube. | 20 – 50 % |
| **> 3,3** | *surging* | **glissant-frontal** (déferlement de gonflement) | la vague ne casse pas vraiment, elle monte sur la pente en bloc. Plages très raides, houle longue. | > 50 % |

**Notre plage.** Le profil de `beachProfile()` donne les pentes locales suivantes :

| d (m, > 0 = terre) | altitude (m) | pente locale |
|---|---|---|
| −3,2 | 0,150 | 1,9 % |
| −2,4 | 0,336 | **35,5 %** |
| −2,0 | 0,488 | **39,9 %** |
| −1,6 | 0,649 | **39,8 %** |
| −1,2 | 0,801 | 35,6 % |
| −0,8 | 0,929 | 27,6 % |
| −0,4 | 1,017 | 15,8 % |
| 0,0 | 1,050 | 2,6 % |
| +0,4 | 1,097 | 17,1 % |
| +1,2 | 1,263 | **22,2 %** |
| +2,4 | 1,501 | 15,4 % |
| +3,6 | 1,600 | 2,4 % (crête de berme) |
| +5,0 | 1,663 | 4,5 % |

> ⚠️ Le commentaire de `BeachGenerator.js` annonce « pente ~11 % » pour l'avant-plage.
> C'est faux : le `smoothstep` donne une rampe sous-marine à **40 %** au point
> d'inflexion. La face de plage émergée, elle, est à **21 %** en moyenne. La pente de
> référence pour le jet de rive est donc **β = 0,21** à mi-marée et pleine mer, et
> **β = 0,35 à 0,40** à basse mer (la ligne d'eau est alors sur la rampe sous-marine).

Avec β = 0,21 et nos six états de mer, `ξ₀` vaut **1,4 à 2,1** : on est en
**déferlement plongeant à frontal**. C'est le bon régime pour le jeu — c'est le plus
photogénique et le plus violent au pied des murs. À basse mer (β = 0,40) on monte à
`ξ₀ = 2,7–4,0` : déferlement frontal, presque du gonflement, la vague monte en bloc
sans se casser. C'est exactement ce qu'on observe sur une plage raide à marée basse,
et ça donne une variété gratuite au cours du cycle de marée.

## 1.4 Run-up : la formule de Stockdon et al. (2006), chiffrée pour notre plage

C'est **la** formule de référence, calibrée sur dix campagnes de terrain. Elle
décompose le run-up en une composante lente (le set-up) et deux composantes
oscillantes (le swash incident, à la fréquence des vagues, et le swash
infragravitaire, à la fréquence des groupes).

```
    ξ₀ ≥ 0,3  :   R2%  =  1,1 · [ η̄  +  ½ · √(S_inc² + S_ig²) ]

                  η̄     = 0,35 · β · √(Hs · L₀)          set-up
                  S_inc = 0,75 · β · √(Hs · L₀)          swash incident
                  S_ig  = 0,06 ·     √(Hs · L₀)          swash infragravitaire

    ξ₀ < 0,3  :   R2%  =  0,043 · √(Hs · L₀)             (plage dissipative saturée)

    L₀ = g Tp² / (2π)
```

`R2%` est le niveau atteint ou dépassé par **2 % des vagues** — la vague sur
cinquante. C'est la bonne mesure pour un jeu : c'est la vague qui fait mal.

Notes importantes :
- Toutes les composantes sont dimensionnellement des longueurs en `β√(Hs L₀)` : la
  formule est **Froude-cohérente**, donc parfaitement transposable à notre échelle
  réduite (§3.1).
- Au-delà de β ≈ 0,10 le run-up croît quasi linéairement avec la pente. En dessous, la
  dépendance à la pente disparaît (le swash sature).
- Saturation : `R < R_s = A·g·β²·Tp²` avec `A ≈ 0,14`. Chez nous, pour β = 0,21 et
  Tp = 2,6 s : `R_s = 0,14 × 9,81 × 0,0441 × 6,76 = 0,41 m`. Nos R2% de 24 cm
  restent sous la saturation — bien.
- La précision annoncée des formules de run-up n'est jamais meilleure que ±25 %. On a
  donc une grande liberté de calibrage sans trahir la physique.

### Table de run-up complète pour notre plage

**β = 0,21 (face de plage — mi-marée et pleine mer) :**

| Niveau | Hs (m) | Tp (s) | L₀ (m) | ξ₀ | η̄ (cm) | S_inc (cm) | S_ig (cm) | **R2% (cm)** | excursion ℓ (m) | u₀ (m/s) | t_up (s) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Clapot | 0,04 | 1,6 | 4,0 | 2,10 | 2,9 | 6,3 | 2,4 | **6,9** | 0,33 | 1,17 | 0,57 |
| Petites vagues | 0,09 | 2,0 | 6,2 | 1,75 | 5,5 | 11,8 | 4,5 | **13,0** | 0,62 | 1,60 | 0,78 |
| Houle | 0,18 | 2,6 | 10,6 | 1,61 | 10,1 | 21,7 | 8,3 | **23,9** | 1,14 | 2,17 | 1,05 |
| Grosse houle | 0,30 | 3,1 | 15,0 | 1,49 | 15,6 | 33,4 | 12,7 | **36,8** | 1,75 | 2,69 | 1,30 |
| Tempête | 0,45 | 3,6 | 20,2 | 1,41 | 22,2 | 47,5 | 18,1 | **52,4** | 2,49 | 3,21 | 1,56 |

**β = 0,15 (variante douce) et β = 0,40 (basse mer, rampe sous-marine) :**

| Niveau | R2% à β=0,15 | R2% à β=0,30 | R2% à β=0,40 |
|---|---|---|---|
| Clapot | 5,1 cm | 9,7 cm | 12,9 cm |
| Petites vagues | 9,6 cm | 18,3 cm | 24,2 cm |
| Houle | 17,6 cm | 33,6 cm | 44,4 cm |
| Grosse houle | 27,1 cm | 51,7 cm | 68,4 cm |
| Tempête | 38,6 cm | 73,5 cm | 97,2 cm |

Remarquer que **l'excursion horizontale `ℓ = R2%/β` est presque indépendante de la
pente** (0,33 m / 0,32 m / 0,32 m pour le Clapot à β = 0,15 / 0,30 / 0,40) : le
run-up vertical monte avec la pente, mais la distance parcourue sur le sable reste la
même. C'est cohérent avec la physique (le swash est balistique) et ça simplifie le
game design : **l'excursion ne dépend que de l'état de mer**.

## 1.5 Asymétrie jet / retrait

C'est le point que le ressac sinusoïdal actuel rate complètement, et c'est celui qui
fait toute la différence visuelle et érosive.

| Grandeur | Jet de rive (uprush) | Nappe de retrait (backwash) | Ratio |
|---|---|---|---|
| Durée | `t_up = u₀/(gβ)` | `t_back ≈ 1,4 à 1,6 · t_up` | **1 : 1,5** |
| Vitesse de pointe | `u₀` (1,2 à 3,2 m/s chez nous ; 2–5 m/s en nature) | `≈ 0,65 à 0,75 · u₀` | **1 : 0,7** |
| Épaisseur de lame | épaisse au front (`~0,3·Hs`), s'amincit | mince et régulière | **1 : 0,5** |
| Régime | turbulent, front de choc, bulles | laminaire à transitionnel, nappe lisse | — |
| Coefficient de frottement `f_w` | **0,04 à 0,06** | **0,02 à 0,03** | **2 : 1** |
| Contrainte au fond `τ = ½ρf|u|u` | **2 à 4 × plus forte** à vitesse égale | référence | **3 : 1** |
| Mode de transport | charriage **+ suspension** (couche de *sheet flow*, 100–1600 kg/m³) | charriage dominant | — |
| Bilan sédimentaire | **onshore** (vers la terre) | offshore | net **onshore** |

Trois conséquences directes pour le code :

1. **Le jet est court et violent.** Il faut que la lame arrive comme un mur qui
   s'effondre, pas comme une marée qui monte. Dans un solveur de Saint-Venant on
   obtient ça gratuitement si — et seulement si — la célérité dépend de la profondeur
   (décision **D1**). Sinon le front ne raidit jamais.

2. **Le facteur de frottement est deux fois plus grand à la montée qu'à la descente.**
   Ce n'est pas une bizarrerie : c'est ce qui rend le jet *plus efficace* pour
   transporter le sable malgré sa durée deux fois plus courte, et c'est ce qui
   maintient la plage en place. Sans ce biais, la simulation raboterait
   progressivement la plage jusqu'à la mer.

3. **Une partie de l'eau du jet ne redescend pas.** Elle s'infiltre (chez nous
   `infiltrate()`, vitesse de Darcy × 35). Ça affaiblit le retrait, ça mouille le
   sable — et ça mouille en particulier le pied des murs, ce qui déclenche la chaîne
   de sapement du §5.3.

## 1.6 Groupes de vagues (« sets ») — et pourquoi c'est le cœur du drame

Les vagues n'arrivent pas régulièrement. Un état de mer réel est une **superposition
de composantes de fréquences voisines** ; leur battement produit des trains de 5 à 8
vagues fortes séparés par des accalmies. Deux effets :

**(a) Le battement.** Deux composantes de fréquences `f₁` et `f₂` battent à
`|f₁ − f₂|`. L'enveloppe a une période `T_g = 1/|f₁ − f₂|`, soit `N_g = T_g/Tp`
vagues par groupe. Avec un étalement spectral relatif de 10 à 15 % — typique d'une
houle — on obtient **N_g ≈ 7 à 10 vagues**. C'est de là que vient la légende de la
« septième vague ».

**(b) L'onde longue liée (bound long wave).** Sous un groupe de grosses vagues,
le niveau moyen est *abaissé* ; entre deux groupes, il est *relevé*. Cette onde longue
voyage à la vitesse de groupe, en **opposition de phase** avec l'enveloppe. En
arrivant à la côte elle se libère et devient une oscillation **infragravitaire**
(période 20 à 200 s en nature ; chez nous, après réduction de Froude ×√10,
**6 à 60 s**). C'est elle qui fournit le terme `S_ig` de Stockdon et c'est elle qui
fait que certaines vagues montent **beaucoup** plus haut que les autres.

**Pourquoi ça compte pour le jeu.** Sans groupes, une houle constante est un bruit de
fond : le joueur s'habitue en dix secondes et l'ennui s'installe. Avec des groupes :

- il y a des **accalmies** de 10 à 25 s pendant lesquelles on peut réparer, reboucher
  la douve, remonter un mur — c'est la fenêtre d'action ;
- il y a des **séries** pendant lesquelles on ne peut que regarder ;
- il y a la **vague scélérate** (la 2 % de Stockdon), qui arrive quand la crête d'un
  groupe coïncide avec un pic d'infragravitaire, et qui va **30 à 60 % plus loin** que
  les autres. C'est elle qui franchit la douve. C'est le moment dramatique.

Le rythme est donc : *tension montante (on entend le groupe arriver) → série de coups
→ silence → réparation*. C'est une structure de gameplay complète, offerte par la
physique.

---

# 2. MODÈLE DE SIMULATION RECOMMANDÉ

## 2.1 Le point de départ : ce que fait le code aujourd'hui

`Water.step()` calcule un ressac ainsi :

```js
const s1 = Math.sin(this.time * 0.95);
const s2 = Math.sin(this.time * 0.58 + 1.7);
const raw = (s1 * 0.65 + s2 * 0.35);
this.swash = Math.sign(raw) * Math.pow(Math.abs(raw), 0.7) * 0.052;
```

puis impose au large `h[c] = max(0, seaLevel + swash − terrain)`.

Les périodes sont `2π/0,95 = 6,6 s` et `2π/0,58 = 10,8 s`, l'amplitude ±5,2 cm.
C'est **une marée rapide**, pas une houle. Trois défauts structurels :

1. **Longueur d'onde infinie.** Le niveau est imposé *uniformément* sur toute la bande
   `isOcean`, donc tous les points du large montent et descendent en phase. Il n'y a
   jamais de crête individuelle.
2. **Pas de levée possible.** Voir §2.2 : le schéma actuel propage à vitesse
   constante. Une onde ne peut donc pas gonfler en arrivant sur le haut-fond.
3. **Réflexion totale.** `h[c] = ...` est une condition de Dirichlet : tout ce qui
   revient du rivage rebondit sur la ligne de génération et repart. Avec des vagues
   énergiques, le domaine devient une baignoire résonnante.

Le commentaire du code dit d'ailleurs, lucidement : *« Une houle plus marquée est
spectaculaire pendant dix secondes, puis elle rabote la plage »*. C'est vrai **avec
ce modèle-là** : sans crêtes individuelles, l'érosion est étalée uniformément dans le
temps et l'espace, donc elle rabote au lieu de sculpter. Avec des vagues discrètes et
des accalmies, l'érosion se concentre là où il faut (les fronts, les pieds de mur) et
laisse le reste tranquille.

## 2.2 ⚠️ D1 — La correction de célérité, préalable à tout

C'est la découverte la plus importante de ce document. Linéarisons le schéma pipe sur
fond plat, en 1D :

```
    ∂f_i/∂t  = (A g / L) · (h_i − h_{i+1})            [flux entre i et i+1]
    ∂h_i/∂t  = − (1/A) · (f_i − f_{i−1})
```

En substituant, avec `A = Δx²` et `L = Δx` :

```
    ∂²h_i/∂t² = − (1/A) (∂f_i/∂t − ∂f_{i−1}/∂t)
              = − (g/L) (h_i − h_{i+1} − h_{i−1} + h_i)
              = (g/L) (h_{i+1} − 2h_i + h_{i−1})
              = g · Δx · ∂²h/∂x²
```

C'est une équation d'onde de célérité :

```
    c_pipe = √(g · Δx) = √(9,81 × 0,04) = 0,63 m/s     ← INDÉPENDANTE DE h !
```

alors que la physique exige `c = √(g h)`, soit **2,97 m/s dans 90 cm d'eau**.

| profondeur h | `c = √(gh)` physique | `c_pipe` actuel | erreur |
|---|---|---|---|
| 0,90 m (large, mi-marée) | 2,97 m/s | 0,63 m/s | ÷ 4,7 |
| 0,40 m (ligne de génération) | 1,98 m/s | 0,63 m/s | ÷ 3,1 |
| 0,10 m (surf) | 0,99 m/s | 0,63 m/s | ÷ 1,6 |
| 0,04 m (nappe) | 0,63 m/s | 0,63 m/s | **exact** |

Le modèle de Mei et al. est conçu pour l'**érosion hydraulique par ruissellement** :
des lames d'eau d'épaisseur comparable à la maille. Dans ce régime `h ≈ Δx` et
l'approximation est bonne. Pour une mer de 90 cm sur une maille de 4 cm, elle ne l'est
pas du tout.

**Conséquences observables :** aucune levée (`c` ne varie pas avec `h`, donc pas de
raccourcissement de la longueur d'onde, donc pas de gonflement d'amplitude, donc pas
de déferlement) ; le front d'onde ne raidit pas ; le jet de rive n'est jamais projeté,
il *déborde*.

**Correction.** La forme correcte de l'équation de quantité de mouvement linéarisée
est `∂q/∂t = −g h ∂η/∂x`, avec `q = h·u` le débit par unité de largeur. Le flux
volumique à travers une face de largeur `L` vaut `f = q·L`, d'où :

```
    f' = max(0, f · damp + dt · g · h̄_face · (H_i − H_j))
```

`A g / L` (= `g·Δx`) est simplement remplacé par `g · h̄_face`. Une seule
multiplication de plus par face.

Choix de `h̄_face` — c'est là que se joue la robustesse en mouillé/sec :

```js
// Profondeur "hydrauliquement connectée" entre deux cellules : ce que le
// schéma peut réellement transporter. La formulation min/max est celle qui
// evite qu'une cellule pleine pousse de l'eau dans un voisin dont le fond
// est plus haut que sa propre surface libre.
const hFace = Math.max(HFACE_MIN,
                       Math.min(surf[c] + h[c], surf[n] + h[n])
                     - Math.max(surf[c], surf[n]));
```

| constante | valeur | rôle |
|---|---|---|
| `HFACE_MIN` | **0,006 m** | plancher : sans lui, la pointe du jet de rive (h → 0) a une célérité nulle et n'avance plus jamais. 6 mm ⇒ `c_min = 0,24 m/s`. |
| `HFACE_CAP` | **0,55 m** | plafond appliqué **uniquement** dans la bande de génération/éponge. Cape la célérité à 2,32 m/s, ce qui divise par deux le nombre de sous-pas nécessaires. Invisible : la seule conséquence est que la houle *hors champ* voyage 25 % moins vite au large. On compense dans le générateur. |

**Bonus : le damping devient physique.** `WATER_DAMPING = 0,985` par pas de 1/60 s
vaut `0,985^60 = 0,40` par seconde, soit **60 % de la quantité de mouvement perdue
par seconde**. Une vague qui traverse 1,6 m de surf zone à 2 m/s met 0,8 s : elle
perd la moitié de son énergie en frottement numérique. À remplacer par un frottement
de fond réel, semi-implicite (inconditionnellement stable) :

```
    f ← f / (1 + dt · (f_w / 2) · |u| / h)          f_w = 0,02 à 0,06
```

| régime | h | |u| | coefficient | facteur par pas (1/60 s) |
|---|---|---|---|---|
| large | 0,60 m | 0,25 m/s | 0,010 s⁻¹ | 0,9998 (négligeable — correct) |
| surf | 0,15 m | 1,20 m/s | 0,20 s⁻¹ | 0,9967 |
| jet de rive | 0,05 m | 2,20 m/s | **1,32 s⁻¹** | 0,978 (fort — correct) |
| nappe fine | 0,01 m | 0,60 m/s | 1,80 s⁻¹ | 0,970 |

Le frottement mord donc **là où il doit** (dans la lame mince) et nulle part ailleurs.
On peut alors relever `WATER_DAMPING` à **0,999** (numérique pur, anti-oscillation)
sans que le solveur devienne instable, et récupérer les vagues nettes.

## 2.3 Comparaison des quatre modèles

### (a) Condition aux limites oscillante au large + solveur existant

*On impose une élévation variable dans le temps et dans l'espace sur une bande au
large et on laisse les équations de Saint-Venant faire le reste : levée, déferlement,
ressaut, jet de rive et retrait.*

| | |
|---|---|
| **Coût CPU** | Le coût du solveur actuel, × le nombre de sous-pas (2 à 3). Aucune structure de données nouvelle hormis 3 `Float32Array(65536)` (η précédent, indicateur de déferlement, masque de relaxation) = **768 ko**. |
| **Qualité** | Excellente sur tout ce qui est *après* le déferlement (le ressaut et le swash sont *exactement* ce que Saint-Venant décrit). Médiocre avant : pas de dispersion, donc les crêtes raidissent trop tôt — mais sur 3 m de haut-fond, personne ne le verra. |
| **Interaction avec le jeu** | **Totale et gratuite.** Une douve creusée modifie la bathymétrie donc modifie l'écoulement. Un brise-lames force le déferlement plus au large. Une brèche concentre un rip. Un mur réfléchit. Rien de tout ça n'a à être codé. |
| **Risques** | Réflexion sur la limite (résolu par la relaxation, §2.5). CFL (résolu par sous-pas, §8). Dissipation au déferlement (résolu §4.2). |

### (b) Train de ressauts injectés analytiquement à une ligne de déferlement calculée

*On calcule où `H = 0,78 h`, on y injecte des ressauts analytiques, on laisse le
solveur les propager sur l'estran.*

| | |
|---|---|
| **Coût CPU** | Plus faible : on ne simule que l'estran, la zone du large peut être purement visuelle. |
| **Qualité** | Bonne pour le swash, mais **on perd le déferlement lui-même** en tant qu'événement spatial : il est décrété, pas produit. |
| **Rédhibitoire** | La ligne de déferlement dépend de la bathymétrie, **donc des constructions du joueur**. Calculer analytiquement où déferlent les vagues, c'est décider à l'avance que le brise-lames du joueur ne sert à rien — ou alors le recoder à la main, ce qui est exactement le travail que le solveur fait déjà. Deuxième problème : l'injection analytique de masse casse le bilan de volume, ce qui, couplé à `infiltrate()`, dérive. |

### (c) Modèle 1D transversal résolu finement puis étalé le long du rivage

*Un profil `η(s,t)` résolu sur 200 points le long de la normale au rivage, décalé en
phase le long du rivage.*

| | |
|---|---|
| **Coût CPU** | **Dérisoire** : 200 cellules au lieu de 20 000. Un facteur 100. |
| **Qualité visuelle** | Très bonne : des crêtes parfaitement propres, du déferlement, du swash. |
| **Rédhibitoire** | Un profil 1D ne sait pas router l'eau **le long** du rivage. Or c'est *tout* ce que fait le joueur : creuser une tranchée oblique pour amener la mer, ouvrir une douve, ménager un déversoir, laisser une brèche. Avec (c), la douve ne se remplit pas, la tranchée ne coule pas, la brèche ne draine pas. On tue la mécanique centrale. |
| **Usage résiduel** | **À garder comme mode « qualité basse »** sur machine faible : on résout le profil 1D et on l'*imprime* dans le champ `h` 2D. On perd l'interaction mais on garde le spectacle. C'est un repli honnête, pas un modèle. |

### (d) Purement cinématique (vagues scriptées)

| | |
|---|---|
| **Coût** | Nul. |
| **Qualité** | Peut être superbe (Gerstner + shader). |
| **Rédhibitoire** | Zéro interaction. Le joueur qui construit une digue et voit les vagues la traverser comme un fantôme perd toute confiance dans le monde. Et l'érosion doit alors être un système *séparé* et arbitraire — c'est-à-dire tout ce qu'on essaie d'éviter. |
| **Usage résiduel** | **À garder pour le hors-champ.** Au-delà de la bande de génération, vers le bord du domaine, il n'y a plus d'interaction possible : une nappe Gerstner cinématique y est parfaite et gratuite, et elle raccorde visuellement la simulation à l'horizon. |

### Verdict

> **Modèle (a)** — génération à la limite au large + solveur de Saint-Venant existant
> corrigé, avec traitement explicite du déferlement.
> **(d)** en décor au-delà de la ligne de génération.
> **(c)** en repli « qualité basse ».
> **(b)** rejeté.

Le facteur décisif n'est pas le coût — (a) coûte 2 à 3 fois le solveur actuel, ce qui
est absorbable — mais le fait que **(a) est le seul modèle où les constructions du
joueur changent la physique des vagues**. Dans un jeu qui s'appelle « château de
sable », c'est non négociable.

## 2.4 Architecture logicielle

Un fichier nouveau, `src/sim/Waves.js`, et cinq points de greffe dans `Water.js`.

```
src/sim/Waves.js
  ├── SEA_STATES[]                 table des 6 niveaux (§3.3)
  └── class WaveField
        ├── constructor(water)
        ├── setSeaState(i) / hs / agitation / direction
        ├── update(dt)             avance phases + enveloppe de groupe
        ├── buildBands()           masques génération / éponge (au changement de marée)
        ├── target(c, t)           état cible (η, q) pour la cellule c
        └── applyGeneration(dt)    relaxation vers la cible

src/sim/Water.js  (modifications)
  ├── step()          → boucle de sous-pas, appelle waves
  ├── applyBoundaries → scindé : seep() + waves.applyGeneration()
  ├── flux()          → k dépend de h̄_face  (D1)  + frottement semi-implicite
  ├── integrate()     → cap de Froude au lieu du cap de vitesse en dur
  ├── breaking(dt)    → NOUVEAU : détection, dissipation, écume
  ├── erode()         → biais jet/retrait, gate par la contrainte
  ├── undermine(dt)   → NOUVEAU : sapement des parois (D4)
  ├── notch(x,y,z,a)  → NOUVEAU : creuse à une ALTITUDE, pas au sommet
  └── advectFoam(dt)  → NOUVEAU : l'écume dérive avec le courant
```

## 2.5 D3 — Zone de relaxation : générer et absorber avec le même code

La technique standard (Larsen & Dancy 1983 ; Madsen 1997 ; Higuera 2018) : dans une
bande de largeur `W_relax`, on mélange à chaque pas la solution calculée avec l'état
cible analytique, avec un poids qui va de 1 (bord extérieur) à 0 (bord intérieur).

```
    h ← (1 − α) · h_solved + α · h_target
    f ← (1 − α) · f_solved + α · f_target

    α(s) = 1 − (exp(s^p) − 1) / (e − 1)         s ∈ [0,1], 0 au bord extérieur
                                                p = 3,5
```

Ce mélange fait **les deux choses à la fois** :
- il **génère** l'onde incidente (là où α ≈ 1, l'état est imposé) ;
- il **absorbe** tout ce qui revient du rivage (une onde sortante n'est pas dans
  l'état cible, donc elle est progressivement annulée par le mélange).

C'est infiniment plus simple, plus stable et plus court qu'une condition de Sommerfeld
ou une couche PML, et c'est ce qu'utilisent tous les canaux à houle numériques.

**État cible.** Pour une onde progressive en eau peu profonde, l'invariant de Riemann
sortant impose la relation vitesse/élévation :

```
    η_t(c, t) = seaLevel + Σᵢ aᵢ · cos(ωᵢ t − kᵢ·x_c + φᵢ)      (élévation)
    u_t(c, t) = (η_t − seaLevel) · √(g / h₀)                    (vitesse)
    q_t       = u_t · h_t     →     f_t = q_t · L · n̂          (flux volumique)
```

où `h₀ = seaLevel − surf[c]` est la profondeur au repos et `n̂` la normale au rivage
`(0.4472, 0.8944)`. C'est cette relation `u = η√(g/h)` qui rend la limite
« transparente » : une onde qui la traverse dans le bon sens est reproduite
exactement, une onde qui revient ne l'est pas et se fait absorber.

**Géométrie des bandes.** Elles doivent **suivre la marée**, sinon à basse mer la
bande `isOcean` (d < −1,6) est complètement à sec :

| marée | niveau (m) | rivage (d) | profondeur en d = −1,6 |
|---|---|---|---|
| −1,00 (basse) | 0,590 | −1,75 | **−0,059 m → À SEC** |
| −0,50 | 0,820 | −1,15 | 0,171 m |
| 0,00 | 1,050 | 0,00 | 0,401 m |
| +0,50 | 1,280 | +1,28 | 0,631 m |
| +1,00 (pleine) | 1,510 | +2,46 | 0,861 m |

Définition retenue, **par la profondeur au repos et non par `d`** :

```js
// Bande de génération : là où le fond est assez profond pour porter la houle
// qu'on veut injecter, ET assez loin du rivage pour que la levée ait de la place.
h0(c)      = seaLevel − surf0(c)                  // surf0 = profil non érodé
genInner   = { c : h0(c) ≥ H_GEN }                // H_GEN = 0,18 m
genOuter   = les W_RELAX cellules les plus au large de genInner
sponge     = les W_SPONGE cellules du bord du domaine
```

| constante | valeur | note |
|---|---|---|
| `H_GEN` | **0,18 m** | profondeur minimale d'injection. À basse mer, la profondeur max du domaine est 0,44 m : on injecte alors à `d ≈ −2,6`, ce qui laisse 0,85 m de surf zone. C'est court, mais c'est physiquement juste : une plage raide à marée basse a une surf zone étroite. |
| `W_RELAX` | **20 cellules (0,80 m)** | ≥ Δx·20. En dessous de ~15 cellules, la réflexion résiduelle devient audible (mode de baignoire). |
| `W_SPONGE` | **10 cellules (0,40 m)** | amortissement final au bord du domaine. |
| `p` (profil α) | **3,5** | exposant du profil de relaxation. |

**Important : la bande de génération lit `surf0`, le profil de plage d'origine, pas
`surfaceH`.** Sinon le joueur qui creuse un trou au large déplace la ligne de
génération et fait n'importe quoi. En revanche **tout le reste du domaine lit
`surfaceH`** : c'est là que les constructions comptent.

## 2.6 Pseudo-code complet du modèle retenu

### `src/sim/Waves.js`

```js
/**
 * Generateur de houle.
 *
 * Produit, sur une bande au large qui suit la maree, un etat cible (elevation
 * et debit) correspondant a une mer irreguliere : superposition de N
 * composantes de periodes voisines, modulee par une enveloppe de groupe lente.
 * Le solveur de Water.js se charge ensuite de TOUT le reste : levee sur le
 * haut-fond, deferlement, ressaut, jet de rive, retrait, courant de retour.
 *
 * La bande sert AUSSI de zone absorbante : le melange progressif vers l'etat
 * cible annule les ondes sortantes. Une condition de Dirichlet (ce que fait
 * applyBoundaries aujourd'hui) reflechirait tout le retrait.
 */

import {
  NX, NZ, VOXEL, ORIGIN_X, ORIGIN_Z, GRAVITY, clamp, smoothstep,
} from '../core/Config.js';
import { SHORE_NX, SHORE_NZ, beachProfile, shoreDistance } from '../world/BeachGenerator.js';

const COLS = NX * NZ;

// --- reglages de generation --------------------------------------------------
export const H_GEN     = 0.18;   // profondeur minimale d'injection (m)
export const W_RELAX   = 20;     // largeur de la bande de relaxation (cellules)
export const W_SPONGE  = 10;     // largeur de l'eponge de bord (cellules)
export const RELAX_P   = 3.5;    // exposant du profil alpha
export const N_COMP    = 5;      // composantes spectrales
export const HFACE_CAP = 0.55;   // plafond de profondeur effective au large (m)

/** Ecarts relatifs de frequence des composantes (irrationnels entre eux :
 *  la superposition ne se repete jamais a l'echelle d'une partie). */
const DF = [-0.137, -0.061, 0.0, 0.072, 0.151];
/** Ecarts d'incidence, en radians (etalement directionnel). */
const DTHETA = [-0.21, -0.09, 0.0, 0.11, 0.19];

/** Les six etats de mer. Voir §3.3 du document pour la justification. */
export const SEA_STATES = [
  { key:'glass',  label:'Mer d\'huile',     hs:0.000, tp:0.0, agit:0.00 },
  { key:'lap',    label:'Clapot',           hs:0.040, tp:1.6, agit:0.25 },
  { key:'small',  label:'Petites vagues',   hs:0.090, tp:2.0, agit:0.40 },
  { key:'swell',  label:'Houle',            hs:0.180, tp:2.6, agit:0.55 },
  { key:'big',    label:'Grosse houle',     hs:0.300, tp:3.1, agit:0.75 },
  { key:'storm',  label:'Tempête',          hs:0.450, tp:3.6, agit:1.00 },
];

export class WaveField {
  constructor(water) {
    this.water = water;

    /** Poids de relaxation, 0 = solveur libre, 1 = etat impose. */
    this.alpha = new Float32Array(COLS);
    /** Abscisse le long de la normale au rivage (m), precalculee. */
    this.sx = new Float32Array(COLS);
    /** Abscisse le long du rivage (m), pour l'etalement directionnel. */
    this.sy = new Float32Array(COLS);
    /** Profondeur au repos sur le profil D'ORIGINE (m). */
    this.h0 = new Float32Array(COLS);

    this.time = 0;
    this.stateIndex = 3;               // "Houle" par defaut
    this.hs = 0.18;                    // hauteur significative demandee (m)
    this.tp = 2.6;                     // periode de pic (s)
    this.agitation = 0.55;             // 0..1
    this.incidence = 0.28;             // rad, ~16 deg par rapport a la normale
    this.tideGate = 0.45;              // k_T, ecretage par la maree (§7.2)
    this.enabled = true;

    /** Amplitudes, pulsations, nombres d'onde, phases des composantes. */
    this.a  = new Float32Array(N_COMP);
    this.w  = new Float32Array(N_COMP);
    this.kx = new Float32Array(N_COMP);
    this.ky = new Float32Array(N_COMP);
    this.ph = new Float32Array(N_COMP);

    /** Etat courant, lu par l'UI et l'audio. */
    this.hsEffective = 0;
    this.setupHeight = 0;
    this.runup2 = 0;
    this.groupPhase = 0;
    this.groupAmp = 1;

    this._bandsSea = -99;
    this.buildGeometry();
    this.applyState(this.stateIndex);
  }

  // --- geometrie -------------------------------------------------------------

  /** Abscisses cross-shore / longshore : ne changent jamais. */
  buildGeometry() {
    for (let z = 0; z < NZ; z++) {
      const wz = ORIGIN_Z + (z + 0.5) * VOXEL;
      for (let x = 0; x < NX; x++) {
        const wx = ORIGIN_X + (x + 0.5) * VOXEL;
        const c = x + NX * z;
        // s croit vers la TERRE ; la houle se propage donc dans le sens +s.
        this.sx[c] = SHORE_NX * wx + SHORE_NZ * wz;
        this.sy[c] = -SHORE_NZ * wx + SHORE_NX * wz;
        this.h0[c] = 0; // rempli par buildBands
      }
    }
  }

  /**
   * Recalcule le masque de relaxation. La bande de generation SUIT la maree :
   * a basse mer elle se rapproche du rivage, sinon elle se retrouve a sec.
   * Appele quand le niveau de la mer a bouge de plus d'un centimetre.
   */
  buildBands(force = false) {
    const W = this.water;
    if (!force && Math.abs(W.seaLevel - this._bandsSea) < 0.01) return;
    this._bandsSea = W.seaLevel;

    // 1. profondeur au repos sur le profil D'ORIGINE (pas surfaceH : sinon un
    //    trou creuse au large deplacerait la ligne de generation).
    let sGenInner = -1e9;
    for (let c = 0; c < COLS; c++) {
      const d = W.shore[c];
      const h = W.seaLevel - beachProfile(d);
      this.h0[c] = h;
      // Abscisse la plus "terre" ou la profondeur atteint encore H_GEN
      if (h >= H_GEN && this.sx[c] > sGenInner) sGenInner = this.sx[c];
    }
    // Repli : a maree tres basse le domaine peut n'avoir nulle part H_GEN.
    if (sGenInner < -1e8) {
      let best = -1e9, bestS = 0;
      for (let c = 0; c < COLS; c++) if (this.h0[c] > best) { best = this.h0[c]; bestS = this.sx[c]; }
      sGenInner = bestS;
    }
    this.sGenInner = sGenInner;
    this.genWidth = W_RELAX * VOXEL;

    // 2. profil alpha : 1 au bord large, 0 a sGenInner.
    const denom = Math.E - 1;
    for (let c = 0; c < COLS; c++) {
      // t = 0 a sGenInner, 1 a sGenInner - genWidth (vers le large)
      const t = clamp((sGenInner - this.sx[c]) / this.genWidth, 0, 1);
      this.alpha[c] = t <= 0 ? 0 : (Math.exp(Math.pow(t, RELAX_P)) - 1) / denom;
    }
  }

  // --- spectre ---------------------------------------------------------------

  applyState(i) {
    const s = SEA_STATES[clamp(i | 0, 0, SEA_STATES.length - 1)];
    this.stateIndex = i;
    this.hs = s.hs;
    this.tp = s.tp;
    this.agitation = s.agit;
    this.enabled = s.hs > 0;
    this.rebuildSpectrum();
  }

  /**
   * Recalcule amplitudes / pulsations / nombres d'onde.
   *
   * Spectre etroit facon JONSWAP : N composantes autour de f_p, ponderees par
   * une gaussienne de largeur relative sigma. On normalise pour que
   *   Hs = 4 * sqrt(m0) = 4 * sqrt( SUM a_i^2 / 2 )   =>   SUM a_i^2 = Hs^2 / 8
   *
   * L'agitation elargit le spectre (sigma) et l'etalement directionnel : une
   * mer "nerveuse" est une mer dont l'energie est repartie sur plus de
   * frequences et plus de directions. Une houle longue et propre est etroite.
   */
  rebuildSpectrum() {
    const W = this.water;
    // Ecretage par la maree : sinon "Tempete" a pleine mer noie tout le domaine.
    const gate = 1 - this.tideGate * Math.max(0, W ? W.tide : 0);
    // Limitation par la profondeur : une vague plus haute que 0,60 h a deja
    // deferle plus au large, hors du domaine. C'est ce qui fait qu'a maree
    // basse la mer est automatiquement plus sage.
    const hGen = Math.max(0.05, (W ? W.seaLevel : 1.05) - beachProfile(this.sGenInner ?? -2.6));
    const hsEff = Math.min(this.hs * gate, 0.60 * hGen);
    this.hsEffective = hsEff;

    const sigma = 0.055 + 0.10 * this.agitation;      // largeur spectrale relative
    const spread = 0.35 + 0.75 * this.agitation;      // etalement directionnel
    const fp = this.tp > 0 ? 1 / this.tp : 0;
    if (fp === 0 || hsEff <= 0) { this.a.fill(0); return; }

    // 1. poids gaussiens
    let sum2 = 0;
    const wgt = new Float32Array(N_COMP);
    for (let i = 0; i < N_COMP; i++) {
      const r = DF[i] / sigma;
      wgt[i] = Math.exp(-0.5 * r * r);
      sum2 += wgt[i] * wgt[i];
    }
    // 2. normalisation vers Hs
    const scale = Math.sqrt((hsEff * hsEff / 8) / sum2);
    // 3. pulsations et nombres d'onde (relation de dispersion en eau peu profonde)
    const hRef = Math.max(H_GEN, hGen);
    const cRef = Math.sqrt(GRAVITY * Math.min(hRef, HFACE_CAP));
    for (let i = 0; i < N_COMP; i++) {
      this.a[i] = wgt[i] * scale;
      const f = fp * (1 + DF[i]);
      this.w[i] = 2 * Math.PI * f;
      const k = this.w[i] / cRef;                     // k = omega / c
      const th = this.incidence + DTHETA[i] * spread;
      this.kx[i] = k * Math.cos(th);                  // vers la terre
      this.ky[i] = k * Math.sin(th);                  // le long du rivage
      if (this.ph[i] === 0) this.ph[i] = Math.random() * Math.PI * 2;
    }

    // 4. grandeurs derivees, pour l'UI et pour le module d'erosion
    const beta = 0.21;
    const L0 = GRAVITY * this.tp * this.tp / (2 * Math.PI);
    const root = Math.sqrt(hsEff * L0);
    this.setupHeight = 0.35 * beta * root;
    const sInc = 0.75 * beta * root;
    const sIg  = 0.06 * root;
    this.runup2 = 1.1 * (this.setupHeight + 0.5 * Math.hypot(sInc, sIg));
  }

  // --- avance ----------------------------------------------------------------

  update(dt) {
    this.time += dt;
    this.buildBands();
    // Le spectre depend de la maree (ecretage + limitation de profondeur) :
    // on le rafraichit doucement, pas a chaque frame.
    this._reSpec = (this._reSpec || 0) + dt;
    if (this._reSpec > 0.5) { this._reSpec = 0; this.rebuildSpectrum(); }

    // Enveloppe de groupe explicite, EN PLUS du battement naturel des
    // composantes. Le battement donne des groupes de ~7 vagues ; l'enveloppe
    // explicite permet de les rendre plus ou moins marques via l'agitation,
    // et donc de doser le drame.
    const tg = this.tp * (6 + 3 * (1 - this.agitation));   // periode de groupe
    this.groupPhase = (this.time / Math.max(tg, 1e-3)) % 1;
    const depth = 0.20 + 0.45 * this.agitation;            // profondeur de modulation
    const e = 0.5 + 0.5 * Math.sin(this.groupPhase * 2 * Math.PI);
    this.groupAmp = (1 - depth) + depth * Math.pow(e, 1.7) * 1.6;
  }

  /** Elevation cible (au-dessus du niveau de la mer) pour la cellule c. */
  eta(c) {
    let e = 0;
    const sx = this.sx[c], sy = this.sy[c];
    for (let i = 0; i < N_COMP; i++) {
      e += this.a[i] * Math.cos(this.w[i] * this.time - this.kx[i] * sx - this.ky[i] * sy + this.ph[i]);
    }
    return e * this.groupAmp;
  }

  /**
   * Relaxation vers l'etat cible. REMPLACE la branche `isOcean` de
   * Water.applyBoundaries.
   *
   * Sur la bande, on melange l'etat calcule et l'etat analytique. Ce melange
   * genere l'onde incidente ET absorbe tout ce qui revient du rivage.
   */
  applyGeneration(dt) {
    const W = this.water;
    const h = W.h, surf = W.field.surfaceH;
    const fR = W.fR, fL = W.fL, fT = W.fT, fB = W.fB;
    const alpha = this.alpha;
    const lvl = W.seaLevel;

    for (let c = 0; c < COLS; c++) {
      const al = alpha[c];
      if (al <= 0.001) continue;

      const bed = surf[c];
      const eta = this.enabled ? this.eta(c) : 0;
      const hTarget = Math.max(0, lvl + eta - bed);
      // Relation de Riemann : u = eta * sqrt(g/h0). C'est elle qui rend la
      // limite transparente pour les ondes sortantes.
      const h0 = Math.max(0.02, lvl - bed);
      const u = eta * Math.sqrt(GRAVITY / h0);
      // Debit volumique cible, projete sur les quatre tuyaux.
      const q = u * hTarget * VOXEL;               // m3/s a travers une face
      const qx = q * SHORE_NX, qz = q * SHORE_NZ;  // vers la TERRE

      h[c] = h[c] * (1 - al) + hTarget * al;
      // Le flux cible est signe : on le range dans le bon tuyau.
      const tR = qx > 0 ? qx : 0, tL = qx < 0 ? -qx : 0;
      const tT = qz > 0 ? qz : 0, tB = qz < 0 ? -qz : 0;
      fR[c] = fR[c] * (1 - al) + tR * al;
      fL[c] = fL[c] * (1 - al) + tL * al;
      fT[c] = fT[c] * (1 - al) + tT * al;
      fB[c] = fB[c] * (1 - al) + tB * al;
    }
  }
}
```

### Modifications de `src/sim/Water.js`

```js
// --- constructor -------------------------------------------------------------
import { WaveField, HFACE_CAP } from './Waves.js';

  this.waves    = new WaveField(this);
  /** Elevation de la surface libre au pas precedent (detection de deferlement). */
  this.etaPrev  = new Float32Array(COLS);
  /** Indicateur de deferlement, 0..1. Nourrit la dissipation ET l'ecume. */
  this.brk      = new Float32Array(COLS);
  /** Ecume seche : reste sur le sable apres le retrait (laisse d'ecume). */
  this.foamDry  = new Float32Array(COLS);
  this.foamTmp  = new Float32Array(COLS);

// --- boucle ------------------------------------------------------------------
  step(dt) {
    const t0 = performance.now();
    this.time += dt * this.tideSpeed;

    this.tide = Math.sin((this.time / TIDE_PERIOD) * Math.PI * 2);
    this.seaLevel = SEA_LEVEL + this.tide * TIDE_AMPLITUDE;
    this.updateWaterTable();
    if (this.moisture) this.moisture.tableH = this.tableH;

    this.waves.update(dt);

    // --- SOUS-PAS -------------------------------------------------------------
    // Depuis la correction D1, le schema est explicitement limite par la CFL :
    //     dt <= 0.8 * dx / (sqrt(g h_max) + |u|_max)
    // A pleine mer (h = 1,36 m) ca fait 8,8 ms, soit 2 a 3 sous-pas a 60 Hz.
    const n = this.substeps(dt);
    const sub = dt / n;
    for (let k = 0; k < n; k++) {
      this.waves.applyGeneration(sub);
      this.seep(sub);                 // ex-branche "suintement" d'applyBoundaries
      this.computeScanRanges();
      this.flux(sub);                 // D1 : k depend de h_face
      this.integrate(sub);
      this.breaking(sub);             // NOUVEAU
    }

    // --- morphologie (une fois par frame : c'est lent, ca n'a pas besoin d'etre
    //     sous-echantillonne) ----------------------------------------------------
    this.erode(dt);
    this.undermine(dt);               // NOUVEAU
    this.advectSediment(dt);
    this.advectFoam(dt);              // NOUVEAU
    this.infiltrate(dt);

    this.stats.ms = this.stats.ms * 0.85 + (performance.now() - t0) * 0.15;
  }

  /** Nombre de sous-pas pour respecter la CFL. Borne a 4. */
  substeps(dt) {
    // hMaxSea est mis a jour par integrate() : profondeur max de la frame.
    const c = Math.sqrt(GRAVITY * Math.min(this.hMaxSea, HFACE_CAP)) + this.uMax;
    return clamp(Math.ceil((dt * c) / (0.8 * VOXEL)), 1, 4);
  }
```

```js
  /**
   * D1 : la celerite doit dependre de la profondeur.
   *
   * L'ancienne version utilisait k = dt*A*g/L = dt*g*dx, soit une celerite
   * fixe de sqrt(g*dx) = 0,63 m/s quelle que soit la profondeur. Consequence :
   * aucune levee (shoaling), donc aucun deferlement possible, donc pas de
   * vagues individuelles. C'est LA raison pour laquelle le ressac sinusoidal
   * ne donnait qu'une bouillie.
   */
  flux(dt) {
    const F = this.field;
    const surf = F.surfaceH;
    const h = this.h;
    const fR = this.fR, fL = this.fL, fT = this.fT, fB = this.fB;
    const vx = this.vx, vz = this.vz;
    const alpha = this.waves.alpha;
    const kBase = dt * GRAVITY;
    // Damping NUMERIQUE seulement (anti-oscillation). Le vrai frottement est
    // le terme semi-implicite ci-dessous.
    const damp = Math.pow(WATER_DAMPING_NUM, dt * 60);   // 0.999

    for (let z = 0; z < NZ; z++) {
      const row = NX * z;
      const xa = this.scanA[z], xb = this.scanB[z];
      for (let x = xa; x <= xb; x++) {
        const c = row + x;
        const hc = h[c];
        if (hc < WATER_EPSILON) {
          if (fR[c] || fL[c] || fT[c] || fB[c]) fR[c] = fL[c] = fT[c] = fB[c] = 0;
          continue;
        }
        const bc = surf[c];
        const H = bc + hc;

        // Frottement de fond semi-implicite : tau_b = 0.5 rho f_w |u| u.
        // Il mord DANS LA LAME MINCE (jet de rive) et nulle part ailleurs :
        // c'est exactement le bon comportement, et c'est ce qui remplace le
        // damping global de 0.985 qui mangeait 60 % de la quantite de
        // mouvement par seconde.
        const sp = Math.hypot(vx[c], vz[c]);
        // f_w double a la MONTEE (documente : le jet a un coefficient de
        // frottement deux fois superieur au retrait, ce qui explique le
        // transport net vers la terre).
        const onshore = (vx[c] * SHORE_NX + vz[c] * SHORE_NZ) > 0;
        const fw = onshore ? FW_UPRUSH : FW_BACKWASH;
        const fric = 1 / (1 + dt * 0.5 * fw * sp / Math.max(hc, 0.004));

        // --- quatre tuyaux ---
        // hFace : profondeur hydrauliquement connectee. C'est le facteur qui
        // donne c = sqrt(g h) et donc la levee.
        let out = 0;
        for (let k = 0; k < 4; k++) {
          const n = NEI[k] === 0 ? c + 1 : NEI[k] === 1 ? c - 1 : NEI[k] === 2 ? c + NX : c - NX;
          const inside = /* bornes */;
          const Hn = inside ? surf[n] + h[n] : this.seaLevel;
          const bn = inside ? surf[n] : bc;
          let hF = Math.min(H, Hn) - Math.max(bc, bn);
          if (hF < HFACE_MIN) hF = HFACE_MIN;
          // Plafond dans la bande de generation : cape la celerite et divise
          // par deux le nombre de sous-pas. Invisible.
          if (alpha[c] > 0.01 && hF > HFACE_CAP) hF = HFACE_CAP;
          const f = Math.max(0, (FLUX[k][c] * damp + kBase * hF * (H - Hn)) * fric);
          FLUX[k][c] = f;
          out += f;
        }

        // Mise a l'echelle : on ne peut pas donner plus d'eau qu'on en a.
        if (out > 0) {
          const avail = (hc * A) / dt;
          if (out > avail) {
            const s = avail / out;
            fR[c] *= s; fL[c] *= s; fT[c] *= s; fB[c] *= s;
          }
        }
      }
    }
  }
```

```js
  /**
   * integrate() : idem, avec un cap de FROUDE au lieu du cap de vitesse en dur.
   *
   * L'ancien `if (sp > 4)` est arbitraire : dans 5 cm d'eau, 4 m/s c'est
   * Fr = 5,7, une absurdite physique qui fait exploser l'erosion ; dans 90 cm,
   * 4 m/s c'est Fr = 1,35, parfaitement legitime. Le bon garde-fou est le
   * nombre de Froude.
   */
    const cel = Math.sqrt(GRAVITY * Math.max(hm, 0.004));
    const sp = Math.hypot(vx[c], vz[c]);
    const spMax = FR_MAX * cel;                    // FR_MAX = 1.6
    if (sp > spMax) { const s = spMax / sp; vx[c] *= s; vz[c] *= s; }
    if (h1 > this.hMaxSea) this.hMaxSea = h1;
    if (sp > this.uMax) this.uMax = sp;
```

---

# 3. GÉNÉRATION DE LA HOULE

## 3.1 L'échelle : notre plage est un modèle de Froude au 1:10

Point crucial, souvent raté. Notre domaine fait 10,24 m et la mer y est profonde de
0,90 m. Une houle réelle de période 8 s a, dans 40 cm d'eau, une longueur d'onde
`L = √(g·h)·T = 1,98 × 8 = 15,8 m` : **elle ne tient pas dans le domaine**. Injecter
des périodes océaniques ne produirait qu'une seule bosse qui monte et descend — c'est
exactement le ressac actuel.

La sortie est la **similitude de Froude**. Les équations de Saint-Venant sont
invariantes par la transformation :

```
    longueurs  : λ          (échelle géométrique)
    temps      : √λ
    vitesses   : √λ
    périodes   : √λ
    hauteurs   : λ
    débits     : λ^(5/2)
```

Avec **λ = 10**, notre bac de 10 m représente une plage de 100 m :

| Grandeur | Plage réelle | Notre domaine (λ = 10) |
|---|---|---|
| Étendue | 100 m | 10,24 m |
| Profondeur au large | 9 m | 0,90 m |
| Hs de houle moyenne | 1,8 m | **0,18 m** |
| Période Tp | 8,2 s | **2,6 s** |
| Longueur d'onde au déferlement | 25 m | 2,5 m |
| Vitesse du jet de rive | 6,9 m/s | **2,17 m/s** |
| Marée (amplitude) | 4,6 m | 0,46 m |
| Cycle de marée | 12 h 40 | **12 min** (déjà dans `Config.js`, accéléré ×63 par rapport à Froude — choix de jeu assumé) |

**Le solveur, lui, n'a rien à savoir de tout ça** : il résout les équations à
l'échelle 1:1 du bac. C'est seulement le *nommage* qui se fait à l'échelle réelle. Le
joueur qui lit « Grosse houle » voit 30 cm dans son bac ; l'analogie mentale est celle
d'une houle de 3 m sur une plage de 100 m. Ça marche parce que Froude est exact pour
les écoulements à surface libre dominés par la gravité — c'est-à-dire le nôtre.

Corollaire important : **toutes les formules empiriques dont les termes sont
dimensionnellement des longueurs** (Stockdon, Hunt, Green, la limite `H = 0,78 h`)
sont transposables telles quelles. Celles qui contiennent une échelle de grain
(le `exp(−10 d₅₀^0,55)` de certaines formules de run-up) ne le sont pas — on ne réduit
pas la taille des grains de sable. On les évite.

## 3.2 Spectre : produire un train crédible et non répétitif

### Formule

```
    η(s, y, t) = A_g(t) · Σᵢ₌₁..N  aᵢ · cos( ωᵢ t − k_x,ᵢ · s − k_y,ᵢ · y + φᵢ )
```

- `s` = abscisse cross-shore (croissante vers la terre), `y` = abscisse le long du rivage.
- `N = 5` composantes. Trois seraient audibles comme un battement mécanique ; au-delà
  de six, le gain est nul et le coût monte (`eta()` est évalué par cellule de la
  bande, soit ~2 000 cellules × N cosinus par sous-pas).

**Pulsations.** On écarte les composantes de `f_p` par des rapports *mutuellement
irrationnels*, sans quoi la superposition se répète avec une période courte et le
joueur l'entend :

```js
const DF = [-0.137, -0.061, 0.0, 0.072, 0.151];
ωᵢ = 2π · f_p · (1 + DFᵢ)
```

Battements dominants qui en résultent :

| paire | Δf relatif | `T_g` à `Tp = 2,6 s` | vagues par groupe |
|---|---|---|---|
| 2–3 | 0,061 | 42,6 s | 16 |
| 3–4 | 0,072 | 36,1 s | 14 |
| 1–2 | 0,076 | 34,2 s | 13 |
| 4–5 | 0,079 | 32,9 s | 13 |
| **1–3** | **0,137** | **19,0 s** | **7,3 ← la « septième vague »** |
| 1–5 | 0,288 | 9,0 s | 3,5 |

Le battement à 7,3 vagues est celui qu'on veut. Les battements longs (13–16 vagues)
fournissent la modulation lente qui empêche la lassitude.

**Amplitudes.** Pondération gaussienne autour du pic (JONSWAP étroit) puis
normalisation par le moment d'ordre 0 :

```
    wᵢ    = exp( − ½ · (DFᵢ / σ)² )
    m₀    = Σ aᵢ² / 2                      (variance de la surface libre)
    Hs    = 4 √m₀                          (définition spectrale de Hs)
    ⇒  Σ aᵢ² = Hs² / 8
    ⇒  aᵢ  = wᵢ · √( (Hs²/8) / Σ wⱼ² )
```

`σ` = largeur spectrale relative, pilotée par l'agitation :

```
    σ = 0,055 + 0,10 · agitation           σ ∈ [0,055 ; 0,155]
```

Une houle propre venue de loin est étroite (σ = 0,06) ; une mer du vent locale est
large (σ = 0,15). C'est exactement la différence entre *swell* et *wind sea*, et
c'est ce que le joueur ressentira comme « régulier » vs « nerveux ».

**Nombres d'onde.** Relation de dispersion en eau peu profonde, évaluée à la
profondeur de la ligne de génération :

```
    c_ref = √( g · min(h_gen, HFACE_CAP) )
    kᵢ    = ωᵢ / c_ref
    k_x,ᵢ = kᵢ · cos(θ₀ + Δθᵢ · spread)
    k_y,ᵢ = kᵢ · sin(θ₀ + Δθᵢ · spread)
```

**Étalement directionnel.** `Δθ = [−0,21, −0,09, 0, +0,11, +0,19]` rad, multiplié
par `spread = 0,35 + 0,75 · agitation`. Effet : les crêtes ne sont pas des lignes
droites parfaites — elles ondulent le long du rivage et **déferlent en « pelant »**,
d'un bout à l'autre, au lieu de casser d'un bloc. C'est ce détail qui fait la
différence entre « une vague de jeu vidéo » et « une vague ». Coût : zéro (un terme
de plus dans un cosinus déjà calculé).

### Enveloppe de groupe explicite

Le battement des composantes produit déjà des groupes. On y ajoute une enveloppe
lente **pilotable**, pour que la molette « agitation » puisse accentuer ou lisser les
séries :

```
    T_g   = Tp · ( 6 + 3 · (1 − agitation) )         9 Tp au calme, 6 Tp agité
    e(t)  = ½ + ½ · sin( 2π t / T_g )
    A_g   = (1 − D) + D · e(t)^1,7 · 1,6            D = 0,20 + 0,45 · agitation
```

L'exposant 1,7 rend l'enveloppe **piquée** : des accalmies larges, des séries courtes
et franches. Un `sin` nu donnerait une respiration molle.

| agitation | `D` | `A_g` min | `A_g` max | ressenti |
|---|---|---|---|---|
| 0,00 | 0,20 | 0,80 | 1,12 | vagues régulières, presque métronomiques |
| 0,40 | 0,38 | 0,62 | 1,23 | groupes nets, accalmies visibles |
| 0,75 | 0,54 | 0,46 | 1,32 | séries franches, longs répits |
| 1,00 | 0,65 | 0,35 | 1,39 | mer désordonnée, coups de boutoir |

`A_g` max ≈ 1,39 combiné à la crête d'une superposition favorable donne la **vague
scélérate** : localement 1,8 à 2,2 × `Hs`, ce qui est exactement le rapport
`H_max/Hs ≈ 1,86` prédit par la statistique de Rayleigh sur un enregistrement de
1 000 vagues. La physique tombe juste sans qu'on l'ait forcée.

### Ondulation infragravitaire

Le terme `S_ig` de Stockdon vient de l'onde longue liée. On peut le simuler
explicitement, très simplement, en modulant **le niveau moyen** dans la bande de
génération en opposition de phase avec l'enveloppe (c'est la définition physique de
l'onde longue liée : le niveau est *abaissé* sous les gros groupes et *relevé* entre
eux) :

```
    η_ig(t) = − C_ig · Hs · ( A_g(t) − Ā_g )        C_ig ≈ 0,22
```

Effet en jeu : entre deux groupes, le plan d'eau est relevé de quelques centimètres,
et les vagues de *début* de série montent plus haut que leur taille ne le laisserait
croire. C'est le mécanisme réel de « la vague qui vient te chercher plus haut ».
Coût : un scalaire.

## 3.3 D6 — Les six niveaux exposés au joueur

### Table maîtresse

Valeurs calculées pour **β = 0,21** (face de plage, mi-marée), `L₀ = gTp²/2π`,
formule de Stockdon. Le « taux d'érosion relatif » est `u₀³ / Tp` normalisé sur le
niveau 2 (`u₀³` = loi énergétique de Bagnold pour le transport).

| # | Nom interface | `Hs` (m) | `Tp` (s) | vagues/min | `ξ₀` | déferlement | `R2%` | excursion | `u₀` jet | `τ` jet | érosion rel. |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **0** | **Mer d'huile** | 0 | — | 0 | — | aucun | 0 | 0 | 0 | 0 Pa | **0,00** |
| **1** | **Clapot** | 0,04 | 1,6 | 37 | 2,10 | frontal | 6,9 cm | 0,33 m | 1,17 m/s | 34 Pa | **0,39** |
| **2** | **Petites vagues** | 0,09 | 2,0 | 30 | 1,75 | plongeant | 13,0 cm | 0,62 m | 1,60 m/s | 64 Pa | **1,00** |
| **3** | **Houle** | 0,18 | 2,6 | 23 | 1,61 | plongeant | 23,9 cm | 1,14 m | 2,17 m/s | 118 Pa | **1,92** |
| **4** | **Grosse houle** | 0,30 | 3,1 | 19 | 1,49 | plongeant | 36,8 cm | 1,75 m | 2,69 m/s | 181 Pa | **3,07** |
| **5** | **Tempête** | 0,45 | 3,6 | 17 | 1,41 | plongeant | 52,4 cm | 2,49 m | 3,21 m/s | 258 Pa | **4,49** |

Détail des composantes de run-up (cm) :

| # | set-up `η̄` | swash incident `S_inc` | swash infragravitaire `S_ig` | `R2%` | durée du jet `t_up` |
|---|---|---|---|---|---|
| 1 | 2,9 | 6,3 | 2,4 | 6,9 | 0,57 s |
| 2 | 5,5 | 11,8 | 4,5 | 13,0 | 0,78 s |
| 3 | 10,1 | 21,7 | 8,3 | 23,9 | 1,05 s |
| 4 | 15,6 | 33,4 | 12,7 | 36,8 | 1,30 s |
| 5 | 22,2 | 47,5 | 18,1 | 52,4 | 1,56 s |

### Justification des choix

- **`Hs` en progression géométrique de raison ≈ 2,1.** Chaque cran doit être
  clairement plus gros que le précédent. Une progression linéaire donne quatre niveaux
  qui se ressemblent et un qui détonne.
- **`Tp` croît avec `Hs`** comme dans la nature : `Tp ≈ 5,4 · √Hs` (loi fetch-limitée
  réduite d'un facteur √10 par Froude). Vérification : `5,4 × √0,18 = 2,29` — on
  utilise 2,6, un peu plus long, pour garder `ξ₀ > 1` et donc des déferlantes
  **plongeantes** photogéniques plutôt que glissantes.
- **`ξ₀` reste entre 1,4 et 2,1 sur toute la gamme.** C'est délibéré : le type de
  déferlement ne doit pas changer d'un cran à l'autre (sinon l'esthétique saute) ; il
  change avec la **marée** (β passe de 0,21 à 0,40 à basse mer), ce qui donne de la
  variété *dans le temps* plutôt que dans les réglages.
- **Le taux d'érosion relatif s'étale sur un facteur 11,5** entre Clapot et Tempête, et
  il est **nul** en mer d'huile. C'est la dynamique nécessaire pour que la molette soit
  ressentie comme un vrai choix.
- **17 à 37 vagues par minute.** À 23/min (« Houle »), une vague toutes les 2,6 s :
  assez fréquent pour que ce soit vivant, assez espacé pour que chaque vague soit un
  **événement** qu'on regarde. En dessous de 15/min ça traîne ; au-delà de 45/min ça
  redevient un bruit de fond.

### Contrôle « agitation » séparé

Le niveau donne `Hs` et `Tp`. L'agitation (0 à 1, indépendante) module quatre choses :

| Ce que pilote l'agitation | Formule | à 0 | à 1 |
|---|---|---|---|
| Largeur spectrale `σ` | `0,055 + 0,10·a` | 0,055 | 0,155 |
| Étalement directionnel | `0,35 + 0,75·a` | 0,35 | 1,10 |
| Profondeur de groupe `D` | `0,20 + 0,45·a` | 0,20 | 0,65 |
| Période de groupe `T_g` | `Tp·(6 + 3(1−a))` | 9 Tp | 6 Tp |
| Gain de déferlement `C_b` | `3,0 + 2,5·a` | 3,0 s⁻¹ | 5,5 s⁻¹ |

À agitation 0 : houle longue et propre, crêtes parallèles, vagues régulières,
déferlement doux et prévisible — de la « belle houle de fin d'été ». À agitation 1 :
mer croisée, crêtes tordues, séries brutales, écume partout. **Même `Hs`, deux mers
totalement différentes.** C'est ce que le joueur demande quand il dit « l'intensité ».

## 3.4 Direction de la houle, incidence et dérive littorale

Le rivage est une diagonale de normale `n̂ = (0,4472 ; 0,8944)`, soit **−26,6° par
rapport à l'axe Z**. On paramètre l'incidence `θ₀` par rapport à cette normale.

**Faut-il modéliser la dérive littorale (longshore drift) ?**

*Pour :* c'est l'un des phénomènes les plus visibles d'une plage. Un courant parallèle
au rivage s'installe dès que les vagues déferlent en biais ; il transporte du sable,
contourne les obstacles, crée flèches et tombolos. Formule CERC :

```
    Q = K · (ρ_s − ρ)⁻¹ · (ρ / (16 √γ_b)) · H_b^(5/2) · sin(2 α_b)      K ≈ 0,4
```

Le transport est maximal vers **45° d'incidence au déferlement** (≈ 50° au large, la
réfraction réduisant l'angle en approchant).

*Contre :* dérisoire à notre échelle. Avec `H_b = 0,20 m` et `α_b = 12°` (l'incidence
chute fortement par réfraction — loi de Snell avec `c = √(gh)`), la CERC donne de
l'ordre de `10⁻⁵ m³/s` par mètre de rivage. Sur un cycle de marée de 12 minutes :
**7 cm³**. C'est-à-dire rien.

**Verdict : oui à l'incidence, non au modèle de dérive.**

- **Garder l'incidence** `θ₀ = 0,20 à 0,35 rad` (11° à 20°). Elle coûte **zéro** (un
  terme dans un cosinus) et offre trois choses gratuitement :
  1. les crêtes **pèlent** le long du rivage au lieu de casser d'un bloc — énorme
     visuellement ;
  2. le jet de rive arrive **en biais** sur les constructions, donc les attaque par un
     flanc : ça casse la symétrie et rend chaque partie différente ;
  3. le courant longshore **émerge quand même du solveur**, puisqu'il résout la
     quantité de mouvement en 2D. Il sera faible, mais il sera là, et il donnera la
     dérive visible de l'écume le long de la laisse.
- **Ne coder aucun modèle de dérive dédié.** Pas de formule empirique, pas de transport
  longshore explicite. Ce que le solveur produit suffit et reste cohérent.
- **Exposer l'incidence** comme réglage secondaire (« La mer vient de… ») à trois
  crans : *de face* (θ = 0), *de la gauche* (θ = +0,30), *de la droite* (θ = −0,30).
  C'est un vrai levier tactique : ça décide quel flanc du château prend les coups.

---

# 4. DÉFERLEMENT ET RESSAUT

## 4.1 Détection du déferlement dans un solveur en eaux peu profondes

Trois familles de critères, par ordre de robustesse dans notre contexte.

### (i) Critère de vitesse de surface (Kennedy et al. 2000) — **retenu**

Standard des modèles de Boussinesq/Saint-Venant en surf zone. On déferle quand la
surface libre monte plus vite qu'une fraction de la célérité :

```
    ∂η/∂t  ≥  γ_on  · √(g h)      →  déclenchement       γ_on  = 0,65
    ∂η/∂t  <  γ_off · √(g h)      →  extinction          γ_off = 0,15
```

avec un **relâchement progressif** sur `T* = 5 · √(h/g)` (0,36 s dans 5 cm d'eau,
1,0 s dans 40 cm) : le rouleau ne disparaît pas instantanément quand le critère cesse
d'être vérifié, sinon on obtient un clignotement.

*Pourquoi celui-ci :* il ne demande qu'une valeur d'histoire (`η` au pas précédent), il
est purement local, il n'exige pas d'estimer « la hauteur de vague » — impossible dans
un champ où les vagues ne sont pas identifiées — et il fonctionne identiquement pour
une déferlante au large et pour un ressaut sur l'estran.

### (ii) Critère de Froude — **retenu en complément**

```
    Fr = |u| / √(g h)  >  1,0     →  écoulement supercritique = ressaut
```

Il attrape ce que (i) rate : les ressauts **stationnaires** (sortie d'une brèche de
douve, pied de mur), où `∂η/∂t ≈ 0` mais où la dissipation est bien réelle. Important
pour le jeu : le joueur doit voir de l'écume là où l'eau se précipite dans sa tranchée.

### (iii) Critère `H/h > γ = 0,78` — **non utilisable directement**

Il exige de connaître `H`, la hauteur *de la vague*, alors que le solveur ne connaît
que `h`, la hauteur *d'eau instantanée*. On pourrait l'estimer par suivi de
crête/creux, mais c'est cher et fragile. **On le garde comme critère de
dimensionnement** (c'est lui qui fixe `Hs_eff ≤ 0,60 · h_gen` en §3.2, et qui dit où la
vague *devrait* casser), pas comme critère d'exécution.

En pratique, avec la correction D1, le déferlement se produit **de lui-même** à peu près
là où `H/h ≈ 0,8` : c'est une propriété des équations de Saint-Venant, pas quelque
chose qu'on impose. C'est précisément l'argument du modèle (a).

### Code

```js
  /**
   * DEFERLEMENT.
   *
   * Detection : critere de Kennedy et al. (2000) sur la vitesse de montee de
   * la surface libre, complete par un critere de Froude pour attraper les
   * ressauts stationnaires (breche de douve, pied de mur).
   *
   * Dissipation : le modele pipe n'a pas d'equation de quantite de mouvement
   * explicite ou l'on pourrait ajouter une viscosite de rouleau. On agit donc
   * directement sur les FLUX, ce qui revient exactement au meme : la perte de
   * quantite de mouvement au travers d'un ressaut hydraulique.
   *
   * A quoi ca sert dans le jeu : sans ce terme, l'energie de la houle arrive
   * intacte jusqu'au rivage et rase tout ; avec lui, un haut-fond ou un
   * brise-lames construit par le joueur DISSIPE reellement.
   */
  breaking(dt) {
    const h = this.h, surf = this.field.surfaceH;
    const vx = this.vx, vz = this.vz;
    const fR = this.fR, fL = this.fL, fT = this.fT, fB = this.fB;
    const etaPrev = this.etaPrev, brk = this.brk, foam = this.foam;
    const invDt = 1 / dt;
    const gain = BREAK_GAIN_BASE + BREAK_GAIN_AGIT * this.waves.agitation;
    const foamDecayWet = Math.exp(-dt / FOAM_TAU_WET);

    for (let z = 1; z < NZ - 1; z++) {
      const row = NX * z;
      const xa = Math.max(1, this.scanA[z]);
      const xb = Math.min(NX - 2, this.scanB[z]);
      for (let x = xa; x <= xb; x++) {
        const c = row + x;
        const hw = h[c];
        if (hw < WATER_EPSILON) { etaPrev[c] = surf[c]; brk[c] = 0; continue; }

        const eta  = surf[c] + hw;
        const dEta = (eta - etaPrev[c]) * invDt;
        etaPrev[c] = eta;

        const cel = Math.sqrt(GRAVITY * hw);
        const on  = BREAK_ON  * cel;      // 0.65 c
        const off = BREAK_OFF * cel;      // 0.15 c

        let b = brk[c];
        if (dEta >= on) {
          b = 1;
        } else if (dEta <= off) {
          // Relachement sur T* = 5 sqrt(h/g) : le rouleau survit a la crete.
          const tStar = 5 * Math.sqrt(hw / GRAVITY);
          b = Math.max(0, b - dt / Math.max(tStar, 0.05));
        } else {
          b = Math.max(b, (dEta - off) / (on - off));
        }

        // Ressaut stationnaire : Froude > 1
        const sp = Math.hypot(vx[c], vz[c]);
        const fr = sp / Math.max(cel, 0.04);
        if (fr > 1) b = Math.max(b, Math.min(1, (fr - 1) / 0.6));

        brk[c] = b;
        if (b < 0.02) { foam[c] *= foamDecayWet; continue; }

        // --- 1. dissipation : perte de quantite de mouvement -----------------
        // Semi-implicite => inconditionnellement stable, quel que soit dt.
        const k = 1 / (1 + gain * b * dt);
        fR[c] *= k; fL[c] *= k; fT[c] *= k; fB[c] *= k;

        // --- 2. etalement du rouleau -----------------------------------------
        // Un ressaut a une epaisseur physique (l'ecume roulante). Sans ce
        // terme, le front reste un choc d'UNE cellule : visuellement un mur de
        // 4 cm, pas un rouleau. La diffusion lui donne 3 a 5 cellules.
        //   nu = C * b * sqrt(g h) * dx        (viscosite de rouleau)
        // Stabilite : nu*dt/dx^2 <= 0.25 ; a b=1, h=0.2, dx=0.04 :
        //   nu = 0.6*1*1.40*0.04 = 0.0336 m2/s ; 0.0336*0.0083/0.0016 = 0.17 OK
        const nu  = ROLLER_NU * b * cel * VOXEL;
        const lap = h[c + 1] + h[c - 1] + h[c + NX] + h[c - NX] - 4 * hw;
        h[c] = Math.max(0, hw + nu * dt * lap / (VOXEL * VOXEL));

        // --- 3. ecume ---------------------------------------------------------
        foam[c] = Math.min(1.2, foam[c] * foamDecayWet + b * FOAM_GAIN * dt);
      }
    }
  }
```

## 4.2 Constantes de déferlement

| constante | valeur | justification |
|---|---|---|
| `BREAK_ON` | **0,65** | Kennedy et al. (2000), valeur standard. En dessous de 0,50 on déclenche sur du clapot ordinaire et tout devient blanc. |
| `BREAK_OFF` | **0,15** | idem. L'hystérésis 0,65 → 0,15 est indispensable : sans elle le rouleau clignote à chaque pas. |
| `T*` (relâchement) | **`5·√(h/g)`** | 0,36 s dans 5 cm, 1,01 s dans 40 cm. Donne au rouleau une durée de vie physique. |
| `BREAK_GAIN_BASE` | **3,0 s⁻¹** | calibrage : une vague qui traverse 1,2 m de surf zone à 1,5 m/s (0,8 s) en régime `b = 1` conserve `1/(1+3×0,8) = 29 %` de sa quantité de mouvement. Cohérent avec la mesure (une déferlante dissipe 70 à 90 % de son énergie dans la surf zone). |
| `BREAK_GAIN_AGIT` | **2,5 s⁻¹** | l'agitation renforce la dissipation (mer croisée = plus turbulente). Total 3,0 à 5,5 s⁻¹. |
| `ROLLER_NU` | **0,6** | épaisseur du rouleau. À 0,3 le front reste un mur d'une cellule ; à 1,2 le ressaut est mou et on perd l'impact. |
| `FR_MAX` | **1,6** | plafond de Froude dans `integrate()`, remplace le `sp > 4` en dur. Un ressaut réel monte à Fr = 1,5–2,5 ; on cape à 1,6 pour la stabilité de l'érosion. |
| `FW_UPRUSH` | **0,050** | frottement à la montée. Plage documentée 0,02–0,10 ; le jet est dans le haut. |
| `FW_BACKWASH` | **0,025** | à la descente. Le rapport 2:1 est mesuré et c'est lui qui produit le transport net vers la terre. |
| `HFACE_MIN` | **0,006 m** | plancher de célérité, pour que la pointe du jet avance encore. |
| `HFACE_CAP` | **0,55 m** | plafond dans la bande de génération (économie de sous-pas). |
| `WATER_DAMPING_NUM` | **0,999** | ex-`WATER_DAMPING = 0,985`. Le frottement physique a pris le relais. |
| `FOAM_GAIN` | **3,5 s⁻¹** | une cellule en plein déferlement sature son écume en 0,3 s. |

## 4.3 Où naît l'écume, et combien de temps elle vit

Trois sources distinctes, trois durées de vie distinctes. Les confondre est l'erreur
classique — le shader actuel le note d'ailleurs très justement : *« L'écume naît de la
TURBULENCE, pas de la faible profondeur »*.

| Source | Où | Champ | `τ` | Aspect |
|---|---|---|---|---|
| **Crête déferlante** | `brk > 0,3` | `foam` | **2,5 s** | bande dense et vive au sommet du front, se déplace avec lui |
| **Écume de surf** | trace laissée par `brk` | `foam`, advectée | **5 à 7 s** | nappe blanche qui traîne derrière la vague, s'étire dans le courant |
| **Laisse d'écume** | sur le sable après le retrait | `foamDry` (nouveau) | **9 à 14 s** | dentelle immobile à la limite du jet, marque la laisse, sèche sur place |

Facteurs de décroissance exponentielle par pas à 60 Hz (`exp(−dt/τ)`) :

| `τ` | facteur / frame |
|---|---|
| 2 s | 0,99170 |
| 4 s | 0,99584 |
| 6 s | 0,99723 |
| 9 s | 0,99815 |
| 14 s | 0,99881 |

**Advection.** L'écume est portée par le courant. On réutilise exactement la
machinerie semi-lagrangienne de `advectSediment()` :

```js
  /**
   * L'ecume derive avec le courant. Sans ca elle reste collee la ou elle est
   * nee, et le retrait laisse une nappe blanche immobile qui ne ressemble a
   * rien. Avec, elle s'etire en trainees dans le sens de l'ecoulement : c'est
   * la lecture la plus immediate du champ de vitesse pour le joueur.
   */
  advectFoam(dt) {
    const foam = this.foam, tmp = this.foamTmp, dry = this.foamDry;
    const vx = this.vx, vz = this.vz, h = this.h;
    const dryDecay = Math.pow(0.99815, dt * 60);          // tau ~ 9 s
    for (let z = 0; z < NZ; z++) {
      const row = NX * z;
      const xa = this.scanA[z], xb = this.scanB[z];
      for (let x = xa; x <= xb; x++) {
        const c = row + x;
        if (h[c] < WATER_EPSILON) {
          // La cellule vient de s'assecher : l'ecume se DEPOSE. C'est la laisse
          // d'ecume, celle qui reste sur le sable mouille apres le retrait et
          // qui trahit jusqu'ou la mer est montee.
          if (foam[c] > 0.02) { dry[c] = Math.max(dry[c], foam[c] * 0.75); foam[c] = 0; }
          tmp[c] = 0;
          dry[c] *= dryDecay;
          continue;
        }
        const px = clamp(x - (vx[c] * dt) / VOXEL, 0, NX - 1.001);
        const pz = clamp(z - (vz[c] * dt) / VOXEL, 0, NZ - 1.001);
        const x0 = px | 0, z0 = pz | 0;
        const tx = px - x0, tz = pz - z0;
        const a  = foam[x0     + NX * z0],       b = foam[x0 + 1 + NX * z0];
        const cc = foam[x0 + NX * (z0 + 1)],     d = foam[x0 + 1 + NX * (z0 + 1)];
        tmp[c] = (a * (1 - tx) + b * tx) * (1 - tz) + (cc * (1 - tx) + d * tx) * tz;
        // L'ecume seche est reprise par l'eau qui repasse dessus.
        if (dry[c] > 0) { tmp[c] = Math.min(1.2, tmp[c] + dry[c] * 0.5); dry[c] *= 0.5; }
      }
      for (let x = xa; x <= xb; x++) foam[row + x] = tmp[row + x];
    }
  }
```

**Pourquoi `foamDry` est un tableau séparé.** Parce que le shader d'eau fait
`if (d < 0.0016) discard;` : une écume stockée dans `foam` sur une cellule sèche n'est
**jamais dessinée**. La laisse d'écume — l'un des détails les plus évocateurs d'une
plage — serait invisible. `foamDry` doit être lu par le shader du **sable** (§6.4), pas
par celui de l'eau.

---

# 5. INTERACTION AVEC LE SABLE — LE CŒUR DU JEU

## 5.1 Contrainte de cisaillement sous un jet de rive

Deux formulations coexistent dans la littérature, et le code actuel mélange les deux.

**(a) Contrainte de traînée de fond** — celle qui compte dans le jet de rive :

```
    τ_b = ½ · ρ · f_w · |u| · u                 ρ = 1000 kg/m³
```

**(b) Contrainte d'écoulement graduellement varié** — celle qui compte dans une nappe
qui ruisselle sur une pente :

```
    τ_b = ρ · g · h · S                          S = pente de la ligne d'énergie
```

`Water.erode()` utilise aujourd'hui `τ = ρ g min(h,0.25) sinα · 0.35 + ρ u² · 0.012`,
soit un mélange des deux avec des coefficients ad hoc. Ce n'est pas faux — pour du
ruissellement, (b) domine et c'est ce que Mei et al. modélisent — mais **dans un jet de
rive c'est (a) qui domine d'un ordre de grandeur**, parce que la lame est mince (`h`
petit ⇒ (b) petit) et rapide (`u` grand ⇒ (a) grand).

### Chiffres

| Régime | `h` | `|u|` | `f_w` | `τ` par (a) | `τ` par (b), S = 0,21 |
|---|---|---|---|---|---|
| Nappe calme dans une douve | 0,08 m | 0,10 m/s | 0,03 | **0,15 Pa** | 165 Pa (mais S ≈ 0 : **~0 Pa**) |
| Ruissellement sur la face de plage | 0,02 m | 0,30 m/s | 0,03 | **1,4 Pa** | 41 Pa × 0,35 = 14 Pa |
| Jet de rive « Petites vagues » | 0,04 m | 1,60 m/s | 0,050 | **64 Pa** | 29 Pa |
| Jet de rive « Houle » | 0,06 m | 2,17 m/s | 0,050 | **118 Pa** | 43 Pa |
| Jet de rive « Grosse houle » | 0,09 m | 2,69 m/s | 0,050 | **181 Pa** | 65 Pa |
| Jet de rive « Tempête » | 0,14 m | 3,21 m/s | 0,050 | **258 Pa** | 101 Pa |
| Retrait « Houle » | 0,04 m | 1,52 m/s | 0,025 | **29 Pa** | 29 Pa |

**Rapport jet de rive / nappe calme : 400 à 1700.** C'est ça, la réponse à la question
« pourquoi une vague fait ce qu'une flaque ne fait pas ». Trois causes cumulées :

1. **`u²`.** Passer de 0,1 à 2,2 m/s, c'est ×480 sur `u²`.
2. **`f_w` doublé.** Le front du jet est un choc turbulent, chargé de bulles ; sa
   rugosité effective est deux à quatre fois celle d'un écoulement établi. Mesuré :
   « la contrainte au fond à travers le front du jet est typiquement deux à quatre fois
   supérieure à celle du retrait à vitesse et position équivalentes ».
3. **La couche de *sheet flow*.** Sous un jet, ce n'est pas du charriage grain par
   grain : c'est une couche de quelques centimètres à 100–1600 kg/m³ de sable en
   mouvement collectif. Le sable ne s'érode pas, il **flue**.

### Ce qu'il faut changer dans `erode()`

```js
  /**
   * EROSION.
   *
   * Deux regimes, deux formules. Le ruissellement (Mei et al.) est domine par
   * la pente ; le jet de rive est domine par la vitesse. On prend le MAX des
   * deux, ce qui bascule automatiquement du bon cote.
   *
   * Le biais montee/descente (f_w double a la montee) n'est pas un detail :
   * c'est LUI qui produit le transport net vers la terre, donc la berme, donc
   * une plage qui se maintient au lieu de se raboter jusqu'a la mer.
   */
    const sp  = Math.hypot(vx[c], vz[c]);
    const onshore = (vx[c] * SHORE_NX + vz[c] * SHORE_NZ) > 0;
    const fw  = onshore ? FW_UPRUSH : FW_BACKWASH;

    // (a) trainee de fond : domine dans la lame mince et rapide du jet
    const tauDrag = 0.5 * 1000 * fw * sp * sp;
    // (b) ecoulement graduellement varie : domine dans le ruissellement
    const tauFlow = 1000 * GRAVITY * Math.min(hw, 0.25) * sinA * 0.35;
    // (c) surcote de deferlement : un ressaut qui casse SUR le sable remue
    //     bien davantage qu'un ecoulement lisse de meme vitesse.
    const tau = Math.max(tauDrag, tauFlow) * (1 + BREAK_TAU * brk[c]);   // BREAK_TAU = 1.6
```

## 5.2 D5 — Recalibrer la résistance du sable

Avec la formule (a), les contraintes du jet de rive montent à 34–258 Pa. Or le seuil
d'arrachement du code vaut aujourd'hui :

```js
const TAU_CRIT_DRY = 0.168;      // Shields, sable propre 0,3 mm  → correct
const COHESION_RESIST = 30;      // multiplicateur de cohesion    → BEAUCOUP trop bas
tauCrit = TAU_CRIT_DRY * (1 + COHESION_RESIST * cohesionFactor(w) * packFactor(p));
```

### Résistances obtenues, avant / après

| Qualité du sable | `w` | `p` | `τ_crit` avec 30 | `τ_crit` avec **600** |
|---|---|---|---|---|
| Sec, en vrac | 0,00 | 0,20 | 0,2 Pa | **0,2 Pa** |
| Frais, à peine tassé | 0,05 | 0,30 | 1,4 Pa | **23,9 Pa** |
| Parfait, versé en vrac | 0,12 | 0,20 | 1,3 Pa | **22,5 Pa** |
| Parfait, tassé à la main | 0,12 | 0,50 | 2,4 Pa | **44,7 Pa** |
| Parfait, bien damé | 0,12 | 0,75 | 3,6 Pa | **69,6 Pa** |
| Parfait, *pound-up* de compétition | 0,12 | 1,00 | 5,1 Pa | **99,1 Pa** |
| Mouillé, damé | 0,35 | 0,70 | 3,2 Pa | **61,3 Pa** |
| Trempé, damé | 0,60 | 0,70 | 1,6 Pa | **29,1 Pa** |
| Saturé (liquéfié) | 1,00 | 0,70 | 0,2 Pa | **0,2 Pa** |

Avec 30, **le clapot le plus modeste (34 Pa) bat le meilleur mur du jeu (5,1 Pa)** :
tout part, quelle que soit la qualité de la construction, et le savoir-faire du joueur
ne sert à rien. Avec 600, on obtient la **matrice de jeu** suivante :

### Matrice houle × qualité de construction (τ_jet vs τ_crit)

| | vrac 22 Pa | tassé 45 Pa | bien damé 70 Pa | pound-up 99 Pa |
|---|---|---|---|---|
| **Clapot** 34 Pa | 💀 emporté | ✅ tient | ✅ tient | ✅ tient |
| **Petites vagues** 64 Pa | 💀 | 💀 | ✅ tient (de peu) | ✅ tient |
| **Houle** 118 Pa | 💀 | 💀 | 💀 | 💀 (de peu) |
| **Grosse houle** 181 Pa | 💀 | 💀 | 💀 | 💀 |
| **Tempête** 258 Pa | 💀 | 💀 | 💀 | 💀 |

Et pour le **retrait** (`f_w` moitié, `u` × 0,7 ⇒ `τ` divisé par 4) :

| | vrac 22 Pa | tassé 45 Pa | bien damé 70 Pa | pound-up 99 Pa |
|---|---|---|---|---|
| **Clapot** 8 Pa | ✅ | ✅ | ✅ | ✅ |
| **Petites vagues** 16 Pa | ✅ | ✅ | ✅ | ✅ |
| **Houle** 29 Pa | 💀 | ✅ | ✅ | ✅ |
| **Grosse houle** 44 Pa | 💀 | ✅ (de peu) | ✅ | ✅ |
| **Tempête** 63 Pa | 💀 | 💀 | ✅ | ✅ |

C'est exactement la boucle de jeu voulue :

- **Le damage compte.** Passer de « versé » à « pound-up » fait gagner deux crans de
  houle. Le geste de tasser, qui est le geste central du vrai château de sable, devient
  une vraie décision.
- **Le jet tue, le retrait épargne.** Une construction survit facilement aux nappes de
  retrait mais pas aux impacts frontaux : d'où l'intérêt de **casser le jet** (douve,
  brise-lames) plutôt que d'essayer de résister à tout.
- **Il n'y a pas de mur qui tienne face à « Houle » en attaque directe.** Au-dessus du
  niveau 2, la seule défense est *hydraulique*, pas *structurelle*. C'est la leçon de
  toutes les vraies plages, et c'est un excellent enseignement de jeu.
- **Le sable trempé perd les deux tiers de sa résistance** (70 → 29 Pa). Une vague qui
  ne casse pas le mur le **prépare** pour la suivante. C'est la chaîne de sapement.

> **Note de calibrage.** Dans le code actuel, la comparaison `τ > τ_crit` fonctionne
> comme un *interrupteur*, la vitesse réelle d'érosion étant fixée par le modèle de
> capacité (`EROSION_CAPACITY · sinα · |u| · lw · 0,008`) et par le plafond dur
> `0,006 · dt · 60 · VOXEL`. Il faut garder cette architecture : `τ/τ_crit` décide
> **si** ça s'érode, la capacité et le plafond décident **à quelle vitesse**. Avec
> `COHESION_RESIST = 600`, l'interrupteur devient enfin discriminant. Recommandation :
> ajouter un multiplicateur doux d'excès pour que ce ne soit pas binaire :
> `rate ∝ min(3, (τ/τ_crit − 1))`.

## 5.3 D4 — SAPEMENT : creuser au pied, pas raboter le sommet

C'est le point technique le plus important du §5, et il tient en une phrase :

> **`dig()` retire du sable au sommet d'une colonne. Un mur sapé ne perd pas son
> sommet : il perd son pied.**

```js
  dig(x, z, amount) {
    ...
    let y = F.topY[c];          // ← LE SOMMET
    while (remaining > 0 && y >= 0) { ... y--; }
  }
```

Avec `dig()` seul, une vague qui frappe un mur de 30 cm **rabote son sommet**, le mur
raccourcit progressivement, et on obtient un talus doux. Ce n'est pas ce qui se passe
sur une plage. Ce qui se passe sur une plage :

```
   1. le mur, intact          2. la vague creuse une ENCOCHE au niveau de l'eau
      ┌────────┐                 ┌────────┐
      │        │                 │        │
      │        │                 │        │
      │        │              ~~~╞═══     │  ← encoche à l'altitude de la lame
      └────────┘                 └────────┘

   3. le porte-à-faux s'accumule 4. RUPTURE : le bloc part d'un coup
      ┌────────┐                       
      │        │                    ▒ ▒ ▒     
      │        │  ← contrainte     ▒  ▒  ▒  ← le pan tombe en bloc dans l'eau
   ~~~╞══════  │                 ~~~▒▒▒▒▒
      └────────┘                    └───────┘
```

### Le mécanisme physique

Quand un jet de rive frappe une paroi raide, il ne glisse pas dessus : il **stagne**,
la pression dynamique se convertit en pression statique, et l'écoulement est dévié vers
le bas. Il se forme au pied de la paroi un **tourbillon en fer à cheval** (le même que
sous une pile de pont) qui multiplie la contrainte locale. À cela s'ajoutent :

- l'**action hydraulique** : l'eau chassée dans les pores du sable en fait sauter les
  grains par surpression ;
- la **saturation** : chaque passage sature un peu plus le sable de la paroi. Or
  `cohesionFactor(w)` s'effondre au-delà de `w = 0,25` et **s'annule à `w = 0,90`**.
  Un mur trempé n'a plus de cohésion capillaire du tout ;
- l'**exfiltration au retrait** : quand la nappe redescend, l'eau qui sort du sable
  déstabilise les grains de surface (gradient hydraulique sortant).

Résultat : une **encoche (notch)** au niveau de la lame d'eau, puis un porte-à-faux,
puis une rupture **brutale et complète** — pas un émiettement.

### Ce que le moteur fournit déjà

`Granular.js` a **déjà tout le nécessaire** :

| Ce qu'il faut | Ce qui existe | Où |
|---|---|---|
| Détecter un voxel sans appui | `movable(i)`, `below < ISO` | `Granular.movable`, `processVoxel` |
| Savoir si la cohésion le retient | `checkSupport(x,y,z,m,pk)` : BFS dans la matière, limité par `maxOverhang()` | `Granular.checkSupport` |
| Accumuler la contrainte avant rupture | `this.stress[i]`, seuil `STRESS_BREAK` | `Granular.processVoxel` |
| Faire tomber le bloc d'un coup | déjà le comportement quand `stress ≥ STRESS_BREAK` | idem |
| Afficher les micro-fissures avant rupture | `stress` est déjà lu par le shader | commentaire de `Granular` |
| Réveiller la zone | `wake(x,y,z)`, `wakeBox(...)` | `Granular.wake` |

**Il ne manque donc qu'une chose : creuser au bon endroit.** Le porte-à-faux,
l'accumulation de contrainte, les micro-fissures annonciatrices et l'effondrement en
bloc sont déjà écrits et testés.

### Code

```js
/** Hauteur de paroi emergee minimale pour qu'on parle de "mur" (m). */
const UNDERCUT_RISE  = 0.06;    // 1,5 voxel
/** Vitesse minimale du jet pour saper (m/s). */
const UNDERCUT_V     = 0.35;
/** Amplification de la contrainte par le tourbillon de pied. */
const SCOUR_GAIN     = 2.2;     // K = 1 + SCOUR_GAIN * min(Fr, 1.8)  ->  1 a 5,0
/** Vitesse de creusement de reference (m/s a exces de contrainte unitaire). */
const UNDERCUT_RATE  = 0.009;
/** Plafond dur par pas : un mur ne doit JAMAIS disparaitre en une frame. */
const UNDERCUT_CAP   = 0.35;    // en fraction de VOXEL par pas de 1/60 s

  /**
   * SAPEMENT DES PAROIS.
   *
   * Le jet de rive qui frappe un mur ne rabote pas son sommet : il creuse une
   * ENCOCHE a son pied, a l'altitude de la lame d'eau. Le pan au-dessus se
   * retrouve en porte-a-faux, la contrainte s'accumule dans Granular.stress,
   * et quand elle depasse STRESS_BREAK le bloc part d'un coup.
   *
   * Tout ce qui suit la creation de l'encoche est deja implemente dans
   * Granular (checkSupport / stress / STRESS_BREAK). La seule chose qui
   * manquait etait de creuser au bon endroit : dig() retire au SOMMET d'une
   * colonne, ce qui ne peut produire qu'un aplanissement doux.
   */
  undermine(dt) {
    if (!this.erosionEnabled || this.wallAttack <= 0) return;
    const F = this.field;
    const h = this.h, vx = this.vx, vz = this.vz, sed = this.sed;
    const surf = F.surfaceH, brk = this.brk;
    const capStep = UNDERCUT_CAP * VOXEL * dt * 60;

    for (let z = 1; z < NZ - 1; z++) {
      const row = NX * z;
      const xa = Math.max(1, this.scanA[z]);
      const xb = Math.min(NX - 2, this.scanB[z]);
      for (let x = xa; x <= xb; x++) {
        const c = row + x;
        const hw = h[c];
        if (hw < 0.004) continue;                       // pas de lame utile
        const ux = vx[c], uz = vz[c];
        const sp = Math.hypot(ux, uz);
        if (sp < UNDERCUT_V) continue;

        const eta = surf[c] + hw;                       // surface libre
        const cel = Math.sqrt(GRAVITY * hw);
        const fr = Math.min(sp / Math.max(cel, 0.05), 1.8);
        // Tourbillon de pied : la contrainte au pied d'un obstacle vaut 2 a 5
        // fois la contrainte de l'ecoulement libre (meme mecanique que
        // l'affouillement autour d'une pile de pont).
        const K = 1 + SCOUR_GAIN * fr;
        // Une vague qui DEFERLE sur le mur cogne plus fort qu'une nappe lisse.
        const tau = 0.5 * 1000 * FW_UPRUSH * sp * sp * K * (1 + BREAK_TAU * brk[c]);

        // --- les quatre voisins : lequel est un MUR ? ---
        for (let k = 0; k < 4; k++) {
          const dx = k === 0 ? 1 : k === 1 ? -1 : 0;
          const dz = k === 2 ? 1 : k === 3 ? -1 : 0;
          const nx = x + dx, nz = z + dz;
          const n = nx + NX * nz;

          // Le jet doit etre dirige VERS la paroi.
          const push = ux * dx + uz * dz;
          if (push < UNDERCUT_V) continue;
          // La paroi doit depasser la surface libre.
          if (surf[n] - eta < UNDERCUT_RISE) continue;

          // Voxel VISE : celui qui borde la surface libre, PAS le sommet.
          const yHit = clamp(Math.round((eta - ORIGIN_Y) / VOXEL - 0.5), 0, NY - 1);
          const i = n + SLICE * yHit;
          if (F.density[i] < ISO) continue;             // deja creuse ici

          // Resistance LOCALE du voxel vise. C'est la que la chaine se boucle :
          // un mur que les vagues precedentes ont trempe (w -> 1) a une
          // cohesionFactor nulle, donc tauCrit = TAU_CRIT_DRY = 0,17 Pa.
          const w  = F.moisture[i] / 255;
          const pk = F.packing[i]  / 255;
          const tauCrit = TAU_CRIT_DRY *
                (1 + COHESION_RESIST * cohesionFactor(w) * packFactor(pk));
          if (tau <= tauCrit) continue;

          const excess = Math.min(3, tau / tauCrit - 1);
          const amount = Math.min(UNDERCUT_RATE * excess * this.wallAttack * dt, capStep);
          if (amount < 1e-6) continue;

          const got = this.notch(nx, yHit, nz, amount);
          if (got > 0) {
            sed[c] += got;                              // le sable part en suspension
            this.stats.eroded += got;
          }
        }
      }
    }
  }

  /**
   * Retire de la matiere sur une TRANCHE D'ALTITUDE (le voxel vise et celui
   * juste dessous), et non au sommet de la colonne comme dig().
   *
   * C'est cette fonction, et elle seule, qui produit le surplomb. Le reste de
   * la mecanique d'effondrement est deja dans Granular.
   */
  notch(x, y, z, amount) {
    const F = this.field;
    let remaining = Math.round((amount / VOXEL) * 255);
    if (remaining <= 0) return 0;
    let removed = 0;
    const col = x + NX * z;
    // On mord sur deux voxels : celui de la surface libre et celui du dessous.
    // Une encoche d'un seul voxel (4 cm) se comble par eboulement avant
    // d'avoir pu creer un porte-a-faux visible.
    for (let dy = 0; dy >= -1 && remaining > 0; dy--) {
      const yy = y + dy;
      if (yy < 0) break;
      const i = col + SLICE * yy;
      const d = F.density[i];
      if (d === 0) continue;
      const take = Math.min(d, remaining);
      this.writeDensity(x, yy, z, d - take);
      removed += take;
      remaining -= take;
    }
    if (removed > 0) {
      // Reveille la COLONNE AU-DESSUS : c'est elle qui va se retrouver en
      // porte-a-faux, accumuler du stress et finir par tomber en bloc.
      if (this.granular) {
        this.granular.wake(x, Math.min(NY - 1, y + 1), z);
        this.granular.wake(x, Math.min(NY - 1, y + 2), z);
      }
      if (this.moisture) this.moisture.touchColumn(x, z);
    }
    return (removed / 255) * VOXEL;
  }
```

### Calibrage : combien de vagues pour abattre un mur ?

Une paroi de château prend un jet pendant `t_up ≈ 1 s` par vague, dont ~0,4 s à pleine
vitesse. Pour un mur en pound-up (`τ_crit = 99 Pa`) frappé par « Houle »
(`τ = 118 Pa`, `K = 1 + 2,2 × 1,4 = 4,1` ⇒ `τ_effectif ≈ 480 Pa`) :

```
    excess = min(3, 480/99 − 1) = 3
    amount = 0,009 × 3 × 1,0 × 0,4 s = 10,8 mm par vague
```

L'encoche atteint 4 cm (un voxel) en **4 vagues**, 8 cm (deux voxels, porte-à-faux
franc) en **8 vagues**, soit ~21 s à 23 vagues/min. Le pan tombe quelque part entre la
6ᵉ et la 12ᵉ vague selon `maxOverhang()` — c'est-à-dire selon la qualité du damage,
comme il se doit. C'est le bon rythme : assez long pour qu'on ait le temps de courir
réparer, assez court pour que ce soit une menace réelle.

Pour du sable versé en vrac (`τ_crit = 22 Pa`) : `excess = 3` aussi (plafonné), mais
`wake` déclenche des éboulements de pente bien avant la rupture de porte-à-faux. Le mur
en vrac **fond** au lieu de s'effondrer. Deux signatures visuelles distinctes pour deux
qualités de construction — excellent retour au joueur.

## 5.4 Formation d'une micro-falaise (scarp)

Une **micro-falaise** (*scarp*) est la petite marche verticale, de quelques centimètres
à quelques dizaines, qui apparaît sur l'estran là où l'érosion s'arrête net. Elle est
extrêmement caractéristique d'une plage en érosion, et elle est **gratuite** chez nous
si trois conditions sont réunies.

**Condition 1 : l'érosion doit se concentrer à la limite du jet, pas être uniforme.**
La limite du jet est là où la lame s'arrête et où le retrait s'organise : c'est le point
de contrainte maximale. On l'identifie comme **le front** — une cellule sèche au pas
précédent et mouillée maintenant :

```js
    // Front du jet : la lame vient d'arriver ici. La contrainte y est
    // maximale (choc + turbulence + f_w double) : c'est la que se creuse la
    // micro-falaise.
    const wasDry = this.wetPrev[c] === 0;
    this.wetPrev[c] = hw > WATER_EPSILON ? 1 : 0;
    const frontBoost = wasDry ? SCARP_FRONT : 1;         // SCARP_FRONT = 2.4
```

**Condition 2 : le sable doit tenir la verticale.** C'est déjà le cas :
`thetaMax(w=0,12, p=0,5) ≈ 87°`. La règle de pente de `Granular` ne rabotera pas la
marche tant que le sable est dans le régime « parfait ».

**Condition 3 : le pied doit être plus faible que le sommet.** C'est le cas : le pied
est saturé par le passage répété de l'eau (`w → 1`, `cohesionFactor → 0`), le sommet est
resté dans le régime pendulaire. **C'est cette inversion de résistance qui fabrique la
verticalité.** L'érosion attaque le bas, laisse le haut, et la marche se forme.

Hauteur de scarp attendue : de l'ordre de `R2%/3`, soit **2 à 17 cm** selon l'état de
mer. Elle recule vers la terre tant que la houle dure, et elle est **effacée à
l'accalmie suivante** par le dépôt du jet (le sable remonte). Le cycle
« creusement / effacement » au rythme des groupes est l'un des plus beaux
comportements émergents à attendre du système.

## 5.5 Transport et dépôt : où va le sable arraché

```
   BERME       FACE DE PLAGE          MARCHE      AVANT-PLAGE
   (dépôt)     (transit)              (dépôt)     (dépôt fin)
      ▲            │                     ▲            ▲
      │            │                     │            │
   ───┴────────────┼─────────────────────┴────────────┴────►
      limite    zone de              base du       barre
      du jet   balancement           jet de rive   d'avant-côte
```

**Trois zones de dépôt**, toutes produites par le même mécanisme : le sédiment se
dépose là où la capacité de transport chute, c'est-à-dire là où la vitesse chute.

1. **La berme, à la limite du jet.** Le jet transporte plus que le retrait (`f_w` × 2,
   et une partie de l'eau s'infiltre au lieu de redescendre). Le bilan net est donc
   **vers la terre**, et le sable s'accumule au point le plus haut atteint. C'est la
   berme. Chez nous c'est automatique dès que `FW_UPRUSH = 2 × FW_BACKWASH` et que
   `infiltrate()` tourne. **Il ne faut surtout pas symétriser le frottement** : sans le
   biais, la simulation raboterait la plage jusqu'à la mer, ce qui est exactement le
   symptôme décrit dans le commentaire actuel de `Water.js`.

2. **La marche (step), à la base du jet de rive.** Le retrait accélère en descendant la
   pente, puis rencontre brutalement l'eau de la vague suivante et s'arrête : toute sa
   charge tombe d'un coup. Il se forme une petite marche de sable grossier au niveau de
   la basse mer du swash. Ça sort tout seul de `advectSediment()` + `deposit()`.

3. **Le bourrelet devant un obstacle.** Le sable arraché au pied d'un mur ne part pas
   loin : le jet le pousse latéralement, puis le retrait le ramène, et il s'accumule
   **juste devant** l'ouvrage en un croissant. Visuellement, c'est l'indice que le
   château se fait manger. Émergent, sans code dédié.

**Une correction à apporter à `deposit()`.** Il écrit :

```js
    F.moisture[i] = 255;   // sature
    F.packing[i]  = 40;    // absolument pas tasse
```

`moisture = 255` donne `cohesionFactor(1,0) = 0`, donc `τ_crit = 0,17 Pa` : **le sable
qui vient d'être déposé est immédiatement réérodable par n'importe quoi**. C'est
physiquement correct au moment du dépôt, mais ça empêche la berme de se construire :
tout ce qui se dépose repart à la vague suivante. Correction :

```js
    // Le sable depose par le jet de rive est sature au moment ou il se pose,
    // mais il draine tres vite (la nappe est plus bas) : en une seconde il
    // repasse en regime capillaire et retrouve de la cohesion. Deposer a 255
    // le rend indefiniment reerodable et empeche toute berme de se former.
    F.moisture[i] = DEPOSIT_MOISTURE;   // 205 (w = 0,80) -> draine vers 0,15
    F.packing[i]  = DEPOSIT_PACK;       // 55  (le jet tasse un peu en se posant)
```

Et laisser `Moisture` faire son travail de drainage vers `tableH`.

## 5.6 Comment une DOUVE protège vraiment

La douve fonctionne pour **trois raisons distinctes et cumulatives**, toutes
reproduites par le solveur sans code dédié.

**(1) Elle avale le volume du jet.** Le volume d'eau qu'un jet de rive transporte
au-delà de la ligne d'eau, par mètre de rivage, vaut approximativement :

```
    q ≈ ½ · h₀ · u₀ · t_up            avec  h₀ ≈ 0,30 · Hs
```

| Niveau | `h₀` | `u₀` | `t_up` | **`q` (m³/m)** | douve carrée équivalente |
|---|---|---|---|---|---|
| Clapot | 1,2 cm | 1,17 m/s | 0,57 s | **0,004** | **6 × 6 cm** |
| Petites vagues | 2,7 cm | 1,60 m/s | 0,78 s | **0,017** | **13 × 13 cm** |
| Houle | 5,4 cm | 2,17 m/s | 1,05 s | **0,062** | **25 × 25 cm** |
| Grosse houle | 9,0 cm | 2,69 m/s | 1,30 s | **0,157** | **40 × 40 cm** |
| Tempête | 13,5 cm | 3,21 m/s | 1,56 s | **0,338** | **58 × 58 cm** |

**Ces chiffres sont un cadeau de game design.** Ils sont mémorables, ils sont à
l'échelle de la main, et ils donnent au joueur une règle simple et vraie :
*« une douve de 25 cm de côté arrête la Houle »*. Le joueur peut la découvrir par
l'expérience, et un panneau d'aide peut la confirmer.

**(2) Elle supprime la charge hydraulique.** Le jet monte sur la pente parce qu'il a de
l'énergie cinétique. En tombant dans la douve, il la convertit en turbulence
(déferlement — le solveur détectera `Fr > 1` et dissipera) au lieu de la convertir en
altitude. L'eau qui ressort de l'autre côté est **lente**, donc `τ ∝ u²` s'effondre.
Un jet à 2,17 m/s réduit à 0,5 m/s voit sa contrainte passer de 118 à **6 Pa** : sous le
seuil du plus mauvais sable.

**(3) Elle se comble — et c'est très bien.** L'eau qui décélère dans la douve y dépose
sa charge (`advectSediment` + `deposit` le font tout seuls). La douve se remplit de
sable, perd sa section, et cesse de protéger. **Le joueur doit la recreuser.** C'est la
boucle d'entretien qui donne au jeu son rythme, et elle est entièrement émergente.

**Ce qui rend la douve fragile — et donc intéressante :**
- une **brèche** concentre tout le débit et devient un chenal qui s'auto-creuse (rip) ;
- **à pleine mer** la douve est déjà pleine d'eau, donc sa capacité tampon est nulle ;
- **la vague scélérate** d'un groupe (×1,8 à 2,2 `Hs`) demande une capacité 3 à 5 fois
  supérieure à la vague moyenne : dimensionner sur la moyenne, c'est perdre.

**Recommandation forte : ne rien coder de spécifique.** Aucune détection de « douve »,
aucun bonus de protection. Tout ce qui précède sort du solveur. C'est la meilleure
justification du modèle (a).

## 5.7 Comment un BRISE-LAMES protège vraiment

Un brise-lames (une barre de sable construite au large, immergée ou émergée) marche
parce qu'il **force le déferlement plus tôt**. Le critère `H ≈ 0,78 h` dit que la vague
casse dès que la profondeur tombe sous `H/0,78`. En surélevant le fond, le joueur crée
artificiellement cette condition — et l'énergie est dissipée **là-bas** au lieu de
l'être sur son château.

### Règle de dimensionnement

| Grandeur | Valeur recommandée | Raison |
|---|---|---|
| Altitude de crête `z_c` | à `0,6 · Hs` **sous** le plan d'eau | c'est le seuil `H = 0,78 h` : `h = Hs/0,78 = 1,28 Hs` → crête à `−1,28 Hs` sous la surface... mais un brise-lames *submergé* dissipe le mieux entre `−0,5` et `−0,8 Hs`. |
| Largeur de crête `B` | `≥ 2 · h_local`, soit 25 à 50 cm | une barre étroite laisse la vague se reformer derrière (le rouleau a besoin de place pour dissiper) |
| Distance au rivage | 1 à 2 `L_déferlement`, soit **1 à 2,5 m** | trop près : la vague n'a pas le temps de se dissiper ; trop loin : elle se reforme |
| Longueur `L_b` vs distance `D` | `L_b/D > 1` → **tombolo** ; `< 1` → **saillant** | la réponse morphologique classique |

### Vérification chiffrée pour « Houle » (`Hs = 0,18 m`)

Sans brise-lames, la vague casse là où `h = 0,18/0,78 = 0,23 m`, c'est-à-dire à
`d ≈ −0,55 m` à mi-marée : **55 cm du rivage**. Elle arrive donc encore chargée.

Avec une barre dont la crête est à 12 cm sous la surface, placée à `d = −2,0 m` : elle
casse là-bas, à 2 m du rivage, et dissipe `1 − 1/(1 + 3,0 × 1,0) = 75 %` de sa quantité
de mouvement en traversant le rouleau. La vague transmise fait `Hs ≈ 0,09 m` : **on est
redescendu d'un cran complet dans la table**, et le mur en pound-up qui tombait en
8 vagues devient invulnérable.

Coefficient de transmission attendu (d'Angremond et al., pour un ouvrage submergé) :

```
    K_t ≈ −0,4 · R_c/Hs + 0,64 · (B/Hs)^(−0,31) · (1 − e^(−0,5 ξ))
```

avec `R_c` le franc-bord (négatif si submergé). Pour `R_c = −0,12`, `B = 0,40`,
`Hs = 0,18`, `ξ = 1,6` : `K_t ≈ 0,27 + 0,64 × 0,74 × 0,55 = 0,53`. Cohérent avec
l'estimation par la dissipation.

**Et là encore : rien à coder.** Le brise-lames est du sable dans `surfaceH` ; le
solveur voit la bathymétrie, le module `breaking()` voit la remontée de `∂η/∂t`, la
dissipation s'applique. **La seule condition, c'est que le module de déferlement lise
`surfaceH` et non le profil d'origine** — donc que la bande de génération soit la seule
chose figée (§2.5).

### Effet secondaire à espérer : le saillant

Derrière un brise-lames, l'énergie est réduite, donc le transport aussi, donc le sable
s'y accumule : il se forme un **saillant** qui grossit vers la barre et peut la
rejoindre (**tombolo**). Chez nous, `advectSediment` + `deposit` devraient le produire
en quelques minutes de jeu. C'est une récompense visuelle magnifique pour un joueur
qui a bien construit — et elle arrive **toute seule**.

## 5.8 Récapitulatif de la stratégie défensive du joueur

| Défense | Ce qu'elle attaque | Efficacité | Coût d'entretien |
|---|---|---|---|
| **Damer le sable** (pound-up) | `τ_crit` × 4,4 | +2 crans de houle | aucun, mais lent à faire |
| **Douve** | volume + énergie du jet | jusqu'à +2 crans, si section suffisante | **fort** (elle se comble) |
| **Brise-lames** | `Hs` incidente | −1 à −2 crans | moyen (il s'érode) |
| **Bâtir haut** (au-delà de `R2%`) | rien ne monte jusqu'à vous | total… jusqu'à la marée | aucun |
| **Bâtir derrière la berme** (`d > 3,6`) | atteignable seulement au-delà du niveau 2 à pleine mer | très forte | aucune |
| **Épaissir les murs** | `maxOverhang()` ∝ `√t` | retarde la rupture par sapement | aucun |
| **Angle par rapport à la houle** | présente une arête, pas une face | modéré | aucun |

Le tableau doit rester **vrai dans le jeu**. Il l'est si — et seulement si — on adopte
le modèle (a) : chacune de ces défenses agit sur la physique, pas sur un score.

---

# 6. RENDU DE LA VAGUE

Principe directeur : **tout tirer des champs qui existent déjà**. Le rendu actuel lit
une texture RGBA (`niveau`, `profondeur`, `écume`, `sédiment`). On ajoute **une seule**
texture, et rien d'autre — pas de système de vagues parallèle, pas de maillage
supplémentaire, pas de simulation de spray autonome.

## 6.1 La texture de flux (la seule addition)

```js
// WaterRenderer : seconde DataTexture, RGBA en HalfFloat (256×256×4×2 o = 512 ko)
//   R = vx        vitesse X          (m/s)
//   G = vz        vitesse Z          (m/s)
//   B = brk       indicateur de deferlement 0..1
//   A = foamDry   laisse d'ecume sur le sable 0..1
this.flowTex = new THREE.DataTexture(this.flow, NX, NZ, THREE.RGBAFormat, THREE.HalfFloatType);
```

Coût : 512 ko téléversés par frame, soit 31 Mo/s à 60 Hz. Acceptable, et à comparer aux
1 Mo/s de la texture existante en `FloatType`. On peut d'ailleurs **basculer la texture
existante en HalfFloat** au passage : la précision d'un demi-flottant (10 bits de
mantisse, soit ~3 chiffres significatifs) est largement suffisante pour des hauteurs
d'eau en mètres, et ça divise le trafic par deux.

Avec ces deux textures, **les six effets demandés sont tous dérivables**. Détail :

| Effet demandé | Champ source | Rien à ajouter ? |
|---|---|---|
| Face de vague qui se cambre | `∇η` + `vx,vz` (déplacement horizontal dans le vertex shader) | ✅ |
| Crête d'écume | `brk` + `foam` | ✅ |
| Panache de projection (spray) | `brk × |v|` (émission de particules) | ✅ (billboards) |
| Nappe fine et brillante sur le sable | `depth` faible + `|v|` élevé → Fresnel renforcé | ✅ |
| Laisse d'écume qui reste et se dissipe | `foamDry` lu par le shader du **sable** | ✅ |
| Sable sombre derrière la vague | `moisture` du voxel de surface (déjà là) | ✅ |

## 6.2 Cambrure : le déplacement horizontal de crête

Le champ `h` est une carte de hauteur : il ne peut pas décrire une lèvre qui se
retourne. Mais il n'en a pas besoin. Ce que l'œil lit comme « la vague se cambre »,
c'est **l'asymétrie du profil** : face avant raide, face arrière douce. On l'obtient en
déplaçant horizontalement les sommets vers l'avant de la vague, proportionnellement à
la vitesse et au déferlement — exactement le cisaillement d'une onde de Gerstner :

```glsl
// --- VERTEX SHADER : cambrure ---------------------------------------------
// Une carte de hauteur ne peut pas se retourner. Mais l'oeil ne lit pas une
// lèvre qui se retourne : il lit une ASYMETRIE (face avant raide, face
// arriere douce). On la produit en decalant les sommets vers l'avant, comme
// une onde de Gerstner. Le decalage est plafonne a une demi-cellule, sinon
// le maillage se replie et fait des triangles inverses.
vec4 fl = texture2D(uFlow, uvw);
vec2 vel = fl.rg;
float brk = fl.b;
float sp  = length(vel);

// Le raidissement suit la vitesse ET l'indicateur de deferlement : une vague
// qui n'a pas encore casse se cambre deja (levee), celle qui casse plonge.
float curl = uCurl * (0.35 * smoothstep(0.4, 2.2, sp) + 0.65 * brk);
vec2  dir  = sp > 1e-3 ? vel / sp : vec2(0.0);
float lift = smoothstep(0.01, 0.10, depth);          // pas de cambrure en nappe fine
p.xz += dir * min(curl * lift, 0.5 * uCell);         // uCell = VOXEL

// La crete se soulève un peu au moment de casser : la lèvre monte avant de
// tomber. Deux centimetres suffisent a le lire.
p.y += brk * uLipRise * lift;                        // uLipRise = 0.02
```

`uCurl = 0,06 m` : à pleine vitesse et plein déferlement, la crête est décalée de 6 cm
vers l'avant — une cellule et demie. La face avant se comprime, la face arrière s'étire.
C'est suffisant : les vagues sont vues de trois quarts dans un diorama, et l'asymétrie
lue est très forte pour un coût nul.

## 6.3 Écume : trois couches distinctes

Le shader actuel a **déjà** la bonne intuition (« l'écume naît de la turbulence »). Il
suffit de séparer ce qui est aujourd'hui confondu :

```glsl
// --- FRAGMENT SHADER : ecume en trois couches ------------------------------
// 1. CRETE : blanc pur, dense, mobile. C'est le rouleau lui-meme.
//    On la sature volontairement : c'est le seul endroit de l'image ou l'eau
//    doit etre completement opaque.
float crest = smoothstep(0.35, 0.80, brk);

// 2. TRAINEE : l'ecume advectee derriere la vague. Elle s'ETIRE dans le sens
//    du courant — d'ou la deformation anisotrope du bruit. Sans cet
//    etirement, l'ecume ressemble a de la mousse a raser posee sur l'eau.
vec2 flowUv = vWorldPos.xz;
vec2 sdir   = sp > 1e-3 ? vel / sp : vec2(1.0, 0.0);
mat2 stretch = mat2(sdir.x, -sdir.y, sdir.y, sdir.x);
vec2 fuv = stretch * flowUv * vec2(9.0, 34.0);       // etire 3.8x le long du flux
float lace = vnoise2(fuv - vec2(uTime * sp * 1.2, 0.0));
float trail = smoothstep(0.20, 0.70, vFoam * (0.55 + 0.75 * lace));

// 3. BORDURE : la dentelle de la lame la plus mince. Deja presente.
float edge = 1.0 - smoothstep(0.004, 0.06, d);

float foam = max(crest, max(trail, vFoam * edge * 1.6));
col = mix(col, vec3(0.97, 0.97, 0.95), foam);
```

**Le point important est l'étirement anisotrope du bruit d'écume dans le sens du
courant.** C'est le détail qui fait qu'une nappe d'écume « coule » au lieu de flotter :
l'œil lit la direction et la vitesse de l'écoulement directement dans la texture. Coût :
une matrice 2×2 par fragment.

## 6.4 Laisse d'écume : dans le shader du SABLE, pas de l'eau

Le shader d'eau fait `if (d < 0.0016) discard;`. Tout ce qui reste sur le sable après
le retrait est donc invisible. La laisse d'écume doit être dessinée par
`SandMaterial.js`, qui a déjà un uniforme `uWaterTable` — on lui ajoute la texture de
flux et il lit le canal `A` :

```glsl
// --- SandMaterial : laisse d'ecume et sable mouille ------------------------
vec4 fl = texture2D(uFlow, sandUv);
float lees = fl.a;                                    // foamDry

// Dentelle : l'ecume seche est bulleuse et irreguliere, pas une bande unie.
float bub = vnoise2(vWorldPos.xz * 46.0);
float leesMask = smoothstep(0.18, 0.55, lees * (0.45 + 0.9 * bub));
albedo = mix(albedo, vec3(0.94, 0.93, 0.90), leesMask * 0.8);
roughness = mix(roughness, 0.95, leesMask);           // l'ecume seche est MATE

// Le sable sombre derriere la vague : deja gratuit. La moisture du voxel de
// surface est mise a jour par Water.infiltrate(), et SandMaterial l'utilise
// deja pour assombrir. Il suffit de verifier que la courbe est assez marquee :
// du sable mouille est 35 a 45 % plus sombre et NETTEMENT plus speculaire.
```

Et pour la nappe brillante :

```glsl
// --- WaterRenderer : nappe fine et brillante -------------------------------
// Une lame de 5 mm sur du sable n'est presque pas coloree : c'est un MIROIR
// rasant. On force donc le Fresnel a saturer en faible profondeur, sinon la
// nappe du jet de rive est invisible et le joueur ne voit pas jusqu'ou la mer
// est montee.
float film = 1.0 - smoothstep(0.002, 0.035, d);
fres = mix(fres, 1.0, film * 0.75);
alpha = max(alpha, film * 0.55);
```

## 6.5 Panache de projection (spray)

Le seul système réellement nouveau, et il reste minuscule.

```js
/**
 * Spray. Emis la ou une vague DEFERLE vite : brk eleve ET vitesse elevee.
 * Un simple pool de billboards, sans physique de collision — les gouttes
 * suivent une balistique et meurent. 400 particules suffisent largement a
 * cette echelle ; au-dela on ne voit plus que du brouillard.
 */
const SPRAY_MAX   = 400;
const SPRAY_BRK   = 0.55;    // seuil de deferlement
const SPRAY_SPEED = 1.2;     // seuil de vitesse (m/s)
const SPRAY_RATE  = 18;      // particules / s / m2 de crete active
const SPRAY_LIFE  = [0.5, 1.1];

emitSpray(dt) {
  // On echantillonne une cellule sur 16 : le front de deferlement fait
  // typiquement 300 a 900 cellules, on n'a pas besoin de toutes les visiter.
  for (let k = 0; k < SPRAY_SAMPLES; k++) {
    const c = this.sprayCursor = (this.sprayCursor + 9973) % COLS;  // pas premier
    const b = W.brk[c];
    if (b < SPRAY_BRK) continue;
    const sp = Math.hypot(W.vx[c], W.vz[c]);
    if (sp < SPRAY_SPEED) continue;
    if (Math.random() > SPRAY_RATE * b * dt * SAMPLE_AREA) continue;
    // Vitesse initiale : la vitesse de la vague, plus une composante
    // verticale. Une deferlante plongeante projette VERS L'AVANT et vers le
    // haut, pas en fontaine verticale.
    spawn({
      x: ..., y: surf[c] + W.h[c], z: ...,
      vx: W.vx[c] * 1.25 + jitter(0.4),
      vy: 0.6 + 0.55 * sp + jitter(0.3),
      vz: W.vz[c] * 1.25 + jitter(0.4),
      life: lerp(SPRAY_LIFE[0], SPRAY_LIFE[1], Math.random()),
      size: 0.012 + 0.020 * Math.random(),
    });
  }
}
```

Intégration : `y += vy·dt`, `vy -= 9,81·dt`, alpha `∝ life`. Rendu en `Points` additif,
une seule draw call. **Le détail qui compte : la composante horizontale doit dominer.**
Une déferlante plongeante projette son panache vers l'avant, presque à l'horizontale ;
une fontaine verticale ressemble à un geyser et casse l'illusion.

Émission secondaire, très peu coûteuse et très payante : **du spray au pied des murs**.
Là où `undermine()` a trouvé une paroi et un jet rapide, on émet 2 à 3 gouttes — l'eau
qui gicle contre l'obstacle. C'est le retour visuel qui dit au joueur *« ton mur est en
train d'être attaqué ici »*, avant même que quoi que ce soit ne tombe.

## 6.6 Ce qu'il ne faut PAS faire

| Tentation | Pourquoi c'est une erreur |
|---|---|
| Ajouter une nappe Gerstner par-dessus la simulation, pour « faire plus joli » | elle ne coïncidera pas avec `h`, donc la ligne d'eau visible ne sera pas la ligne d'eau physique. Le joueur bâtira au mauvais endroit et se sentira trahi. |
| Générer l'écume à partir de la profondeur | toutes les flaques et toutes les douves se bordent de blanc — c'est faux et c'est laid. Le commentaire du shader actuel a déjà tranché : l'écume vient de la turbulence. |
| Un système de particules pour la mousse de surface | `foam` advecté fait le travail pour zéro particule. Les particules sont pour le spray *en l'air*, uniquement. |
| Faire du spray un système physique (collisions, dépôt) | invisible à cette échelle et à ce prix. Balistique + mort. |
| Rendre la cambrure par déplacement de sommets non plafonné | le maillage se replie, on obtient des triangles inversés qui scintillent. Plafonner à `0,5 · VOXEL`. |

---

# 7. RÉGLAGES ET INTERFACE

## 7.1 Les contrôles à exposer

Trois réglages primaires, deux secondaires, un interrupteur. Pas un de plus.

### Primaire 1 — « Hauteur des vagues » (6 crans)

| cran | libellé | sous-titre |
|---|---|---|
| 0 | **Mer d'huile** | *La mer ne bouge pas. Pour construire tranquillement.* |
| 1 | **Clapot** | *Un petit clapot qui lèche le bas de la plage.* |
| 2 | **Petites vagues** | *Elles montent, elles redescendent. Rien de méchant.* |
| 3 | **Houle** | *De vraies vagues. Elles déferlent et elles courent sur le sable.* |
| 4 | **Grosse houle** | *Ça tape. Prévoyez une douve.* |
| 5 | **Tempête** | *La mer reprend tout. Vous êtes prévenu.* |

### Primaire 2 — « Agitation de la mer » (4 crans)

| cran | libellé | valeur `a` | sous-titre |
|---|---|---|---|
| 0 | **Régulière** | 0,10 | *Des vagues bien alignées, toujours pareilles.* |
| 1 | **Naturelle** | 0,40 | *Elles arrivent par séries, avec des accalmies.* |
| 2 | **Nerveuse** | 0,70 | *Mer courte et désordonnée. Ça pilonne.* |
| 3 | **Déchaînée** | 1,00 | *Aucun répit, aucune régularité.* |

### Primaire 3 — « Ce que la mer abîme » (4 crans)

| cran | libellé | `wallAttack` | `erosionEnabled` |
|---|---|---|---|
| 0 | **Rien** | 0 | `false` |
| 1 | **Juste le sable meuble** | 0,35 | `true` |
| 2 | **Normal** | 1,0 | `true` |
| 3 | **Impitoyable** | 1,8 | `true` |

**Séparer « hauteur » de « dégâts » est essentiel.** Beaucoup de joueurs veulent le
spectacle de la Tempête sans perdre leur château : c'est une demande parfaitement
légitime, et y répondre coûte un multiplicateur.

### Secondaires

- **« La mer vient de… »** : *de face* / *de la gauche* / *de la droite* (§3.4).
- **« Vitesse de la marée »** : le contrôle existe déjà (`tideSpeed`, cyclé par
  `HUD.cycleTide`).

### Vocabulaire : ce qu'il faut bannir

| ❌ Jamais dans l'interface | ✅ À la place |
|---|---|
| Hauteur significative, Hs | Hauteur des vagues |
| Période de pic, Tp | (ne pas exposer — dérivé de la hauteur) |
| Nombre d'Iribarren, déferlement plongeant | (ne pas exposer) |
| Run-up, jet de rive, swash | *« jusqu'où la mer monte »* |
| Coefficient d'érosion | *« ce que la mer abîme »* |
| Ressac | *« les vagues »* |

En revanche, **le panneau de debug (F3) doit tout afficher** : `Hs_eff`, `Tp`, `ξ₀`,
`R2%`, `η̄`, nombre de sous-pas, cellules mouillées, `ms` du solveur. C'est l'outil de
calibrage.

## 7.2 D6 — Interaction avec la marée : doser le drame

### Le problème, chiffré

Sans écrêtage, la portée du jet de rive (exprimée en distance au rivage moyen `d`,
sachant que la **crête de berme est à `d = 3,6 m`** et que le domaine s'arrête vers
`d = 8,8 m`) :

| Niveau | basse mer | mi-marée | **pleine mer** |
|---|---|---|---|
| Clapot | `d = −1,6` | `d = 0,5` | `d = 3,1` |
| Petites vagues | `d = −1,4` | `d = 0,8` | `d = 4,5` ⚠️ |
| Houle | `d = −1,1` | `d = 1,3` | `d = 6,9` ⚠️⚠️ |
| Grosse houle | `d = −0,9` | `d = 1,9` | `d = 9,8` 💀 |
| Tempête | `d = −0,8` | `d = 3,0` | `d > 12` 💀 **domaine entier noyé** |

À pleine mer, tout ce qui dépasse le niveau 2 **franchit la berme**, et la Tempête noie
la totalité du monde, arrière-plage comprise. Aucune stratégie de placement ne survit :
c'est frustrant, pas dramatique.

Noter aussi la **limitation automatique par la profondeur** à basse mer : la ligne de
génération n'est plus que dans 0,26 m d'eau, donc `Hs_eff ≤ 0,6 × 0,26 = 0,16 m`. Les
niveaux 4 et 5 sont **spontanément ramenés à 0,19 m** à marée basse. C'est
physiquement juste (les grosses vagues ont déjà cassé plus au large) et c'est
gratuit.

### La solution : écrêtage par la marée

```js
    Hs_eff = min( Hs · (1 − k_T · max(0, marée)),  0,60 · h_gen )
    k_T = 0,45   ("Normal")
```

Portée résultante :

| Niveau | marée −1 | −0,5 | 0 | +0,5 | **+1** |
|---|---|---|---|---|---|
| Clapot | −1,6 | −0,9 | 0,5 | 1,6 | **2,9** |
| Petites vagues | −1,4 | −0,7 | 0,8 | 1,8 | **3,7** |
| Houle | −1,1 | 0,1 | 1,3 | 2,3 | **5,5** |
| Grosse houle | −0,9 | 0,9 | 1,9 | 3,7 | **7,7** |
| Tempête | −0,8 | 1,2 | 3,0 | 6,7 | **10,2** |

C'est déjà beaucoup mieux : jusqu'au niveau 3, la berme (`d = 3,6`) **tient à pleine
mer**. Les niveaux 4 et 5 la franchissent — c'est leur raison d'être.

Réglage de `k_T` par le cran « ce que la mer abîme » :

| cran | `k_T` | effet |
|---|---|---|
| Rien | 1,0 | la houle s'annule complètement à pleine mer |
| Juste le sable meuble | 0,65 | la berme n'est jamais franchie |
| Normal | 0,45 | la berme tient jusqu'au niveau 3 |
| Impitoyable | 0,00 | pleine mer + Tempête = table de départ ci-dessus |

### Le rythme du cycle de marée

Le cycle dure 12 minutes. La courbe `sin` donne naturellement le bon rythme :

```
   marée
    +1 │              ╭──────╮                   ← PLEINE MER  (2 min de danger)
       │           ╭──╯      ╰──╮
     0 │───────╭───╯            ╰───╮────────    ← mi-marée (l'action)
       │    ╭──╯                    ╰──╮
    −1 │────╯                          ╰──────   ← BASSE MER (4 min de chantier)
       └────────────────────────────────────────
        0    2    4     6     8    10    12  min
```

| Phase | Durée | Ce que le joueur fait |
|---|---|---|
| **Basse mer** (marée < −0,5) | ~4 min | **construction pure**. La mer est loin, l'estran est nu et humide : le meilleur sable du jeu est accessible. |
| **Montante** (−0,5 → +0,5) | ~3 min | **défense**. Le rivage avance de 1,3 m/min, on creuse la douve, on renforce. Le jet de rive commence à toucher. |
| **Pleine mer** (marée > +0,5) | ~2 min | **spectacle et survie**. Rien à faire qu'à regarder et à colmater. |
| **Descendante** | ~3 min | **inspection et réparation**. On voit les dégâts se découvrir. |

C'est une boucle de 12 minutes bien rythmée. **La houle doit renforcer ce rythme, pas
le remplacer** : d'où l'écrêtage, qui fait de la marée le maître du tempo et de la houle
le maître de l'intensité.

### Télégraphier, toujours

La règle d'or : **rien ne doit détruire sans avoir été annoncé.**

1. **Les groupes annoncent eux-mêmes.** Une série commence par des vagues à 60–70 % de
   la pleine amplitude. Le joueur a 2 à 3 vagues pour voir venir. C'est un effet de
   l'enveloppe `A_g`, il est gratuit.
2. **Le son.** `Game.updateAmbient(dt, this.water.swash * 10, ...)` existe déjà :
   l'alimenter avec `waves.groupAmp` et `Σ brk` donne le grondement qui monte avant une
   série. C'est le meilleur avertissement possible.
3. **La pastille de marée.** `HUD.tideChip` a déjà une classe `warn` quand
   `tidePhase > 0.7 && rising`. Y ajouter la houle : *« Pleine mer dans 1 min — Grosse
   houle »*.
4. **La laisse d'écume.** `foamDry` marque physiquement jusqu'où la mer est montée. Le
   joueur *voit* la ligne de danger sur le sable, en permanence. C'est le meilleur
   indicateur qui soit, et il ne coûte rien parce qu'il est déjà dans la simulation.
5. **Le stress de `Granular`.** Les micro-fissures sur les surplombs apparaissent avant
   la rupture. Un mur sapé se **fissure** avant de tomber.

## 7.3 Le mode « mer d'huile »

Le niveau 0 doit être **vraiment** calme, pas « presque calme » :

```js
  // Mer d'huile : on n'annule pas seulement l'amplitude, on annule le
  // generateur. Une amplitude nulle laisse quand meme le solveur agiter la
  // surface a cause de la relaxation, et le joueur qui a demande le calme
  // verrait encore frissonner l'eau.
  if (stateIndex === 0) {
    this.waves.enabled = false;           // eta() -> 0, cible = plan d'eau plat
    this.brk.fill(0);
    // Erosion par les vagues coupee ; l'infiltration, la maree et le
    // ruissellement continuent (creuser une tranchee doit toujours marcher).
    this.wallAttack = 0;
  }
```

**Ce qui doit rester actif en mer d'huile :**
- la marée (c'est le cœur du jeu, et elle apporte son propre drame lent) ;
- l'infiltration et la nappe (creuser près de l'eau doit toujours donner une flaque) ;
- le ruissellement et l'érosion par écoulement (verser un seau doit creuser) ;
- le module granulaire (les murs trop hauts s'effondrent toujours).

**Ce qui doit s'arrêter :** le déferlement, le jet de rive, le sapement, le spray, et
la clameur sonore. La mer doit devenir un miroir. C'est un contraste esthétique fort et
c'est un vrai mode de jeu — « le matin, avant que ça se lève ».

Un mode complémentaire, à exposer aussi : **« Sanctuaire »** = mer d'huile **+**
`tideSpeed = 0` **+** `erosionEnabled = false`. Rien ne bouge, on sculpte. Le contrôle
`erosionEnabled` existe déjà dans `Water`.

---

# 8. BUDGET ET STABILITÉ

## 8.1 Coût par pas de simulation

### Cellules mouillées, mesurées sur le profil réel

| marée | niveau (m) | cellules mouillées | % du domaine | `h_max` | `c = √(g h_max)` |
|---|---|---|---|---|---|
| −1,00 | 0,590 | 7 832 | 12,0 % | 0,44 m | 2,08 m/s |
| −0,50 | 0,820 | 11 130 | 17,0 % | 0,67 m | 2,56 m/s |
| 0,00 | 1,050 | 18 816 | 28,7 % | 0,90 m | 2,97 m/s |
| +0,50 | 1,280 | 27 904 | 42,6 % | 1,13 m | 3,33 m/s |
| +1,00 | 1,510 | 36 480 | 55,7 % | 1,36 m | 3,65 m/s |

La ruse des `scanA/scanB` (ne parcourir que les lignes mouillées élargies) est donc
**très** payante : entre 12 % et 56 % du domaine au lieu de 100 %. Il faut la préserver
scrupuleusement.

### Décompte par frame

Pour le cas médian (mi-marée, ~19 000 cellules mouillées, +15 % de marge de scan
= 22 000 cellules visitées) :

| Passe | Fréquence | Cellules | Opérations / cellule | Total |
|---|---|---|---|---|
| `waves.applyGeneration` | × n_sub | ~2 400 (bande seule) | ~35 (5 cos + relax) | 250 k |
| `seep` | × n_sub | 65 536 (plein domaine) | ~4 | 786 k |
| `computeScanRanges` | × n_sub | 256 lignes | ~8 | 5 k |
| `flux` | × n_sub | 22 000 | ~45 (4 faces × hFace) | 3,0 M |
| `integrate` | × n_sub | 22 000 | ~30 | 2,0 M |
| `breaking` | × n_sub | 22 000 | ~28 | 1,8 M |
| `erode` | × 1 | 22 000 | ~55 | 1,2 M |
| `undermine` | × 1 | ~1 200 (cellules rapides) | ~70 | 0,08 M |
| `advectSediment` | × 1 | 22 000 | ~25 | 0,55 M |
| `advectFoam` | × 1 | 22 000 | ~28 | 0,62 M |
| `infiltrate` | × 1 | 12 000 | ~22 | 0,26 M |
| **Total à n_sub = 2** | | | | **≈ 18,5 M op/frame** |

À ~4 opérations/ns en JS optimisé (Float32Array, boucles monomorphes, pas
d'allocation), cela donne **4 à 7 ms par frame**. C'est 2,3 à 2,8 fois le coût du
solveur actuel. Sur un budget de 16,7 ms, c'est jouable mais serré : il reste 10 ms pour
le maillage, le granulaire et le rendu.

### Optimisations obligatoires

| # | Optimisation | Gain |
|---|---|---|
| **O1** | `seep()` ne doit **pas** parcourir les 65 536 cellules à chaque sous-pas. Ne le faire qu'**une fois par frame**, hors de la boucle de sous-pas : le suintement est lent (`SEEPAGE_RATE`), sa discrétisation n'a aucune importance. | **−786 k × (n−1)** |
| **O2** | Fusionner `breaking` dans la queue d'`integrate` : les deux parcourent les mêmes cellules avec les mêmes bornes. Une seule passe de cache. | −20 % sur les deux |
| **O3** | Fusionner `advectFoam` et `advectSediment` : mêmes vitesses, mêmes interpolations bilinéaires, deux valeurs transportées au lieu d'une. On calcule `px, pz, x0, z0, tx, tz` **une seule fois**. | −40 % sur les deux |
| **O4** | Sous-passer **uniquement la bande profonde**. La CFL n'est violée que là où `h > 0,25 m`, c'est-à-dire dans la bande du large (~8 600 cellules). Les 13 000 cellules de l'estran peuvent rester à un seul pas. Schéma à deux vitesses. | −35 % du surcoût de sous-pas |
| **O5** | Précalculer `Math.hypot` → `Math.sqrt(a*a+b*b)`. `hypot` est 3 à 8 fois plus lent en V8 (il gère les dénormaux). Il est appelé ~100 000 fois par frame. | **−0,5 à 1 ms** |
| **O6** | La table `eta()` du générateur peut être précalculée sur une grille 1D en `s` (l'incidence rend la dépendance en `y` faible) : 256 valeurs au lieu de 2 400 × 5 cosinus. | −200 k |

Avec O1, O3 et O5 seuls, on retombe autour de **3,5 à 5 ms**. C'est le budget cible.

## 8.2 Condition CFL

Depuis la correction D1, le schéma est **explicitement limité par la CFL** :

```
    dt  ≤  CFL_SAFE · Δx / ( √(g h_max) + |u|_max )       CFL_SAFE = 0,8
```

| marée | `h_max` | `c` | `|u|_max` typique | `dt_CFL` | sous-pas à 60 Hz |
|---|---|---|---|---|---|
| basse | 0,44 m | 2,08 m/s | 0,5 m/s | 12,4 ms | **2** |
| mi-marée | 0,90 m | 2,97 m/s | 0,6 m/s | 8,9 ms | **2** |
| pleine | 1,36 m | 3,65 m/s | 0,7 m/s | 7,3 ms | **3** |
| pleine + `HFACE_CAP` = 0,55 | (0,55 m) | 2,32 m/s | 0,7 m/s | 10,6 ms | **2** |

**Le plafond `HFACE_CAP = 0,55 m` économise un sous-pas complet à pleine mer**, pour un
effet visuel nul (la houle du large voyage 25 % moins vite ; on compense en ajustant
`c_ref` dans le calcul des nombres d'onde, §3.2, donc la longueur d'onde apparente reste
correcte).

```js
  /** Nombre de sous-pas pour respecter la CFL. Borne dure a 4. */
  substeps(dt) {
    const hEff = Math.min(this.hMaxSea, HFACE_CAP);
    const c = Math.sqrt(GRAVITY * hEff) + this.uMax;
    return clamp(Math.ceil((dt * c) / (CFL_SAFE * VOXEL)), 1, 4);
  }
```

**Pourquoi une borne dure à 4.** Si une frame prend 100 ms (chargement, GC), `dt` est
grand et le calcul demanderait 12 sous-pas : le solveur mangerait toute la frame
suivante et on entrerait dans une spirale de la mort. Mieux vaut violer légèrement la
CFL pendant deux frames — le schéma est *diffusif*, pas explosif, quand on la viole
(voir §8.3) — que de perdre le contrôle du budget. Complément indispensable :
**plafonner `dt` lui-même à 1/30 s** dans `Game.update()`.

## 8.3 Garde-fous

Le schéma pipe est **remarquablement docile** parce que la mise à l'échelle des flux
(« une cellule ne peut pas donner plus d'eau qu'elle n'en a ») borne structurellement le
transport. Quand la CFL est violée, il **diffuse** au lieu d'exploser. C'est sa grande
qualité et il faut la préserver : la mise à l'échelle doit rester **après** l'ajout du
terme `g·h̄` et **après** le frottement.

| # | Garde-fou | Valeur | Ce qu'il empêche |
|---|---|---|---|
| **G1** | Mise à l'échelle des flux sortants | (existant) | volumes négatifs, `h < 0` |
| **G2** | Plafond de Froude sur la vitesse | `Fr ≤ 1,6` | vitesses aberrantes en lame mince ⇒ érosion aberrante. **Remplace le `sp > 4` en dur**, qui est trop permissif dans 5 cm d'eau (Fr = 5,7 !) et trop restrictif dans 90 cm. |
| **G3** | Plancher de profondeur de face | `HFACE_MIN = 6 mm` | pointe du jet figée |
| **G4** | Plafond de profondeur de face en bande | `HFACE_CAP = 0,55 m` | sous-pas excessifs |
| **G5** | Plafond d'arrachement par pas | `0,006 · dt · 60 · VOXEL` (existant) | une seule vague qui creuse un canyon |
| **G6** | Plafond de sapement par pas | `UNDERCUT_CAP = 0,35 · VOXEL` | un mur qui disparaît en une frame |
| **G7** | Borne de sous-pas | `n ≤ 4` | spirale de la mort |
| **G8** | Plafond de `dt` | `dt ≤ 1/30 s` dans `Game.update()` | idem, à la source |
| **G9** | Dissipation semi-implicite | `1/(1+k·dt)` partout | instabilité du terme de déferlement quel que soit `dt` |
| **G10** | Stabilité de la diffusion de rouleau | `ν·dt/Δx² ≤ 0,25` | oscillations en damier |
| **G11** | Conservation du volume | un `console.assert` en debug sur `Σh·A + infiltré − généré` | fuite ou création de masse par la bande de relaxation |
| **G12** | Budget du granulaire | `granular.step(dt, budget)` (existant) | un effondrement massif qui gèle la frame |

### Le piège de G11

La zone de relaxation **crée et détruit de la masse** — c'est inhérent à la méthode.
C'est acceptable (c'est un bord ouvert : l'océan est censé être infini au-delà), mais il
faut le **mesurer**, sinon un bug de signe fait monter ou descendre le niveau global de
plusieurs centimètres en quelques minutes sans qu'on comprenne pourquoi. Instrumenter :

```js
  // Debug : bilan de masse. Ce qui entre par la bande de relaxation moins ce
  // qui sort doit rester du meme ordre que le flux d'une houle, pas deriver.
  this.stats.injected += (hAfter - hBefore) * A;    // dans applyGeneration
```

### Test de non-régression indispensable

Un cas de validation analytique, à lancer en CI :

> **Run-up de Carrier & Greenspan.** Une onde solitaire d'amplitude `a` sur une pente
> plane de pente `β` doit atteindre `R/a` conforme à la loi de Synolakis
> `R/h = 2,831 · √(cot β) · (a/h)^1,25`. Si le solveur corrigé donne le bon ordre de
> grandeur (à ±30 %), la chaîne levée → déferlement → run-up est saine. Si elle donne
> 5 fois moins, c'est que D1 n'a pas été appliquée correctement.

---

# 9. PLAN D'IMPLÉMENTATION PAR ÉTAPES

Chaque étape est jouable et mesurable. Ne pas passer à la suivante sans avoir validé.

| # | Étape | Fichiers | Critère de validation |
|---|---|---|---|
| **1** | **D1 — célérité `g·h̄_face`** + sous-pas + plafond de Froude | `Water.flux`, `Water.integrate`, `Water.step` | Verser un seau : l'onde traverse le domaine à `√(gh)`, pas à 0,63 m/s. Le ressac actuel devient *déjà* beaucoup plus vivant — c'est le meilleur retour sur investissement du projet. |
| **2** | **Frottement de fond physique**, `WATER_DAMPING` → 0,999 | `Water.flux`, `Config` | Une nappe fine s'arrête ; une masse d'eau profonde ne perd plus 60 %/s. |
| **3** | **`Waves.js` : générateur + relaxation** | nouveau, `Water.step`, `Water.applyBoundaries` | Des crêtes individuelles traversent la bande, gonflent sur le haut-fond, et **rien ne se réfléchit** sur la limite. |
| **4** | **`breaking()` : détection + dissipation + écume** | `Water.breaking` | Les crêtes cassent visiblement à `h ≈ 1,3 Hs` ; l'écume naît sur le front et pas ailleurs. |
| **5** | **Table des 6 niveaux + UI** | `Waves.SEA_STATES`, `HUD` | Les six crans sont distinguables au premier coup d'œil. |
| **6** | **`advectFoam` + `foamDry` + laisse d'écume** | `Water`, `SandMaterial` | La laisse marque le run-up sur le sable et s'efface en ~10 s. |
| **7** | **D5 — recalibrage `COHESION_RESIST`** + biais jet/retrait dans `erode()` | `Water.erode`, `Config` | La matrice houle × qualité du §5.2 se vérifie en jeu. Une berme se forme. |
| **8** | **D4 — `undermine()` + `notch()`** | `Water` | Un mur vertical se creuse au pied, se fissure (stress), puis tombe **en bloc**. |
| **9** | **Rendu : cambrure, écume anisotrope, nappe brillante** | `WaterRenderer` | — |
| **10** | **Spray** | nouveau `render/Spray.js` | — |
| **11** | **Écrêtage de marée + télégraphe (son, pastille)** | `Waves`, `HUD`, `Audio` | Une pleine mer + Grosse houle est spectaculaire sans être injouable. |
| **12** | **Optimisations O1/O3/O5** | `Water` | Retour sous 5 ms. |

**Si le temps manque, faire 1, 2, 3, 4, 7, 8.** Ces six étapes donnent l'essentiel :
des vagues qui déferlent et qui sapent. Le reste est du raffinement.

---

# 10. RÉCAPITULATIF DES CONSTANTES

À ajouter dans `Config.js` (ou dans `Waves.js` pour ce qui est purement houle).

```js
// =============================================================================
// VAGUES — hydrodynamique
// =============================================================================

/** Profondeur de face minimale (m). Sans ce plancher, la pointe du jet de rive
 *  a une celerite nulle et n'avance plus jamais. */
export const HFACE_MIN = 0.006;
/** Profondeur de face maximale DANS LA BANDE DE GENERATION (m). Cape la
 *  celerite a 2,32 m/s et economise un sous-pas a pleine mer. Invisible. */
export const HFACE_CAP = 0.55;
/** Marge de securite CFL. */
export const CFL_SAFE = 0.80;
/** Nombre maximal de sous-pas par frame (anti-spirale de la mort). */
export const SUBSTEP_MAX = 4;
/** Damping NUMERIQUE seul (le frottement physique a pris le relais).
 *  Etait 0.985, ce qui mangeait 60 % de la quantite de mouvement par seconde. */
export const WATER_DAMPING_NUM = 0.999;
/** Plafond de Froude. Remplace le "if (sp > 4)" en dur, absurde en lame mince. */
export const FR_MAX = 1.6;

// --- frottement de fond ------------------------------------------------------
/** Coefficient de frottement a la MONTEE du jet (turbulent, charge de bulles). */
export const FW_UPRUSH = 0.050;
/** ... et a la descente. Le rapport 2:1 est mesure ; c'est lui qui produit le
 *  transport net vers la terre, donc la berme, donc une plage qui tient. */
export const FW_BACKWASH = 0.025;

// --- deferlement -------------------------------------------------------------
/** Seuil de declenchement, en fraction de sqrt(gh) (Kennedy et al. 2000). */
export const BREAK_ON = 0.65;
/** Seuil d'extinction. L'hysteresis evite le clignotement du rouleau. */
export const BREAK_OFF = 0.15;
/** Dissipation de base au deferlement (1/s). */
export const BREAK_GAIN_BASE = 3.0;
/** Supplement de dissipation apporte par l'agitation (1/s). */
export const BREAK_GAIN_AGIT = 2.5;
/** Epaisseur du rouleau (viscosite de rouleau adimensionnee). */
export const ROLLER_NU = 0.6;
/** Surcote de contrainte quand un ressaut casse SUR le sable. */
export const BREAK_TAU = 1.6;

// --- ecume -------------------------------------------------------------------
export const FOAM_GAIN = 3.5;       // 1/s : saturation en 0,3 s
export const FOAM_TAU_WET = 5.0;    // s : ecume portee par l'eau
export const FOAM_TAU_DRY = 9.0;    // s : laisse d'ecume sur le sable
export const FOAM_DEPOSIT = 0.75;   // fraction deposee quand la cellule s'asseche

// =============================================================================
// VAGUES — sable
// =============================================================================

/** Contrainte critique du sable propre (Pa, Shields, 0,3 mm). Inchangee. */
export const TAU_CRIT_DRY = 0.168;
/** Multiplicateur de cohesion. ETAIT 30 : avec 30, le clapot le plus modeste
 *  (34 Pa) battait le meilleur mur du jeu (5,1 Pa), donc le damage ne servait
 *  a rien. Avec 600, la table de resistance recoupe exactement la table des
 *  six niveaux de houle (voir la matrice du §5.2). */
export const COHESION_RESIST = 600;

/** Hauteur de paroi emergee au-dessus de la lame pour qu'on parle de "mur" (m). */
export const UNDERCUT_RISE = 0.06;
/** Vitesse minimale du jet pour saper (m/s). */
export const UNDERCUT_V = 0.35;
/** Amplification par le tourbillon de pied (affouillement type pile de pont).
 *  K = 1 + SCOUR_GAIN * min(Fr, 1.8)  ->  entre 1 et 5,0. */
export const SCOUR_GAIN = 2.2;
/** Vitesse de creusement de l'encoche (m/s, a exces de contrainte unitaire). */
export const UNDERCUT_RATE = 0.009;
/** Plafond dur par pas, en fraction de VOXEL. Un mur ne doit JAMAIS disparaitre
 *  en une frame. */
export const UNDERCUT_CAP = 0.35;
/** Amplification de la contrainte sur le FRONT du jet (la ou naissent les
 *  micro-falaises). */
export const SCARP_FRONT = 2.4;

/** Etat du sable fraichement depose par le jet. ETAIT 255 / 40 : a 255,
 *  cohesionFactor(1,0) = 0 donc tau_crit = 0,17 Pa, et tout ce qui se depose
 *  repart a la vague suivante — aucune berme ne pouvait se former. */
export const DEPOSIT_MOISTURE = 205;   // w = 0,80, draine ensuite vers 0,15
export const DEPOSIT_PACK = 55;        // le jet tasse un peu en se posant

// =============================================================================
// VAGUES — generation
// =============================================================================

export const H_GEN = 0.18;        // profondeur minimale d'injection (m)
export const W_RELAX = 20;        // largeur de la bande de relaxation (cellules)
export const W_SPONGE = 10;       // eponge de bord (cellules)
export const RELAX_P = 3.5;       // exposant du profil alpha
export const N_COMP = 5;          // composantes spectrales
export const C_IG = 0.22;         // amplitude de l'onde longue liee
export const TIDE_GATE = 0.45;    // k_T : ecretage de la houle a pleine mer

// =============================================================================
// VAGUES — rendu
// =============================================================================

export const CURL_AMOUNT = 0.06;  // m : deplacement horizontal de crete
export const LIP_RISE = 0.02;     // m : soulevement de la levre au deferlement
export const SPRAY_MAX = 400;
export const SPRAY_BRK = 0.55;
export const SPRAY_SPEED = 1.2;
export const SPRAY_RATE = 18;
```

## Table de synthèse des six niveaux (référence rapide)

| # | Nom | `Hs` | `Tp` | `ξ₀` | `R2%` | excursion | `u₀` | `τ` jet | douve mini | érosion |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 | Mer d'huile | 0 | — | — | 0 | 0 | 0 | 0 Pa | — | 0,00 |
| 1 | Clapot | 4 cm | 1,6 s | 2,10 | 6,9 cm | 0,33 m | 1,17 m/s | 34 Pa | 6 cm | 0,39 |
| 2 | Petites vagues | 9 cm | 2,0 s | 1,75 | 13,0 cm | 0,62 m | 1,60 m/s | 64 Pa | 13 cm | 1,00 |
| 3 | Houle | 18 cm | 2,6 s | 1,61 | 23,9 cm | 1,14 m | 2,17 m/s | 118 Pa | 25 cm | 1,92 |
| 4 | Grosse houle | 30 cm | 3,1 s | 1,49 | 36,8 cm | 1,75 m | 2,69 m/s | 181 Pa | 40 cm | 3,07 |
| 5 | Tempête | 45 cm | 3,6 s | 1,41 | 52,4 cm | 2,49 m | 3,21 m/s | 258 Pa | 58 cm | 4,49 |

---

# 11. SOURCES

**Déferlement, similitude, indice de déferlement**
- [Surf similarity parameter — Coastal Wiki](https://www.coastalwiki.org/wiki/Surf_similarity_parameter) — seuils ξ, `γ ~ 1,06 + 0,14 ln ξ`, `Cr ~ 0,1 ξ²`, `R ~ Hs·ξ`
- [Iribarren number — Wikipedia](https://en.wikipedia.org/wiki/Iribarren_number)
- [Breaker index — Coastal Wiki](https://www.coastalwiki.org/wiki/Breaker_index) — Miché, Battjes 1974, Goda 2010
- [Wave breaking — Bosboom & Stive, *Coastal Dynamics* (LibreTexts §5.2.5)](https://geo.libretexts.org/Bookshelves/Oceanography/Coastal_Dynamics_(Bosboom_and_Stive)/05:_Coastal_hydrodynamics/5.02:_Wave_transformation/5.2.5:_Wave_breaking) — `γ` = 0,6–0,8 (glissant) / 0,8–1,2 (plongeant), Miché `H/L ≤ 1/7`
- [Battjes, *Surf Similarity*, ICCE 1974](https://icce-ojs-tamu.tdl.org/icce/article/download/2921/2586/12546)
- [Goda, *Reanalysis of regular and random breaking wave statistics* (2010)](https://www.ancientportsantiques.com/wp-content/uploads/Documents/ENGINEERING/Maritime/BW/WaveBreaking-Goda2010.pdf)
- [Parameterization of nearshore wave breaker index (arXiv 2104.00208)](https://arxiv.org/pdf/2104.00208)
- [A modified breaker index formula for depth-induced wave breaking in spectral wave models](https://www.sciencedirect.com/science/article/abs/pii/S0029801822018108)

**Run-up et jet de rive**
- [Wave run-up — Coastal Wiki](https://www.coastalwiki.org/wiki/Wave_run-up) — Hunt 1959, Stockdon 2006, saturation `R_s = A g β² T²`
- [Stockdon, Holman, Howd & Sallenger (2006), *Empirical parameterization of setup, swash and runup*, Coastal Engineering](https://www.academia.edu/22292546/Empirical_parameterization_of_setup_swash_and_runup)
- [py-wave-runup — implémentations de référence](https://py-wave-runup.readthedocs.io/en/latest/models.html) — coefficients exacts Stockdon / Holman / Nielsen / Ruggiero / Senechal
- [USGS Data Series 602 — jeu de données de run-up de Stockdon et al.](https://pubs.usgs.gov/ds/602)
- [Swash zone dynamics — Coastal Wiki](https://www.coastalwiki.org/wiki/Swash_zone_dynamics) — vitesses 2–5 m/s, `0,02 < f < 0,1`, critère de saturation de Miché, roll-off en `f⁻⁴`
- [Run-up and inundation generated by non-decaying dam-break bores on a planar beach — JFM](https://www.cambridge.org/core/journals/journal-of-fluid-mechanics/article/runup-and-inundation-generated-by-nondecaying-dambreak-bores-on-a-planar-beach/DA14F3B9D1F6CA4AAE76E4DDBE34BCA2)
- [Shen & Meyer / Ho & Meyer — *Climb of a bore on a beach, Part 3: Run-up* (JFM)](https://www.cambridge.org/core/journals/journal-of-fluid-mechanics/article/abs/climb-of-a-bore-on-a-beach-part-3-runup/F0442E52ABAD0C00F1C43DBC0EE8B3C6)
- [One-dimensional and weakly two-dimensional swash on a plane beach (arXiv 2504.18467)](https://arxiv.org/pdf/2504.18467)
- [Double dam-break-generated swash flows on a rough planar beach — Physics of Fluids](https://pubs.aip.org/aip/pof/article/38/4/045118/3386075/Double-dam-break-generated-swash-flows-on-a-rough)

**Set-up, groupes, infragravitaire**
- [Wave set-up — Coastal Wiki](https://www.coastalwiki.org/wiki/Wave_set-up)
- [Cross-shore balance — wave set-up and set-down (LibreTexts §5.5.4)](https://geo.libretexts.org/Bookshelves/Oceanography/Coastal_Dynamics_(Bosboom_and_Stive)/05:_Coastal_hydrodynamics/5.05:_Wave-induced_set-up_and_currents/5.5.4:_Cross-shore_balance-wave_set-up_and_set-down)
- [Radiation stress — Wikipedia](https://en.wikipedia.org/wiki/Radiation_stress)
- [Infragravity waves — Coastal Wiki](https://www.coastalwiki.org/wiki/Infragravity_waves) — onde longue liée, opposition de phase avec l'enveloppe
- [Group bound long waves as a source of infragravity energy in the surf zone](https://www.sciencedirect.com/science/article/abs/pii/0278434395000372)
- [List, *Wave groupiness as a source of nearshore long waves*, ICCE](https://icce-ojs-tamu.tdl.org/icce/index.php/icce/article/download/4038/3721)
- [Undertow — Coastal Wiki](https://www.coastalwiki.org/wiki/Undertow)

**Levée, propagation, échelles**
- [Green's law — Wikipedia](https://en.wikipedia.org/wiki/Green%27s_law) — `a ∝ h^(−1/4)`
- [Wave shoaling — Wikipedia](https://en.wikipedia.org/wiki/Wave_shoaling)
- [Shallow-water wave theory — Coastal Wiki](https://www.coastalwiki.org/wiki/Shallow-water_wave_theory)
- [Douglas sea scale — Wikipedia](https://en.wikipedia.org/wiki/Douglas_sea_scale) — échelle d'état de mer 0–9
- [Sea state and swell — MetService](https://blog.metservice.com/Sea_State_and_Swell)
- [JONSWAP / Pierson-Moskowitz — implémentation de référence](https://github.com/haphaeu/jonswap)
- [wavespectra — construction de spectres](https://wavespectra.readthedocs.io/en/latest/construction.html)

**Numérique : déferlement en Saint-Venant / Boussinesq, limites absorbantes**
- [Implementation and Evaluation of Breaking Detection Criteria for a Hybrid Boussinesq Model — *Water Waves* (Springer)](https://link.springer.com/article/10.1007/s42286-019-00023-8) — critère de Froude de surface, bascule Boussinesq → NSWE
- [Wave-Breaking Model for Boussinesq-Type Equations Including Roller Effects — JWPCOE](https://ascelibrary.org/doi/10.1061/(ASCE)WW.1943-5460.0000022)
- [The flow in the surf zone: a fully nonlinear Boussinesq-type approach](https://www.sciencedirect.com/science/article/abs/pii/S0378383905000256)
- [Surf zone dynamics simulated by a Boussinesq type model, Part II: surf beat and swash oscillations](https://www.sciencedirect.com/science/article/abs/pii/S037838399700029X)
- [Optimal sponge layer for water waves numerical models — *Ocean Engineering*](https://www.sciencedirect.com/science/article/abs/pii/S0029801818309417)
- [Higuera, *Enhancing active wave absorption in RANS models* (arXiv 1810.03492)](https://arxiv.org/pdf/1810.03492)
- [An Absorbing Beach for Numerical Simulations of Nonlinear Waves in a Wave Tank](https://www.researchgate.net/publication/245273208_An_Absorbing_Beach_for_Numerical_Simulations_of_Nonlinear_Waves_in_a_Wave_Tank)
- [Benchmarking of Numerical Models for Wave Overtopping — Accuracy versus Speed (arXiv 2006.03508)](https://arxiv.org/pdf/2006.03508)

**Sédiments, érosion, micro-falaises, ouvrages**
- [A review of practical models of sand transport in the swash zone — *Earth-Science Reviews*](https://www.sciencedirect.com/science/article/pii/S0012825223000442)
- [Shear stress and sediment transport calculations for swash zone modelling — *Coastal Engineering*](https://www.sciencedirect.com/science/article/abs/pii/S0378383901000369) — `f_w` montée ≈ 2 × descente
- [Field measurements of sheet flow sediment transport in the swash zone — ICCE](https://icce-ojs-tamu.tdl.org/icce/article/download/6612/pdf_600/28194) — 100–1600 kg/m³
- [Hydrodynamics and sediment transport under a dam-break-driven swash](https://www.sciencedirect.com/science/article/abs/pii/S037838392100140X)
- [Beach scarp dynamics at nourished beaches — *Coastal Engineering*](https://www.sciencedirect.com/science/article/pii/S0378383919303229)
- [Dune erosion — Coastal Wiki](https://www.coastalwiki.org/wiki/Dune_erosion) — sapement au pied, encoche, glissement du surplomb
- [Littoral drift and shoreline modelling — Coastal Wiki](https://www.coastalwiki.org/wiki/Littoral_drift_and_shoreline_modelling) — CERC
- [Longshore Sediment Transport — Coastal Engineering Manual, EM 1110-2-1100 III-2](https://pdhonline.com/courses/c773/Part-III-Chap_2entire.pdf)
- [van Rijn, *Detached breakwaters* (2018)](https://www.leovanrijn-sediment.com/papers/Detachedbreakwaters2018.pdf) — saillant vs tombolo, `L_b/D`
- [Experimental study of the short-term efficiency of different breakwater configurations on beach protection — Springer](https://link.springer.com/article/10.1007/s40722-016-0051-9)
- [Evaluation of beach response due to construction of submerged detached breakwater — Frontiers in Marine Science](https://www.frontiersin.org/journals/marine-science/articles/10.3389/fmars.2024.1367411/full)

**Rendu temps réel**
- [Real-time Breaking Waves for Shallow Water Simulations (Thürey et al.)](https://www.researchgate.net/publication/220936975_Real-time_Breaking_Waves_for_Shallow_Water_Simulations) — détection du front raide dans le champ de hauteur, nappes de fluide, particules d'écume
- [A Model for Real Time Ocean Breaking Waves Animation — SBGames](https://sbgames.org/papers/sbgames10/computing/full/full4.pdf)
- [Ocean Wave Rendering with Whitecap in the Visual System of a Maritime Simulator](https://hrcak.srce.hr/file/264243) — écume par accumulation linéaire / dissipation exponentielle
- [GodotOceanWaves — FFT + écume par Jacobien](https://github.com/2Retr0/GodotOceanWaves)
- [Godot Realistic Shoreline & Ocean Waves (REBOOT16)](https://store.godotengine.org/asset/reboot16/waves/) — NSWE sur GPU jusqu'à 2048², plage à 60 fps
- [Ocean Rendering, Part 1 — Simulation (R. Ryan)](https://rtryan98.github.io/2025/10/04/ocean-rendering-part-1.html)
- [Why simulating ocean waves is one of gaming's hardest challenges — SurferToday](https://www.surfertoday.com/surfing/ocean-wave-simulation-in-video-games)

**Documents internes**
- `docs/RECHERCHE-PHYSIQUE-SABLE.md` — cohésion capillaire, Mohr-Coulomb, `θ_max(w, p)`
- `docs/RECHERCHE-RENDU-3D.md`
- `docs/ARCHITECTURE.md`
- Mei et al., *Fast Hydraulic Erosion Simulation and Visualization on GPU* — le modèle « pipe » d'origine
