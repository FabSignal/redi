# Redi

## Doc for developers

Production-oriented monorepo with a modular, scalable architecture. It contains multiple Next.js applications, backend services, Soroban smart contracts, and shared packages used across the ecosystem.

## Tech Stack

- Node.js (ESM)
- pnpm (workspaces)
- Turborepo (task orchestration and caching)
- TypeScript
- Next.js (App Router)
- React (via Next.js)
- Tailwind CSS
- Husky + lint-staged (Git hooks)
- Supabase (Database/Auth)
- Stellar + Soroban (smart contracts and clients)
- Observability package scaffold (future OpenTelemetry integration)

## Requirements

- Node.js LTS (recommended: 20.x)
- pnpm (recommended: latest stable)
- Git

Verify:

```bash
node -v
pnpm -v
git --version
```

## Repository Structure

- `apps/` - Next.js applications
  - `landing/`, `b2c/`, `merchant/`, `pos/`

- `services/` - backend processes
  - `indexer/`, `workers/`

- `packages/` - shared libraries
  - `shared/`, `ui/`, `api-client/`, `stellar-soroban/`, `crossmint/`, `defindex/`, `observability/`, `config/`

- `contracts/` - smart contracts
  - `soroban/` (buffer/bridge/perks)

- `infra/` - infrastructure (e.g., Supabase migrations, scripts)
- `docs/` - architecture notes and runbooks

## Installation

1. Clone and enter the repository:

```bash
git clone <repo-url>
cd redi
```

2. Install dependencies:

```bash
pnpm install
```

3. Configure environment variables

### Root environment (backend/infra)

Copy the template and fill in required values:

```bash
cp .env.example .env
```

### App environments (frontend)

Each Next app uses its own local env file:

- Copy `apps/<app>/.env.local.example` to `apps/<app>/.env.local`
- Fill in public variables as needed (`NEXT_PUBLIC_*`)

Example:

```bash
cp apps/b2c/.env.local.example apps/b2c/.env.local
```

Security notes:

- Do not commit `.env` or `.env.local` files.
- Never place secrets (e.g., Supabase Service Role key) in `NEXT_PUBLIC_*` variables.

## Local Ports

Next.js apps:

- `landing`: 3000
- `b2c`: 3001
- `merchant`: 3002
- `pos`: 3003

Backend services (reference; adjust to implementation):

- `indexer`: 4101
- `workers`: 4102

Frontend API base (reference):

- `NEXT_PUBLIC_API_URL`: default `http://localhost:4000`

## Common Commands

### Development (monorepo)

Run all available `dev` tasks:

```bash
pnpm exec turbo dev
```

### Development (single app)

Example (B2C):

```bash
pnpm --filter @redi/b2c dev
```

Example (Landing):

```bash
pnpm --filter @redi/landing dev
```

### Build

```bash
pnpm exec turbo build
```

### Lint

```bash
pnpm exec turbo lint
```

### Typecheck

```bash
pnpm exec turbo typecheck
```

### Tests

```bash
pnpm exec turbo test
```

### List workspaces

```bash
pnpm -r list --depth -1
```

## Development Guidelines

### Workspaces and Dependencies

- Applications and services consume internal packages via workspace names:
  - `@redi/shared`, `@redi/ui`, etc.

- Rule: packages under `packages/*` must not import from `apps/*`.
- Add dependencies in the correct workspace:

Root (repository tooling):

```bash
pnpm add -Dw <package>
```

Specific workspace:

```bash
pnpm --filter @redi/b2c add <package>
pnpm --filter @redi/shared add -D <package>
```

### TypeScript Base Configuration

- A root `tsconfig.base.json` provides shared defaults.
- `packages/*/tsconfig.json` extends the base to ensure consistency.

### ESM Policy

- The repository uses ESM. Keep imports/exports consistent.
- For Node-executed TypeScript compiled to JavaScript, follow the project policy regarding emitted `.js` extensions where applicable.

## Git Hooks (Husky)

Husky is used to enforce quality checks locally.

Install hooks (one-time setup after `pnpm install`):

```bash
pnpm exec husky install
```

Recommended hooks:

- `pre-commit`: run `lint-staged` on staged files
- `pre-push`: run `typecheck` (and tests when available) across the monorepo

Example `.husky/pre-commit`:

```sh
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"

pnpm exec lint-staged
```

Example `.husky/pre-push` (Turbo-based):

```sh
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"

pnpm exec turbo typecheck
pnpm exec turbo test
```

## Contributing

1. Create a branch from `main`.
2. Keep changes scoped and modular (prefer shared packages over duplicated code).
3. Ensure the following pass before opening a PR:

```bash
pnpm exec turbo lint
pnpm exec turbo typecheck
pnpm exec turbo build
```

4. Add or update documentation under `docs/` when behavior or architecture changes.

## Notes

- `packages/ui` is intended to host shared UI components.
- `packages/shared` is intended for domain types, schemas, and pure utilities.
- `packages/config` is intended for centralized configuration and env validation.
- Smart contracts live under `contracts/soroban/` and are consumed via `packages/stellar-soroban`.
