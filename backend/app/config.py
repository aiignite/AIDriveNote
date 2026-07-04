from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    DATABASE_URL: str = Field(..., min_length=1)
    DATABASE_URL_SYNC: str = Field(..., min_length=1)

    SECRET_KEY: str = Field(..., min_length=32)
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    REFRESH_TOKEN_EXPIRE_DAYS: int = 14

    APP_NAME: str = "AIDriveNote"
    DEBUG: bool = False
    CORS_ORIGINS: str = "http://localhost:3270"
    API_DOCS_ENABLED: bool = True

    OLLAMA_BASE_URL: str = "http://localhost:11434"
    OLLAMA_MODEL: str = "qwen2.5"
    AI_PROVIDER: str = "ollama"

    ANTHROPIC_API_KEY: str | None = None
    OPENAI_API_KEY: str | None = None
    MINIMAX_API_KEY: str | None = None

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8", "extra": "ignore"}


@lru_cache()
def get_settings() -> Settings:
    return Settings()
