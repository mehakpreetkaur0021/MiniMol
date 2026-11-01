import express from 'express';
import healthRoutes from './routes/healthRoutes.js';
import aiRoutes from './routes/aiRoutes.js';
import errorHandler from './middleware/errorHandler.js';

const app = express();

app.use(express.json());
app.use('/api', healthRoutes);
app.use('/api/ai', aiRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

app.use(errorHandler);

export default app;
