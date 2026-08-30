# DeepAgents JS sandbox findings

DeepAgents JavaScript treats sandboxes as backends. A sandbox backend exposes the standard filesystem tools (`ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`) plus an `execute` tool for shell commands inside the isolated environment. The isolation boundary protects the host from files, credentials and arbitrary commands.

The official docs show `LangSmithSandbox` with `SandboxClient` and mention LangSmith, AgentCore, Daytona and other providers. Sandboxes can be thread-scoped or assistant-scoped; a project-focused coding app should use an assistant/project-scoped sandbox and map sessions to isolated worktrees or directories inside it. Sandboxes need an explicit lifecycle and cleanup/TTL.

`FilesystemBackend` is not a process sandbox: it scopes file operations to a root directory, while `LocalShellBackend` explicitly runs unrestricted shell commands on the host and must not be presented as isolated. For production safety, the agent should use a real sandbox backend, not the current direct `execFile` path.

Sources:

- https://docs.langchain.com/oss/javascript/deepagents/sandboxes
- https://docs.langchain.com/oss/javascript/deepagents/backends
- https://www.langchain.com/blog/execute-code-with-sandboxes-for-deepagents
