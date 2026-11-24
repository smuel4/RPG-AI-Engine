# Freixo de testes online

Este modo usa a mesma transação de turno, recibo e projeção de rotinas do piloto local. A campanha reservada conserva o ID para reutilizar as validações existentes. Seu isolamento vem do projeto Firebase dedicado, das credenciais desse projeto e do convite por UID. O servidor não cria campanhas ao iniciar. O frontend autentica com Google e só consulta o documento da campanha reservada. A narração é fixa.

| Ambiente | Configuração |
| --- | --- |
| Desenvolvimento geral | Sem as variáveis do staging. Use o fluxo existente. |
| Piloto emulado | Launcher visual existente, com Auth e Firestore no loopback. |
| Staging online | Build e servidor em produção, com o mesmo conjunto de variáveis públicas de staging. |

## Variáveis de staging

| Nome | Valor ou origem |
| --- | --- |
| VITE_FREIXO_STAGING | true |
| VITE_STAGING_CHECKPOINTS | Omitida ou false por padrão. true exige autorização de publicação e o mesmo valor no build e no runtime |
| VITE_STAGING_PROJECT_ID | echo-ark-staging |
| VITE_STAGING_API_KEY | Chave pública da configuração Web desse projeto |
| VITE_STAGING_APP_ID | App ID público da configuração Web |
| FIREBASE_PROJECT_ID | O mesmo ID de VITE_STAGING_PROJECT_ID |
| FIRESTORE_DATABASE_ID | (default), único banco Standard do projeto |
| NODE_ENV | production |
| PORT | Fornecida pelo Render. No ensaio local, 3000 ou outra livre |
| NARRATOR_MODE | fixed |
| STAGING_OWNER_UID | UID da única conta de teste autorizada, com e-mail verificado |
| STAGING_SERVICE_ACCOUNT_JSON | JSON da conta de serviço dedicada ao projeto de staging, em segredo do servidor |
| STAGING_CLARIFICATION_KEY | 32 bytes aleatórios codificados em 64 caracteres hexadecimais, em segredo do servidor |

O domínio Auth deriva do ID do projeto. As três variáveis públicas de configuração Firebase e a flag Vite entram no build. Preserve os segredos apenas no ambiente do servidor. Use uma conta de serviço dedicada com acesso aos dados do Firestore no projeto de staging, sem permissões em outros projetos. Mantenha a mesma chave de esclarecimento entre reinícios e builds. A troca da chave invalida esclarecimentos pendentes. Recibos já gravados continuam vinculados às tentativas originais.

## Checklist de publicação futura

1. Após autorização, use o projeto Firebase Spark já criado, com o ID exato `echo-ark-staging`. Registre o app Web, habilite Google no Auth e crie somente o banco Standard (default). Obtenha o UID da conta convidada no Auth. Reserve os dados fictícios exclusivamente para esse projeto.
2. Aplique apenas firestore.staging.rules ao projeto novo, por meio de firebase.staging.json. Primeiro confira o ID no terminal e confirme que é o mesmo do app Web. Em PowerShell, depois de preencher o ambiente de staging:

```powershell
if ($env:FIREBASE_PROJECT_ID -cne 'echo-ark-staging' -or
    $env:VITE_STAGING_PROJECT_ID -cne 'echo-ark-staging') { throw 'Projeto de staging divergente' }
npx.cmd --no-install firebase deploy --only firestore:rules --config firebase.staging.json --project $env:FIREBASE_PROJECT_ID
node --import tsx scripts/provision-staging-pilot.ts --apply $env:FIREBASE_PROJECT_ID
```

O provisionamento só deve ser executado após autorização. Ele cria o convite, a campanha e os NPCs em um lote de criação, que falha integralmente se qualquer documento de destino existir. Para revogar o acesso ao piloto, remova `stagingAccess/pilot`. A API verifica o convite por requisição e o relê dentro das transações de escrita de turnos e checkpoints. Se a remoção entrar primeiro na ordem de commit do Firestore, a operação perde a autorização. Revogar a sessão no Firebase Auth impede a renovação da sessão. O piloto usa o convite para bloquear também o uso de tokens já emitidos.

3. Configure um único Render Web Service Free, com Node 22 LTS atualizado ou 24 LTS, sem meio de pagamento. Use build `npm ci --include=dev && npm run build`, start `npm start` e health check `/api/health`. Configure as variáveis acima antes do build e habilite a origem pública do serviço nos domínios autorizados do Firebase Auth. Mantenha os deploys automáticos desligados durante o ensaio. Frontend e API compartilham a origem.
4. Confirme que a conta convidada pode abrir a campanha e persistir a ida ao quintal, receber o convite de Henrique e recuperar um turno após recarga ou reinício sem duplicação. Teste PC e celular. Em outra conta, verifique a recusa na API e na leitura do Firestore. Teste escrita direta, ID de campanha comum e acesso a estado privado e recibos. O site estático pode ser público. A proteção é aplicada aos dados e às operações.
5. Compartilhe a URL somente depois dessas verificações. A flag desabilita os checkpoints no staging por padrão. As regras do banco bloqueiam o acesso direto aos snapshots e recibos mesmo com a API habilitada.

## Checkpoints autoritativos no piloto local

Em PowerShell, execute `npm.cmd run verify:engine:http -- --alternate --visual` e abra `http://127.0.0.1:13219`. Entre com a conta emulada indicada pelo launcher e abra a campanha reservada de Freixo. Salve um checkpoint, confirme um turno que mude o local e o relógio e então selecione **Carregar**. Confira o local, a data, a hora e a revisão do checkpoint e confirme a restauração. O histórico ativo deve terminar no ponto salvo e continuar na nova linha temporal. A sessão usa dados descartáveis.

A transação grava estado público e privado, revisão, evento e recibo. A restauração mantém as entradas e recibos antigos para auditoria, e o histórico do narrador segue os cortes da linha ativa. A API lista até 30 checkpoints recentes e entrega apenas metadados. Checkpoints legados do fluxo geral continuam no formato original. Os limites atômicos e de tamanho podem recusar operações grandes sem alterar a campanha.

Para habilitar o recurso online, é necessária autorização explícita após aprovação do gate completo em emuladores e teste visual local. A flag faz parte da assinatura da configuração pública do build. O servidor valida essa assinatura no início. Com a flag ativa, a rota usa o Auth e o convite do projeto de staging e mantém a autoria transacional. Desabilitar a flag exige um build correspondente e preserva os snapshots, recibos e operações pendentes. A validação deve cobrir acesso direto negado aos snapshots e recibos, restauração concorrente com um turno, repetição após reinício e ausência de vazamento de memórias. Use uma campanha descartável no primeiro ensaio online.

Ao perder a resposta de um checkpoint, recarregue a mesma aba, entre com a mesma conta se necessário e escolha **Retomar checkpoint**. A identidade do pedido fica no armazenamento da sessão da aba, vinculada ao ambiente, à conta e à campanha. O reenvio usa o mesmo recibo. Fechar a aba ou apagar o armazenamento pode eliminar a referência local.

As duas notas estáticas pessoais identificadas no bundle descrevem familiaridade de Teresa com a vila e ensinamentos de Henrique que Samuel já recebeu. São conteúdo narrativo inofensivo conhecido pelo protagonista. O rótulo pessoal governa a fala de cada NPC. Memórias gravadas em jogo e futuras revelações confidenciais pertencem ao servidor.

## Reinício e limites

O relógio avança em turnos válidos. O processo não executa simulação contínua. O Firestore mantém revisões, efeitos e recibos após reinício. A trava em memória coordena apenas o processo corrente. Depois de uma resposta perdida ou erro temporário, a interface preserva a identidade e oferece Retomar turno. A transação e o recibo são a proteção persistente contra duplicação. Nesta fase, mantenha uma instância e um testador autorizado.
