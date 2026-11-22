// Paths relative to tests/. Emulator and HTTP groups require isolated infrastructure.
export const testGroups = {
  local: [
    'checkpoint.test.ts',
    'echoArcFreeTurn.test.ts',
    'echoArcValidation.test.ts',
    'firestoreRulesSimulator.test.ts',
    'localEmulatorPort.test.ts',
    'narrativeStage.test.tsx',
    'narratorMemory.test.ts',
    'narratorTurn.test.ts',
    'npcMemory.test.ts',
    'npcRelationship.test.ts',
    'npcRoutine.test.ts',
    'pendingTurn.test.ts',
    'persistPilotTurn.test.ts',
    'turnIdentity.test.ts',
    'turnPlanner.test.ts',
  ],
  emulator: [
    'firestoreCheckpointNamedDb.test.ts',
    'firestoreCheckpointOfficial.test.ts',
    'firestoreOwnershipOfficial.test.ts',
    'firestorePilotTurnOfficial.test.ts',
    'firestorePlayerActionOfficial.test.ts',
    'firestoreRestoreProbe.test.ts',
    'firestoreRestoreUpdateOnly.test.ts',
    'firestoreRulesOfficial.test.ts',
  ],
  http: [
    'freixoObjectsHttpOfficial.test.ts',
  ],
};
