# CitizenTape — Plan de Monétisation & Crédits

> **Date :** 15 avril 2026 | **Auteur :** Wael | **Version :** 1.0

---

## Résumé des idées clés

| Idée | Source | Statut |
|------|--------|--------|
| Gratuit jusqu'à 10-20 min, puis payant par tranches | Wael (voice note) | A valider |
| 1 € par tranche de 10 min, crédits "freezables" | Wael (voice note) | A valider |
| Émotions débloquées après un seuil d'utilisation OU en Pro | Wael (voice note) | A valider |
| Bruits de fond IA (rivière, coup de fusil, ambiances) en payant | Wael (voice note) | A valider |
| 3 tiers : Free / Pro / Studio avec features progressives | Spec roadmap | A valider |
| Profil acteur public | Spec roadmap | Phase 2 |
| Casting Board (annonces + candidatures) | Spec roadmap | Phase 3 |
| Coaching vidéo + live | Spec roadmap | Phase 3 |
| Connexion entre acteurs / matching | Spec roadmap | Phase 3 |

---

## OPTION A — Modèle "à la minute" (idée Wael)

> Philosophie : L'utilisateur paye uniquement la voix IA (ElevenLabs).
> Tout le reste est gratuit. Simple, transparent, pas d'abonnement.

### Comment ça marche

| Étape | Ce qui se passe |
|-------|-----------------|
| **1. Arrivée** | L'utilisateur utilise l'app librement. Aucun mur. |
| **2. Premiers 15-20 min** | Voix IA gratuite. Compteur visible : "🎤 18:32 restantes". |
| **3. Crédits épuisés** | Modal : "Tes minutes IA sont écoulées. Recharge 10 min pour 1 €." |
| **4. Recharge** | L'utilisateur achète des packs de 10 min à 1 €. |
| **5. Freeze** | S'il part pisser / fait une pause → les crédits se gèlent (pas de décompte si pas de TTS actif). |
| **6. Seuil atteint** | Après X € dépensés (ex: 5 €), les émotions se débloquent gratuitement. |

### Grille tarifaire

| Pack | Prix | Minutes IA | Bonus |
|------|------|-----------|-------|
| **Essai gratuit** | 0 € | 15-20 min | Premier lancement uniquement |
| **Recharge x1** | 1 € | 10 min | — |
| **Recharge x5** | 4 € | 50 min | 10 min offertes |
| **Recharge x10** | 7 € | 100 min | 30 min offertes |

### Ce qui consomme des minutes

| Action | Coût | Pourquoi |
|--------|------|----------|
| Voix IA ElevenLabs (partenaire lit) | **Temps réel** | Appel API payant |
| Bruits de fond IA (ambiances) | **Temps réel** | Appel API payant |
| Voix navigateur (Speech Synthesis) | **0 min** | Gratuit, local |
| Upload PDF / téléprompter | **0 min** | Parsing local |
| Enregistrement vidéo | **0 min** | Local |
| Mode partenaire WebRTC (humain) | **0 min** | P2P |

### Ce qui se débloque progressivement

| Seuil | Déblocage |
|-------|-----------|
| **0 €** (gratuit) | 3 voix de base, émotion Neutre, vitesse Normal |
| **3 € dépensés** | 5 émotions débloquées (Excité, Triste, Colère, Chuchoté) |
| **5 € dépensés** | Toutes les 13 voix débloquées |
| **10 € dépensés** | Slider vitesse libre (0.37x → 2x) |
| **10 € dépensés** | Bruits de fond IA disponibles (ambiances sonores dans les scènes) |

### Avantages de cette option

- Simple à comprendre pour l'utilisateur
- Pas d'engagement mensuel (pas de friction "abonnement")
- Le freeze rassure : "je paye que quand j'utilise"
- Progression naturelle : plus tu utilises, plus tu débloques

### Inconvénients

- Revenus moins prévisibles (pas récurrents)
- L'utilisateur peut ne jamais revenir après l'essai gratuit
- Plus complexe à implémenter (compteur temps réel vs simple compteur de répliques)

---

## OPTION B — Modèle abonnement (spec roadmap)

> Philosophie : 3 tiers avec features progressives.
> Revenus récurrents, prévisibles.

### Grille des tiers

| | **Free** (inscrit) | **Pro** | **Studio** |
|---|---|---|---|
| **Prix** | 0 € | 9,99 €/mois | 24,99 €/mois |
| **Crédits voix IA** | 50 répliques/mois | 500 répliques/mois | Illimité |
| **Voix ElevenLabs** | 3 voix de base | 13 voix | 13 voix + futures premium |
| **Émotions** | Neutre seul | 5 émotions | 5 émotions + sliders custom |
| **Vitesse** | Normal seul | 3 vitesses | Slider libre |
| **Bruits de fond IA** | ❌ | ❌ | ✅ |
| **Profil acteur** | Bio + photo | Complet + showreel | Complet + badge vérifié |
| **Enregistrements** | Local seulement | Cloud 30 jours | Cloud illimité |
| **Casting Board** | Voir annonces | Postuler (3/mois) | Postuler illimité |
| **Coaching** | ❌ | Cours vidéo | Cours + sessions live |
| **Groupes révision** | ❌ | Rejoindre | Matching auto |
| **Réseaux sociaux** | ❌ | Links sur profil | Partage direct depuis app |

### Visiteur (sans compte)

| Élément | Détail |
|---------|--------|
| Crédits | 15 répliques (localStorage, pas de reset) |
| Voix | 3 voix de base |
| Features | Téléprompter + enregistrement local + WebRTC partenaire |
| Conversion | Bannière non-bloquante : "Inscris-toi pour 50 crédits/mois" |

### Avantages de cette option

- Revenus récurrents et prévisibles
- Les features Pro/Studio (castings, coaching) sont de vraies propositions de valeur
- Modèle éprouvé (Spotify, Netflix, etc.)

### Inconvénients

- L'abonnement fait peur aux utilisateurs occasionnels
- Plus de features à développer pour justifier le prix
- Le Studio à 24,99 € est ambitieux sans une base d'utilisateurs

---

## OPTION C — Hybride (recommandation)

> Combiner le meilleur des deux : pas d'abonnement obligatoire,
> mais un abonnement disponible pour les power users.

### Comment ça marche

| Profil | Accès | Prix |
|--------|-------|------|
| **Visiteur** | 15 min gratuites, 3 voix, neutre | 0 € |
| **Inscrit (gratuit)** | 20 min/mois, 3 voix, neutre | 0 € |
| **Pay-as-you-go** | Recharges de 10 min à 1 €, freeze, déblocages progressifs | 1 € par tranche |
| **Pro (abo)** | 500 répliques/mois, toutes voix/émotions, profil, castings | 9,99 €/mois |
| **Studio (abo)** | Illimité, bruits de fond IA, coaching, matching | 24,99 €/mois |

> L'utilisateur choisit : soit il recharge quand il veut (pas d'engagement),
> soit il prend un abo pour tout débloquer.

---

## Feature spéciale : Bruits de fond IA

> Idée Wael : "L'IA peut rentrer en jeu et rajouter les bruits de fond —
> une rivière, un coup de fusil — si c'est dans le texte."

### Comment ça marche

| Étape | Détail |
|-------|--------|
| 1 | Le PDF est analysé (déjà fait par le parser existant) |
| 2 | Les didascalies/actions sont détectées (déjà filtré par `isLikelyStageDirectionContent`) |
| 3 | L'IA identifie les mots-clés d'ambiance : "rivière", "coup de fusil", "pluie", "foule", etc. |
| 4 | Des sons d'ambiance correspondants sont joués en arrière-plan pendant la scène |
| 5 | Payant uniquement (Pro/Studio ou après X € dépensés) |

### Exemples de sons

| Mot-clé dans le script | Son joué |
|------------------------|----------|
| "bruit de pas", "marche" | Pas sur gravier/bois/béton |
| "coup de feu", "tir" | Détonation |
| "rivière", "eau" | Eau qui coule |
| "pluie", "orage" | Pluie + tonnerre |
| "foule", "marché" | Brouhaha |
| "porte claque" | Claquement de porte |
| "musique", "piano" | Musique d'ambiance |
| "silence", "nuit" | Ambiance nocturne (grillons, vent léger) |

> **Implémentation technique** : Sons pré-enregistrés en MP3 hébergés sur Cloudflare R2.
> Pas besoin d'IA générative pour les sons — une bibliothèque de 30-50 sons couvre 90% des cas.

---

## Tableau récapitulatif — Toutes les décisions à prendre

| # | Décision | Options | Impact |
|---|----------|---------|--------|
| 1 | **Modèle principal** | A (minutes) / B (abo) / C (hybride) | Architecture + pricing |
| 2 | **Gratuit : combien ?** | 15 répliques / 15 min / 20 min | Conversion vs générosité |
| 3 | **Unité de crédit** | Répliques (simple) / Minutes (précis) | UX + complexité technique |
| 4 | **Prix recharge** | 1 €/10 min, 4 €/50 min, 7 €/100 min | Revenus |
| 5 | **Prix Pro** | 7,99 € / 9,99 € / 12,99 € par mois | Positionnement |
| 6 | **Prix Studio** | 19,99 € / 24,99 € / 29,99 € par mois | Positionnement |
| 7 | **Déblocage progressif ?** | Oui (après X € dépensés) / Non (tout dès le Pro) | Rétention vs simplicité |
| 8 | **Bruits de fond IA** | Inclus dans Pro / Studio only / Pay-as-you-go | Différenciation |
| 9 | **Freeze des crédits** | Oui (pause auto) / Non (ils tournent) | UX |
| 10 | **Casting Board** | Phase 1 (mock) / Phase 2 (backend) / Plus tard | Priorité dev |
| 11 | **Coaching** | Phase 2 / Phase 3 / Plus tard | Partenariats nécessaires |
| 12 | **Profils publics** | Phase 1 (localStorage) / Phase 2 (serveur) | Backend nécessaire |
| 13 | **Paiement** | Stripe / Apple Pay / Google Pay / Les 3 | Intégration |

---

## Prochaine étape

1. **Wael choisit le modèle** (A, B, ou C) et valide les prix
2. **Phase 1** : Implémenter le gating côté client (tiers, cadenas, modal upgrade)
3. **Phase 2** : Intégrer Stripe + backend crédits
4. **Phase 3** : Casting Board, Coaching, Profils publics

> Ce document est la base de discussion. Rien n'est codé tant que les décisions ne sont pas validées.
