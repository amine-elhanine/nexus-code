# Contributing to Nexus

Thank you for contributing to Nexus! This document outlines development practices, commit guidelines, and verification procedures.

## Development Workflow

1. Create a focused branch for your work: `git checkout -b <type>/<description>`.
2. Follow strict TypeScript type safety: avoid `any`, explicit assertions where possible, and run `npm run check`.
3. Adhere to code conventions configured in `.editorconfig` (2 spaces indentation, LF endings, UTF-8).

## Testing and Verification

Before opening a pull request or merging changes, ensure the entire verification matrix passes:

```bash
# Typecheck
npm run check

# Unit tests
npm run test:unit

# Renderer unit tests
npm run test:renderer

# Notebook pipeline and vector tests
npm run test:notebook

# Permissions and security checks
npm run test:permissions
```

## Commit Message Conventions

Commit messages should adhere to conventional commit specifications:
- `feat(...)`: New user-facing capabilities or features
- `fix(...)`: Bug fixes and regression repairs
- `docs(...)`: Documentation and guide updates
- `refactor(...)`: Code changes that neither fix bugs nor add features
- `test(...)`: Adding or updating test suites
- `chore(...)`: Maintenance, dependency management, or build configuration

Use descriptive commit subjects and include rationale in commit bodies where applicable.
