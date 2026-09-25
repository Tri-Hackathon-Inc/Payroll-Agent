// Calls a chat model through an OpenAI-compatible API (the Hugging Face router by default; Groq,
// Gemini, OpenRouter, or a local Ollama through provider openai-compatible) and measures it.
// Server-side only: the credential comes from the environment variable named in the model
// configuration and is never logged or returned. A self-hosted endpoint may have no credential.

const HF_ROUTER_URL = 'https://router.huggingface.co/v1';
const PROVIDERS = new Set(['huggingface', 'openai-compatible']);

class ModelUnavailable extends Error {}

// Why a model cannot be called right now, or null when it can.
function unavailableReason(model, env = process.env) {
  if (!PROVIDERS.has(model.provider)) return `${model.name} has no runtime integration yet (provider ${model.provider}).`;
  const needsCredential = model.provider === 'huggingface' || Boolean(model.credentialEnv);
  if (needsCredential && (!model.credentialEnv || !env[model.credentialEnv])) return `${model.name} is not connected: set ${model.credentialEnv || 'a credential variable'} on the server.`;
  if (model.provider === 'openai-compatible' && !env[model.endpointEnv]) return `${model.name} is not connected: set ${model.endpointEnv}.`;
  return null;
}

function upstreamError(status, detail) {
  if (status === 400 && /not supported by any provider/i.test(detail || '')) status = 404;
  const reason = {
    401: 'the access token was rejected',
    403: 'the access token lacks permission to call this model',
    402: 'the account has no inference credits left',
    404: 'the model is not served by any available provider',
    429: 'the provider rate limit was reached; try again shortly',
    503: 'the model is overloaded at the provider; try again shortly',
  }[status] || `the provider returned HTTP ${status}`;
  return new ModelUnavailable(`Model call failed: ${reason}.${detail ? ` (${detail})` : ''}`);
}

async function callModel(model, messages, { env = process.env, fetchImpl = fetch, timeoutMs } = {}) {
  const reason = unavailableReason(model, env);
  if (reason) throw new ModelUnavailable(reason);
  const baseUrl = (env[model.endpointEnv] || HF_ROUTER_URL).replace(/\/+$/, '');
  const parameters = model.parameters || {};
  const started = performance.now();
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(model.credentialEnv ? { Authorization: `Bearer ${env[model.credentialEnv]}` } : {}),
      },
      // Provider-specific parameters in the configuration (e.g. reasoning_effort) pass through.
      body: JSON.stringify({
        ...parameters,
        model: model.modelId,
        messages,
        temperature: parameters.temperature ?? 0.2,
        max_tokens: parameters.max_tokens ?? 1024,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs || Number(env.MODEL_TIMEOUT_MS) || 60000),
    });
  } catch (error) {
    throw new ModelUnavailable(error.name === 'TimeoutError' ? 'Model call timed out.' : 'Model provider could not be reached.');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Gemini wraps its error in a one-item array.
    const error = (Array.isArray(body) ? body[0] : body)?.error;
    const detail = typeof error === 'string' ? error : error?.message;
    throw upstreamError(response.status, detail && String(detail).slice(0, 200));
  }
  const latencyMs = Math.round(performance.now() - started);
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) throw new ModelUnavailable('Model returned an empty answer.');
  const completionTokens = body.usage?.completion_tokens ?? null;
  return {
    text,
    metrics: {
      latencyMs,
      promptTokens: body.usage?.prompt_tokens ?? null,
      completionTokens,
      // End-to-end rate (includes time to first token), since the call is not streamed.
      tokensPerSecond: completionTokens ? Math.round((completionTokens / (latencyMs / 1000)) * 10) / 10 : null,
      provider: body.provider || null,
    },
  };
}

module.exports = { callModel, unavailableReason, ModelUnavailable, HF_ROUTER_URL };
