# FastAPI + Next.js Template

Project skeleton mirroring the architecture of `26_ReactFastApp`. Copy this
folder, rename, and start building.

## Layout

```
_template_fastapp/
  backend/            # FastAPI + asyncpg + ib-async
    core/             # config (pydantic-settings)
    db/               # raw asyncpg per-table modules
    routers/          # HTTP layer (FastAPI APIRouters)
    services/         # business logic
    schemas/          # pydantic models
    helpers/          # cross-cutting helpers
    my_logging/       # logging setup
    dependencies.py   # FastAPI Depends() providers
    main.py           # app + lifespan + router includes
    pyproject.toml
  frontend/           # Next.js (App Router) + Tailwind
    app/              # routes
      (root)/         # shared chrome route group
    components/
      ui/             # primitives (shadcn-style)
    lib/              # api_prefix, utils, types
    generated/        # openapi-typescript output
    constants/
    public/
    package.json
  .env.example        # copy to C:/codebase/env-repo/<project>.env
```

## Architecture at a glance

Request flow:

```
browser → Next.js (/api/* rewrite) → FastAPI router → service → db
                                                              ↘ ib-async (IB client)
```

- **CORS-free**: the browser only ever talks to the Next.js origin; Next
  proxies `/api/*` to FastAPI via `next.config.ts`.
- **Typed contract**: `npm run gen:types` regenerates
  `frontend/generated/api.ts` from FastAPI's OpenAPI schema.
- **Shared resources**: IB client and asyncpg pool are created in the
  FastAPI lifespan and exposed via `Depends()` providers in
  `dependencies.py`.

## Getting started for a new project

1. Copy this folder, rename to e.g. `27_MyApp`.
2. Create `C:/codebase/env-repo/27_MyApp.env` from `.env.example`.
3. Update `Config.env_file` in `backend/core/config.py` to point at the new
   filename.
4. Update FastAPI title/description in `backend/main.py`.
5. Update Next.js `metadata.title` in `frontend/app/layout.tsx`.
6. Backend: `cd backend && uv sync && uv run uvicorn main:app --reload`
7. Frontend: `cd frontend && npm install && npm run dev`
8. With backend running, `npm run gen:types` to refresh API types.
