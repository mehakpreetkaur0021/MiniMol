export class AiDecisionRequestError extends Error {
  constructor(message, code = 'AI_REQUEST_FAILED') {
    super(message);
    this.name = 'AiDecisionRequestError';
    this.code = code;
  }
}

export async function requestAiDecisions(snapshot, fetchImplementation = fetch) {
  let response;

  try {
    response = await fetchImplementation('/api/ai/decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot),
    });
  } catch {
    throw new AiDecisionRequestError('Unable to reach the AI decision service.', 'AI_NETWORK_ERROR');
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new AiDecisionRequestError('The AI decision service returned an invalid response.', 'AI_INVALID_RESPONSE');
  }

  if (!response.ok || !payload.success) {
    throw new AiDecisionRequestError(
      payload?.error?.message || 'Unable to request AI decisions.',
      payload?.error?.code || 'AI_REQUEST_FAILED',
    );
  }

  return payload.data;
}

// Kept as a compatibility alias for callers that have not yet adopted the
// provider-neutral client API. The backend now uses OpenRouter.
export const requestGeminiDecisions = requestAiDecisions;
