"""
Centralized application settings (pydantic-settings).

The .env file lives in C:/codebase/env-repo/ and is loaded once at import
time. Add new env vars here as typed fields — pydantic will fail fast at
startup if anything required is missing.
"""
from typing import List
from pathlib import Path
from pydantic import field_validator
from pydantic_settings import BaseSettings

# IB connection fields (IB_HOST / IB_PORT / IB_CLIENT_ID) come from
# this mixin -- declared in ONE place across every project that talks
# to IB. Env-key names unchanged, so the existing 30_ReviewApp.env file
# keeps working.
from data_sources.ib._config import IBSourceConfig


class Settings(IBSourceConfig, BaseSettings):
    # --- Database ---
    DATABASE_URL: str

    # --- Interactive Brokers ---
    # IB_HOST / IB_PORT / IB_CLIENT_ID inherited from IBSourceConfig above.
    IB_CLIENT_ID: int

    # --- API ---
    API_PREFIX: str
    ALLOWED_ORIGINS: str

    # --- Anthropic (Weekly Review) ---
    # Drop your key into the .env file when ready. Empty by default so the
    # backend boots without it; the /api/reviews endpoint returns a clean
    # 503 if it's missing rather than crashing at startup.
    ANTHROPIC_API_KEY: str
    # Model used to generate weekly trade reviews. Override in .env to use
    # Opus for deeper analysis or Haiku for cheap/fast drafts.
    ANTHROPIC_MODEL: str

    TIMEZONE:str


    # --- IB Flex Web Service (historical executions with accurate timestamps) ---
    # Set up a Flex Query in IB Account Management → Reports → Flex Queries that
    # includes "Trades" / "Executions" with at least: execID, symbol, buySell,
    # quantity, price, dateTime (or tradeDate+tradeTime). Then create a Flex
    # Token under "Flex Web Service Configuration" and put both values here.
    IB_FLEX_TOKEN: str
    IB_FLEX_QUERY_ID: str

    @field_validator("ALLOWED_ORIGINS")
    def parse_allowed_origins(cls, v: str) -> List[str]:
        return v.split(",") if v else []



    class Config:
        ENV_REPO = Path("C:/codebase/env-repo")
        # TODO: rename to <project>.env when you copy this template
        env_file = ENV_REPO / "30_ReviewApp.env"
        env_file_encoding = "utf-8"
        case_sensitive = True


settings = Settings()
