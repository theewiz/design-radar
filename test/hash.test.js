import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sha256, normalizeText, createContentFingerprint } from '../src/utils/hash.js';

describe('Hashing and Fingerprinting Utility', () => {
  it('computes consistent SHA-256 digests', () => {
    const input = 'Senior Product Designer Fintech';
    const hash1 = sha256(input);
    const hash2 = sha256(input);

    assert.equal(hash1, hash2);
    assert.equal(typeof hash1, 'string');
    assert.equal(hash1.length, 64);
  });

  it('produces different hashes for different inputs', () => {
    const hashA = sha256('Role A');
    const hashB = sha256('Role B');
    assert.notEqual(hashA, hashB);
  });

  it('throws TypeError if non-string is passed to sha256', () => {
    assert.throws(() => sha256(12345), {
      name: 'TypeError',
    });
    assert.throws(() => sha256(null), {
      name: 'TypeError',
    });
  });

  it('normalizes whitespace and casing properly in normalizeText', () => {
    const messy = '   Senior    Product\n\tDesigner  Fintech   ';
    assert.equal(normalizeText(messy), 'senior product designer fintech');
    assert.equal(normalizeText(''), '');
    assert.equal(normalizeText(null), '');
    assert.equal(normalizeText(undefined), '');
  });

  it('generates identical content fingerprints for matching text regardless of whitespace/casing', () => {
    const titleA = 'Jane Doe on LinkedIn: Senior Product Designer';
    const snippetA = 'We are hiring a Senior Product Designer for our Payments team in Europe (Remote).';

    const titleB = '  JANE DOE on LinkedIn: Senior Product Designer  ';
    const snippetB = 'We  are hiring a senior product designer for our payments team in europe (remote).';

    const fingerprintA = createContentFingerprint(titleA, snippetA);
    const fingerprintB = createContentFingerprint(titleB, snippetB);

    assert.equal(fingerprintA, fingerprintB);
    assert.equal(fingerprintA.length, 64);
  });

  it('generates distinct fingerprints for differing snippets', () => {
    const fp1 = createContentFingerprint('Role', 'Hiring at Company A');
    const fp2 = createContentFingerprint('Role', 'Hiring at Company B');

    assert.notEqual(fp1, fp2);
  });
});
