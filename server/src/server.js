import 'dotenv/config';
import app from './app.js';

const port = Number(process.env.PORT) || 5000;

const server = app.listen(port, () => {
  console.log(`Traffic management API is running on http://localhost:${port}`);
});

server.on('error', (error) => {
  console.error('Unable to start traffic management API:', error.message);
  process.exit(1);
});
