// Claude (the Anthropic API) for subtitle translation, through the official SDK: the models a key can use, and one
// batch of numbered lines translated. Called by subtitle-translator.cjs, which does the batching, retries and handing
// over to another model or API; the SDK's errors come back in that file's shape ({status, retryAfter}, AbortError,
// TimeoutError).
const Anthropic = require('@anthropic-ai/sdk');

// Fixed, so an ANTHROPIC_BASE_URL set on the PC (a developer's proxy) does not take the user's key elsewhere.
const BASE_URL = 'https://api.anthropic.com';
// Models that take the server-side fallback: a request one of them declines is answered by another model in the same
// call (the API picks it by the kind of refusal), instead of the batch coming back untranslated.
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const DEFAULT_MODEL = 'claude-opus-5-5';

// Retries are subtitle-translator's (its retried() waits as long as a rate limit asks), so the SDK makes one try.
// fetch: the caller's, so a test can answer for the API.
const client = (key, fetch) => new Anthropic({ apiKey: key, baseURL: BASE_URL, maxRetries: 0, timeout: 180000, ...(fetch ? { fetch } : {}) });

// The API's own message and status, and how long a rate limit asks to wait. A key out of credit is a 400 like a request
// the model does not take, so it is marked (billing) and not tried again in another shape.
function plainError(error, signal) {
  if (signal?.aborted) return signal.reason ?? Object.assign(new Error('번역을 취소했습니다.'), { name: 'AbortError' });
  if (error instanceof Anthropic.APIUserAbortError) return Object.assign(new Error('번역을 취소했습니다.'), { name: 'AbortError' });
  if (error instanceof Anthropic.APIConnectionTimeoutError) return Object.assign(new Error('Claude가 제때 답하지 않았습니다.'), { name: 'TimeoutError' });
  if (error instanceof Anthropic.APIError && error.status) {
    const message = String(error.error?.error?.message || '');
    return Object.assign(new Error(`Claude HTTP ${error.status}${message ? `: ${message}` : ''}`), {
      status: error.status, retryAfter: Number(error.headers?.get?.('retry-after')) || 0, billing: /credit balance|billing/i.test(message) });
  }
  return error;
}

// Every model the key can use, as the API lists them (newest first).
async function listModels(key, fetch) {
  const ids = [];
  try { for await (const model of client(key, fetch).models.list({ limit: 100 })) if (model?.id) ids.push(String(model.id)); }
  catch (error) { throw plainError(error); }
  return [...new Set(ids)];
}
const defaultModel = models => models.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : models[0] || '';
// The family a model belongs to (opus, sonnet, haiku, fable), so a used-up model hands over to one of its own kind.
const familyOf = model => String(model).match(/^claude-(?:\d+(?:-\d+)*-)?([a-z]+)/)?.[1] || '';

// One batch: instructions as the system prompt (cached, as every batch of an episode sends the same one), the lines as
// the user's message. shape: what the request asks of the model ({effort, schema, fallback}); the caller drops what a
// model does not take (older models have no effort or structured outputs). Streamed, so a long answer does not run
// into the request timeout.
async function translate({ key, model, instructions, input, shape = {}, signal, fetch }) {
  const outputConfig = { ...(shape.effort ? { effort: shape.effort } : {}), ...(shape.schema ? { format: { type: 'json_schema', schema: shape.schema } } : {}) };
  const params = {
    model, max_tokens: 32000,
    system: [{ type: 'text', text: instructions, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: input }],
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {})
  };
  const api = client(key, fetch);
  let message;
  try {
    const stream = shape.fallback && FALLBACK_MODELS.has(model)
      ? api.beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' }, { signal })
      : api.messages.stream(params, { signal });
    message = await stream.finalMessage();
  } catch (error) { throw plainError(error, signal); }
  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category;
    throw Object.assign(new Error(`Claude가 이 부분의 번역을 거절했습니다${category ? ` (${category})` : ''}.`), { refused: true });
  }
  if (message.stop_reason === 'max_tokens') throw new Error('Claude의 답이 길이 제한에서 끊겼습니다.');
  return (message.content || []).filter(block => block.type === 'text').map(block => block.text).join('');
}

module.exports = { listModels, defaultModel, familyOf, translate, DEFAULT_MODEL };
