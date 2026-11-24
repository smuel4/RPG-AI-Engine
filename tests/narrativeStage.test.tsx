import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { NarrativeStage } from '../src/components/NarrativeStage';
import { createEchoArcBundle } from '../src/engine/echoArcFixture';
import { formatWorldClock } from '../src/engine/constants';

test('mantém o histórico completo e o campo de esclarecimento ao consultar outro painel', () => {
  const { campaign, narrative } = createEchoArcBundle('dono');
  const entries = Array.from({ length: 150 }, (_, sequence) => ({
    ...narrative[0], id: String(sequence), sequence, content: 'Mensagem ' + sequence,
  }));
  const html = renderToStaticMarkup(<NarrativeStage campaign={campaign} entries={entries}
    historyVisible={false} isMutating={false} clarification="Qual objeto você deseja examinar?"
    onSubmitAction={async () => true} onCancelClarification={() => {}} />);
  assert.equal((html.match(/<article\b/g) ?? []).length, 150);
  assert.match(html, /aria-label="Histórico narrativo"[^>]+overflow-y-auto[^>]+hidden lg:block/);
  assert.match(html, /<label[^>]+for="player-action-input"[^>]*>Informe o objeto/);
  assert.match(html, /<textarea[^>]+id="player-action-input"/);
  assert.match(html, /Qual objeto você deseja examinar\?/);
  assert.match(html, /Cancelar e escrever outra ação/);
});

test('envio normal usa o botão de ação e só oferece retomada quando a requisição termina', () => {
  const { campaign, narrative } = createEchoArcBundle('dono');
  const props = { campaign, entries: narrative, onSubmitAction: async () => true };
  const sending = renderToStaticMarkup(<NarrativeStage {...props} pendingAction="Observo a cozinha."
    isMutating={true} clarification="Qual objeto você deseja examinar?" />);
  assert.match(sending, /aria-busy="true"[^>]*class="[^"]*min-w-\[8\.5rem\]/);
  assert.match(sending, /Registrando/);
  assert.match(sending, /<textarea[^>]+readOnly/);
  assert.match(sending, /Qual objeto você deseja examinar/);
  assert.doesNotMatch(sending, /Turno pendente|Retomar turno/);
  const recovery = renderToStaticMarkup(<NarrativeStage {...props} pendingAction="Observo a cozinha."
    isMutating={false} onResumePending={() => {}} />);
  assert.match(recovery, /Turno pendente: Observo a cozinha/);
  assert.match(recovery, /Retomar turno/);
  const conflict = renderToStaticMarkup(<NarrativeStage {...props} pendingAction="Observo a cozinha."
    isMutating={false} pendingConflict onDiscardPending={() => {}} />);
  assert.match(conflict, /Descartar tentativa local/);
  assert.doesNotMatch(conflict, /Retomar turno/);
  const rejected = renderToStaticMarkup(<NarrativeStage {...props} isMutating={false} gameplayFeedback="Objeto fora de alcance." />);
  assert.match(rejected, /Objeto fora de alcance/);
  const confirmed = renderToStaticMarkup(<NarrativeStage {...props} isMutating={false} />);
  assert.doesNotMatch(confirmed, /Turno pendente|Retomar turno|Registrando/);
  const pilot = renderToStaticMarkup(<NarrativeStage {...props} isMutating={false} automaticDuration />);
  assert.doesNotMatch(pilot, /Tempo gasto/);
  assert.ok(pilot.includes(formatWorldClock(campaign.worldTime)));
  const discovery = renderToStaticMarkup(<NarrativeStage {...props} isMutating={false} automaticDuration
    gameplayFeedback="Samuel não reconhece esse destino." scene={{
      revision: campaign.revision, timelineId: 'tl_root', location: campaign.currentLocation,
      exits: [{ id: 'well', label: 'poço' }], people: [{ id: 'teresa', name: 'Teresa', available: true }],
      landmarks: [{ id: 'cupboard', name: 'armário' }],
    }} />);
  assert.match(discovery, /<details.*?<summary[^>]*>O que há aqui<\/summary>/);
  assert.match(discovery, /Saídas:<\/dt> <dd[^>]*>poço/);
  assert.match(discovery, /Pessoas:<\/dt> <dd[^>]*>Teresa/);
  assert.match(discovery, /Pontos de interesse:<\/dt> <dd[^>]*>armário/);
  assert.match(discovery, /role="status"[^>]*>Samuel não reconhece esse destino/);
  assert.match(discovery, /<textarea[^>]+id="player-action-input"/);
  assert.doesNotMatch(confirmed, /O que há aqui/);
});
