# Claudex

Un terminal, un débat structuré entre Claude Code et Codex, et toi qui arbitres — au lieu de copier-coller les réponses de l'un dans l'autre à la main.

## Ce que ça fait

- Lance Claude Code et Codex sur le même sujet, en lecture seule tant qu'ils n'ont pas atteint un consensus explicite.
- Transfère chaque réponse **intégralement, verbatim** à l'autre agent — pas de résumé automatique, pas de perte de nuance.
- Pas de limite de tours arbitraire : le débat s'enchaîne seul jusqu'au consensus. Claudex ne démarre que dans un vrai terminal, et Échap met en pause au clavier même pendant un tour — la supervision est structurelle, pas budgétaire. Si tu comptes t'éloigner, `/autonomy starts <N>` ou `/autonomy time <durée>` pose une borne ; une fenêtre épuisée termine le tour courant puis attend `/resume`.
- Le premier message reste provisoire jusqu'à sa qualification, et la conversation reste ouverte dans tous les cas : un non-sujet (`<<NO_TOPIC>>`) obtient une réponse puis attend que tu donnes un vrai sujet — qui remplace alors le premier message — et un sujet incomplet (`<<WAIT_HUMAN>>`) attend ta précision, qui vient s'y ajouter. Rien n'est écrit dans la mémoire du projet tant qu'aucun sujet n'est accepté.
- Dès le consensus atteint, une synthèse complète (non attribuée à l'un ou l'autre) de ce qui va être implémenté s'affiche automatiquement — visibilité avant de taper `/handoff` ou `/implement`, sans avoir à remonter tout le débat.
- `/handoff` génère un fichier markdown autoportant (mémoire projet + synthèse) à transmettre tel quel à une session `claude` ou `codex` native pour l'implémentation — chemin recommandé, pour garder toute l'ergonomie native de ces outils (`/implement` reste disponible pour rester dans Claudex sur des changements ponctuels).
- Tu peux intervenir à tout moment : message aux deux agents, ou ciblé sur l'un des deux.
- Tu peux changer le modèle de l'un ou l'autre en cours de session.
- Les demandes d'autorisation d'outil de Claude Code s'affichent dans l'interface et attendent ta décision.
- Le débat s'écrit dans le terminal comme une sortie normale : le scroll, la sélection et le copier-coller restent ceux de ton émulateur, et rien de déjà affiché n'est jamais redessiné. La zone vive est bornée à sept lignes en permanence, y compris au démarrage — c'est délibéré : une trame aussi haute que le terminal amène Ink à tout effacer, scrollback compris, dès que la fenêtre rétrécit. Les réponses Claude et Codex arrivent par vrais deltas. Commandes et outils sont résumés sur l'unique ligne de statut, sans leur sortie détaillée.
- Mémoire de projet persistante (`.claudex/memory/`) : décisions actées, devlog des sessions, limites connues — lue automatiquement par Claude Code (`CLAUDE.md`) et par Codex (`AGENTS.md`) à chaque session.
- `/new`, `/quit` et Ctrl+C utilisent un arrêt quiescent : les tours sont annulés, les adaptateurs réellement arrêtés, puis seulement l'instantané stable est archivé. Un échec conserve l'interface et se reprend avec `/retry`.

## Limite connue (pas un bug)

Codex est piloté via `codex app-server` afin de recevoir les deltas de texte et les événements d'activité. Claudex conserve toutefois une politique non interactive (`approvalPolicy: never`) : le niveau d'accès est accordé pour le tour entier (phase débat = lecture seule, phase implémentation = écriture dans le workspace via `/implement`) et une action hors sandbox échoue au lieu d'ouvrir une approbation Codex. Claude garde son mécanisme d'autorisation propre. Voir `.claudex/memory/limits.md`.

## Ce qui sort de ta machine

À lire avant de pointer Claudex sur un dépôt qui ne t'appartient pas, et avant de l'installer au
travail.

**Ton code part chez deux fournisseurs.** Claudex pilote Claude Code (Anthropic) et Codex (OpenAI).
Tout ce que les agents lisent — fichiers, extraits, résultats de recherche — est envoyé aux deux, et
chaque réponse de l'un est transmise intégralement à l'autre. Si ton employeur encadre l'usage des
outils IA, c'est cette phrase qu'il faut lui montrer.

**Codex exécute des commandes sans te demander.** Pendant le débat, il tourne dans un bac à sable du
système d'exploitation qui l'empêche d'écrire dans ton dépôt et de joindre le réseau. Claude, lui,
n'a aucun outil d'exécution (voir « Limite connue »).

**« Lecture seule » veut dire « ne peut rien modifier », pas « ne voit que le dépôt ».** Dans la
version actuelle de Codex, rien ne permet de restreindre ce qu'une commande peut *lire* : elle peut
ouvrir n'importe quel fichier accessible à ton compte et en recopier le contenu dans le transcript,
qui est ensuite envoyé aux deux modèles et écrit sur disque. Sans réseau, une commande ne peut rien
exfiltrer elle-même — mais elle peut recopier. **N'analyse pas avec Claudex du code auquel tu ne fais
pas confiance.**

**Les débats s'écrivent dans ton dépôt.** Claudex crée `.claudex/` à la racine du dossier où tu le
lances et y enregistre les transcripts. Au premier lancement il installe aussi `.claudex/.gitignore`
pour éviter qu'ils partent dans un commit. Les décisions et limites, elles, restent versionnables :
elles sont courtes et `CLAUDE.md` comme `AGENTS.md` les référencent.

## Prérequis

- Node.js 22 ou plus récent (exigé par Ink 7).
- **Claude Code** installé et authentifié (commande `claude` disponible).
- **Codex CLI** installé et authentifié (commande `codex` disponible).
- Un vrai terminal interactif : Claudex refuse de démarrer sans TTY.

Les deux abonnements sont nécessaires — un débat consomme des jetons des deux côtés simultanément.

## Installation

```bash
npm install
npm link   # rend la commande `claudex` disponible globalement
```

## Usage

```bash
claudex
```
Ouvre un écran d'accueil : tableau de bord (modèles configurés, versions CLI détectées, mémoire du projet), puis un champ pour taper le sujet à débattre.

Raccourci pour aller droit au débat :
```bash
claudex "Quelle architecture pour la timeline vidéo ?"
```

### Commandes dans l'interface

| Commande | Effet |
|---|---|
| texte libre | message envoyé aux deux agents (ou, sur l'écran d'accueil, démarre le débat sur ce sujet) |
| `/claude <texte>` / `/codex <texte>` | message ciblé sur un seul agent |
| `/model claude\|codex <nom>` | change le modèle — utilisable aussi sur l'écran d'accueil, avant de démarrer |
| `/handoff` | après consensus, génère un fichier markdown autoportant (`.claudex/memory/handoffs/`) à transmettre à une session `claude` ou `codex` native — chemin recommandé pour implémenter |
| `/implement` | passe en phase d'implémentation (écriture activée) dans Claudex même, n'assigne personne |
| `/implement claude\|codex [précision]` | passe en implémentation ET lance direct l'agent choisi sur ce qui vient d'être décidé — l'instruction par défaut suffit car l'agent a déjà tout le débat en mémoire de session |
| `/autonomy unbounded` | retire une borne posée ; c'est aussi le comportement par défaut |
| `/autonomy starts <N>` | borne la fenêtre à N nouveaux départs automatiques |
| `/autonomy time <durée>` | borne les nouveaux départs (`ms`, `s`, `m`, `h`) ; le tour en cours finit normalement |
| `--remember` après une commande `/autonomy` | mémorise cette politique pour le projet |
| `/resume` | retente un tour en échec ou ouvre une nouvelle fenêtre avec la même politique |
| `/pause` | arrête l'enchaînement automatique après le tour en cours |
| `/cancel` | annule le tour actif, conserve le texte partiel et permet une reprise explicite |
| `/accept-topic` | valide manuellement le sujet après une réponse de qualification sans marqueur |
| `/decide <sujet> \| <approche>` | enregistre une décision dans la mémoire du projet |
| `/limit <texte>` | enregistre une contrainte connue |
| `/save` | écrit un instantané partiel, immuable et identifié comme tel, sans fermer la session |
| `/new` | arrête proprement, archive dans `.claudex/memory/transcripts/`, réinitialise les deux contextes, puis revient à l'accueil |
| `/retry` | retente uniquement l'étape d'arrêt ou d'archivage qui a échoué |
| `/new --discard` / `/quit --discard` | abandonne explicitement l'archive, uniquement après un échec d'archivage |
| `/emergency-exit` | quitte sans garantie d'archive ; dernier recours si un arrêt externe ne se termine jamais |
| `/help` | écrit l'aide dans le fil du débat |
| `/quit` | arrête proprement, archive, puis quitte |

Ctrl+C suit le même chemin sûr que `/quit` et n'abandonne jamais implicitement une archive.

## Validation locale

```bash
npm run check
```

Cette commande exécute le typecheck strict, ESLint typé (dont React Hooks et les promesses non gérées), puis toute la suite Vitest.

## Architecture

```
src/
  agents/        adaptateurs CodingAgent (Claude Agent SDK, Codex app-server)
  orchestrator/   machine à états du débat (tours, consensus, intervention)
  memory/         lecture/écriture de .claudex/memory/*.md
  ui/
    Root.tsx       écran d'accueil ↔ vue de débat, possède les agents et le cycle de vie de la session
    DebateView.tsx vue du débat : amorçage haut/bas, puis transcript append-only et pied de page borné
    stream/         pipeline de rendu (filtre de marqueurs, sanitisation ANSI, découpage de lignes, markdown incrémental, écriture stdout)
    components/     WelcomeScreen (dashboard + saisie du sujet), statut, permission, saisie, enveloppe du pied de page
```

## Statut

V1 : boucle de débat fonctionnelle, interception de permission côté Claude, mémoire de projet, écran d'accueil avec tableau de bord, contexte réinitialisé proprement entre deux sujets (`/new`).
Pas encore fait : répartition automatique implémenteur/reviewer en phase d'implémentation (pour l'instant, orchestrée à la main via `/claude` et `/codex` une fois `/implement` lancé) ; affichage de la consommation de tokens en temps réel (prévu, pas encore fait).
