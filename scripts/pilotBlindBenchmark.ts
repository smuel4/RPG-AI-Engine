import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { blindCorpus } from './pilotBlindCorpus';
import { evaluateCommand, evaluateShadow, evaluationCatalog, publicTravelRequest, readExternalResults } from './pilotCommandEvaluation';

function publicRequest(sample: typeof blindCorpus[number]) {
  const request = publicTravelRequest(sample.id, sample.text, sample.scene.location, evaluationCatalog(sample.scene));
  assert.ok(request, 'Origem ausente na fixture ' + sample.id);
  return request;
}

export function exportBlindRequests() {
  return blindCorpus.map(publicRequest);
}

export async function evaluateBlindBenchmark(input: unknown = []) {
  const proposals = readExternalResults(input, blindCorpus);
  const rows = await Promise.all(blindCorpus.map(async (sample) => {
    const request = publicRequest(sample);
    const baseline = await evaluateCommand(sample, proposals, sample.group === 'travel');
    const eligible = baseline.request !== undefined;
    const offered = proposals.get(sample.id)?.proposal;
    const diagnostic = offered === undefined ? undefined : evaluateShadow(offered,
      sample.scene.location, evaluationCatalog(sample.scene), new Set(request.destinations.map(({ id }) => id)));
    const wrongTarget = sample.expectedProposal === 'travel' && diagnostic?.status === 'route-valid' &&
      diagnostic.target !== sample.steps[0]?.target;
    const correct = sample.expectedProposal === 'travel'
      ? diagnostic?.status === 'route-valid' && !wrongTarget && diagnostic.minutes === sample.minutes
      : diagnostic?.status === sample.expectedProposal;
    return { id: sample.id, group: sample.group, split: sample.split, eligible,
      baseline: baseline.category, expectedProposal: sample.expectedProposal, expectedTarget: sample.steps[0]?.target,
      diagnostic, offeredTravel: baseline.proposedTravel, policy: baseline.shadow, received: baseline.received,
      correct, wrongTarget, recovered: baseline.shadowRecovery };
  }));
  const count = (subset: typeof rows) => ({
    cases: subset.length,
    eligible: subset.filter(({ eligible }) => eligible).length,
    correct: subset.filter(({ correct }) => correct).length,
    recoveries: subset.filter(({ recovered }) => recovered).length,
    wrongTargets: subset.filter(({ wrongTarget }) => wrongTarget).length,
    inappropriateTravelSuggestions: subset.filter(({ group, offeredTravel }) => group !== 'travel' && offeredTravel).length,
    correctClarifications: subset.filter(({ correct, expectedProposal }) => correct && expectedProposal === 'clarify').length,
    correctAbstentions: subset.filter(({ correct, expectedProposal }) => correct && expectedProposal === 'abstain').length,
    invalid: subset.filter(({ diagnostic }) => diagnostic?.status === 'invalid').length,
    missing: subset.filter(({ diagnostic }) => !diagnostic).length,
    policyRouteValidOutsideEligibility: subset.filter(({ eligible, policy }) => !eligible && policy?.status === 'route-valid').length,
  });
  return { summary: { ...count(rows),
    baseline: Object.fromEntries([...new Set(rows.map(({ baseline }) => baseline))].map((category) =>
      [category, rows.filter(({ baseline }) => baseline === category).length])),
    byGroup: Object.fromEntries([...new Set(rows.map(({ group }) => group))].map((group) =>
      [group, count(rows.filter((row) => row.group === group))])),
    reserved: count(rows.filter(({ split }) => split === 'holdout')),
  }, rows };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [mode, file, ...extra] = process.argv.slice(2);
  if (mode === '--requests' && file === undefined) {
    console.log(JSON.stringify(exportBlindRequests(), null, 2));
  } else if ((mode === '--baseline' && file === undefined) || (mode === '--proposals' && file && !extra.length)) {
    const input = file ? JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/u, '')) : [];
    console.log(JSON.stringify(await evaluateBlindBenchmark(input), null, 2));
  } else {
    throw new Error('Use --requests, --baseline ou --proposals arquivo.json. Execução com provedor desabilitada.');
  }
}
