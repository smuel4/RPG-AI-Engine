# Referências de locais no WorldPack

`id` é a chave de execução e persistência do catálogo. Em Freixo, ela ainda coincide com o nome legado. `stableId` é uma referência exata opcional para chamadas estruturadas do planejador. O resolvedor traduz as duas para a mesma entrada. `name` e `aliases` descrevem nomes que podem ser reconhecidos em comandos. Aliases podem ser ambíguos e ficam fora da resolução de chaves.

Rotas, localizações iniciais, atividades, rotinas, objetos e entregas usam a chave `id` no WorldPack V1. As validações rejeitam referências fora desse conjunto e colisões entre chaves estáveis e legadas. O planejador usa a chave de execução no caminho e nos efeitos autorizados.

## Pontos de compatibilidade

| Fluxo | Dependência da chave legada |
| --- | --- |
| Campanha e NPCs | `Campaign.currentLocation` e `NpcRecord.location` servem à presença, às rotas e às comparações de cena. |
| Persistência do piloto | A posição projetada é gravada na campanha e no resultado do recibo. Posições de objetos no chão, estado de atividades de NPC e proveniência espacial também carregam referências de local. |
| Checkpoints e linhas temporais | O snapshot grava a localização da campanha e dos NPCs. A restauração os devolve ao estado ativo e conserva o histórico das outras linhas. |
| Replay e histórico | O recibo e os registros narrativos retornam o resultado já confirmado. Textos históricos e resumos de eventos são registros do turno original. |
| Apresentação | A narração e a localização exibida pelo painel ainda usam o valor legado em vários pontos. A lista de saídas usa os aliases do catálogo. |

## Antes de gravar IDs estáveis

Separar a apresentação da chave em narração e painel e adaptar, na mesma revisão de contrato, presença de NPCs, rotinas, rotas e objetos. Verificar leitura mista, restauração de snapshots antigos, concorrência transacional e replay em linhas distintas. Uma eventual migração precisa ser versionada e preservar os recibos e textos históricos. Nesta etapa, nenhum registro é regravado.
