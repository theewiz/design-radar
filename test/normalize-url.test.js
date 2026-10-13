import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLinkedInUrl, isLinkedInPostUrl } from '../src/utils/normalize-url.js';

describe('LinkedIn URL Normalization', () => {
  it('normalizes a standard LinkedIn post URL', () => {
    const raw = 'https://www.linkedin.com/posts/jane-doe-senior-product-designer-12345';
    const expected = 'https://www.linkedin.com/posts/jane-doe-senior-product-designer-12345';
    assert.equal(normalizeLinkedInUrl(raw), expected);
  });

  it('strips query parameters from the URL', () => {
    const raw = 'https://www.linkedin.com/posts/jane-doe-123?trk=public_post&utm_source=share&utm_medium=member_desktop';
    const expected = 'https://www.linkedin.com/posts/jane-doe-123';
    assert.equal(normalizeLinkedInUrl(raw), expected);
  });

  it('strips hash fragments from the URL', () => {
    const raw = 'https://www.linkedin.com/posts/jane-doe-123#comments';
    const expected = 'https://www.linkedin.com/posts/jane-doe-123';
    assert.equal(normalizeLinkedInUrl(raw), expected);
  });

  it('strips unnecessary trailing slashes', () => {
    const raw = 'https://www.linkedin.com/posts/jane-doe-123///';
    const expected = 'https://www.linkedin.com/posts/jane-doe-123';
    assert.equal(normalizeLinkedInUrl(raw), expected);
  });

  it('normalizes domain from linkedin.com to www.linkedin.com', () => {
    const raw = 'https://linkedin.com/posts/jane-doe-123';
    const expected = 'https://www.linkedin.com/posts/jane-doe-123';
    assert.equal(normalizeLinkedInUrl(raw), expected);
  });

  it('normalizes domain from m.linkedin.com to www.linkedin.com', () => {
    const raw = 'https://m.linkedin.com/posts/jane-doe-123';
    const expected = 'https://www.linkedin.com/posts/jane-doe-123';
    assert.equal(normalizeLinkedInUrl(raw), expected);
  });

  it('adds https protocol if protocol is omitted', () => {
    const raw = 'www.linkedin.com/posts/jane-doe-123';
    const expected = 'https://www.linkedin.com/posts/jane-doe-123';
    assert.equal(normalizeLinkedInUrl(raw), expected);
  });

  it('supports LinkedIn feed update URN patterns', () => {
    const raw = 'https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678?trk=feed';
    const expected = 'https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678';
    assert.equal(normalizeLinkedInUrl(raw), expected);
    assert.equal(isLinkedInPostUrl(raw), true);
  });

  it('supports LinkedIn pulse article URLs', () => {
    const raw = 'https://www.linkedin.com/pulse/we-are-hiring-design-leaders-john-smith?utm_campaign=share';
    const expected = 'https://www.linkedin.com/pulse/we-are-hiring-design-leaders-john-smith';
    assert.equal(normalizeLinkedInUrl(raw), expected);
    assert.equal(isLinkedInPostUrl(raw), true);
  });

  it('preserves the case of the post path so the link still resolves', () => {
    // Real Serper result. The trailing hash is case-sensitive, so lowercasing it
    // would store a URL that does not exist.
    const raw = 'https://www.linkedin.com/posts/taomar_productdesign-uiux-designengineering-activity-7512179706696351744-7eJh';

    assert.equal(
      normalizeLinkedInUrl(raw),
      'https://www.linkedin.com/posts/taomar_productdesign-uiux-designengineering-activity-7512179706696351744-7eJh'
    );
  });

  it('preserves the case of a mixed-case post slug', () => {
    const raw = 'https://www.linkedin.com/posts/AcmePay_Senior-Product-Designer-12345';

    assert.equal(normalizeLinkedInUrl(raw), raw);
    assert.equal(
      normalizeLinkedInUrl(`${raw}?trk=public_profile#comments`),
      raw,
      'query and fragment removal must not alter the path'
    );
  });

  it('lowercases the host because DNS is case-insensitive', () => {
    const raw = 'https://WWW.LinkedIn.COM/posts/AcmePay_Senior-Product-Designer-12345';

    assert.equal(
      normalizeLinkedInUrl(raw),
      'https://www.linkedin.com/posts/AcmePay_Senior-Product-Designer-12345'
    );
  });

  it('lowercases the feed URN path without altering its identifiers', () => {
    const raw = 'https://www.linkedin.com/feed/update/URN:LI:Activity:7123456789012345678';
    const expected = 'https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678';
    assert.equal(normalizeLinkedInUrl(raw), expected);
  });

  it('rejects non-LinkedIn URLs', () => {
    assert.equal(normalizeLinkedInUrl('https://twitter.com/posts/123'), null);
    assert.equal(normalizeLinkedInUrl('https://example.com/job/senior-designer'), null);
    assert.equal(isLinkedInPostUrl('https://example.com'), false);
  });

  it('rejects general LinkedIn profile URLs (not posts)', () => {
    assert.equal(normalizeLinkedInUrl('https://www.linkedin.com/in/janedoe'), null);
    assert.equal(isLinkedInPostUrl('https://www.linkedin.com/in/janedoe'), false);
  });

  it('rejects LinkedIn job board and login pages', () => {
    assert.equal(normalizeLinkedInUrl('https://www.linkedin.com/jobs/view/12345'), null);
    assert.equal(normalizeLinkedInUrl('https://www.linkedin.com/login'), null);
  });

  it('handles malformed and empty inputs gracefully', () => {
    assert.equal(normalizeLinkedInUrl(''), null);
    assert.equal(normalizeLinkedInUrl(null), null);
    assert.equal(normalizeLinkedInUrl(undefined), null);
    assert.equal(normalizeLinkedInUrl('not a url'), null);
    assert.equal(isLinkedInPostUrl(''), false);
    assert.equal(isLinkedInPostUrl(null), false);
  });
});
