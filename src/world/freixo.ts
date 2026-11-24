import { defineWorldPack, type NpcIdentity, type WorldPackV1 } from './worldPack';

// The current display labels also serve as persisted location IDs.
export const freixoWoodWorkshop = 'Oficina de Madeira · Vila de Freixo';
export const freixoFamilyYard = 'Quintal da casa da família, Vila de Freixo';
export const freixoFamilyKitchen = 'Cozinha da casa da família, Vila de Freixo';

export const villageWell = 'Poço da Vila de Freixo';
export const freixoWoodland = 'Bosque de Freixo';

export const familyYard = freixoFamilyYard;
export const familyRoom = 'Quarto de Samuel, casa da família, Vila de Freixo';

const familyKitchen = freixoFamilyKitchen;

const routes = [
  { from: familyKitchen, to: familyYard, minutes: 2 },
  { from: familyYard, to: villageWell, minutes: 4 },
  { from: familyKitchen, to: villageWell, minutes: 6 },
  { from: familyKitchen, to: familyRoom, minutes: 1 },
];
export const localCatalog = {
  places: [familyKitchen, familyYard, villageWell, familyRoom].map((id) => ({ id, aliases: [] })),
  routes: routes.flatMap((route) => [route, { ...route, from: route.to, to: route.from }]),
};

export const freixoPlayableCatalog = {
  // Provisional connection for the playable local pilot.
  routes: [...localCatalog.routes,
    { from: familyYard, to: freixoWoodWorkshop, minutes: 4 },
    { from: freixoWoodWorkshop, to: familyYard, minutes: 4 },
    { from: villageWell, to: freixoWoodland, minutes: 5 },
    { from: freixoWoodland, to: villageWell, minutes: 5 }],
  objects: [
    { id: 'demo-armario-cozinha', name: 'armário', aliases: ['armário da cozinha'], location: familyKitchen,
      description: 'Um pequeno armário fixo na cozinha.',
      openable: { aberto: 'O armário está aberto.', fechado: 'O armário está fechado.' } },
    { id: 'demo-bancada-cozinha', name: 'bancada', aliases: ['bancada da cozinha'], location: familyKitchen,
      description: 'Há uma bancada de trabalho na cozinha.',
      condition: { activityId: 'demo-organizar-cozinha', initial: 'A bancada ainda está por organizar.',
        organize: { completed: 'A bancada está organizada.' }, knownBy: ['echo-arc:teresa'] } },
    { id: 'demo-bancada-oficina', name: 'bancada de trabalho', aliases: ['bancada da oficina', 'bancada'],
      location: freixoWoodWorkshop, description: 'Há uma bancada de trabalho na oficina de madeira.' },
    { id: 'freixo-bosque-marco-pedra', name: 'marco de pedra', aliases: ['marco', 'pedra da trilha'],
      location: freixoWoodland, description: 'Um marco de pedra coberto de musgo fica à beira da trilha.' },
    // Initial test fixture for the authoritative pickup and drop flow.
    { id: 'demo-bloco-madeira', name: 'bloco de madeira', aliases: ['bloco'], location: familyKitchen,
      description: 'Um pequeno bloco de madeira sem marcas.',
      // V2 fixture: only Henrique in the workshop is authorized to receive this object.
      portable: { storageId: 'demo-armario-cozinha', delivery: { recipientKey: 'echo-arc:henrique', location: freixoWoodWorkshop } } },
  ],
  activities: [{ id: 'demo-organizar-cozinha', location: familyKitchen, participant: 'Teresa',
    verb: 'organizar', target: 'cozinha', minutes: 5, result: 'A bancada da cozinha ficou organizada.' }],
  occurrences: [{
    id: 'freixo-henrique-pausa', location: familyYard, npcKey: 'echo-arc:henrique', routine: 'next',
    narration: 'Henrique faz um aceno do quintal. “Se quiser conversar sobre a oficina, tenho um tempo agora.”',
  }],
  places: [
    { id: familyKitchen, stableId: 'freixo-cozinha', aliases: ['cozinha', 'casa'] },
    { id: familyYard, stableId: 'freixo-quintal', aliases: ['quintal', 'pátio'] },
    { id: villageWell, stableId: 'freixo-poco', aliases: ['poço'] },
    { id: familyRoom, stableId: 'freixo-quarto', aliases: ['quarto'] },
    { id: freixoWoodWorkshop, stableId: 'freixo-oficina', aliases: ['oficina', 'oficina de madeira', 'oficina de Henrique'] },
    { id: freixoWoodland, stableId: 'freixo-bosque', aliases: ['bosque', 'bosque da vila'],
      description: 'A trilha se estreita sob as copas, e folhas secas cobrem o chão.' },
  ],
} satisfies WorldPackV1['catalog'];

export const echoArcIdentities: Record<string, NpcIdentity> = {
  'Teresa|Mãe adotiva': {
    key: 'echo-arc:teresa',
    temperament: 'Serena, atenta ao cotidiano.',
    voice: 'Tom familiar e tranquilo, com comentários concretos sobre o que está acontecendo.',
    occupation: 'Cuida do lar.',
    objective: 'Organizar a manhã da casa no seu próprio ritmo.',
    routine: { location: 'Casa da Família · Vila de Freixo', fromHour: 6, untilHour: 11,
      activity: 'Organizar a mesa e os afazeres da manhã.',
      dialogue: { kind: 'work', present: 'Estou organizando a mesa e os afazeres da manhã.',
        past: 'Eu estava organizando a mesa e os afazeres da manhã.' } },
    knowledge: [{ source: 'personal', fact: 'Conhece as rotinas da Vila de Freixo.', knownBy: ['echo-arc:teresa'] }],
  },
  'Henrique|Pai adotivo': {
    key: 'echo-arc:henrique',
    temperament: 'Prático, valoriza a disciplina no trabalho.',
    voice: 'Fala direta e familiar, com exemplos do ofício quando cabem na conversa.',
    occupation: 'Artesão de madeira.',
    objective: 'Dar andamento ao trabalho da oficina.',
    routine: { location: freixoWoodWorkshop, fromHour: 6, untilHour: 11,
      activity: 'Trabalhar a madeira na oficina.',
      dialogue: { kind: 'work', present: 'Estou trabalhando a madeira na oficina.',
        past: 'Eu estava trabalhando a madeira na oficina.' } },
    nextRoutine: { location: freixoFamilyYard, fromHour: 11.5, untilHour: 13,
      activity: 'Fazer uma pausa no quintal.',
      dialogue: { kind: 'rest', present: 'Estou fazendo uma pausa no quintal.',
        past: 'Eu estava fazendo uma pausa no quintal.' } },
    knowledge: [{ source: 'personal', fact: 'Ensinou a Samuel noções práticas de ofício e disciplina.',
      knownBy: ['echo-arc:henrique'] }],
  },
};


const teresa = echoArcIdentities['Teresa|Mãe adotiva'];
const henrique = echoArcIdentities['Henrique|Pai adotivo'];
export const freixoLira: WorldPackV1['npcs'][number] = {
  key: 'freixo-local-lira', name: 'Lira', location: villageWell,
};

export const freixoWorldPack = defineWorldPack({
  version: 1,
  catalog: freixoPlayableCatalog,
  npcs: [
    { key: teresa.key, name: 'Teresa', location: familyKitchen,
      identity: { ...teresa, routine: teresa.routine && { ...teresa.routine, location: familyKitchen } } },
    { key: henrique.key, name: 'Henrique', location: freixoWoodWorkshop, identity: henrique },
    freixoLira,
  ],
});
