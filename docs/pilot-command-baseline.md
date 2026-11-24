# Baseline de comandos naturais de Freixo

O caso `baseline natural` em `tests/persistPilotTurn.test.ts` executa o corpus no fluxo autoritativo com armazenamento em memória e narração determinística. Cada entrada parte de uma nova cópia da campanha. O caso contextual prepara o foco antes da medição. Aceites verificam posição e relógio. Recusas comparam todos os documentos antes e depois do turno.

O piloto reconhece deslocamento, observação, conversa e consultas, espera, organização, ajuda, abertura, fechamento e transferências de objetos. Uma etapa posterior valida presença, alcance, posse, rota e outros requisitos. A gramática de deslocamento do piloto é mais restrita que a interface geral de planejamento. A detecção do prefixo e o separador de etapas agora reutilizam o vocabulário do piloto. O restante da precedência foi preservado.

## Proposta de contrato para avaliação em modo sombra

```ts
type TravelProposal =
  | { kind: 'travel'; destination: string }
  | { kind: 'clarify'; question: string }
  | { kind: 'abstain' };
```

O primeiro experimento pode se limitar a deslocamento. A entrada contém o comando original e referências de locais autorizadas para divulgação na cena. O servidor deve decodificar a proposta em tempo de execução, rejeitar referências desconhecidas, conferir se o texto autoriza a ação e submeter qualquer destino ao mesmo planejador de rota. Duração, posição final, recibo e efeitos pertencem ao motor. O modo sombra registra somente o resultado comparativo e nunca encaminha a proposta para gravação.

Usar o mesmo corpus e os mesmos estados iniciais para comparar acerto de intenção e alvo, aceites indevidos, esclarecimentos e falhas de linguagem versus falta de conteúdo. Medir latência e custo quando houver autorização para chamadas reais. Perguntas, negativas, hipóteses, destinos desconhecidos e etapas inválidas entram como controles negativos. A cobertura deve incluir frases espontâneas e casos inéditos antes de tomar decisões sobre integração.
