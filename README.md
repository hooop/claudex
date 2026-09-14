# Claudex

Claudex fait débattre Claude Code et Codex sur une question de conception, dans un seul terminal et sous arbitrage humain. Il remplace le copier-coller manuel des réponses d'un outil vers l'autre.

![Écran d'accueil de Claudex : en-tête animé, état de la mémoire du projet, et une question de conception saisie dans le champ du sujet](docs/accueil.png)

## Principe

Une session suit toujours le même cycle :

1. Une question de conception est posée.
2. Claude répond. Sa réponse est transmise à Codex.
3. Codex répond. Sa réponse est transmise à Claude.
4. Le cycle se répète jusqu'à ce que les deux agents soient explicitement d'accord.
5. Claudex affiche une synthèse de ce qui a été décidé.
6. La commande `/handoff` écrit cette décision dans un fichier markdown, prêt à être donné à une session `claude` ou `codex` pour l'implémentation.

Pendant tout le débat, les deux agents sont en lecture seule : ils lisent le code, ils ne le modifient pas.

## Points notables

**Transmission intégrale.** Aucune réponse n'est résumée avant d'être transmise à l'autre agent. Le texte passe verbatim.

**Pas de limite de tours.** Le débat s'enchaîne jusqu'au consensus. La touche `Échap` met en pause à tout moment, y compris pendant qu'un agent écrit.

**Intervention possible à tout moment.** Un message peut être adressé aux deux agents, ou à un seul.

**Qualification du sujet.** Le premier message est évalué avant de devenir le sujet officiel. Une demande hors sujet ou incomplète reçoit une réponse et attend une précision. Rien n'est écrit dans la mémoire du projet tant qu'aucun sujet n'est accepté.

**Mémoire de projet.** Les décisions et les contraintes sont enregistrées dans `.claudex/memory/`, puis relues automatiquement au début de chaque session par Claude via `CLAUDE.md` et par Codex via `AGENTS.md`.

**Sortie terminal classique.** Le débat s'écrit comme une sortie normale. Le défilement, la sélection et le copier-coller restent ceux du terminal, et rien de déjà affiché n'est redessiné.

## Autorisations

Les deux agents ne gèrent pas les autorisations de la même façon.

**Claude Code** demande une autorisation avant d'utiliser un outil. La demande s'affiche dans Claudex et attend une décision.

**Codex** ne demande rien. Son niveau d'accès est fixé au démarrage de chaque tour, en lecture seule pendant le débat. Une action qui sortirait de ce cadre échoue, au lieu d'ouvrir une demande d'autorisation.

Le détail technique est consigné dans `.claudex/memory/limits.md`.

## Ce qui sort de la machine

Section à lire avant d'utiliser Claudex sur un dépôt appartenant à un tiers, ou dans un contexte professionnel.

**Le code est envoyé à deux fournisseurs.** Claudex pilote Claude Code (Anthropic) et Codex (OpenAI). Tout ce que les agents lisent, fichiers, extraits et résultats de recherche, est envoyé aux deux, et chaque réponse de l'un est transmise à l'autre.

**Codex exécute des commandes sans les soumettre à validation.** Pendant le débat, il tourne dans un bac à sable du système d'exploitation qui l'empêche d'écrire dans le dépôt et d'accéder au réseau.

**Lecture seule signifie « ne peut rien modifier », pas « ne voit que le dépôt ».** Dans la version actuelle de Codex, rien ne permet de restreindre ce qu'une commande peut lire. Elle peut ouvrir n'importe quel fichier accessible au compte courant et en recopier le contenu dans le transcript, qui est ensuite envoyé aux deux modèles et écrit sur disque. Sans réseau, une commande ne peut rien exfiltrer par elle-même, mais elle peut recopier. Claudex ne doit donc pas être utilisé pour analyser du code non fiable.

**Les débats sont écrits dans le dépôt.** Claudex crée un dossier `.claudex/` à la racine du répertoire de lancement et y enregistre les transcripts. Au premier lancement, il y installe aussi un `.gitignore` pour que ces transcripts ne partent pas dans un commit. Les décisions et les limites restent versionnables : elles sont courtes, et `CLAUDE.md` comme `AGENTS.md` y renvoient.

## Prérequis

| Requis | Rôle |
|---|---|
| Node.js 22 ou plus récent | Exécute Claudex |
| Abonnement Claude (Pro, Max ou Team) | Fait fonctionner l'agent Claude Code |
| Abonnement ChatGPT (Plus, Pro ou Business) | Fait fonctionner l'agent Codex |
| Un terminal interactif | Claudex refuse de démarrer dans un script ou un pipe |

Les deux abonnements sont nécessaires simultanément : un débat consomme des jetons des deux côtés en même temps. Avec un seul des deux, Claudex démarre mais le débat échoue au premier tour.

### Aucune clé API n'est nécessaire

Claudex ne demande aucune clé API, n'en stocke aucune et n'en lit aucune. Il n'y a pas de fichier `.env` à créer ni de variable d'environnement à définir.

L'authentification se fait une seule fois, dans Claude Code et dans Codex, avec les comptes habituels. Claudex réutilise ensuite ces connexions. La seule information qu'il lit dans la configuration est le modèle par défaut, afin de l'afficher sur son tableau de bord.

Une exception mérite d'être connue : si la variable d'environnement `ANTHROPIC_API_KEY` est définie, Claude Code peut l'utiliser à la place de l'abonnement, ce qui déclenche une facturation à l'usage. Pour rester sur l'abonnement, `echo $ANTHROPIC_API_KEY` ne doit rien afficher.

## Installation

### 1. Node.js

```bash
node --version
```

Si la version affichée est inférieure à `v22`, installer Node.js depuis [nodejs.org](https://nodejs.org) en choisissant la version LTS, puis rouvrir le terminal.

### 2. Claude Code

```bash
npm install -g @anthropic-ai/claude-code
claude
```

Se connecter au premier lancement, puis quitter avec `/quit`. Vérifier ensuite avec `claude --version`.

### 3. Codex

```bash
npm install -g @openai/codex
codex
```

Se connecter au premier lancement, puis quitter. Vérifier ensuite avec `codex --version`.

### 4. Claudex

```bash
git clone https://github.com/hooop/claudex.git
cd claudex
npm install
npm link
```

`npm link` rend la commande `claudex` disponible depuis n'importe quel dossier. Il crée un lien vers ce répertoire, qui ne doit donc pas être déplacé ensuite. Pour retirer la commande : `npm unlink -g claudex`.

### 5. Vérification

```bash
npm run check
```

Cette commande enchaîne le typecheck TypeScript strict, ESLint et 283 tests. Tout doit être au vert.

### Problèmes courants

| Message | Cause et correction |
|---|---|
| `command not found: claudex` | L'étape 4 n'a pas abouti. Relancer `npm link` depuis le dossier `claudex`. |
| `Claudex a besoin d'un vrai terminal interactif (TTY)` | Claudex a été lancé dans un script ou un pipe. Le lancer directement dans un terminal. |
| `command not found: claude` ou `codex` | Reprendre l'étape 2 ou l'étape 3. |
| Le débat échoue dès le premier tour | Un des deux comptes n'est pas connecté. Lancer `claude` puis `codex` séparément pour vérifier. |
| `EACCES` pendant un `npm install -g` | Droits insuffisants sur le dossier npm global. Voir [la documentation npm](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally). |

## Utilisation

```bash
claudex
```

L'écran d'accueil affiche les modèles configurés et l'état de la mémoire du projet, puis attend le sujet à débattre.

Pour démarrer directement sur un sujet :

```bash
claudex "Quelle architecture pour la timeline vidéo ?"
```

### Déroulé d'une session

1. Se placer dans le dossier du projet concerné. Claudex lit ce dossier et y écrit sa mémoire.
2. Lancer `claudex`.
3. Saisir la question, en langage naturel.
4. Laisser le débat s'enchaîner. `Échap` met en pause, un message libre recadre les deux agents.
5. Au consensus, la synthèse s'affiche automatiquement.
6. `/handoff` écrit la décision dans un fichier markdown autonome.
7. `/quit` archive la session et quitte.

Aucune modification n'est apportée au code pendant ce parcours : une session produit une décision et un fichier markdown.

### Commandes

Parler aux agents :

| Commande | Effet |
|---|---|
| texte libre | Message envoyé aux deux agents. Sur l'écran d'accueil, démarre le débat sur ce sujet. |
| `/claude <texte>` | Message adressé à Claude uniquement |
| `/codex <texte>` | Message adressé à Codex uniquement |
| `/model claude\|codex <nom>` | Change le modèle d'un agent, y compris avant le démarrage |

Enregistrer :

| Commande | Effet |
|---|---|
| `/handoff` | Après consensus, écrit un fichier markdown autonome dans `.claudex/memory/handoffs/`, à donner tel quel à une session `claude` ou `codex` pour l'implémentation |
| `/save` | Écrit un instantané de la session en cours, identifié comme partiel, sans la fermer |
| `/decide <sujet> \| <approche>` | Enregistre une décision dans la mémoire du projet |
| `/limit <texte>` | Enregistre une contrainte connue |
| `/decisions` | Affiche les décisions déjà enregistrées |

Contrôler le rythme :

| Commande | Effet |
|---|---|
| `/pause` | Arrête l'enchaînement automatique après le tour en cours |
| `/resume` | Relance un tour en échec, ou ouvre une nouvelle fenêtre d'autonomie |
| `/cancel` | Annule le tour en cours en conservant le texte déjà reçu |
| `/autonomy starts <N>` | Limite le débat à N démarrages automatiques |
| `/autonomy time <durée>` | Limite les démarrages automatiques dans le temps (`ms`, `s`, `m`, `h`) |
| `/autonomy unbounded` | Retire la limite. C'est le comportement par défaut. |
| `--remember` | Ajouté à une commande `/autonomy`, mémorise la politique pour le projet |

Terminer :

| Commande | Effet |
|---|---|
| `/new` | Archive la session, réinitialise les deux agents et revient à l'écran d'accueil |
| `/quit` | Archive la session et quitte |
| `/retry` | Relance l'étape d'arrêt ou d'archivage qui a échoué |
| `/help` | Affiche l'aide dans le fil du débat |

`Ctrl+C` suit le même chemin que `/quit` et n'abandonne jamais une archive sans confirmation explicite. L'aide intégrée `/help` liste l'ensemble des commandes, y compris celles réservées aux cas de dernier recours.

## Architecture

```
src/
  agents/         adaptateurs vers le Claude Agent SDK et Codex app-server
  orchestrator/   machine à états du débat (tours, consensus, interventions)
  memory/         lecture et écriture de .claudex/memory/
  ui/             écran d'accueil, vue de débat, pipeline de rendu du flux
```

## Statut

Fonctionnel : boucle de débat, autorisations d'outil côté Claude, mémoire de projet, écran d'accueil avec tableau de bord, réinitialisation propre du contexte entre deux sujets.

Prévu : affichage de la consommation de jetons en temps réel.
