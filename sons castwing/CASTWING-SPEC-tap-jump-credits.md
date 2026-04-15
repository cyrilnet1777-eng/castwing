# Castwing — Spec pour Cursor

> **Date :** 15 avril 2026
> **Auteur :** Wael (via Claude)
> **Fichier cible :** `index.html` (inline JS/CSS)
> **Règle d'or :** Ne rien modifier d'autre que ce qui est décrit ici. Demander confirmation avant tout ajout hors spec.

---

## Feature 1 — Tap-to-Jump dans le Téléprompter

### Contexte utilisateur

> « Si je swipe dans la lecture et que je clique sur une phrase, la voix devrait reprendre à cette phrase. Par exemple, si je suis page 1 et que je clique sur une réplique page 3, la lecture saute là-bas et l'AI repart de cette réplique. »

### Comportement attendu

1. **Chaque réplique dans le téléprompter est cliquable/tappable.**
2. Quand l'utilisateur tape sur une réplique :
   - L'index courant (`currentLineIndex` ou équivalent) saute à cette ligne.
   - Le highlight visuel se déplace immédiatement sur la ligne tappée.
   - Si la ligne tappée est une **réplique du partenaire** (pas le personnage de l'utilisateur) ET qu'on est en mode **AI vocal** ou **Auto** → l'AI la lit immédiatement via TTS.
   - Si la ligne tappée est une **réplique de l'utilisateur** → on attend simplement (l'utilisateur va la jouer).
   - Si on est en mode **Manuel** → pas de TTS, on déplace juste le curseur.
3. **Scroll automatique** : après le tap, le téléprompter scrolle pour centrer la ligne tappée à l'écran.
4. **Arrêt de la lecture en cours** : si l'AI est en train de lire une réplique (audio en cours), le tap sur une autre ligne doit **interrompre** la lecture en cours (`audio.pause()` + `audio.currentTime = 0`) avant de lancer la nouvelle.
5. **WebRTC Partner mode** : si un partenaire est connecté, envoyer la nouvelle position via le data channel pour synchroniser le téléprompter des deux côtés.

### Implémentation technique

#### Étape 1 — Rendre chaque réplique cliquable

Dans la fonction qui génère le HTML du téléprompter (chercher là où les `<div>` ou `<p>` des répliques sont créés), ajouter :

```javascript
// Pour chaque ligne du script affichée dans le téléprompter :
lineElement.style.cursor = 'pointer';
lineElement.setAttribute('data-line-index', i); // i = index dans le tableau de lignes
lineElement.addEventListener('click', () => handleTapToJump(i));
```

#### Étape 2 — Fonction handleTapToJump

```javascript
function handleTapToJump(targetIndex) {
  // 1. Stopper tout audio TTS en cours
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
  }
  // Aussi annuler tout speechSynthesis en cours (fallback browser)
  if (window.speechSynthesis.speaking) {
    window.speechSynthesis.cancel();
  }

  // 2. Mettre à jour l'index courant
  currentLineIndex = targetIndex;

  // 3. Mettre à jour le highlight visuel
  updatePrompterHighlight(currentLineIndex);

  // 4. Scroller vers la ligne
  scrollToLine(currentLineIndex);

  // 5. Si mode AI vocal ou Auto, et que la ligne est une réplique partenaire → lire
  const line = scriptLines[currentLineIndex];
  if (line && line.character !== selectedCharacter) {
    if (currentMode === 'ai_vocal' || currentMode === 'auto') {
      speakLine(line.text); // fonction TTS existante
    }
  }

  // 6. Sync WebRTC si partenaire connecté
  if (dataConnection && dataConnection.open) {
    dataConnection.send({ type: 'jump', index: currentLineIndex });
  }
}
```

#### Étape 3 — Réception du jump côté partenaire

Dans le handler des messages du data channel (chercher `dataConnection.on('data', ...)`) :

```javascript
// Ajouter ce case dans le switch/if existant :
if (data.type === 'jump') {
  currentLineIndex = data.index;
  updatePrompterHighlight(currentLineIndex);
  scrollToLine(currentLineIndex);
}
```

#### Étape 4 — Feedback visuel au tap

Ajouter en CSS :

```css
/* Réplique tappable */
.prompter-line {
  cursor: pointer;
  transition: background-color 0.15s ease;
  border-radius: 6px;
  padding: 4px 8px;
}

.prompter-line:active {
  background-color: rgba(65, 105, 225, 0.15); /* flash royal blue */
}
```

### Tableau des tâches (Feature 1)

| # | Tâche | Priorité | Détail |
|---|-------|----------|--------|
| 1.1 | Ajouter `data-line-index` + event listener `click` sur chaque ligne du téléprompter | 🔴 Haute | Chercher la boucle de rendu des répliques |
| 1.2 | Créer `handleTapToJump(index)` | 🔴 Haute | Voir code ci-dessus |
| 1.3 | Stopper l'audio en cours avant de lancer le nouveau | 🔴 Haute | `audio.pause()` + `speechSynthesis.cancel()` |
| 1.4 | Appeler `speakLine()` si la ligne est une réplique partenaire en mode AI/Auto | 🔴 Haute | Condition sur `line.character !== selectedCharacter` |
| 1.5 | Sync la position via data channel WebRTC | 🟡 Moyenne | Message `{ type: 'jump', index }` |
| 1.6 | CSS feedback au tap (`:active` highlight) | 🟢 Basse | Cosmétique mais améliore l'UX mobile |

---

## Feature 2 — Système de crédits + Onboarding Free/Signup

### Philosophie

- **Ne pas être agressif.** L'utilisateur doit sentir qu'il peut essayer l'app librement.
- **Seule ressource payante = la voix AI (TTS ElevenLabs).** C'est la seule chose qui coûte de l'argent côté serveur.
- **Tout le reste est gratuit** : upload PDF, téléprompter, enregistrement vidéo, mode partenaire WebRTC, navigation dans le script.
- Les voix browser (Speech Synthesis API) sont **toujours gratuites** et ne consomment pas de crédits.

### Ce qui consomme des crédits

| Action | Coût | Pourquoi |
|--------|------|----------|
| 1 réplique lue par une voix ElevenLabs | **1 crédit** | Appel API payant |
| Voix browser (Speech Synthesis) | **0 crédit** | Gratuit, tourne en local |
| Upload PDF | 0 | Parsing local via PDF.js |
| Enregistrement vidéo | 0 | MediaRecorder local |
| Mode partenaire WebRTC | 0 | P2P, pas de serveur |
| Navigation téléprompter | 0 | Rien côté serveur |

### Quotas proposés

| Profil | Crédits | Détail |
|--------|---------|--------|
| **Visiteur (sans compte)** | **15 crédits** | Stocké en `localStorage`. Suffisant pour tester 1-2 scènes courtes avec la voix AI. Pas de reset. |
| **Compte gratuit (inscrit)** | **50 crédits / mois** | Reset le 1er de chaque mois. L'inscription débloque aussi l'historique des sessions (futur). |
| **Premium (futur)** | Illimité | Abonnement payant, à implémenter plus tard. Pour l'instant, ne pas coder ce tier — juste prévoir la place dans la structure de données. |

> **Note :** Les chiffres (15 et 50) sont ajustables. L'important c'est la mécanique, pas les valeurs exactes.

### Parcours utilisateur

#### Cas 1 — Nouveau visiteur (pas de compte)

```
Arrivée sur cast-wing.com
       │
       ▼
┌─────────────────────────────────────────────┐
│  Écran d'accueil normal (choix langue, etc.)│
│  L'utilisateur utilise l'app normalement.   │
│  Pas de popup, pas de mur d'inscription.    │
└─────────────────┬───────────────────────────┘
                  │
                  ▼
         Première fois qu'il lance une voix AI ElevenLabs :
┌─────────────────────────────────────────────┐
│  Petite bannière en bas (non bloquante) :   │
│  "🎭 Tu as 15 lectures vocales AI gratuites.│
│   Inscris-toi pour en avoir 50/mois !"      │
│   [Continuer]  [S'inscrire]                 │
└─────────────────────────────────────────────┘
                  │
                  ▼
         L'utilisateur continue. Chaque réplique AI
         décrémente le compteur. Affichage discret
         du compteur dans un coin : "🎤 12 restants"
                  │
                  ▼
         Quand il atteint 0 :
┌─────────────────────────────────────────────┐
│  Modal (bloquante cette fois) :             │
│  "Tes crédits vocaux sont épuisés !         │
│   Tu peux :                                 │
│   • Continuer avec les voix gratuites du    │
│     navigateur (illimitées)                 │
│   • T'inscrire pour 50 crédits/mois         │
│                                             │
│   [Utiliser voix navigateur]  [S'inscrire]  │
└─────────────────────────────────────────────┘
```

**Important :** même à 0 crédits, l'app reste **100% utilisable** avec les voix navigateur. On ne bloque jamais l'utilisateur.

#### Cas 2 — Utilisateur inscrit

```
Connexion via Google/Apple/Email (système existant)
       │
       ▼
  Le serveur vérifie/crée l'entrée utilisateur.
  Crédits initiaux : 50.
  Date de reset : 1er du mois prochain.
       │
       ▼
  Compteur discret affiché : "🎤 47/50"
       │
       ▼
  Si crédits épuisés avant le reset :
  même modal que le visiteur, mais avec
  "Tes crédits se renouvellent le [date]"
  au lieu de "Inscris-toi".
```

### Implémentation technique

#### Étape 1 — Structure de données crédits (localStorage pour visiteurs)

```javascript
// Clé localStorage : castwing_credits_v1
const DEFAULT_GUEST_CREDITS = {
  total: 15,
  remaining: 15,
  isGuest: true,
  createdAt: new Date().toISOString()
};

function getCredits() {
  const stored = localStorage.getItem('castwing_credits_v1');
  if (stored) return JSON.parse(stored);
  // Premier visit : initialiser
  localStorage.setItem('castwing_credits_v1', JSON.stringify(DEFAULT_GUEST_CREDITS));
  return DEFAULT_GUEST_CREDITS;
}

function consumeCredit() {
  const credits = getCredits();
  if (credits.remaining <= 0) return false;
  credits.remaining -= 1;
  localStorage.setItem('castwing_credits_v1', JSON.stringify(credits));
  updateCreditDisplay(credits.remaining);
  return true;
}
```

#### Étape 2 — Vérification avant chaque appel TTS ElevenLabs

Dans la fonction qui appelle `/api/tts` (chercher `fetchTTSFromBestEndpoint` ou la fonction qui fait le `fetch` vers ElevenLabs), ajouter **au tout début** :

```javascript
async function speakWithElevenLabs(text, voiceId, options) {
  // --- CREDIT CHECK ---
  const credits = getCredits();

  if (credits.remaining <= 0) {
    // Proposer le fallback navigateur
    showCreditsDepletedModal();
    // Fallback automatique vers voix navigateur
    speakWithBrowserVoice(text);
    return;
  }

  // Consommer 1 crédit
  consumeCredit();

  // --- Appel TTS normal (code existant) ---
  const response = await fetch('/api/tts', { ... });
  // ...
}
```

#### Étape 3 — Affichage du compteur

Ajouter un petit badge discret dans l'interface de la session (pas sur l'écran d'accueil). Position suggérée : en haut à droite, à côté des contrôles existants.

```html
<div id="credit-badge"
     style="position: fixed; top: 12px; right: 12px;
            background: rgba(0,0,0,0.6); color: #fff;
            padding: 4px 10px; border-radius: 12px;
            font-size: 13px; font-family: 'DM Sans', sans-serif;
            z-index: 1000; display: none;">
  🎤 <span id="credit-count">15</span>
</div>
```

```javascript
function updateCreditDisplay(remaining) {
  const badge = document.getElementById('credit-badge');
  const countEl = document.getElementById('credit-count');
  if (!badge || !countEl) return;

  countEl.textContent = remaining;
  badge.style.display = 'block';

  // Couleur selon le niveau
  if (remaining <= 3) {
    badge.style.background = 'rgba(220, 53, 69, 0.85)'; // rouge
  } else if (remaining <= 8) {
    badge.style.background = 'rgba(255, 165, 0, 0.85)'; // orange
  } else {
    badge.style.background = 'rgba(0, 0, 0, 0.6)'; // normal
  }
}
```

#### Étape 4 — Bannière de bienvenue (première utilisation TTS)

Affichée une seule fois, quand le premier appel TTS est déclenché :

```javascript
function showWelcomeCreditBanner() {
  if (localStorage.getItem('castwing_credit_banner_shown')) return;
  localStorage.setItem('castwing_credit_banner_shown', 'true');

  const banner = document.createElement('div');
  banner.innerHTML = `
    <div style="position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
                background: #1a1a2e; color: #fff; padding: 14px 20px;
                border-radius: 12px; font-family: 'DM Sans', sans-serif;
                font-size: 14px; z-index: 9999; max-width: 380px;
                text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.3);">
      <div style="margin-bottom: 8px;">🎭 Tu as <strong>15 lectures vocales AI</strong> gratuites.</div>
      <div style="margin-bottom: 12px; opacity: 0.8; font-size: 12px;">
        Inscris-toi pour en avoir 50 par mois !
      </div>
      <div style="display: flex; gap: 8px; justify-content: center;">
        <button onclick="this.closest('div[style]').parentElement.remove()"
                style="padding: 8px 16px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.3);
                       background: transparent; color: #fff; cursor: pointer; font-size: 13px;">
          Continuer
        </button>
        <button onclick="openAuthModal(); this.closest('div[style]').parentElement.remove()"
                style="padding: 8px 16px; border-radius: 8px; border: none;
                       background: #4169e1; color: #fff; cursor: pointer; font-size: 13px;">
          S'inscrire
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(banner);

  // Auto-dismiss après 8 secondes
  setTimeout(() => { if (banner.parentElement) banner.remove(); }, 8000);
}
```

#### Étape 5 — Modal crédits épuisés

```javascript
function showCreditsDepletedModal() {
  const credits = getCredits();
  const isGuest = credits.isGuest;

  let message, buttons;
  if (isGuest) {
    message = `Tes crédits vocaux AI sont épuisés !<br>
               <span style="opacity:0.7; font-size:13px;">
               Tu peux continuer avec les voix gratuites du navigateur,
               ou t'inscrire pour 50 crédits/mois.
               </span>`;
    buttons = `
      <button onclick="switchToBrowserVoice(); closeModal(this)"
              style="...">🔊 Voix navigateur</button>
      <button onclick="openAuthModal(); closeModal(this)"
              style="... background:#4169e1; ...">S'inscrire</button>
    `;
  } else {
    // Utilisateur inscrit, calculer la date de reset
    const nextReset = getNextResetDate();
    message = `Tes crédits vocaux du mois sont épuisés !<br>
               <span style="opacity:0.7; font-size:13px;">
               Renouvellement le ${nextReset}.
               Continue avec les voix navigateur en attendant.
               </span>`;
    buttons = `
      <button onclick="switchToBrowserVoice(); closeModal(this)"
              style="...">🔊 Voix navigateur</button>
    `;
  }

  // Créer et afficher le modal (utiliser le système de modal existant si disponible)
  showModal(message, buttons);
}
```

#### Étape 6 — Migration guest → inscrit

Quand un visiteur s'inscrit, ses crédits restants sont transférés et complétés :

```javascript
function onUserSignedIn(user) {
  const guestCredits = getCredits();

  if (guestCredits.isGuest) {
    // Transférer : garder le max entre les crédits restants et 50
    const newCredits = {
      total: 50,
      remaining: Math.max(guestCredits.remaining, 50),
      isGuest: false,
      userId: user.id,
      resetDate: getNextFirstOfMonth(),
      createdAt: new Date().toISOString()
    };
    localStorage.setItem('castwing_credits_v1', JSON.stringify(newCredits));
  }

  updateCreditDisplay(getCredits().remaining);
}
```

#### Étape 7 — Reset mensuel (côté client, simplifié)

```javascript
function checkMonthlyReset() {
  const credits = getCredits();
  if (credits.isGuest) return; // pas de reset pour les guests

  const resetDate = new Date(credits.resetDate);
  if (new Date() >= resetDate) {
    credits.remaining = credits.total; // 50
    credits.resetDate = getNextFirstOfMonth();
    localStorage.setItem('castwing_credits_v1', JSON.stringify(credits));
  }
}

function getNextFirstOfMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
}

// Appeler au chargement de l'app
checkMonthlyReset();
```

### i18n

Les textes de la bannière et du modal doivent utiliser le système i18n existant. Clés à ajouter :

```javascript
// Ajouter dans chaque objet de langue :
credits_welcome: "🎭 Tu as {n} lectures vocales AI gratuites.",
credits_signup_cta: "Inscris-toi pour en avoir {n} par mois !",
credits_depleted_guest: "Tes crédits vocaux AI sont épuisés !",
credits_depleted_user: "Tes crédits vocaux du mois sont épuisés !",
credits_renewal: "Renouvellement le {date}.",
credits_browser_fallback: "Continue avec les voix gratuites du navigateur.",
credits_btn_browser: "🔊 Voix navigateur",
credits_btn_signup: "S'inscrire",
credits_btn_continue: "Continuer",
```

### Tableau des tâches (Feature 2)

| # | Tâche | Priorité | Détail |
|---|-------|----------|--------|
| 2.1 | Structure de données crédits dans localStorage | 🔴 Haute | `castwing_credits_v1`, voir code étape 1 |
| 2.2 | `consumeCredit()` + vérification avant chaque appel `/api/tts` | 🔴 Haute | Ne PAS bloquer les voix navigateur |
| 2.3 | Badge compteur en haut à droite | 🔴 Haute | Visible uniquement en session, couleur selon niveau |
| 2.4 | Bannière de bienvenue (1ère utilisation TTS) | 🟡 Moyenne | Non bloquante, auto-dismiss 8s |
| 2.5 | Modal crédits épuisés avec fallback voix navigateur | 🔴 Haute | Jamais bloquer l'utilisateur |
| 2.6 | `switchToBrowserVoice()` — basculer automatiquement | 🔴 Haute | Changer le mode voix sans recharger |
| 2.7 | Migration guest → inscrit au signup | 🟡 Moyenne | `onUserSignedIn()`, voir étape 6 |
| 2.8 | Reset mensuel côté client | 🟡 Moyenne | `checkMonthlyReset()` au chargement |
| 2.9 | Clés i18n pour tous les textes crédits | 🟡 Moyenne | 11 langues |
| 2.10 | (Futur) Stocker les crédits côté serveur pour les users inscrits | 🟢 Basse | Pour l'instant localStorage suffit, mais prévoir la migration |

---

## Résumé de l'ordre d'implémentation recommandé

| Ordre | Tâche | Feature |
|-------|-------|---------|
| 1 | Tap-to-jump : rendre les lignes cliquables + `handleTapToJump` | F1 |
| 2 | Tap-to-jump : stopper audio + lancer nouveau TTS | F1 |
| 3 | Structure crédits + `consumeCredit()` | F2 |
| 4 | Vérification crédits avant appel `/api/tts` | F2 |
| 5 | Badge compteur | F2 |
| 6 | Modal crédits épuisés + fallback voix navigateur | F2 |
| 7 | Bannière bienvenue | F2 |
| 8 | Sync WebRTC du jump | F1 |
| 9 | Migration guest → inscrit | F2 |
| 10 | Reset mensuel | F2 |
| 11 | i18n crédits | F2 |

---

## Notes pour l'implémenteur

- **Ne pas toucher** au système d'auth existant (Google/Apple/Email). Le système de crédits se branche par-dessus.
- **Ne pas toucher** au flux TTS existant sauf pour ajouter la vérification de crédits au début.
- **Les voix navigateur doivent rester gratuites et illimitées.** C'est le filet de sécurité.
- **localStorage uniquement pour l'instant.** Un utilisateur malin pourrait tricher en modifiant localStorage. C'est OK pour le lancement — la migration serveur viendra plus tard (tâche 2.10).
- Tous les noms de fonctions dans cette spec sont des **suggestions**. Adapter aux conventions du code existant.
