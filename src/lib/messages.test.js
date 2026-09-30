import test from 'node:test';
import assert from 'node:assert/strict';
import { splitMessage } from './messages.js';

test('the first sentence becomes a short title, the rest the explanation', () => {
  assert.deepEqual(
    splitMessage('Parte troppo grande (~172 MB): su questo dispositivo il limite per parte è ~160 MB. Dividi in almeno 3 parti.'),
    { title: 'Parte troppo grande (~172 MB)', detail: 'Su questo dispositivo il limite per parte è ~160 MB. Dividi in almeno 3 parti.' },
  );
  assert.deepEqual(
    splitMessage('Il file è vuoto (0 byte). Scegli un file audio valido.'),
    { title: 'Il file è vuoto (0 byte).', detail: 'Scegli un file audio valido.' },
  );
});

test('short messages and decimals stay intact', () => {
  assert.deepEqual(splitMessage('Export annullato.'), { title: 'Export annullato.', detail: '' });
  assert.deepEqual(splitMessage('Peso 85.8 MB pronto'), { title: 'Peso 85.8 MB pronto', detail: '' });
  assert.deepEqual(splitMessage(''), { title: '', detail: '' });
});
