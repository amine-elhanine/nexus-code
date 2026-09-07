# Nexus

Nexus est un coding agent desktop autonome orienté projet, construit entièrement en TypeScript/JavaScript avec Electron. Il combine **LangChain** pour le modèle et les outils, **LangGraph** pour le workflow déterministe extérieur et **DeepAgents** pour la boucle agentique longue durée, la planification et le contexte projet.

## Fonctionnalités principales

L'application permet d'ouvrir n'importe quel dépôt local, de dialoguer avec l'agent, de suivre en direct l'exécution des outils, de planifier et d'exécuter des modifications avec vérification automatisée et réparation des erreurs.

### 1. Boucle agentique LangGraph avec passe de réparation

L'agent exécute un graphe déterministe `START → brief → deep_agent → verify → (repair pass) → END` :
- **`brief`** : prépare le contexte de session, résume l'historique conversationnel (jusqu'à 16 tours récents) et annonce le mode actif.
- **`deep_agent`** : pilote le modèle via DeepAgents avec mémoire persistante (projet et session), gestion de liste de tâches (todo-list), outils de fichiers et délégation de sous-agents.
- **`verify`** : exécute automatiquement la commande de vérification statique appropriée (`npm run typecheck` > `npm run check` > `tsc --noEmit` > `npm run lint` > `cargo check` > `go vet` > `ruff check`) ainsi que les tests ciblés (`findTargetedTests`). En cas d'échec, les erreurs de vérification sont réinjectées dans `deep_agent` en conservant l'intégralité du transcript pour une passe de réparation ciblée.
- En mode **Plan**, le nœud de vérification est sauté et le graphe se termine immédiatement.
- **Reprise après interruption** : les erreurs transitoires du fournisseur (429, connexions coupées) déclenchent un retry borné avec backoff exponentiel qui honore l'en-tête `Retry-After` lorsque le fournisseur l'envoie ; le run reprend depuis le dernier superstep complet au lieu de recommencer.

### 2. Modes d'autonomie

1. **Plan** : Mode lecture seule strict (les opérations d'écriture, édition, suppression et commandes système sont bloquées au niveau du backend). L'agent inspecte le code et génère un plan d'implémentation détaillé sans modifier le projet. Limite de récursion : 60 étapes.
2. **Ask** : Mode interactif standard. L'agent implémente la modification demandée, exécute la vérification et synthétise son travail. Limite de récursion : 160 étapes.
3. **Auto** : Mode autonome étendu avec budget de récursion élevé (300 étapes). L'agent planifie, implémente, vérifie et répare automatiquement les erreurs détectées.

### 3. Isolation Git Worktree (Opt-in)

- **Branches & Worktrees isolés** : Les sessions peuvent exécuter leur code dans un `git worktree` dédié (`.nexus/worktrees/<session-id>`) sur une branche isolée, préservant la branche de travail principale de toute modification intermédiaire non validée.
- **Fusion et abandon 1-Click** : L'utilisateur peut inspecter le diff isolé, fusionner les modifications dans la branche principale (`Merge to Main`) ou abandonner le worktree sans risque (`Discard`).

### 4. Checkpoints et Rollback instantané

- **Snapshot persistant avant chaque run** : Nexus prend un instantané de l'état Git avant chaque exécution de l'agent, écrit sur disque (`.nexus/checkpoints/`) — il survit donc au redémarrage de l'application.
- **Rollback instantané** : En cas de résultat insatisfaisant, une carte d'action dédiée permet de restaurer le projet à son état exact pré-run d'un seul clic (`Undo run`). Un checkpoint inconnu ou expiré déclenche une erreur explicite plutôt qu'un échec silencieux.
- **Reversion par fichier & globale** : L'onglet Diff permet de rejeter individuellement les modifications d'un fichier (`revertFile`) ou de rejeter l'ensemble des fichiers modifiés/non-suivis (`Discard all`).

### 5. Exécution directe des commandes

Le sandbox local (validation d'arguments, allowlist d'outils, approbations) a été retiré de l'application. Les commandes exécutées par l'agent, les scripts `npm run`, les services d'arrière-plan et les outils MCP tournent **directement sur votre machine avec vos privilèges utilisateur** :

- **Pas de filtrage de commandes** : l'agent peut exécuter n'importe quelle commande shell, avec chaînage, pipes et redirections.
- **Pas de restriction réseau** : l'agent peut installer des paquets et accéder au réseau public.
- **Annulation et nettoyage** : le bouton Stop tue l'arbre de processus complet de la commande en cours ; les daemons et terminaux sont arrêtés proprement à la fermeture (`before-quit`).
- **Environnement des daemons épuré** : les serveurs de dev ne reçoivent pas les secrets de l'environnement hôte (seules les variables structurelles comme `PATH` sont transmises).
- **Chiffrement des clés** : Les clés d'API restent chiffrées au repos via `safeStorage` (DPAPI sous Windows, Keychain sous macOS, libsecret sous Linux) et déchiffrées uniquement en mémoire.

Si vous avez besoin d'isolation, exécutez Nexus dans une VM ou un conteneur dédié — l'application elle-même n'offre plus de barrière de sécurité.

### 6. Services & Processus d'arrière-plan (Daemons)

- **Gestionnaire de daemons intégré** : Démarrez, surveillez et arrêtez des serveurs de développement locaux (ex. Vite, Next.js, API servers) directement depuis l'interface.
- **Détection automatique des ports** : Détection en temps réel des ports d'écoute (ex. `localhost:5173`, `port 3000`) avec ouverture directe dans le navigateur intégré.

### 7. Navigateur & Outils Web intégrés

- **Partition isolée `persist:browser`** : Le composant `<webview>` est isolé dans sa propre partition de session afin de ne pas altérer les cookies de l'application hôte.
- **Inspection sans redirections surprises** : les outils `browser_inspect` / `browser_fetch_api` suivent les redirections manuellement (chaque saut re-validé, plafonné) pour éviter les contournements via 302.
- **Vrai historique de navigation** : Back/Forward/reload pilotent le webview en place (`goBack`/`goForward`/`reload`) au lieu de le remonter, préservant l'état des pages.
- **Fenêtre agent pilotable (`browser_act`)** : l'agent agit directement dans le navigateur intégré via une webview cachée (même session `persist:browser` que l'onglet Browser) — pas de fenêtre séparée. Snapshot d'éléments (`e3`, `e7`…), click, fill (compatible React), touches clavier, scroll, navigation et screenshots (`.nexus/browser/`, `http(s)` uniquement). Bascule **Headless/Watching** : en arrière-plan invisible, ou l'onglet Browser suit l'agent en direct (bannière "Follow" sinon).

### 8. Intégrations MCP & Compétences (Skills)

- **Model Context Protocol (MCP)** : Connexion transparente à des serveurs MCP locaux (`stdio`) ou distants (`http`, `sse`). Ces serveurs s'exécutent avec vos privilèges.
- **Middleware de compétences (Skills)** : Importation et création de fichiers `SKILL.md` (globaux ou scopés au projet) avec confinement strict des chemins de fichiers.

### 9. Diff Monaco Side-by-Side avec comparaison HEAD

- **Diff visuel complet** : Comparaison côte à côte ou en ligne propulsée par Monaco Editor, exploitant directement `git show HEAD:<path>` pour comparer les modifications par rapport à l'état originel.

---

## Installation

Dans PowerShell sous Windows, si l'exécution des scripts `.ps1` est restreinte, utilisez les binaires `.cmd` :

```powershell
npm.cmd install
```

Configurez ensuite vos fournisseurs de modèles (OpenAI, Anthropic, Google Gemini, Ollama, DeepSeek, Azure OpenAI, etc.) depuis l'interface **Providers**.

Les variables d'environnement suivantes sont également supportées en fallback :

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

## Publier une mise à jour (auto-update)

L'application vérifie les nouvelles versions au lancement (builds installés uniquement) via `electron-updater` et le flux GitHub Releases du dépôt public `L7A9/nexus` (voir `build.publish` dans `package.json` — le code, lui, reste dans le dépôt privé). Rien ne s'affiche tant qu'aucune release plus récente n'existe ; sinon, un badge apparaît dans la barre du haut, le téléchargement est automatique, et l'utilisateur clique pour redémarrer et installer. La page Réglages → Updates permet aussi de vérifier manuellement.

Pour publier (les releases doivent être **publiques** — un dépôt privé exigerait un token côté utilisateur) :

```powershell
# 1. Monter la version dans package.json (ex. 0.2.0)
# 2. Construire + publier la release GitHub (latest.yml inclus) :
$env:GH_TOKEN = "github_pat_..."
npm.cmd run dist -- --publish always
```

Notes :

- Seule la version installée (Setup NSIS) se met à jour seule ; la version Portable se retélécharge manuellement.
- En développement (`npm start`, non packagé), la vérification rapporte simplement la version locale — tester le flux réel avec `NEXUS_UPDATE_DEV=1` et un fichier `dev-app-update.yml`.

---

## Structure du projet

- `electron/` : Backend Electron et services système.
  - `main.ts` : Cycle de vie Electron, handlers IPC, isolation réseau et protocoles personnalisés (`nexus-attachment://`). Les événements agent sont étiquetés par session et les transcriptions complètes sont persistées.
  - `agent-service.ts` : Orchestration LangGraph, sélection des vérifications et boucle de réparation. Le compteur d'usage additionne les invocations successives du modèle au lieu de garder la dernière.
  - `command-service.ts` : Exécution directe des commandes (sans politique), annulation d'arbre de processus et backend lecture-seule pour le mode Plan.
  - `subagent-service.ts` : Délégation hiérarchique de sous-agents ; les coûts affichés sont nuls ("—") pour les modèles sans tarif connu.
  - `daemon-service.ts` : Gestionnaire de processus d'arrière-plan et détection de ports, avec environnement épuré.
  - `terminal-service.ts` : Shells interactifs en streaming — vrai PTY via un processus hôte externe (`pty-host.cjs` + `node-pty`), repli automatique sur des pipes si l'hôte est indisponible.
  - `pty-host.cjs` : Hôte PTY out-of-process (protocole JSON sur stdio) exécuté sous le Node système, car un module natif ne peut pas se charger dans le processus principal Electron.
  - `diff-service.ts` : Checkpoints persistés sur disque, instantanés de workspace et calcul des diffs (un seul passage `git diff`).
  - `worktree-service.ts` : Cycle de vie des worktrees Git isolés par session.
  - `providers.ts` : Adaptateurs multi-fournisseurs (OpenAI, Anthropic, Gemini, Azure, Ollama, etc.).
  - `store.ts` : Stockage persistant chiffré via `safeStorage`.
  - `rate-limit.ts` : Retry borné avec backoff exponentiel, honnêteté des compteurs et `Retry-After`.
- `src/` : Frontend React modulaire.
  - `types.ts` : Définitions et interfaces TypeScript partagées.
  - `state/useAppController.ts` : Hook de contrôle global, gestion des états et appels IPC (routage des événements par session).
  - `views/` : Vues principales (`AgentView`, `DiffView`, `MemoryView`).
  - `modals/` : Modales de configuration (`ProviderModal`, `SkillsModal`, `McpModal`, `ProjectPickerModal`, `ConfirmModal`).
  - `components/` : Composants spécialisés (`chat/`, `diff/`, `editor/`, `terminal/`, `browser/`, `daemons/`, `worktree/`, `rules/`, `artifacts/`).

---

## Références techniques

La conception suit les primitives JavaScript officielles :
- [LangChain JS](https://docs.langchain.com/oss/javascript/langchain/overview)
- [LangGraph JS](https://docs.langchain.com/oss/javascript/langgraph/quickstart)
- [DeepAgents JS](https://docs.langchain.com/oss/javascript/deepagents/overview)
