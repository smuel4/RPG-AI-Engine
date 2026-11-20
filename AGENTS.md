# ECHO ARC — Desenvolvimento

## Arquitetura

- `src/App.tsx` é a entrada do jogo. O navegador guarda a identidade do turno em `sessionStorage` antes de chamar `/api/narrator/turn` via `src/services/narratorClient.ts`. Ao retomar um turno pendente, reenvia o mesmo identificador, revisão e linha temporal. Uma resposta de replay encerra a pendência.
- `server.ts` autentica a requisição e encaminha os turnos autoritativos de Freixo a `server/persistPilotTurn.ts`. O piloto valida autoria, revisão e linha temporal, interpreta cada etapa sobre o estado projetado e usa `src/engine/turnPlanner.ts` para rotas do catálogo. Após validar a narração, relê o estado e grava campanha, entradas narrativas, evento, efeitos de NPC e recibo na mesma transação. O replay lê os registros existentes.
- `src/engine` contém regras, rotinas e identidade reutilizáveis. O catálogo de Freixo em `scripts/echoArcFreeTurn.ts` é específico do piloto. Fora dele, o fluxo geral usa `processPlayerAction` e o repositório transacional da campanha no navegador.

## Regras

- O jogador controla ações, falas, sentimentos e escolhas de Samuel. O narrador descreve o mundo e os NPCs. Os efeitos confirmados vêm das regras e, em Freixo, são decididos no servidor.
- NPCs respeitam presença, rotinas e estado persistido. Uma etapa inválida impede efeitos parciais. O replay mantém o resultado e as consequências do turno original.

## Verificação

- Na raiz, execute `npm run verify:engine` após mudanças em turnos. Usa Node.js 22.13+ com as dependências já instaladas, fixtures em memória e TypeScript. O relatório mostra cenário, linha da falha e asserção. As recusas testadas incluem código e etapa.
- Execute `npm run verify:engine:http` para validar o piloto por HTTP com Firebase Auth e Firestore. Use Java 21+ no PATH. O comando inicia emuladores descartáveis no projeto `demo-rpg-ai-engine`, com narração fixa e sem importar ou exportar campanhas. Se 8080, 9099 ou 3219 estiver ocupada, a integração fica pendente. Preserve os processos existentes, campanhas e checkpoints. Para sessões manuais, use dados descartáveis e preserve o checkpoint antes de restaurar uma campanha de teste.
- Para falhas de integração, consulte o diretório temporário de logs impresso pelo comando. O runner manual `scripts/sessao-livre-echo-arc.ts` usa Groq e grava `node_modules/.cache/echo-arc-free-*.jsonl`. A verificação automatizada não executa o runner. Avalie a jogabilidade e a qualidade narrativa no navegador.
- Se o piloto local estiver usando as portas padrão, execute `npm run verify:engine:http -- --alternate`. O runner usa Firestore 18080, Auth 19099 e HTTP 13219, com hub e logs em portas próprias e dados temporários.
