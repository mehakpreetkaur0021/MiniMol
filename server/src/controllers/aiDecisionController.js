import { OpenRouterDecisionError, openRouterDecisionService } from '../ai/openrouterDecisionService.js';
import { validateTrafficSnapshot } from '../ai/promptBuilder.js';

export function createAiDecisionController(decisionService = openRouterDecisionService) {
  return async function requestAiDecision(req, res) {
    const snapshotValidation = validateTrafficSnapshot(req.body);
    if (!snapshotValidation.valid) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_SNAPSHOT',
          message: 'Traffic snapshot is invalid.',
        },
      });
    }

    try {
      const result = await decisionService.requestDecision(req.body);
      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      const controlledError = isDecisionError(error)
        ? error
        : new OpenRouterDecisionError('INTERNAL_ERROR', 'Unable to process the AI decision request.', 500);

      return res.status(controlledError.httpStatus).json({
        success: false,
        error: {
          code: controlledError.code,
          message: controlledError.message,
        },
      });
    }
  };
}

function isDecisionError(error) {
  return Boolean(error)
    && typeof error.code === 'string'
    && Number.isInteger(error.httpStatus)
    && typeof error.message === 'string';
}

export const requestAiDecision = createAiDecisionController();
