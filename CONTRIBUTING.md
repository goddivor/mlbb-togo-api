# Contributing

## Branches

- **`main`** — protected, stable. Direct pushes are disabled; it only ever changes through a reviewed pull request. **Only the maintainer merges `dev` into `main`.**
- **`dev`** — default integration branch. **All work and all pull requests target `dev`, never `main`.**

Create a branch off `dev` for every change:

```
git switch dev
git switch -c <type>/<short-kebab-description>
```

### Branch naming

`<type>/<short-kebab-description>` — e.g. `feat/language-switcher`, `fix/rank-badge-crop`, `chore/bump-next`.

Allowed types: `feat`, `fix`, `refactor`, `chore`, `docs`, `style`, `test`, `perf`.

## Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>
```

- Imperative mood, in English: `add`, `fix`, `update` (not `added`, `fixing`).
- Keep the description short and lower-case; no trailing period.
- Examples:
  - `feat(i18n): add language switcher to the dashboard`
  - `fix(auth): handle expired verification code`
  - `refactor(heroes): extract hero card component`

Do not commit secrets (`.env*`, keys, tokens).

## Pull requests

- **Base branch: `dev`.** PRs opened against `main` will be redirected or closed.
- Title in Conventional Commits style.
- Describe what changes and why; keep PRs focused.
- The maintainer reviews, merges into `dev`, and later promotes `dev` to `main` via a release PR.
