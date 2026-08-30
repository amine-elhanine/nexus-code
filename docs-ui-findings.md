# UI patterns retenus pour ForgePilot

La refonte doit être un espace de travail par session, et non un dashboard. Les patterns observés dans les produits de coding agents modernes sont les suivants :

| Pattern | Décision ForgePilot |
|---|---|
| Sessions indépendantes par projet | Sidebar dédiée aux sessions avec titre, statut et nombre de changements |
| Chat de tâche au centre | Transcript principal avec messages, étapes d’outils, plan et approbations visibles |
| Revue de changements | Panneau diff fichier par fichier avec statistiques +/−, boutons accepter/refuser |
| Éditeur de fichiers | Onglets de fichiers et contenu visible dans un panneau code |
| Terminal intégré | Panneau inférieur escamotable avec sortie de commandes et bouton run |
| Modes d’autonomie | Sélecteur Plan / Ask / Auto, explicite près du prompt |
| Contexte local | Projet, branche, modèle et environnement visibles dans la barre supérieure |
| Multi-agent | Sessions pouvant être parallèles, avec activité et sous-agents dans le fil |

Sources consultées :

- OpenAI, “Introducing the Codex app”: https://openai.com/index/introducing-the-codex-app/
- Anthropic, “Desktop application”: https://code.claude.com/docs/en/desktop
- OpenCode repository and README: https://github.com/opencode-ai/opencode
