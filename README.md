# Nexus

Nexus est un coding agent desktop autonome orienté projet, construit entièrement en TypeScript/JavaScript avec Electron. Il combine **LangChain** pour le modèle et les outils, **LangGraph** pour le workflow déterministe extérieur et **DeepAgents** pour la boucle agentique longue durée, la planification et le contexte projet.

## Fonctionnalités principales

L’application permet d'ouvrir n'importe quel dépôt local, de dialoguer avec l'agent, de suivre en direct l'exécution des outils, de planifier et d'exécuter des modifications avec vérification automatisée et réparation des erreurs.

### 1. Boucle agentique LangGraph avec passe de réparation

L'agent exécute un graphe déterministe `START → brief → deep_agent → verify → (repair pass) → END` :
- **`brief`** : prépare le contexte de session, résume l'historique conversationnel (jusqu'à 16 tours récents) et annonce le mode actif.
- **`deep_agent`** : pilote le modèle via DeepAgents avec mémoire persistante (projet et session), gestion de liste de tâches (todo-list), outils de fichiers et délégation de sous-agents.
- **`verify`** : exécute automatiquement la commande de vérification statique appropriée (`npm run typecheck` > `tsc --noEmit` > `npm run check` > `npm run lint` > `cargo check` > `go vet` > `ruff check`) ainsi que les tests ciblés (`findTargetedTests`). En cas d'échec, les erreurs de vérification sont réinjectées dans `deep_agent` en conservant l'intégralité du transcript pour une passe de réparation ciblée.
- En mode **Plan**, le nœud de vérification est sauté et le graphe se termine immédiatement.

### 2. Modes d'autonomie

1. **Plan** : Mode lecture seule strict (les opérations d'écriture, édition, suppression et commandes système sont bloquées au niveau du backend). L'agent inspecte le code et génère un plan d'implémentation détaillé sans modifier le projet. Limite de récursion : 60 étapes.
2. **Ask** : Mode interactif standard. L'agent implémente la modification demandée, exécute la vérification et synthétise son travail. Limite de récursion : 160 étapes.
3. **Auto** : Mode autonome étendu avec budget de récursion élevé (300 étapes). L'agent planifie, implémente, vérifie et répare automatiquement les erreurs détectées.

### 3. Isolation Git Worktree (Opt-in)

- **Branches & Worktrees isolés** : Les sessions peuvent exécuter leur code dans un `git worktree` dédié (`.nexus/worktrees/<session-id>`) sur une branche isolée, préservant la branche de travail principale de toute modification intermédiaire non validée.
- **Fusion et abandon 1-Click** : L'utilisateur peut inspecter le diff isolé, fusionner les modifications dans la branche principale (`Merge to Main`) ou abandonner le worktree sans risque (`Discard`).

### 4. Checkpoints et Rollback instantané

- **Snapshot automatique avant chaque run** : Nexus prend un instantané de l'état Git avant chaque exécution de l'agent.
- **Rollback instantané** : En cas de résultat insatisfaisant, une carte d'action dédiée permet de restaurer le projet à son état exact pré-run d'un seul clic (`Undo run`).
- **Reversion par fichier & globale** : L'onglet Diff permet de rejeter individuellement les modifications d'un fichier (`revertFile`) ou de rejeter l'ensemble des fichiers modifiés/non-suivis (`Discard all`).

### 5. Politique de commandes locale & Sécurité

La sécurité repose sur une politique locale stricte sans nécessiter de conteneur externe :
- **Environnement minimal épuré** : Les processus enfant sont exécutés avec un environnement système nettoyé, sans propagation de secrets ou de `NODE_OPTIONS`.
- **Validation argument par argument** : Les caractères de chaînage shell (`;`, `&`, `|`, `<`, `>`, `^`, `%`, `!`, backticks, `$`) et les tokens contenant des guillemets imbriqués sont systématiquement rejetés.
- **Outils dev approuvés uniquement** : Seuls les binaires autorisés (`npm`, `pnpm`, `yarn`, `node`, `npx`, `git`, `tsc`, `vite`, `eslint`, `prettier`, `biome`, `cargo`, `go`, `ruff`, `mypy`, `uv`, `poetry`) peuvent être exécutés. Python est strictement restreint aux lanceurs de tests (`pytest`, `python -m pytest`).
- **Modèle de permission Node** : Les scripts `node` directs bénéficient du modèle de permissions intégré (`--permission`) restreint au dossier du projet.
- **Validation manuelle par défaut (`requireApproval: true`)** : Les opérations destructrices ou sensibles (`git clean`, `git branch -D`, `git stash drop`, `git worktree remove`, `git remote`, `git config`, `npx`) requièrent l'approbation explicite de l'utilisateur.
- **Réseau restreint par défaut (`allowNetwork: false`)** : L'installation de paquets externes et l'accès au réseau public via les outils de navigation sont bloqués par défaut (accès autorisé uniquement sur `localhost` / `127.0.0.1` et sous-réseaux privés RFC1918).
- **Chiffrement sécurisé des clés** : Les clés d'API sont chiffrées au repos via `safeStorage` (DPAPI sous Windows, Keychain sous macOS, libsecret sous Linux) et déchiffrées uniquement en mémoire.

### 6. Services & Processus d'arrière-plan (Daemons)

- **Gestionnaire de daemons intégré** : Démarrez, surveillez et arrêtez des serveurs de développement locaux (ex. Vite, Next.js, API servers) directement depuis l'interface.
- **Détection automatique des ports** : Détection en temps réel des ports d'écoute (ex. `localhost:5173`, `port 3000`) avec ouverture directe dans le navigateur intégré.
- **Nettoyage automatique** : Tous les daemons et shells interactifs sont arrêtés proprement à la fermeture de l'application (`before-quit`).

### 7. Navigateur & Outils Web intégrés

- **Partition isolée `persist:browser`** : Le composant `<webview>` est isolé dans sa propre partition de session afin de ne pas altérer les en-têtes ni les cookies de l'application hôte.
- **Capture et inspection visuelle** : Outils de capture d'écran, extraction de texte et inspection DOM accessibles par l'agent.

### 8. Intégrations MCP & Compétences (Skills)

- **Model Context Protocol (MCP)** : Connexion transparente à des serveurs MCP locaux (`stdio`) ou distants (`http`, `sse`).
- **Middleware de compétences (Skills)** : Importation et création de fichiers `SKILL.md` (globaux ou scopés au projet) avec confinement strict des chemins de fichiers.

### 9. Diff Monaco Side-by-Side avec comparaison HEAD

- **Diff visuel complet** : Comparaison côte-à-côte ou en ligne propulsée par Monaco Editor, exploitant directement `git show HEAD:<path>` pour comparer les modifications par rapport à l'état originel.

---

## Installation

Dans PowerShell sous Windows, si l’exécution des scripts `.ps1` est restreinte, utilisez les binaires `.cmd` :

```powershell
npm.cmd install
```

Configurez ensuite vos fournisseurs de modèles (OpenAI, Anthropic, Google Gemini, Ollama, DeepSeek, Azure OpenAI, etc.) depuis l'interface **Providers**.

Les variables d’environnement suivantes sont également supportées en fallback :

| Variable | Rôle | Valeur par défaut |
| --- | --- | --- |
| `OPENAI_API_KEY` | Clé OpenAI | Aucune |
| `OPENAI_BASE_URL` | Endpoint compatible OpenAI | Endpoint OpenAI standard |
| `OPENAI_MODEL` | Modèle par défaut | `gpt-4.1-mini` |

---

## Commandes utiles

- **Vérification TypeScript** :
  ```powershell
  npm.cmd run check
  ```
- **Suite de tests automatisée** :
  ```powershell
  npm.cmd test
  ```
- **Lancement en mode développement** :
  ```powershell
  npm.cmd run dev
  ```
- **Construction du bundle de production** :
  ```powershell
  npm.cmd run build
  npm.cmd start
  ```

---

## Structure du projet

- `electron/` : Backend Electron et services système.
  - `main.ts` : Cycle de vie Electron, handlers IPC, isolation réseau et protocoles personnalisés (`nexus-attachment://`).
  - `agent-service.ts` : Orchestration LangGraph, sélection des vérifications et boucle de réparation.
  - `sandbox-service.ts` : Politique de bac à sable local, exécution sécurisée et terminaison d'arbres de processus.
  - `subagent-service.ts` : Délégation hiérarchique de sous-agents et calcul des coûts par modèle.
  - `daemon-service.ts` : Gestionnaire de processus d'arrière-plan et détection de ports.
  - `terminal-service.ts` : Shells interactifs en streaming et redimensionnement PTY.
  - `diff-service.ts` : Checkpoints, instantanés de workspace et calcul des diffs.
  - `worktree-service.ts` : Cycle de vie des worktrees Git isolés par session.
  - `providers.ts` : Adaptateurs multi-fournisseurs (OpenAI, Anthropic, Gemini, Azure, Ollama, etc.).
  - `store.ts` : Stockage persistant chiffré via `safeStorage`.
- `src/` : Frontend React modulaire.
  - `types.ts` : Définitions et interfaces TypeScript partagées.
  - `state/useAppController.ts` : Hook de contrôle global, gestion des états et appels IPC.
  - `views/` : Vues principales (`AgentView`, `DiffView`, `MemoryView`).
  - `modals/` : Modales de configuration (`ProviderModal`, `SandboxModal`, `SkillsModal`, `McpModal`, `ProjectPickerModal`, `ConfirmModal`).
  - `components/` : Composants spécialisés (`chat/`, `diff/`, `editor/`, `terminal/`, `browser/`, `daemons/`, `worktree/`, `rules/`, `artifacts/`).

---

## Références techniques

La conception suit les primitives JavaScript officielles :
- [LangChain JS](https://docs.langchain.com/oss/javascript/langchain/overview)
- [LangGraph JS](https://docs.langchain.com/oss/javascript/langgraph/quickstart)
- [DeepAgents JS](https://docs.langchain.com/oss/javascript/deepagents/overview)
