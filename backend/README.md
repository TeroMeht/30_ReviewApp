# Backend

FastAPI service with IBKR (`ib-async`) + PostgreSQL (`asyncpg`).

## Layout

```
backend/
  core/            # config (pydantic-settings)
  db/              # raw asyncpg DB modules (one file per table/domain)
  routers/         # FastAPI routers — HTTP layer only
  services/        # business logic, called by routers
  schemas/         # pydantic request/response models
  helpers/         # cross-cutting helpers
  my_logging/      # logging setup
  dependencies.py  # FastAPI Depends() providers (IB, db conn)
  main.py          # app + lifespan + router includes
```

## Run

```bash
uv sync
uv run uvicorn main:app --reload
```

Backend listens on `http://127.0.0.1:8000` (docs at `/docs`).

## Env

Settings are loaded from `C:/codebase/env-repo/<project>.env` — see `core/config.py`.
Update `Config.env_file` to your actual project filename and put real values there.
