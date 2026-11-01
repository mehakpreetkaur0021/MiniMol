import { Router } from 'express';
import { requestAiDecision } from '../controllers/aiDecisionController.js';

const router = Router();

router.post('/decision', requestAiDecision);

export default router;
