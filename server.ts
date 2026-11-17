import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Server health and stage status (never exposes secrets to the client)
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'rpg-ai-engine',
      milestone: 1,
      narratorMode: 'fixed-test-fixture',
      geminiConfiguredOnServer: Boolean(process.env.GEMINI_API_KEY),
      timestamp: new Date().toISOString(),
    });
  });

  // Reserved server-side boundary for Milestone 2 Gemini Narrator integration
  app.post('/api/narrator/turn', (_req, res) => {
    res.status(501).json({
      code: 'NARRATOR_STAGE_2_PENDING',
      message:
        'A integração com a Gemini API está reservada para a Etapa 2. Este marco utiliza narrativa fixa de teste.',
    });
  });

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`RPG AI Engine server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error('Failed to start RPG AI Engine server:', error);
  process.exit(1);
});
