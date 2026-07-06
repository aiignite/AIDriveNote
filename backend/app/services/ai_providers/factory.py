from app.services.ai_providers.base import AIProviderConfig, BaseAIProvider
from app.services.ai_providers.minimax import MiniMaxProvider
from app.services.ai_providers.ollama import OllamaProvider
from app.services.ai_providers.openai_compat import OpenAICompatibleProvider


class AIProviderFactory:
    @staticmethod
    def create(provider: str, config: AIProviderConfig) -> BaseAIProvider:
        provider = (provider or "OLLAMA").upper()
        if provider == "MINIMAX":
            return MiniMaxProvider(config)
        if provider in ("OPENAI", "LMSTUDIO"):
            return OpenAICompatibleProvider(config)
        if provider == "ANTHROPIC":
            # Anthropic via OpenAI-compatible proxy when endpoint configured
            return OpenAICompatibleProvider(config)
        return OllamaProvider(config)

    @staticmethod
    def get_available_providers() -> list[dict[str, object]]:
        from app.config import get_settings
        s = get_settings()
        return [
            {"id": "OLLAMA", "name": "Ollama", "requires_api_key": False},
            {"id": "LMSTUDIO", "name": "LM Studio", "requires_api_key": False},
            {"id": "OPENAI", "name": "OpenAI", "requires_api_key": True, "configured": bool(s.OPENAI_API_KEY)},
            {"id": "ANTHROPIC", "name": "Anthropic", "requires_api_key": True, "configured": bool(s.ANTHROPIC_API_KEY)},
            {"id": "MINIMAX", "name": "MiniMax", "requires_api_key": True, "configured": bool(s.MINIMAX_API_KEY)},
        ]
