# ECHO ARC — Desenvolvimento

## Arquitetura

- `src/App.tsx` é a entrada do jogo. O navegador guarda a identidade do turno em `sessionStorage` antes de chamar `/api/narrator/turn` via `src/services/narratorClient.ts`. Ao retomar um turno pendente, reenvia o mesmo identificador, revisão e linha temporal. Uma resposta de replay encerra a pendência.
- `server.ts` autentica a requisição e encaminha os turnos autoritativos de Freixo a `server/persistPilotTurn.ts`. O piloto valida autoria, revisão e linha temporal, interpreta cada etapa sobre o estado projetado e usa `src/engine/turnPlanner.ts` para rotas do catálogo. Após validar a narração, relê o estado e grava campanha, entradas narrativas, evento, efeitos de NPC e recibo na mesma transação. O replay lê os registros existentes.
- `src/engine` contém regras, rotinas e identidade reutilizáveis. O catálogo de Freixo em `scripts/echoArcFreeTurn.ts` é específico do piloto. Fora dele, o fluxo geral usa `processPlayerAction` e o repositório transacional da campanha no navegador.

## Regras

- O jogador controla ações, falas, sentimentos e escolhas de Samuel. O narrador descreve o mundo e os NPCs. Os efeitos confirmados vêm das regras e, em Freixo, são decididos no servidor.
- NPCs respeitam presença, rotinas e estado persistido. Uma etapa inválida impede efeitos parciais. O replay mantém o resultado e as consequências do turno original.

## Verificação

- `npm run check:full` executa o gate rápido uma vez e depois as suítes `emulator` e `http` em série. Requer Java 21+ e o emulador Firestore já disponível no cache local. O runner cria um projeto demo em emuladores temporários, verifica o hub antes de limpar os bancos e descarta a sessão ao terminar. As oito suítes oficiais exigem esse contexto.

- Na raiz, execute `npm run check` (também disponível como `npm run verify:engine`). O gate confere `scripts/test-manifest.mjs`, executa as suítes locais em processos separados, em sequência, e verifica TypeScript uma vez. Classifique todo novo teste como `local`, `emulator` ou `http`. As duas últimas categorias exigem infraestrutura separada. Use Node.js 22.13+ e as dependências já instaladas.
- Execute `npm run verify:engine:http` para validar o piloto por HTTP com Firebase Auth e Firestore. Use Java 21+ no PATH. O comando inicia emuladores descartáveis no projeto `demo-rpg-ai-engine`, com narração fixa e sem importar ou exportar campanhas. Se 8080, 9099 ou 3219 estiver ocupada, a integração fica pendente. Preserve os processos existentes, campanhas e checkpoints. Para sessões manuais, use dados descartáveis e preserve o checkpoint antes de restaurar uma campanha de teste.
- Para falhas de integração, consulte o diretório temporário de logs impresso pelo comando. O runner manual `scripts/sessao-livre-echo-arc.ts` usa Groq e grava `node_modules/.cache/echo-arc-free-*.jsonl`. A verificação automatizada não executa o runner. Avalie a jogabilidade e a qualidade narrativa no navegador.
- Se o piloto local estiver usando as portas padrão, execute `npm run verify:engine:http -- --alternate`. O runner usa Firestore 18080, Auth 19099 e HTTP 13219, com hub e logs em portas próprias e dados temporários.

## Playtest voluntário de comandos

Execute `node scripts/verify-engine-http.mjs --playtest $roteiro` em PowerShell para enviar somente um roteiro consentido ao endpoint do piloto em emuladores novos, com narração fixa. O launcher visual comum continua disponível com `--visual`. Nenhuma instrumentação de coleta é carregada no navegador.

- Salve o roteiro UTF-8 diretamente em `$env:TEMP`, com nome `echo-arc-playtest-NOME.tsv`. Use uma linha por tentativa, sem cabeçalho, com **objetivo**, tabulação e **frase livre**. Use apenas texto fictício, sem credenciais, dados pessoais, transcrições privadas ou cabeçalhos HTTP. Exemplo: `"open-close`tEscancaro o armário." | Set-Content -Encoding utf8 $roteiro`.
- Rotule o objetivo antes da execução: `travel`, `observation`, `speech`, `wait`, `activity`, `organize`, `open-close`, `pickup`, `drop`, `delivery`, `store`, `retrieve` ou `sequence`. Use `-` para um objetivo compreensível sem regra no catálogo e `?` para intenção insuficiente. O rótulo serve à análise e nunca é enviado ao narrador.
- Para uma rodada comparável, use 30–60 frases distintas. Inclua expressões espontâneas antes das variantes conhecidas, pares de paráfrases e impedimentos de posse, presença, alcance e abertura. Cada execução começa com a fixture nova e aplica as linhas em ordem. Para comparar versões, mantenha o mesmo TSV e confira o contexto antes de cada par.
- A pasta temporária indicada por **Relatório local** contém `tentativas.jsonl` e `relatorio.txt`. O agrupamento é preliminar. Revise principalmente o grupo 0, as ações aceitas com alvo possivelmente errado e os objetivos marcados com `-`. Confronte frase, alvo, recibo, estado, catálogo e uma formulação de controle. Uma recusa genérica sozinha não identifica a causa. Uma observação pode gravar histórico sem alterar o inventário.
- A captura termina com o lote. Omitir `--playtest` nos demais modos mantém a coleta desligada. Apague o TSV e os dois arquivos do relatório quando concluir a revisão. Não há upload nem retenção automática fora da máquina.
