# RPG AI Engine — Primeiro Marco Funcional

Construção da base modular e persistente do **RPG AI Engine** em React, TypeScript, Node.js, Firebase Authentication e Cloud Firestore, entregando a interface completa de campanha em português (PT-BR), validação determinística de regras, auditoria de eventos e a campanha de teste **ECHO ARC** com persistência real em nuvem.

---

### User Review & Critical Decisions

> [!IMPORTANT]
> As preferências abaixo foram confirmadas na etapa de alinhamento e orientam toda a arquitetura desta primeira versão:

- **Estética Visual**: Tema escuro em obsidiana profunda e dourado antigo (*anime-fantasy* elegante e contido, sem exageros visuais ou efeitos neon).
- **Autenticação**: Login exclusivo com **Google Sign-In** via Firebase Authentication (`signInWithPopup`), permitindo configuração imediata sem necessidade de ativar provedores adicionais manualmente no Console do Firebase.
- **Modelo de Persistência**: **Sincronização automática** no Cloud Firestore para cada ação e alteração confirmada pelo motor de regras, combinada com botões explícitos de **Salvar** (criar ponto de controle/checkpoint), **Carregar** (restaurar um checkpoint salvo) e **Campanhas** (criar, alternar e gerenciar campanhas independentes).
- **Idioma da Interface**: **Português (PT-BR)** em todos os rótulos, controles, mensagens de erro e narrativa inicial fixa da campanha *ECHO ARC*.
- **Provisionamento Externo (Sem Faturamento)**: Durante a execução, será solicitada sua confirmação na interface de configuração do Firebase para provisionar o banco Firestore (nível gratuito) e o projeto associado. Nenhum serviço pago ou API de IA generativa será ativado nesta etapa.

---

### 1. Overview & Core Concept

- **O que faz**: Fornece um motor de RPG narrativo focado em integridade de dados e memória persistente. Diferente de chats genéricos onde o texto é a única fonte de verdade, cada campanha mantém estado estruturado (personagem, inventário, moedas, NPCs, calendário do mundo e log de eventos auditável) sincronizado no Cloud Firestore.
- **Público-alvo**: Jogadores e criadores de campanhas narrativas que precisam de consistência mecânica, controle absoluto sobre as decisões do protagonista (Samuel) e histórico auditável antes de conectar o narrador com Gemini API na próxima etapa.
- **Valor principal**: Separação rigorosa entre interface, motor de regras determinístico, camada de persistência e adaptador futuro de IA — garantindo que ações inválidas nunca corrompam o estado do jogo e que recarregar a página ou trocar de dispositivo restaure exatamente a campanha da conta autenticada.

---

### 2. User Experience & Visual Design

#### Fluxos Principais do Usuário

1. **Entrada e Autenticação**: Ao abrir o aplicativo, o jogador vê uma tela de entrada limpa apresentando o *RPG AI Engine* e um único botão de ação principal para entrar com a conta Google. Durante o carregamento inicial da sessão, exibe-se um estado neutro de verificação.
2. **Seleção ou Criação de Campanha**: Após autenticar, caso não haja campanha ativa, o jogador acessa a lista de campanhas da conta ou cria uma nova campanha (incluindo o modelo pré-configurado **ECHO ARC** — Samuel, 18 anos, Vila de Freixo, pais adotivos Teresa e Henrique, calendário inicial e inventário estruturado). Cada campanha recebe um identificador único independente.
3. **Mesa Principal da Campanha (Desktop e Mobile)**:
   - **Desktop (1440px)**: Layout em três colunas balanceadas com barra superior fixa de 3 zonas (`RPG AI Engine` · campanha atual e local · ações `Salvar`, `Carregar`, `Campanhas` e sair).
   - **Mobile**: Barra superior compacta com menu de campanha e navegação inferior/abas alternando suavemente entre *Narrativa*, *Personagem & Inventário* e *Mundo & Eventos*, mantendo alvos de toque $\ge 44\text{px}$.
4. **Loop de Ação, Inventário e Auditoria**:
   - O jogador lê a narrativa fixa inicial na coluna central e envia ações livres para Samuel pelo campo de comando inferior.
   - O motor de regras valida a ação (rejeitando entradas vazias, inválidas ou tentativas de alterar dados inconsistentes sem confirmação).
   - Ações válidas geram um registro estruturado na narrativa, avançam o relógio do mundo (quando aplicável), gravam um item no **Registro de Eventos** e persistem atomicamente no Firestore.
   - Alterações de teste no **Inventário** (adicionar, consumir, ajustar quantidade de itens ou moedas) passam pela mesma validação de regras, gravam evento auditável e persistem imediatamente na nuvem.
   - Clicar em **Salvar** registra um *checkpoint* completo no Firestore; clicar em **Carregar** lista os *checkpoints* salvos e restaura o estado completo da campanha com novo evento de restauração no log.
   - Falhas de rede, permissão ou validação exibem alertas explícitos e legíveis em português na tela, sem mascarar erros ou simular salvamento local.

#### Identidade Visual & Tema

- **Direção Estética**: Grimório contemporâneo de fantasia e anime — linhas arquitetônicas finas, superfícies foscas em obsidiana, realces contidos em dourado antigo e tipografia editorial legível para longas sessões de leitura.
- **Paleta de Cores (Disciplina 60-30-10)**:
  - *60% Superfície Dominante (Obsidiana)*: `#0B0D12` (fundo principal) e `#11151E` (área narrativa).
  - *30% Superfícies Estruturais*: `#161B26` (painéis laterais), `#1E2534` (elevação sutil), bordas finas `1px` em `rgba(212, 175, 55, 0.14)` e texto principal em marfim suave `#EDE8DC` / secundário `#9CA3AF`.
  - *10% Acento Focal (Dourado Antigo & Estados)*: `#D4AF37` (botão primário, aba ativa, foco), `#10B981` (confirmação persistida com rótulo textual), `#D97706` (aviso de alteração/estado pendente) e `#EF4444` (erro de validação ou falha de salvamento).
- **Tipografia & Hierarquia**:
  - *Títulos e Marca*: `Cinzel` (pesos 600 e 700, `text-wrap: balance`) para nome da campanha, títulos de seção e cabeçalho de capítulo.
  - *Prosa Narrativa e Interface*: `Plus Jakarta Sans` (pesos 400 e 600, `15px–16px`, altura de linha `1.65` na área narrativa, medida confortável de leitura `65ch–75ch`).
  - *Dados Tabulares e Relógio*: `JetBrains Mono` com `tabular-nums` para horário do mundo, dias, quantidades de inventário, moedas e IDs de eventos.
- **Restrições Visuais Aplicadas**:
  - Sem cartões aninhados dentro de cartões: separação por espaçamento e divisores finos de `1px`.
  - Sem pílulas decorativas ou tags coloridas em metadados estáticos (data, localização e atributos usam texto limpo separado por `·`).
  - Sem pontos pulsantes decorativos, prefixos técnicos falsos (`//`, `>_`), barras de telemetria no rodapé ou barras laterais espessas (`border-l-4`).
  - Rótulos de botões em português direto e funcional (`Salvar`, `Carregar`, `Campanhas`, `Enviar Ação`, `Nova Campanha`).

#### Feedback Interativo e Tratamento de Erros

- Transições suaves apenas em `transform` e `opacity` ($\le 200\text{ms}$), respeitando `prefers-reduced-motion`.
- Indicador discreto de sincronização ligado exclusivamente ao estado real da escrita no Firestore (*Sincronizado*, *Salvando...* ou *Falha ao salvar* com mensagem de causa e botão de tentar novamente).
- Estados vazios claros para lista de campanhas, inventário vazio, histórico de eventos e lista de checkpoints.

---

### 3. Key Product Decisions & Trade-Offs

- **Motor de Regras Desacoplado (Domínio Puro em TypeScript)**
  - *Abordagem Escolhida*: Todas as regras fundamentais (validação de ação do jogador, invariantes de quantidade não negativa no inventário, progressão de calendário, controle exclusivo das escolhas de Samuel e geração de registros de auditoria) ficam em módulos puros independentes do React e do Firebase.
  - *Por quê*: Facilita testar os invariantes isoladamente, garante que ações inválidas sejam bloqueadas antes de qualquer escrita no banco e prepara a interface exata para quando o servidor Node.js + Gemini API assumir a geração narrativa na etapa 2.
  - *Alternativas Descartadas*: Colocar mutações de estado diretamente dentro de componentes React ou usar `localStorage` como cache principal (violaria o requisito de verdade estruturada e persistência real).

- **Persistência em Cloud Firestore com Subcoleções Auditáveis + Checkpoints**
  - *Abordagem Escolhida*: Cada campanha é um documento raiz pertencente ao `ownerId` autenticado contendo estado estruturado atual (protagonista, moedas, inventário, NPCs, calendário/horário, cena atual). Histórico narrativo, registro de eventos e pontos de controle (*snapshots*) ficam em subcoleções dedicadas da campanha, gravados em `writeBatch` atômico junto com a atualização do estado.
  - *Por quê*: Mantém o documento da campanha leve e rápido de carregar, garante atomicidade entre estado estruturado e registro de eventos (auditoria fiel) e evita o limite de 1 MB de documento do Firestore conforme a história cresce.
  - *Alternativas Descartadas*: Salvar toda a narrativa e eventos dentro de um único array crescente no documento da campanha.

- **Servidor Node.js / Express Estruturado para Evolução Segura**
  - *Abordagem Escolhida*: Incluir servidor Node.js/Express servindo a aplicação e expondo um endpoint de verificação de saúde e contratos de proxy reservados para a futura integração com a Gemini API, sem nenhuma chave secreta no cliente.
  - *Por quê*: Atende à arquitetura solicitada (React + Node.js + GitHub-ready), mantendo a fronteira limpa para chamadas server-side à Gemini API na próxima fase.

---

### 4. Technical Architecture & Data Strategy *(Technical Reference)*

#### Diagrama de Arquitetura e Fluxo de Dados

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       Interface Web (React + Tailwind)                  │
│  ┌──────────────┐  ┌─────────────────────────┐  ┌────────────────────┐  │
│  │ Personagem & │  │ Área Central Narrativa  │  │ Calendário, Log de │  │
│  │  Inventário  │  │ & Campo de Ação Livre   │  │ Eventos & Ações    │  │
│  └──────┬───────┘  └────────────┬────────────┘  └─────────┬──────────┘  │
└─────────┼───────────────────────┼─────────────────────────┼─────────────┘
          │                       │                         │
          ▼                       ▼                         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│             Camada de Motor de Regras & Estado (Domínio Puro)           │
│  • Validador de Ações do Jogador (controle exclusivo de Samuel)         │
│  • Regras de Inventário, Moedas, NPCs e Relógio do Mundo                │
│  • Gerador de Deltas e Eventos Auditáveis                               │
│  • Contrato de Adaptador Narrativo (Fixo nesta etapa / Gemini na Etapa 2)│
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │ Mutações Validadas
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                Serviço de Persistência & Auth (Firebase SDK)            │
│  • Firebase Auth (Google Sign-In)                                       │
│  • Cloud Firestore (writeBatch atômico: estado + narrativa + eventos)   │
│  • Checkpoints manuais (Salvar / Carregar snapshot completo)            │
│  • Tratamento explícito de erros (sem fallback silencioso)              │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Cloud Firestore & Security Rules                     │
│  • firebase-blueprint.json (IR) + firestore.rules (Zero-Trust por UID)  │
│  • Servidor Node.js/Express (serviço web + base segura para Etapa 2)    │
└─────────────────────────────────────────────────────────────────────────┘
```

#### Modelo de Dados Estruturado (Firestore)

- **`/campaigns/{campaignId}`** (Documento Mestre da Campanha)
  - Metadados: `id`, `ownerId`, `name` (ex.: `"ECHO ARC"`), `setting`, `status` (`active` | `archived`), `revision`, `createdAt`, `updatedAt`.
  - Protagonista (`character`): `name` (`"Samuel"`), `age` (`18`), `origin` (`"Jovem adotado, inicialmente comum"`), `currentLocation` (`"Vila de Freixo"`), `futureHook` (`"Academia de Arvend"`), `currency` (ex.: `copper`, `silver`, `gold`), `attributes` (Vitalidade, Foco, Disposição) e `statusEffects`.
  - Inventário (`inventory`): lista estruturada tipada (`id`, `name`, `category`, `quantity`, `description`, `equipable`, `equipped`) com validação estrita de quantidade $\ge 0$ e limites de tamanho.
  - Personagens do Mundo (`npcs`): mapa/lista estruturada (`id`, `name` — ex.: `"Teresa"`, `"Henrique"`, `role`, `location`, `relationship`, `notes`).
  - Tempo do Mundo (`worldTime`): `day`, `month`, `year`, `season`, `hour`, `minute`, `periodOfDay`.
- **`/campaigns/{campaignId}/narrative/{entryId}`** (Entradas Narrativas Ordenadas)
  - `id`, `ownerId`, `campaignId`, `sequence`, `authorRole` (`system_seed` | `player_action` | `engine_response`), `content`, `worldTimeSnapshot`, `createdAt`.
  - *Regra Fundamental*: A narrativa inicial fixa de *ECHO ARC* serve apenas para apresentação e teste da interface, sem registrar fatos canônicos irreversíveis, e o motor nunca inventa decisões atribuídas a Samuel.
- **`/campaigns/{campaignId}/events/{eventId}`** (Registro Auditável de Eventos)
  - `id`, `ownerId`, `campaignId`, `sequence`, `type` (`CAMPAIGN_CREATED` | `PLAYER_ACTION` | `INVENTORY_ADDED` | `INVENTORY_UPDATED` | `INVENTORY_REMOVED` | `CURRENCY_UPDATED` | `TIME_ADVANCED` | `CHECKPOINT_SAVED` | `CHECKPOINT_LOADED`), `summary`, `actor`, `payload` (antes/depois estruturados), `worldTimeSnapshot`, `createdAt`.
- **`/campaigns/{campaignId}/checkpoints/{checkpointId}`** (Pontos de Controle Manuais)
  - `id`, `ownerId`, `campaignId`, `label`, `note`, `snapshot` (cópia estruturada completa de `character`, `inventory`, `npcs`, `worldTime`, `lastEventSequence`), `createdAt`.

#### Mapeamento de Interações, Segurança e Critérios de Aceitação

- **Segurança no Firestore**: Todas as coleções e subcoleções exigem usuário autenticado verificado (`request.auth.uid == ownerId` e verificação no documento pai via `get()` para subcoleções), validação de chaves estritas (`hasAll` / `hasOnly`), limites de tamanho em strings e listas, imutabilidade de `ownerId` e `createdAt`, e timestamps validados contra `request.time`.
- **Critérios de Aceitação Cobertos**:
  1. Autenticar via Google e criar a campanha **ECHO ARC** (ou campanha personalizada).
  2. Enviar uma ação livre de teste para Samuel e verificar registro simultâneo na narrativa, avanço coerente de tempo (se aplicável) e gravação no **Registro de Eventos**.
  3. Adicionar ou alterar a quantidade de um item do inventário (ou tentar uma quantidade negativa/inválida para comprovar que ações inválidas são bloqueadas sem alterar o estado).
  4. Recarregar a página e confirmar que o estado estruturado, inventário, horário, narrativa e eventos permanecem idênticos a partir do Firestore.
  5. Sair, entrar novamente com a mesma conta Google e recuperar a campanha ativa e seus checkpoints.
  6. Testar erro de salvamento (ex.: desconexão ou rejeição simulada no serviço de persistência) e verificar mensagem clara em português orientando o usuário sem perda silenciosa de estado.
