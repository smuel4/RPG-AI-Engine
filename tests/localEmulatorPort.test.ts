import assert from 'node:assert/strict';
import test from 'node:test';
import { localEmulatorPort } from '../src/services/localEmulatorPort';

test('portas locais aceitam padrões e substituições explícitas válidas', () => {
  for (const [fallback, alternate] of [[8080, 18080], [9099, 19099]]) {
    assert.equal(localEmulatorPort(undefined, fallback, 'PORT'), fallback);
    assert.equal(localEmulatorPort(String(alternate), fallback, 'PORT'), alternate);
  }
  for (const invalid of ['', '0', '65536', ' 8080', '1e3', '12.5', 'localhost:8080']) {
    assert.throws(() => localEmulatorPort(invalid, 8080, 'PORT'), /PORT/);
  }
});
