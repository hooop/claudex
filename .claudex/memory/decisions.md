# Décisions

Journal des décisions validées à l'issue d'un débat Claude ↔ Codex.

## 2026-08-04 — Architecture C (file de livraisons)

**Approche retenue :** Architecture C, validée par les deux agents.

**Éléments actés :**
- File de livraisons par destinataire
- Snapshots immuables construits par le drain
- Batches d'intervention avec barrière
- Consensus causal uniquement
- Synthèse read-only invalidable par epoch
- Acquittement par job sur tous les chemins
- Ordonnanceur complet et fermé sur tous ses états

**Statut à la consignation :** aucun fichier modifié, implémentation non démarrée — décision récupérée manuellement suite à un bug de détection de consensus (marqueur non reconnu à cause d'un formatage markdown), qui a empêché la synthèse automatique de se générer. Le détail complet du raisonnement du débat n'a pas pu être archivé automatiquement (commande `/save` absente de cette version de session) ; seule cette décision finale, capturée depuis l'écran, a pu être préservée.

## 2026-08-06 — Commande /handoff pour génération de fichier d'implémentation

**Approche retenue :** Ajouter une commande `/handoff`, coexistant avec `/implement`, qui génère un fichier markdown autoportant (contexte projet + synthèse consensuelle) destiné à être transmis tel quel à une session `claude` ou `codex` native pour implémentation. `/handoff` devient le chemin recommandé par défaut ; `/implement` reste disponible pour rester dans Claudex sur des changements ponctuels.

**Accords :**
- Fonction `saveHandoff(cwd, topic, summary)` dans `store.ts` — sémantique « nouveau fichier » (comme `saveTranscript()`), pas « journal » (comme `appendDecision()`)
- Garde explicite sur `session.implementationSummary?.trim()` avant d'autoriser `/handoff` (garde qui n'existe pas aujourd'hui sur `/implement`)
- Nouvelle API publique `recordHandoffGenerated(path)` sur `Scheduler` (appelle `addEntry()` privé), déléguée par `DebateSession` pour l'UI
- Structure du fichier généré : intro + `## Mémoire projet` (`readMemorySummary()` verbatim) + `## Spécification consensuelle` (`implementationSummary`) + `## Consigne d'exécution`
- Gestion de collision de timestamp par suffixe numérique (`-2`, `-3`, …), création exclusive avec réessai uniquement sur `EEXIST`
- `SYNTHESIS_PROMPT` étendu de façon conditionnelle (fichiers/composants, interfaces, comportements, tests — uniquement s'ils ressortent du débat, sans rubrique vide inventée)
- UX mise à jour pour recommander `/handoff` : bannière post-consensus, placeholder de saisie, `HelpPanel`, `README.md`
- Aucune modification de `/implement`, de la mécanique de débat (Architecture C) ni des critères de consensus

**Fichiers concernés :**
- `src/orchestrator/commands.ts`
- `src/memory/store.ts`
- `src/orchestrator/scheduler.ts`
- `src/orchestrator/session.ts`
- `src/ui/DebateView.tsx`
- `README.md`
- `src/orchestrator/__tests__/commands.test.ts` (nouveau)
- `src/memory/__tests__/store.test.ts` (nouveau)

## 2026-08-11 — L'autonomie est illimitée par défaut ; le consensus survit à une intervention

**Nature :** arbitrage humain direct, hors débat Claude ↔ Codex. Tranche une question que le
handoff du 2026-08-10 laissait explicitement ouverte (« Budget d'autonomie : métrique ; valeur ;
politique de persistance ou question interactive »), et remplace le comportement fail-closed qui
avait été implémenté en attendant.

**Contexte :** les deux comportements se combinaient en piège fermé. Aucune politique d'autonomie
n'étant configurée, aucun tour automatique ne pouvait démarrer ; seules les interventions humaines
faisaient avancer le débat ; et les tours nés d'une intervention étaient exclus du consensus. Les
deux agents pouvaient être d'accord sans que la session puisse jamais se clore.

**Décisions :**
- **Absence de politique d'autonomie = illimité.** Le risque qu'un budget obligatoire borne est
  l'emballement non supervisé. Claudex n'a aucun mode non supervisé : `src/cli.tsx` refuse de
  démarrer sans TTY, et Échap met en pause au clavier même pendant un tour. La supervision est
  structurelle, pas budgétaire. Ce n'est donc pas une valeur par défaut arbitraire : c'est le
  constat qu'aucune borne n'est nécessaire dans le seul mode qui existe.
- `/autonomy starts N` et `/autonomy time <durée>` restent, comme bornes **optionnelles**, pour
  qui prévoit de s'éloigner du terminal. `unbounded` redevient un retrait de borne.
- L'état de suspension `autonomy-required` est supprimé : il n'est plus atteignable.
- **Le consensus dépend de l'epoch seule, plus de l'origine du tour.** Un tour qui répond à la
  dernière intervention porte l'epoch que cette intervention a créée ; deux agents qui s'accordent
  juste après une question humaine s'accordent réellement. Toute entrée plus récente les invalide
  déjà via `incrementEpoch()`.
- Au consensus, les livraisons automatiques encore en attente sont abandonnées : sinon un `/resume`
  après la synthèse rejouerait un tour mis en file avant l'accord et rouvrirait un débat clos. Seule
  une vraie intervention doit le rouvrir, par une nouvelle epoch.

**Fichiers concernés :** `src/orchestrator/scheduler.ts`, `src/types.ts`, `src/orchestrator/types.ts`,
`src/ui/DebateView.tsx`, `src/ui/components/StatusBar.tsx`, `src/__tests__/scheduler.test.ts`,
`src/ui/__tests__/root.test.tsx`, `README.md`.

**Attention pour les tests :** des agents factices qui répondent toujours `<<CONTINUE>>` ne sont
plus freinés par rien. Un fixture qui a besoin d'un débat fini doit poser sa propre borne
(`root.test.tsx` le fait), pas compter sur un blocage global.
