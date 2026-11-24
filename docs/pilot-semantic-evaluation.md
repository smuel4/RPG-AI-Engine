# Freixo — avaliação semântica experimental V1

O navegador mantém a identidade do turno pendente e o servidor passa os turnos de Freixo a `persistPilotTurn`. O piloto reconhece intenções por padrões e precedência, projeta até duas etapas e valida rota, tempo, presença, posse e alcance. A etapa 2 usa o estado projetado pela primeira. Se a projeção falhar, o turno inteiro é recusado. A narração passa por validação antes da transação que relê revisão e linha temporal e grava o recibo junto dos efeitos. Replay usa o recibo existente. `pilotFeedback` transforma códigos e motivos em mensagens e, quando aplicável, o fluxo de esclarecimento de objeto vincula a resposta à tentativa original.

O WorldPack publica o catálogo. `resolvePlaceReference` resolve IDs estáveis e referências legadas. Movimentação textual usa rótulos e aliases. O piloto e a ferramenta experimental compartilham o mesmo planejador tipado de deslocamento, com o limite de 3 trechos e 30 minutos. A única alteração no motor foi extrair esse ponto de entrada do planejador existente.

## Reproduzir

```powershell
node --import tsx scripts/pilotCommandEvaluation.ts
node --import tsx scripts/pilotCommandEvaluation.ts --details
```

Cada frase começa em uma fixture independente com Firestore em memória, o mesmo `persistPilotTurn` do piloto e narração fixa. A avaliação lê o plano do recibo, os alvos disponíveis, a resposta factual, a posição e o relógio, e compara todos os documentos em caso de erro. Uma consulta pode gravar histórico e recibo. Bloqueios são classificados pelos códigos e pelas evidências que o erro expõe, como etapa, NPC ausente, objeto ou motivo. O piloto devolve menos evidência em alguns erros, por exemplo quando um objeto é fixo. Nesses casos a classificação indica a regra observada na fixture e não uma prova independente de identificação por ID.

O corpus tem 70 entradas, incluindo as 19 originais, 30 de desenvolvimento e 21 reservadas do ajuste de propostas sintéticas. Os casos incluem três NPCs, seis locais, condições de alcance, presença, posse, recipiente, horário e uma fixture de rota indisponível. Os dois usos da mesma frase em estados distintos medem a diferença causada pelas regras. A anotação de “Bato perna rumo ao poço” agora registra a intenção executável esperada. O teste antigo continua medindo a recusa segura que de fato ocorre. O playtest HTTP existente aplica um TSV em sequência e é complementar para avaliar contexto acumulado em emuladores.

## Baseline determinístico

| Resultado observado | Original | Desenvolvimento | Reservado | Total de 70 |
| --- | ---: | ---: | ---: | ---: |
| Intenção, alvo e resultado observável corretos em execução ou consulta | 10 | 12 | 6 | 28 |
| Bloqueio correto por regra | 2 | 8 | 4 | 14 |
| Conteúdo fora do WorldPack | 2 | 1 | 1 | 4 |
| Esclarecimento legítimo identificado | 1 | 2 | 1 | 4 |
| Recusa correta de mecânica inexistente | 1 | 0 | 1 | 2 |
| Abstenção correta | 2 | 2 | 3 | 7 |
| Não reconhecimento de intenção executável | 1 | 2 | 2 | 5 |
| Intenção, alvo ou motivo interpretado incorretamente | 0 | 1 | 2 | 3 |
| Pergunta executada indevidamente | 0 | 2 | 1 | 3 |

A concordância com o resultado esperado foi de 59/70, incluindo 25/31 execuções, 3/5 consultas, 20/20 recusas, 4/7 esclarecimentos e 7/7 abstenções. As perguntas com ação indevida somam 3/39 entradas cuja anotação não autorizava executar ação. A amostra é controlada e o conjunto reservado também foi anotado neste trabalho. As proporções servem à comparação entre versões nesta fixture.

- Cinco deslocamentos não reconhecidos usam “bato perna”, “regressar”, “dar uma passada”, “tomo o rumo” e “dou um pulo”. “Vou dar uma passada na oficina” chega ao parser de viagem, mas a expressão inteira é tratada como parte do destino.
- “Examino melhor aquele marco” perde a referência mesmo com foco anterior. “Abro o armário?” e “Vou ao poço?” recebem diagnósticos de alvo desconhecido, apesar de a fixture ter ambos os alvos.
- “Dá para chegar ao bosque por aqui?” e “Onde está Henrique?” entram como fala dirigida automaticamente a Lira e Teresa, respectivamente. A anotação as trata como perguntas ao jogo sem interlocutor explícito. Essa distinção importa porque a fala pode entrar no histórico de uma conversa. “Pego o bloco?” registrou uma transferência quando o corpus esperava confirmação. Nenhuma das negativas ou hipóteses foi executada.

## Contrato e modo sombra

A proposta aceita apenas `{ kind: 'travel', destination }`, `{ kind: 'clarify' }` ou `{ kind: 'abstain' }`. O destino é um ID presente na lista permitida da cena de avaliação. O decodificador rejeita campos extras, alvos desconhecidos e tipos fora do contrato. O avaliador resolve a referência estável e exercita as regras de rota do piloto. Um resultado de rota válida é evidência apenas de viabilidade dentro da fixture. A autorização textual precisa ser avaliada separadamente.

As seis propostas sintéticas são fixas por ID de caso, sem execução de uma segunda ação e sem gravar propostas em recibos. Três destinos coincidiram com intenção, alvo e tempo esperados em cinco falhas de deslocamento. As outras duas falhas de deslocamento pertencem ao conjunto reservado e ficaram sem proposta. Três propostas de abstenção cobrem pergunta, negativa e hipótese. O resultado mede o funcionamento da comparação, pois os alvos sintéticos foram escritos à mão. O conjunto reservado nunca alimenta essas propostas. Diálogo e sequências ficam fora do contrato experimental. Uma extensão exigiria uma proposta por etapa, IDs permitidos por tipo e, para fala direta, uma referência validada ao trecho literal do jogador. O trocador de mensagens do piloto e o narrador não participam do modo sombra.

## Política para um fallback futuro

1. Dar precedência ao reconhecimento determinístico e ao motivo do resultado.
2. Encerrar a tentativa diante de bloqueios por rota, presença, posse, alcance, duração ou qualquer outra regra. Tratar conteúdo inexistente e mecânica indisponível com a resposta do piloto.
3. Esclarecer alvo, turno, condição ou autorização quando houver alternativas legítimas. Tratar consultas, negativas e hipóteses como controles antes de considerar deslocamento.
4. Considerar somente falhas de linguagem com indícios independentes de deslocamento afirmativo e um destino divulgado na cena. O erro genérico de ação incompatível também ocorre em mecânicas inexistentes. Um erro de destino só entra na avaliação se houver evidência textual de referência permitida e de uma formulação mal interpretada. Nesta etapa essa elegibilidade é uma classificação auditada por caso, sem roteamento automático.
5. Decodificar a proposta com a lista permitida, confirmar que o texto autoriza o verbo e o alvo e usar o mesmo estado autoritativo e a mesma projeção. Qualquer fluxo futuro de execução ainda precisa reler revisão e linha temporal e respeitar atomicidade, replay, checkpoints e privacidade.
6. Usar abstenção ou esclarecimento em caso de erro, baixa confiança, ambiguidade ou inconsistência. Históricos privados, fatos de NPC, dados de campanha e efeitos do motor ficam fora da entrada do experimento.

## Próximo experimento autorizado

Executar em modo sombra, offline em relação às campanhas, com o corpus congelado e novas frases cegas anotadas antes da execução. Fornecer apenas texto fictício e referências públicas e necessárias. Registrar a versão do modelo, prompt, parâmetros, número de tentativas e resultado do decodificador e do validador. A revisão das divergências deve usar as anotações e a cena apresentada ao modelo. Reportar casos elegíveis recuperados sobre todos os elegíveis, inclusive falhas e timeouts. Separar erros de intenção, erros de entidade, aceites indevidos sobre os controles negativos, esclarecimentos necessários e recusas corretas. Comparar com o baseline sobre as mesmas entradas e medir latência adicional (mediana e p95), tokens de entrada e saída e custo registrado por proposta e por recuperação correta. Fixar os critérios de decisão antes da coleta e investigar qualquer aceite indevido antes de considerar uma experiência que encaminhe propostas ao piloto.

## Etapa 6.1 — integridade de perguntas

O relatório acima preserva a medição da Etapa 6. A reexecução da mesma lista de frases e fixtures atualiza somente o código esperado para os três esclarecimentos de confirmação. O comportamento esperado já era esclarecer.

| Medida | Etapa 6 | Etapa 6.1 |
| --- | ---: | ---: |
| Resultado esperado | 59/70 | 64/70 |
| Pergunta convertida em ação | 3/39 | 0/39 |
| Execução esperada | 25/31 | 25/31 |
| Consulta correta | 3/5 | 5/5 |
| Esclarecimento legítimo | 4/7 | 7/7 |
| Recusa correta | 20/20 | 20/20 |
| Abstenção correta | 7/7 | 7/7 |

A expressão de transferência aceitava pontuação interrogativa como parte do comando e encaminhava “Pego o bloco?” à coleta. A busca de NPC e a consulta de rota não cobriam “Onde está Henrique?” e “Dá para chegar ao bosque por aqui?”. O fallback de diálogo aceitava uma pergunta solta e usava o único NPC presente como interlocutor. Assim duas consultas acabavam classificadas como conversa.

O servidor agora reconhece as famílias de consulta factual antes de autorizar efeitos e pede esclarecimento para perguntas sem ação afirmativa ou interlocução explícita. Mantém perguntas formuladas em diálogo e as dirigidas em segunda pessoa com foco recente em um NPC presente. As consultas factuais ficam em turno próprio, de modo que uma sequência com uma etapa de consulta ou confirmação pendente é rejeitada antes da narração e da escrita. Negativas e hipóteses sem destinatário não autorizam efeitos. Respostas contextuais à oferta de Teresa continuam sujeitas ao estado da oferta.

Os cinco deslocamentos não reconhecidos e a falha de referência em “Examino melhor aquele marco” continuam no conjunto de erros. Os três destinos sintéticos compatíveis do modo sombra permanecem os mesmos. O fluxo está preparado para comparar propostas reais isoladamente após autorização, usando estes controles e novas frases reservadas. O planejador de rota valida a viabilidade do destino, enquanto uma avaliação independente precisa verificar a autorização textual, os erros e os custos antes de considerar integração.

## Etapa 7 — protocolo de comparação offline

O runner conserva os 70 casos e as três partições. O baseline ainda produz 64/70 resultados esperados e 0/39 ações indevidas em casos que não autorizam ação. O conjunto elegível tem cinco viagens, das quais duas são reservadas. Os demais casos incluem cinco viagens reconhecidas, 12 consultas ou formulações não afirmativas, 14 bloqueios por regra, três destinos inexistentes, uma ambiguidade de destino, seis outros esclarecimentos, um objeto inexistente e 23 casos restantes.

A elegibilidade é uma revisão prévia do enunciado completo na fixture fictícia. Ela verifica que há um único deslocamento afirmativo, linguagem pública suficiente e ausência de dependência de histórico ou conteúdo privado. Além dessa revisão, a ferramenta exige que o piloto tenha devolvido um erro de reconhecimento da viagem ou de análise do destino, sem bloqueio de etapa. Essa revisão vale somente para as frases auditadas. As referências candidatas vêm do catálogo público de Freixo e passam pelo mesmo planejador de distância e rota do piloto. Os IDs de destino no protocolo são estáveis. O planejador continua aceitando origens com referências estáveis e legadas.

O lote sintético padrão fornece três destinos corretos em cinco elegíveis e três abstenções em controles. Há 3/3 destinos corretos entre as três propostas de viagem viáveis enviadas. Os dois casos reservados ficam sem resposta sintética. Os testes adicionais fornecem viagens artificiais para comandos já reconhecidos, perguntas, negativas, hipóteses, ambiguidade e destinos bloqueados ou inexistentes. Também verificam um destino incorreto mas alcançável, que conta como erro mesmo passando pela regra de rota.

### Reprodução local

```powershell
node --import tsx scripts/pilotCommandEvaluation.ts --details
node --import tsx scripts/pilotCommandEvaluation.ts --requests > entradas-sombra.json
node --import tsx scripts/pilotCommandEvaluation.ts --proposals propostas-sombra.json --details
```

O primeiro comando roda o lote sintético. O segundo exporta apenas ID de caso, frase, origem e nomes e IDs dos destinos permitidos. O terceiro substitui o lote sintético pelas propostas do arquivo. O resumo e as linhas de detalhes contêm o gabarito e são para uso local do avaliador. O formato de importação é uma lista JSON com um registro por ID. Os campos de telemetria abaixo são opcionais e devem vir de medições reais ou da fatura. A ausência de um campo é reportada separadamente de zero.

```json
[
  {"id":"original-17","proposal":{"kind":"travel","destination":"freixo-poco"}},
  {"id":"development-01","proposal":{"kind":"clarify"}},
  {"id":"development-02","proposal":{"kind":"abstain"}},
  {"id":"holdout-01","telemetry":{}}
]
```

Uma linha com ID e sem proposta representa uma tentativa sem resposta, como timeout. Omissão da linha também entra no denominador de elegíveis. IDs de caso duplicados ou desconhecidos e envelopes inválidos encerram a importação. Campos opcionais em `telemetry` são `latencyMs` (tempo total adicionado pela tentativa da submissão ao resultado, incluindo espera, retries e decodificação externa quando existirem), `inputTokens`, `outputTokens` e `costUsd`. O relatório mostra cobertura da telemetria, latências p50 e p95 pelo método do posto mais próximo, totais observados de tokens e custo, e custo por recuperação somente quando houver custo registrado para todos os elegíveis. Registre zero explicitamente quando for confirmado. O runner opera exclusivamente com arquivos e fixtures em memória. A execução com provedor está desabilitada.

### Primeira comparação real, mediante autorização explícita

1. Congele a versão do código, as entradas exportadas e o gabarito local. Registre provedor, versão exata do modelo, prompt e parâmetros. Preserve os dois casos reservados sem revisão do prompt a partir das respostas.
2. Envie cada entrada exportada isoladamente, em uma chamada e sem histórico, a uma ferramenta externa autorizada. Mantenha os controles inelegíveis no teste local. Um prompt inicial reproduzível é “Classifique a intenção expressa no comando dado o local de origem e os destinos permitidos. Responda com um único objeto JSON. Use {kind: travel, destination: ID} somente para um deslocamento único afirmativo com destino inequívoco da lista. Use {kind: clarify} quando for necessário perguntar ao jogador. Use {kind: abstain} quando a intenção estiver fora do escopo. Use aspas duplas nos nomes e valores JSON.” Anexe somente o objeto correspondente em `entradas-sombra.json`.
3. Copie o JSON retornado para `proposal` junto ao ID original. Use o formato de tentativa sem resposta para timeout ou falha antes de receber a saída. Para uma saída textual inválida, preserve a string bruta no campo `proposal` para que a avaliação a conte como inválida. Registre duração, tokens e custo da tentativa, inclusive tentativas malsucedidas quando houver medição. Rode a importação e mantenha os resultados reservados no relatório por partição.
4. Compare recuperações corretas sobre todos os elegíveis, destino correto sobre todas as propostas de viagem elegíveis e, separadamente, sobre as propostas de rota válida. Inspecione destinos incorretos, IDs inválidos, tentativas de viagem sobre controles, esclarecimentos, abstenções e ausências. Uma rota viável para outro destino é uma aceitação indevida no ensaio, ainda que o jogo não a execute. Compare latências, tokens e custos observados. O protocolo de viagem mede destino, que é sua única referência de entidade.

Critério inicial para avançar a uma rodada cega maior: pelo menos três recuperações em cinco elegíveis, incluindo pelo menos uma das duas reservadas, e zero aceites indevidos ou propostas inválidas no lote real. Os controles locais devem continuar com zero ações indevidas e zero viagens aprovadas pelo modo sombra em casos inelegíveis. Aplique o mesmo protocolo a novas frases previamente auditadas se a rodada inicial justificar a expansão. Latência e custo precisam ser medidos antes de julgar viabilidade em jogo. Esta rodada pequena serve para decidir se vale ampliar o experimento.

## Etapa 7.2 — benchmark cego ampliado

### Registro da rodada exploratória

Na rodada web anterior foram registrados 5/5 resultados recuperados, incluindo 2/2 casos reservados, com zero destinos errados ou propostas inválidas. No segundo pedido houve uma possível repetição. O contexto da resposta anterior, `abstain`, não foi confirmado, e a resposta posterior foi `travel`. O resultado registrado não estabelece uma taxa de acerto em primeira tentativa.

### Lote congelado

Há 24 frases novas. Doze são viagens afirmativas (10 coloquiais e duas convencionais). As demais se dividem em seis grupos de dois casos: perguntas de rota, hipóteses, negativas, destinos ambíguos, inexistentes e bloqueados. Oito casos compõem a partição reservada, identificada só no relatório local. As duas fixtures com destino bloqueado removem as rotas de entrada de um único local para manter outras opções disponíveis.

O baseline do lote novo tem 14/24 resultados esperados e zero ações indevidas. Das 12 viagens afirmativas, duas estão corretas, sete recebem erros de reconhecimento elegíveis e três caem em outros erros do reconhecedor, fora da política conservadora atual. Entre os oito casos reservados, dois são elegíveis. O corpus anterior conserva seus 64/70 resultados.

O relatório separa o diagnóstico semântico de cada resposta (`diagnostic`) da simulação da política (`policy`). Os controles são enviados exclusivamente para avaliar o modelo. Uma viagem sugerida para controle conta como erro diagnóstico mesmo se o ID estiver fora da lista ou a proposta for inválida. Viagens afirmativas reconhecidas e as três mal classificadas fora da política entram na precisão semântica, porém não no denominador de recuperação do fallback. Uma viagem para destino permitido mas incorreto é um erro de alvo. Um ID fora da lista é uma proposta inválida. Uma pergunta de rota tem resposta esperada `abstain` no contrato de viagem, embora o piloto possa respondê-la como consulta factual. Uma alternativa ambígua pede `clarify`. Hipóteses, negativas e destinos indisponíveis pedem `abstain`.

### Procedimento manual

Execute no PowerShell, na raiz do repositório.

```powershell
$entradas = Join-Path $env:TEMP 'echo-arc-cego-entradas.json'
$respostas = Join-Path $env:TEMP 'echo-arc-cego-respostas.json'
$relatorio = Join-Path $env:TEMP 'echo-arc-cego-relatorio.json'
node --import tsx scripts/pilotBlindBenchmark.ts --requests |
    Set-Content -LiteralPath $entradas -Encoding UTF8
Get-Content -LiteralPath $entradas -Raw -Encoding UTF8 | Set-Clipboard
```

Use uma conversa nova, registre data e modelo exibido e cole o prompt abaixo seguido pelo JSON copiado. Envie uma única vez. Somente o arquivo de entradas pode ser incluído. O código do corpus, o relatório e o gabarito ficam locais. A exportação contém identificadores opacos de caso, frase fictícia, origem pública e destinos públicos permitidos.

```text
Interprete cada pedido do array abaixo isoladamente, usando apenas seu command, origin e destinations.

Responda com um único array JSON válido, sem Markdown, com exatamente um registro por pedido no mesmo ordenamento. Copie o id do pedido literalmente. Cada registro deve ter apenas id e proposal.

O objeto proposal deve ter exatamente uma destas formas:
{"kind":"travel","destination":"ID_DA_LISTA"}
{"kind":"clarify"}
{"kind":"abstain"}

Use travel para uma intenção afirmativa de um único deslocamento com destino inequívoco e presente em destinations. Substitua ID_DA_LISTA pelo valor exato de destinations[].id. Use clarify quando a frase propõe uma partida, mas ainda é preciso escolher entre destinos plausíveis na lista. Use abstain para pergunta de rota, hipótese, negativa, destino ausente da lista ou intenção fora do escopo.

Produza apenas propostas. O jogo decide os efeitos.

PEDIDOS
```

Salve a primeira resposta integral em `$respostas` como UTF-8. Preserve omissões e valores inválidos. Se a resposta inteira vier em formato inválido, registre a falha de formato e guarde o original, sem corrigir ou reenviar. O importador rejeita JSON malformado, IDs desconhecidos, IDs duplicados e campos adicionais fora do envelope implementado. Um registro omitido ou sem proposta conta como ausência no denominador.

```powershell
notepad.exe $respostas
node --import tsx scripts/pilotBlindBenchmark.ts --proposals $respostas |
    Set-Content -LiteralPath $relatorio -Encoding UTF8
(Get-Content -LiteralPath $relatorio -Raw -Encoding UTF8 | ConvertFrom-Json).summary |
    ConvertTo-Json -Depth 8
```

### Critério prévio para considerar um protótipo futuro

A rodada deve produzir um lote completo, pelo menos cinco recuperações em sete elegíveis e pelo menos uma recuperação em dois elegíveis reservados. Exigir zero destinos incorretos, zero propostas inválidas, zero sugestões de viagem em controles, dois esclarecimentos corretos e dez abstenções corretas nos controles. A política deve aceitar zero viagens fora da elegibilidade. Relatar os resultados reais mesmo quando o critério falhar. Uma amostra desse porte e uma única resposta em lote são exploratórias. Os pedidos compartilham contexto e podem influenciar uns aos outros, e a interface web não mede latência, confiabilidade nem custo da API.

Após a coleta, registrar o resultado e recomendar se vale um protótipo futuro. A próxima prioridade de desenvolvimento é jogabilidade com NPCs que tomam iniciativa, eventos locais e mundo vivo, preservando autonomia e persistência.
