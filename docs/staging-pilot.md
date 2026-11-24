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

O provisionamento só deve ser executado após autorização. Ele cria o convite, a campanha e os NPCs em um lote de criação, que falha integralmente se qualquer documento de destino existir. Para revogar acesso, remova stagingAccess/pilot. O servidor exige que esse documento concorde com o UID configurado e volta a conferir autoria na transação do piloto.

3. Configure um único Render Web Service Free, com Node 22 LTS atualizado ou 24 LTS, sem meio de pagamento. Use build `npm ci --include=dev && npm run build`, start `npm start` e health check `/api/health`. Configure as variáveis acima antes do build e habilite a origem pública do serviço nos domínios autorizados do Firebase Auth. Mantenha os deploys automáticos desligados durante o ensaio. Frontend e API compartilham a origem.
4. Confirme que a conta convidada pode abrir a campanha e persistir a ida ao quintal, receber o convite de Henrique e recuperar um turno após recarga ou reinício sem duplicação. Teste PC e celular. Em outra conta, verifique a recusa na API e na leitura do Firestore. Teste escrita direta, ID de campanha comum e acesso a estado privado e recibos. O site estático pode ser público. A proteção é aplicada aos dados e às operações.
5. Compartilhe a URL somente depois dessas verificações. Nesta versão salvar e restaurar checkpoints fica bloqueado no staging, tanto na interface quanto pelas regras do banco. Testes que dependam de checkpoints precisam aguardar um fluxo autoritativo que inclua estado privado e corte de timeline.

## Reinício e limites

O relógio avança em turnos válidos. O processo não executa simulação contínua. O Firestore mantém revisões, efeitos e recibos após reinício. A trava em memória coordena apenas o processo corrente. Depois de uma resposta perdida ou erro temporário, a interface preserva a identidade e oferece Retomar turno. A transação e o recibo são a proteção persistente contra duplicação. Nesta fase, mantenha uma instância e um testador autorizado.
