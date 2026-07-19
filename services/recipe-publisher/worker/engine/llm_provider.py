"""LLM provider 抽象层。

extract_steps 只需要「给定 system + user 文本，返回模型输出的纯文本」这一能力。
这里把具体厂商隐藏在 `chat()` 之后，按环境变量选择：

  LLM_PROVIDER   openai_compatible（默认，国产模型：Qwen/DeepSeek/GLM 等）| anthropic
  LLM_MODEL      模型 id（如 qwen-plus / deepseek-chat / glm-4-plus / claude-sonnet-4-5）
  LLM_BASE_URL   OpenAI 兼容网关地址（如 https://dashscope.aliyuncs.com/compatible-mode/v1）
  LLM_API_KEY    密钥（不设时回退到厂商各自默认的环境变量）
  LLM_MAX_TOKENS 输出上限，默认 4096

云端生产走国产模型（OpenAI 兼容接口，用 openai SDK）；本地开发想用 Claude Code /
Anthropic 官方 API 时把 LLM_PROVIDER 设为 anthropic 即可，无需改调用方。

兼容旧变量：未设置 LLM_* 但设置了 ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN 时，
默认切到 anthropic，保证原庖丁解牛的运行方式不被打断。
"""
from __future__ import annotations

import os


def _default_provider() -> str:
    explicit = os.environ.get("LLM_PROVIDER")
    if explicit:
        return explicit.strip().lower()
    # 无显式配置但有 Anthropic 凭证 → 沿用原 Claude 路径。
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return "anthropic"
    return "openai_compatible"


def resolve_model(explicit: str | None = None) -> str:
    """决定最终模型 id。

    调用方传入的 "claude-sonnet-4-5" 视为「未显式覆盖」的默认哨兵（extract_steps 的
    历史默认值），此时按 LLM_MODEL 或 provider 默认解析；传入其它值则尊重调用方。
    """
    sentinel = "claude-sonnet-4-5"
    if explicit and explicit != sentinel:
        return explicit
    env_model = os.environ.get("LLM_MODEL")
    if env_model:
        return env_model
    provider = _default_provider()
    return sentinel if provider == "anthropic" else "qwen-plus"


def has_credential() -> bool:
    provider = _default_provider()
    if provider == "anthropic":
        return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
    return bool(os.environ.get("LLM_API_KEY") or os.environ.get("OPENAI_API_KEY") or os.environ.get("DASHSCOPE_API_KEY"))


def credential_hint() -> str:
    provider = _default_provider()
    if provider == "anthropic":
        return "缺 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN"
    return "缺 LLM_API_KEY（OpenAI 兼容国产模型），并设置 LLM_BASE_URL / LLM_MODEL"


def _chat_anthropic(system: str, user: str, model: str, max_tokens: int) -> str:
    import anthropic

    client = anthropic.Anthropic()  # SDK 自动读 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL
    msg = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    return msg.content[0].text


def _chat_openai_compatible(system: str, user: str, model: str, max_tokens: int) -> str:
    from openai import OpenAI

    api_key = os.environ.get("LLM_API_KEY") or os.environ.get("OPENAI_API_KEY") or os.environ.get("DASHSCOPE_API_KEY")
    base_url = os.environ.get("LLM_BASE_URL") or os.environ.get("OPENAI_BASE_URL")
    client = OpenAI(api_key=api_key, base_url=base_url)
    resp = client.chat.completions.create(
        model=model,
        max_tokens=max_tokens,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )
    return resp.choices[0].message.content or ""


def chat(system: str, user: str, model: str | None = None) -> str:
    """统一入口：返回模型输出的原始文本（不做 JSON 解析）。"""
    if not has_credential():
        raise RuntimeError(credential_hint())
    provider = _default_provider()
    resolved = resolve_model(model)
    max_tokens = int(os.environ.get("LLM_MAX_TOKENS", "4096"))
    if provider == "anthropic":
        return _chat_anthropic(system, user, resolved, max_tokens)
    return _chat_openai_compatible(system, user, resolved, max_tokens)
