---
"@officehum/cli": minor
---

`--model local/<id>` runs and grades a role on a model served on your own machine behind an
OpenAI-compatible chat-completions endpoint (llama.cpp's `llama-server`, vLLM, Ollama's
`/v1`), with no hosted model key. `OFFICEHUM_LOCAL_BASE_URL` names the endpoint;
`OFFICEHUM_LOCAL_API_KEY` (optional) and `OFFICEHUM_LOCAL_CONTEXT_WINDOW` (default 32768) are read
when set. `run`, `eval`, `eval --judge` and `judge-check` accept it. See `docs/local-models.md`.
