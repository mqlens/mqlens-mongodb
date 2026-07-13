import { describe, it, expect } from 'vitest';
import { uriUser, uriReadPreference } from '../clusterHealth';

describe('uriUser', () => {
  it('extracts the user from a user+pass URI', () => {
    expect(uriUser('mongodb://root:pw@h1:27017,h2:27017/db')).toBe('root');
  });

  it('extracts the user from a user-only URI', () => {
    expect(uriUser('mongodb://root@h1:27017/db')).toBe('root');
  });

  it('returns null for an auth-less URI', () => {
    expect(uriUser('mongodb://h1:27017,h2:27017/db')).toBeNull();
  });

  it('decodes a percent-encoded user in a mongodb+srv URI', () => {
    expect(uriUser('mongodb+srv://user%40corp:pw@cluster0.example.mongodb.net/db')).toBe('user@corp');
  });
});

describe('uriReadPreference', () => {
  it('defaults to primary when absent', () => {
    expect(uriReadPreference('mongodb://h1:27017/db')).toBe('primary');
  });

  it('reads readPreference from the query string', () => {
    expect(uriReadPreference('mongodb://h1:27017/db?readPreference=secondaryPreferred')).toBe('secondaryPreferred');
  });

  it('reads readPreference when other params are present', () => {
    expect(
      uriReadPreference('mongodb://h1:27017/db?retryWrites=true&readPreference=secondaryPreferred&w=majority')
    ).toBe('secondaryPreferred');
  });
});
