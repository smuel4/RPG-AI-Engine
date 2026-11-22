import express from 'express';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { verifyFirebasePlayer } from './server/firebaseAuth';
import { fetchCampaignContext, fetchCommittedTurn } from './server/campaignAccess';
import { checkTurnRevision, isTurnId, type TurnIdentity } from './src/engine/turnIdentity';
import { diagnoseCampaignTurn } from './server/turnPlanDiagnostics';
import { evaluatePilotTurn, readTurnPlanPilot } from './server/turnPlanPilot';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { persistPilotTurn, PilotTurnError, SERVER_PILOT_ID } from './server/persistPilotTurn';
import { clarificationReceiptBinding, issuePilotClarification, readClarificationParts, readPilotClarification } from './server/pilotClarification';
import { describePilotFeedback } from './server/pilotFeedback';
import { freixoEmulatorPorts } from './server/freixoEmulatorPorts.mjs';
import { describeNarratorFailure } from './server/narratorProvider';
import { generateCampaignNarration, selectNarratorMode, tryAcquireNarratorTurn } from './server/narratorService';
import { FixedMilestoneNarrator } from './src/engine/narratorPort';
import { ROOT_TIMELINE_ID } from './src/engine/constants';

const localFreixo = process.env.VITE_FREIXO_LOCAL === 'true';
if (!localFreixo) dotenv.config();
const turnPlanPilot = localFreixo ? { campaignId: SERVER_PILOT_ID,
  catalog: (await import('./scripts/echoArcFreeTurn')).freixoPlayableCatalog }
  : readTurnPlanPilot(process.env.TURN_PLAN_PILOT_CATALOG, process.env.TURN_PLAN_PILOT_CAMPAIGN ?? '');
const serverPilotEnabled = process.env.TURN_PLAN_SERVER_COMMIT === 'true';
const alternateTest = localFreixo && process.env.FREIXO_TEST_ALT_PORTS === '1';
const emulatorPorts = freixoEmulatorPorts(alternateTest);
if (localFreixo && (!serverPilotEnabled || process.env.NODE_ENV === 'production' ||
    process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:' + emulatorPorts.firestore ||
    process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:' + emulatorPorts.auth ||
    (alternateTest && (process.env.PORT !== String(emulatorPorts.http) || process.env.NARRATOR_MODE !== 'fixed')) ||
    !['fixed', 'groq'].includes(process.env.NARRATOR_MODE ?? 'fixed'))) {
  throw new Error('Freixo local exige modo de desenvolvimento, piloto e ambos os emuladores em loopback.');
}
if (serverPilotEnabled && (turnPlanPilot?.campaignId !== SERVER_PILOT_ID ||
    process.env.FIREBASE_PROJECT_ID !== 'demo-rpg-ai-engine' ||
    !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '') ||
    !/^127\.0\.0\.1:\d+$/.test(process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '') ||
    !process.env.FIRESTORE_DATABASE_ID)) {
  throw new Error('O piloto gravável exige projeto demo, campanha reservada e emuladores locais de Auth e Firestore.');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

// Rate limiting defensivo por jogador (mínimo de 3 segundos entre ações consecutivas)
const lastActionPerPlayer = new Map<string, number>();

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Server health and stage status (never exposes secrets to the client)
  app.get('/api/health', (_req, res) => {
    const defaultMode = selectNarratorMode(process.env.NARRATOR_MODE);

    res.json({
      status: 'ok',
      service: 'rpg-ai-engine',
      milestone: 2,
      narratorMode: defaultMode,
      geminiConfiguredOnServer: Boolean(process.env.GEMINI_API_KEY?.trim() && process.env.GEMINI_MODEL?.trim()),
      groqConfiguredOnServer: Boolean(process.env.GROQ_API_KEY?.trim()),
      timestamp: new Date().toISOString(),
    });
  });

  // Stage 2: Turno do Narrador seguro e transacional
  app.post('/api/narrator/turn', async (req, res) => {
    const authorization = req.header('authorization');
    const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1];

    if (!token) {
      res.status(401).json({ code: 'AUTH_REQUIRED', message: 'Token Bearer ausente.' });
      return;
    }

    let playerId: string | null;

    try {
      playerId = await verifyFirebasePlayer(authorization, serverPilotEnabled);
    } catch {
      res.status(401).json({ code: 'INVALID_FIREBASE_TOKEN', message: 'Token Firebase inválido ou expirado.' });
      return;
    }

    if (!playerId) {
      res.status(401).json({ code: 'AUTH_REQUIRED', message: 'Identidade do jogador não confirmada.' });
      return;
    }

    const campaignId: unknown = req.body?.campaignId;
    if (
      typeof campaignId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(campaignId)
    ) {
      res.status(400).json({ code: 'INVALID_CAMPAIGN_ID', message: 'ID da campanha inválido.' });
      return;
    }

    const declaredAction: unknown = req.body?.declaredAction;
    if (typeof declaredAction !== 'string') {
      res.status(400).json({ code: 'INVALID_ACTION', message: 'Ação do jogador obrigatória.' });
      return;
    }

    const trimmedAction = declaredAction.trim();
    if (trimmedAction.length < 1 || trimmedAction.length > 800) {
      res.status(400).json({
        code: 'ACTION_LENGTH_INVALID',
        message: 'Ação deve ter entre 1 e 800 caracteres.',
      });
      return;
    }

    if (/^\/(dar|set|hack|forjar|gold|ouro)\b/i.test(trimmedAction)) {
      res.status(400).json({
        code: 'ACTION_BLOCKED',
        message: 'Comandos diretos de trapaça são bloqueados pelo motor de regras.',
      });
      return;
    }

    let turn: TurnIdentity | undefined;
    if (req.body?.turnId !== undefined) {
      const { turnId, expectedRevision, baseTimelineId, advanceMinutes } = req.body;
      if (!isTurnId(turnId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
          typeof baseTimelineId !== 'string' || !/^[\w-]{1,128}$/.test(baseTimelineId) ||
          !Number.isSafeInteger(advanceMinutes) || advanceMinutes < 0 || advanceMinutes > 720) {
        res.status(400).json({ code: 'INVALID_TURN_IDENTITY', message: 'Identidade do turno inválida.' });
        return;
      }
      turn = { turnId, campaignId, declaredAction: trimmedAction, expectedRevision, baseTimelineId, advanceMinutes };
    }

    // Proteção contra duplicação: trava em voo por campanha
    const releaseTurn = tryAcquireNarratorTurn(campaignId);
    if (!releaseTurn) {
      res.status(409).json({
        code: 'ACTION_IN_PROGRESS',
        message: 'Já existe uma ação sendo narrada para esta campanha. Aguarde a conclusão.',
      });
      return;
    }

    try {
      if (campaignId === SERVER_PILOT_ID) {
        if (!serverPilotEnabled || !turn || !turnPlanPilot) {
          res.status(400).json({ code: 'PILOT_DISABLED', message: 'O turno requer o piloto local e sua identidade original.' });
          return;
        }
        const app = getApps().find(({ name }) => name === 'echo-arc-pilot-store') ??
          initializeApp({ projectId: 'demo-rpg-ai-engine' }, 'echo-arc-pilot-store');
        try {
          const db = getFirestore(app, process.env.FIRESTORE_DATABASE_ID!);
          let objectAnswer: string | undefined;
          let clarification: { binding: string; replayOnly: boolean } | undefined;
          const clarificationToken: unknown = req.body?.clarificationToken;
          if (clarificationToken !== undefined) {
            const parts = readClarificationParts(clarificationToken);
            if (!parts) throw new PilotTurnError('PILOT_CLARIFICATION_EXPIRED');
            const prefix = readPilotClarification(playerId, turn, parts.token);
            objectAnswer = trimmedAction.replace(/[.!?]$/u, '').trim();
            if (!/^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} '’-]{0,159}$/u.test(objectAnswer)) {
              throw new PilotTurnError(prefix ? 'PILOT_OBJECT_UNREGISTERED' : 'PILOT_CLARIFICATION_EXPIRED');
            }
            turn = { ...turn, declaredAction: (prefix ?? parts.prefix) + ' ' + objectAnswer };
            clarification = { binding: clarificationReceiptBinding(playerId, turn, parts.token), replayOnly: prefix === undefined };
          }
          const result = await persistPilotTurn(db,
            turnPlanPilot.catalog, playerId, turn, async (campaign, sceneIntent, present, npcRelationships, narrative, declaredAction) => {
              const mode = process.env.NARRATOR_MODE;
              if (localFreixo && (!mode || mode === 'fixed')) {
                if (sceneIntent.startsWith('Mostre a reação')) return 'A fala encontra uma pausa atenta.';
                const observed = present.activities.find(({ name }) =>
                  sceneIntent.startsWith('Descreva somente o que pode ser percebido de ' + name + ' neste local.'));
                if (observed) {
                  return 'A atividade de ' + observed.name + ' é ' + observed.activity[0].toLocaleLowerCase('pt-BR') + observed.activity.slice(1);
                }
                if (sceneIntent.startsWith('Descreva o que é visível') && present.activities.length) {
                  return present.activities.map(({ name }) => name + ' está em atividade.').join(' ');
                }
                return 'O movimento da manhã segue ao redor.';
              }
              if (mode !== 'groq' && mode !== 'gemini') throw new PilotTurnError('PILOT_NARRATOR_UNAVAILABLE');
              return generateCampaignNarration({ campaign, sceneIntent, declaredAction,
                narrative, inventory: [], npcs: present.npcs, sceneKnowledge: present.knowledge,
                npcActivities: present.activities, npcMemories: present.memories, npcRelationships }, mode);
            }, objectAnswer, clarification);
          res.json({ ...result, turnId: turn.turnId, expectedRevision: turn.expectedRevision, baseTimelineId: turn.baseTimelineId });
        } catch (error) {
          const code = error instanceof PilotTurnError ? error.code : 'PILOT_TURN_FAILED';
          if (localFreixo && error instanceof PilotTurnError && error.reason) {
            console.warn('[freixo] Turno rejeitado', { turnId: turn.turnId, code, reason: error.reason });
          }
          const status = code === 'CAMPAIGN_ACCESS_DENIED' ? 403
            : ['TURN_ID_CONFLICT', 'CONCURRENT_STATE_CONFLICT'].includes(code) ? 409 : 422;
          const messages: Record<string, string> = {
            PILOT_CLARIFICATION_EXPIRED: 'A pergunta expirou. Confira o histórico e envie uma nova ação.',
            PILOT_NARRATION_CONFLICT: 'A resposta do narrador entrou em conflito com o estado da cena. A ação não foi registrada.',
          };
          const step = error instanceof PilotTurnError ? error.step : undefined;
          const message = messages[code] ?? 'O servidor não confirmou o turno piloto (' + code + ').';
          const prefix = error instanceof PilotTurnError ? error.clarificationPrefix : undefined;
          const clarificationToken = prefix && req.body?.clarificationToken === undefined
            ? issuePilotClarification(playerId, turn, prefix) : undefined;
          const feedback = error instanceof PilotTurnError ? describePilotFeedback(error, Boolean(clarificationToken)) : undefined;
          res.status(status).json({ code, message: feedback ?? (step ? 'Etapa ' + step + '. ' + message : message),
            gameplayFeedback: feedback ? true : undefined, clarificationToken });
        }
        return;
      }
      if (serverPilotEnabled) {
        res.status(400).json({ code: 'DEMO_CAMPAIGN_REQUIRED', message: 'Este servidor de teste atende apenas à campanha piloto.' });
        return;
      }
      // Carrega estado canônico no Firestore via banco nomeado com a identidade do jogador
      const context = await fetchCampaignContext(campaignId, token, playerId);

      if (!context) {
        res.status(403).json({
          code: 'CAMPAIGN_ACCESS_DENIED',
          message: 'Campanha não encontrada ou não pertencente ao usuário.',
        });
        return;
      }

      if (turn) {
        const receipt = await fetchCommittedTurn(turn, token, playerId);
        if (receipt.status === 'replayed') {
          res.json({ mode: 'replay', turnId: turn.turnId, narration: receipt.entry.content,
            expectedRevision: turn.expectedRevision, expectedLastSequence: receipt.entry.sequence - 2,
            baseTimelineId: turn.baseTimelineId });
          return;
        }
        if (receipt.status === 'conflict' || !checkTurnRevision(turn, context.campaign)) {
          res.status(409).json({ code: receipt.status === 'conflict' ? 'TURN_ID_CONFLICT' : 'CONCURRENT_STATE_CONFLICT',
            message: 'O identificador ou o estado de origem do turno diverge.' });
          return;
        }
      }
      const now = Date.now();
      if (now - (lastActionPerPlayer.get(playerId) ?? 0) < 3000) {
        res.status(429).json({ code: 'RATE_LIMIT_EXCEEDED', message: 'Aguarde alguns segundos entre ações consecutivas.' });
        return;
      }
      lastActionPerPlayer.set(playerId, now);
      if (context.campaign.status === 'archived') {
        res.status(400).json({
          code: 'CAMPAIGN_ARCHIVED',
          message: 'Campanha arquivada não aceita novas ações.',
        });
        return;
      }

      const planDiagnostic = process.env.TURN_PLAN_DIAGNOSTICS === 'true'
        ? diagnoseCampaignTurn(trimmedAction, context.campaign, context.npcs)
        : undefined;
      const planPilot = turn ? evaluatePilotTurn(turnPlanPilot, turn, playerId, context.campaign) : undefined;
      const activeMode = selectNarratorMode(process.env.NARRATOR_MODE, !IS_PROD && req.body?.mode === 'fixed');
      if (!activeMode) {
        res.status(503).json({
          code: 'NARRATOR_MODE_INVALID',
          message: 'Modo do narrador inv?lido na configura??o do servidor. Sua a??o n?o foi salva.',
        });
        return;
      }

      if (activeMode === 'fixed') {
        const fixedNarrator = new FixedMilestoneNarrator();
        const narration = fixedNarrator.respondToPlayerAction({
          campaign: context.campaign,
          inventory: context.inventory,
          npcs: context.npcs,
          declaredAction: trimmedAction,
        });

        res.json({
          narration,
          mode: 'fixed',
          turnId: turn?.turnId,
          planDiagnostic,
          planPilot,
          expectedRevision: context.campaign.revision,
          expectedLastSequence: context.campaign.lastSequence,
          baseTimelineId: context.campaign.activeTimelineId || ROOT_TIMELINE_ID,
        });
        return;
      }

      const providerLabel = activeMode === 'gemini' ? 'Gemini' : 'Groq';
      const providerCode = activeMode.toUpperCase();
      try {
        const narration = await generateCampaignNarration({
          campaign: context.campaign,
          inventory: context.inventory,
          npcs: context.npcs,
          narrative: context.narrative,
          declaredAction: trimmedAction,
        }, activeMode);

        res.json({
          narration,
          mode: activeMode,
          turnId: turn?.turnId,
          planDiagnostic,
          planPilot,
          expectedRevision: context.campaign.revision,
          expectedLastSequence: context.campaign.lastSequence,
          baseTimelineId: context.campaign.activeTimelineId || ROOT_TIMELINE_ID,
        });
      } catch (error: unknown) {
        const failure = describeNarratorFailure(error, activeMode);

        if (failure.category === 'configuration') {
          res.status(503).json({
            code: providerCode + '_NOT_CONFIGURED',
            message: 'Chave ou modelo sem configura??o no servidor para ' + providerLabel + '. Sua a??o n?o foi salva.',
          });
          return;
        }

        if (failure.code === 'NARRATION_EXCEEDS_LIMIT') {
          res.status(502).json({
            code: 'NARRATION_EXCEEDS_LIMIT',
            message: 'A narrativa gerada excedeu o limite máximo de 2.000 caracteres. O turno foi cancelado sem salvar.',
          });
          return;
        }

        if (failure.code === 'TIMEOUT_EXCEEDED') {
          res.status(504).json({
            code: 'NARRATOR_TIMEOUT',
            message: 'O narrador demorou muito para responder (tempo limite excedido). O turno foi cancelado sem salvar.',
          });
          return;
        }

        if (failure.category === 'provider_http' && failure.status === 503) {
          res.status(503).json({
            code: providerCode + '_OVERLOADED',
            message: 'O servi?o do ' + providerLabel + ' est? temporariamente sobrecarregado. Sua a??o n?o foi salva. Tente novamente mais tarde.',
          });
          return;
        }

        if (failure.category === 'provider_http' && failure.status === 429) {
          res.status(429).json({
            code: providerCode + '_RATE_LIMIT',
            message: 'O provedor atingiu o limite de uso. Sua a??o n?o foi salva. Tente novamente mais tarde.',
          });
          return;
        }

        // Provider credentials and internal errors are reported only in server diagnostics.
        res.status(503).json({
          code: providerCode + '_UNAVAILABLE',
          message: 'O narrador ' + providerLabel + ' est? indispon?vel no momento. Nenhum dado foi salvo.',
        });
      }
    } catch {
      res.status(503).json({
        code: 'CAMPAIGN_ACCESS_CHECK_UNAVAILABLE',
        message: 'Não foi possível consultar os dados da campanha no Firestore.',
      });
    } finally {
      releaseTurn();
    }
  });

  const visualTest = alternateTest && process.env.VITE_FIRESTORE_EMULATOR_PORT === String(emulatorPorts.firestore)
    && process.env.VITE_AUTH_EMULATOR_PORT === String(emulatorPorts.auth);
  if (!IS_PROD && (!alternateTest || visualTest)) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      ...(visualTest ? { cacheDir: path.join(tmpdir(), 'vite-freixo-visual') } : {}),
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (IS_PROD) {
    const distPath = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  const host = localFreixo ? '127.0.0.1' : '0.0.0.0';
  app.listen(PORT, host, () => {
    console.log(`RPG AI Engine server listening on http://${host}:${PORT}`);
  });
}

startServer().catch((error) => {
  console.error('Failed to start RPG AI Engine server:', error);
  process.exit(1);
});
