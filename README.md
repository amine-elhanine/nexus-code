# Nexus

Nexus est un coding agent desktop autonome orienté projet, construit entièrement en TypeScript/JavaScript avec Electron. Il combine **LangChain** pour le modèle et les outils, **LangGraph** pour le workflow déterministe extérieur et **DeepAgents** pour la boucle agentique longue durée, la planification et le contexte projet.

## Fonctionnalités incluses

L’application permet de sélectionner un dépôt local, de visualiser son état de connexion, de dialoguer avec l’agent, de suivre les événements d’outils et de consulter un plan d’exécution visible. Le runtime expose des outils limités au workspace choisi : arborescence, liste, lecture avec lignes, recherche textuelle, création/remplacement, édition par remplacement exact, inspection de `git diff` et commandes de validation.

### Boucle agentique LangGraph

L'agent exécute un graphe déterministe `START → brief → deep_agent → verify → (repair pass) → END` :
- **`brief`** : prépare le contexte de session, résume l'historique conversationnel (jusqu'à 16 tours récents) et annonce le mode actif.
- **`deep_agent`** : pilote le modèle via DeepAgents avec mémoire persistante (projet et session), gestion de liste de tâches (todo-list) et outils de fichiers.
- **`verify`** : exécute automatiquement une commande de vérification statique déduite du projet. En cas d'échec, les erreurs de vérification sont réinjectées dans `deep_agent` pour une passe de réparation ciblée avant de conclure. En mode **Plan**, le nœud de vérification est sauté et le graphe se termine immédiatement.

### Modes d'autonomie

1. **Plan** : Mode lecture seule (les opérations d'écriture, édition, suppression et exécution de commandes sont bloquées au niveau du backend). L'agent inspecte le code et produit un plan d'implémentation détaillé sans modifier le projet. Limite de récursion : 60 étapes.
2. **Ask** : Mode interactif standard. L'agent implémente la modification demandée, exécute la vérification et synthétise son travail. Limite de récursion : 160 étapes.
3. **Auto** : Mode autonome étendu avec budget de récursion élevé (300 étapes). L'agent planifie, implémente, vérifie et répare automatiquement les erreurs détectées.

### Cascade de vérification statique

Le nœud `verify` détecte et sélectionne automatiquement la commande de vérification la plus appropriée pour le projet selon la hiérarchie suivante :
1. `npm run typecheck` si le script `typecheck` existe dans `package.json`.
2. `tsc --noEmit` si un fichier `tsconfig.json` est présent à la racine du projet.
3. `npm run check` si le script `check` existe dans `package.json`.
4. `npm run lint` si le script `lint` existe dans `package.json`.

Les suites de tests lentes ou interactives ne sont pas lancées automatiquement par `verify` pour éviter tout blocage silencieux ; l'agent peut néanmoins lancer des tests ciblés lors de son travail via son outil d'exécution.

### Checkpoints et Rollback 1-Click

- **Snapshot automatique avant chaque run** : Nexus prend un instantané de l'état Git avant chaque exécution de l'agent.
- **Rollback instantané** : En cas de résultat insatisfaisant, une carte d'action dédiée permet de restaurer le projet à son état exact pré-run d'un seul clic (`Undo run`).
- **Reversion par fichier & globale** : L'onglet Diff permet de rejeter individuellement les modifications d'un fichier (`revertFile`) ou de rejeter l'ensemble des fichiers modifiés/non-suivis (`Discard all`).

### Intelligence de Code & Navigation Symbolique

- **`get_symbol_outline`** : Extrait la structure du fichier (classes, méthodes, fonctions, interfaces, types) sans saturer la fenêtre de contexte avec l'intégralité du code source.
- **`find_symbol_definition`** : Recherche instantanément les déclarations d'un symbole dans l'ensemble du projet sans nécessiter d'index externe lourd.
- **Support multilangage** : Analyseur structural pour TypeScript, JavaScript et Python.

### Vérification Ciblée et Tests Unitaires

- **Détection heuristique des tests** : Lors des modifications, `findTargetedTests` identifie automatiquement les fichiers de test associés (`*.test.ts`, `*.spec.ts`, `__tests__`, `pytest`).
- **Boucle de réparation dynamique** : Si des tests ciblés échouent lors du nœud `verify`, les logs d'erreurs sont transmis directement à l'agent pour correction automatique.

### Suivi des Jetons & Coûts d'API

- **Calcul en temps réel** : Suivi des tokens d'entrée et de sortie avec estimation dynamique du coût en dollars affichée dans la barre supérieure et le panneau de contexte.
- **Persistance par session** : Les métriques de consommation sont enregistrées dans l'historique de chaque session de code.

### Autocomplétion Interactive `@` Mention

- **Saisie assistée de fichiers** : En tapant `@` dans le champ de prompt, une liste déroulante filtre en temps réel les fichiers du projet avec navigation au clavier (`Flèches`, `Entrée`, `Tab`, `Échap`).

### Sous-Agents Hiérarchiques (Multi-Agent Delegation)

L'agent principal peut déléguer des sous-tâches isolées à des agents spécialisés via l'outil `delegate_task(role, task)` pour préserver la fenêtre de contexte et garantir une étanchéité stricte :
- **`researcher` (Chercheur)** : Explore l'architecture du code, recherche des symboles et produit une synthèse concise en mode lecture seule (`readOnly: true`).
- **`tester` (Testeur / Débogueur)** : Exécute des tests ciblés, analyse les traces d'appels et fournit un diagnostic d'erreur.
- **`coder` (Développeur)** : Effectue des modifications chirurgicales et ciblées sur un sous-ensemble de fichiers.
- **Cartes d'activité dépliables dans l'UI** : Les exécutions de sous-agents s'affichent sous forme de cartes dédiées avec badge de rôle, étapes d'outils déroulantes et prévisualisation du résultat synthétisé.

### Annulation et sécurité

- **Interruption instantanée** : L'utilisateur peut stopper l'agent à tout moment via le bouton Stop. L'annulation termine l'arbre de processus sous Windows via `taskkill /pid <PID> /T /F` (zéro dépendance externe) et interrompt immédiatement la boucle de streaming.
- **Bac à sable local sans installation** : Chaque commande est analysée argument par argument. Les caractères de chaînage shell (`;`, `&`, `|`, `<`, `>`, `^`, `%`, `!`, backticks, `$`) sont rejetés. Seuls les outils approuvés (`npm`, `pnpm`, `yarn`, `node`, `npx`, `git`, `tsc`, `vite`, `electron`, `eslint`, `prettier`, `python`, `pytest`) sont autorisés. Les scripts `node` directs bénéficient du modèle de permissions intégré (`--permission`).
- **Chiffrement sécurisé des clés** : Les clés d'API sont chiffrées au repos via `safeStorage` (DPAPI sous Windows, Keychain sous macOS, libsecret sous Linux) et déchiffrées uniquement en mémoire.

## Installation

Dans PowerShell, si l’exécution des scripts `.ps1` est bloquée, utilisez les binaires `.cmd` :

```powershell
cd C:\Users\melha_eay78bj\Desktop\code
npm.cmd install
```

Configurez ensuite une clé OpenAI ou OpenAI-compatible depuis **Settings**. Les variables d’environnement suivantes sont également supportées :

| Variable | Rôle | Valeur par défaut |
| --- | --- | --- |
| `OPENAI_API_KEY` | Clé du fournisseur | Aucune |
| `OPENAI_BASE_URL` | Endpoint compatible OpenAI | Endpoint OpenAI standard |
| `OPENAI_MODEL` | Modèle utilisé par l’agent | `gpt-4.1-mini` |

## Lancement

Pour lancer le shell desktop avec Vite :

```powershell
npm.cmd run dev
```

Pour produire un bundle vérifié :

```powershell
npm.cmd run check
npm.cmd run build
npm.cmd start
```

Pour lancer la suite de tests automatisée :

```powershell
npm.cmd test
```

## Architecture

- `electron/main.ts` : gestion du cycle de vie Electron, fenêtres, sessions, et IPC (`agent:run`, `agent:cancel`).
- `electron/agent-service.ts` : orchestration LangGraph (`brief → deep_agent → verify`), gestion des modes, sélection de vérification, et streaming.
- `electron/sandbox-service.ts` : politique de sécurité locale, exécution restreinte, annulation de processus (`taskkill`) et backend read-only.
- `electron/diff-service.ts` : calcul et formatage des diffs Git par fichier.
- `electron/project-tools.ts` : inspection et gardes de sécurité du système de fichiers du workspace.
- `electron/providers.ts` : adaptateurs pour les différents fournisseurs LLM (OpenAI, Anthropic, Google Gemini, Ollama, etc.).
- `electron/store.ts` : persistance sécurisée des projets, sessions, mémoires et clés chiffrées (`safeStorage`).
- `src/App.tsx` : interface utilisateur React avec sélection de modes, checklists interactives, diff split et terminal.
- `src/styles.css` : design tokens sombres.

## Références techniques

La conception suit les primitives JavaScript officielles de LangChain, LangGraph et DeepAgents : [LangChain JS](https://docs.langchain.com/oss/javascript/langchain/overview), [LangGraph JS](https://docs.langchain.com/oss/javascript/langgraph/quickstart) et [DeepAgents JS](https://docs.langchain.com/oss/javascript/deepagents/overview).
