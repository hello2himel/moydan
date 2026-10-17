/**
 * Licence policy: what a game may declare, what a derivative may declare, and
 * which notices must survive a remix. These rules are the platform's only legal
 * enforcement point, so they are asserted directly rather than through a route.
 */

import { describe, expect, it } from 'vitest';
import {
  allowedDerivativeLicenses,
  buildAttributionText,
  describeLicense,
  isKnownLicense,
  isOpenSourceLicense,
  licenseAllowsParameterRemix,
  licenseAllowsSourceRemix,
  LICENSE_POLICIES,
  licensePolicy,
  noticesRequiredFor,
  publicationLicenseOptions,
  SPDX_PATTERN,
  validateLicenseDeclaration,
  type LicenseDeclaration,
} from '@moydan/core';

const assetDeclaration: LicenseDeclaration = {
  spdx: 'MIT',
  assets: [{ path: 'assets/*.png', license: 'CC0-1.0', source: 'original artwork' }],
};

describe('SPDX identifiers', () => {
  it('recognises every licence the platform publishes', () => {
    expect(isKnownLicense('MIT')).toBe(true);
    expect(isKnownLicense('AGPL-3.0-only')).toBe(true);
    expect(isKnownLicense('LicenseRef-AllRightsReserved')).toBe(true);
  });

  it('does not recognise an identifier it has never seen', () => {
    expect(isKnownLicense('WTFPL')).toBe(false);
    expect(licensePolicy('WTFPL')).toBeNull();
    // Inherited object keys must not be mistaken for licences.
    expect(isKnownLicense('toString')).toBe(false);
  });

  it('accepts only the identifier character set', () => {
    expect(SPDX_PATTERN.test('MIT')).toBe(true);
    expect(SPDX_PATTERN.test('BSD-2-Clause')).toBe(true);
    expect(SPDX_PATTERN.test('has space')).toBe(false);
    expect(SPDX_PATTERN.test('a')).toBe(false);
  });

  it('reports proprietary licences as not open source', () => {
    expect(isOpenSourceLicense('MIT')).toBe(true);
    expect(isOpenSourceLicense('LicenseRef-AllRightsReserved')).toBe(false);
  });

  it('describes an unknown licence without inventing a policy', () => {
    const described = describeLicense('WTFPL');
    expect(described.family).toBe('unknown');
    expect(described.allowsSourceRemix).toBe(false);
    expect(described.requiresAttribution).toBe(true);
  });

  it('publishes every policy as an option, sorted by name', () => {
    const options = publicationLicenseOptions();
    expect(options).toHaveLength(Object.keys(LICENSE_POLICIES).length);
    const names = options.map((policy) => policy.name);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });
});

describe('code versus asset applicability', () => {
  it('refuses an asset licence for game code', () => {
    expect(licensePolicy('CC-BY-4.0')?.appliesToCode).toBe(false);
    const issues = validateLicenseDeclaration({ spdx: 'CC-BY-4.0', assets: [] });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('error');
    expect(issues[0]?.message).toContain('asset licence');
  });

  it('refuses a code licence for assets', () => {
    const issues = validateLicenseDeclaration({
      ...assetDeclaration,
      assets: [{ path: 'assets/*.png', license: 'GPL-3.0-only', source: 'original artwork' }],
    });
    expect(issues.map((issue) => issue.message).join(' ')).toContain('cannot be used to licence game assets');
  });

  it('refuses proprietary assets outright', () => {
    const issues = validateLicenseDeclaration({
      ...assetDeclaration,
      assets: [{ path: 'assets/*.png', license: 'LicenseRef-AllRightsReserved', source: 'a friend', attribution: 'x' }],
    });
    expect(issues.map((issue) => issue.message).join(' ')).toContain('proprietary assets cannot be redistributed');
  });

  it('requires a source and an attribution line per asset entry', () => {
    const issues = validateLicenseDeclaration({
      spdx: 'MIT',
      assets: [{ path: 'assets/*.png', license: 'CC-BY-4.0', source: '  ', attribution: '' }],
    });
    const messages = issues.map((issue) => issue.message).join(' | ');
    expect(messages).toContain('declare where the asset came from');
    expect(messages).toContain('requires attribution text');
  });

  it('does not require attribution for a public-domain asset', () => {
    const issues = validateLicenseDeclaration({
      spdx: 'MIT',
      assets: [{ path: 'assets/*.png', license: 'CC0-1.0', source: 'original artwork' }],
    });
    expect(issues).toEqual([]);
  });

  it('rejects an unsupported licence before looking at anything else', () => {
    const issues = validateLicenseDeclaration({
      spdx: 'NOPE',
      assets: [{ path: 'assets/*.png', license: 'ALSO-NOPE', source: 'somewhere' }],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('license.spdx');
  });
});

describe('derivative licences', () => {
  it('confines an AGPL derivative to AGPL', () => {
    expect(allowedDerivativeLicenses('AGPL-3.0-only')).toEqual(['AGPL-3.0-only']);
  });

  it('lets a permissive parent be derived under any code licence', () => {
    const allowed = allowedDerivativeLicenses('MIT');
    expect(allowed).toContain('MIT');
    expect(allowed).toContain('AGPL-3.0-only');
    expect(allowed).not.toContain('LicenseRef-AllRightsReserved');
    expect([...allowed]).toEqual([...allowed].sort());
  });

  it('lets an LGPL parent be derived under LGPL, GPL or AGPL but not MIT', () => {
    const allowed = allowedDerivativeLicenses('LGPL-3.0-only');
    expect(allowed).toEqual(['AGPL-3.0-only', 'GPL-3.0-only', 'LGPL-3.0-only']);
    expect(allowed).not.toContain('MIT');
  });

  it('allows no derivative at all under a no-derivatives licence', () => {
    expect(allowedDerivativeLicenses('CC-BY-ND-4.0')).toEqual([]);
    expect(licenseAllowsSourceRemix('CC-BY-ND-4.0')).toBe(false);
    expect(licenseAllowsParameterRemix('CC-BY-ND-4.0')).toBe(false);
  });

  it('allows no derivative under an unknown or proprietary licence', () => {
    expect(allowedDerivativeLicenses('WTFPL')).toEqual([]);
    expect(allowedDerivativeLicenses('LicenseRef-AllRightsReserved')).toEqual([]);
  });

  it('keeps every copyleft family share-alike consistent', () => {
    for (const spdx of ['GPL-3.0-only', 'AGPL-3.0-only', 'MPL-2.0', 'CC-BY-SA-4.0']) {
      expect(allowedDerivativeLicenses(spdx)).toContain(spdx);
    }
  });
});

describe('attribution and notices', () => {
  it('requires attribution for everything except the public-domain licences', () => {
    expect(licensePolicy('MIT')?.requiresAttribution).toBe(true);
    expect(licensePolicy('Apache-2.0')?.requiresAttribution).toBe(true);
    expect(licensePolicy('CC0-1.0')?.requiresAttribution).toBe(false);
    expect(licensePolicy('Unlicense')?.requiresAttribution).toBe(false);
  });

  it('lists the notices a source remix must carry', () => {
    expect(noticesRequiredFor('MIT')).toEqual(['LICENSE', 'ASSET_LICENSES.md']);
    expect(noticesRequiredFor('Apache-2.0')).toEqual(['LICENSE', 'NOTICE', 'ASSET_LICENSES.md']);
    expect(noticesRequiredFor('OFL-1.1')).toEqual(['LICENSE', 'FONT-LICENSE', 'ASSET_LICENSES.md']);
  });

  it('falls back to the bare LICENSE notice for an unknown licence', () => {
    expect(noticesRequiredFor('WTFPL')).toEqual(['LICENSE']);
  });

  it('never repeats a notice', () => {
    expect(new Set(noticesRequiredFor('Apache-2.0')).size).toBe(noticesRequiredFor('Apache-2.0').length);
  });

  it('builds an attribution line naming the child, the parent and the mode', () => {
    const text = buildAttributionText({
      childTitle: 'Neon Dodge',
      childHandle: 'kai',
      parentTitle: 'Bounce Dodge',
      parentHandle: 'nova',
      parentSpdx: 'MIT',
      mode: 'parameters',
    });
    expect(text).toContain('"Neon Dodge" by @kai');
    expect(text).toContain('parameter remix of "Bounce Dodge" by @nova');
    expect(text).toContain('MIT License');
    expect(text).toContain('must be preserved in further remixes');
  });

  it('states the share-alike and network obligations of the parent licence', () => {
    const agpl = buildAttributionText({
      childTitle: 'Child',
      childHandle: 'kai',
      parentTitle: 'Parent',
      parentHandle: 'nova',
      parentSpdx: 'AGPL-3.0-only',
      mode: 'source',
    });
    expect(agpl).toContain('This derivative must be distributed under: AGPL-3.0-only.');
    expect(agpl).toContain('Network users must be offered the corresponding source');
  });

  it('keeps the parent attribution text so a multi-generation chain names every ancestor', () => {
    const text = buildAttributionText({
      childTitle: 'Third',
      childHandle: 'mira',
      parentTitle: 'Second',
      parentHandle: 'kai',
      parentSpdx: 'MIT',
      parentAttributionText: '"Second" by @kai is a remix of "First" by @nova (MIT).',
      mode: 'source',
    });
    expect(text).toContain('"First" by @nova');
  });

  it('omits the share-alike sentence for a permissive parent', () => {
    const text = buildAttributionText({
      childTitle: 'Child',
      childHandle: 'kai',
      parentTitle: 'Parent',
      parentHandle: 'nova',
      parentSpdx: 'MIT',
      mode: 'source',
    });
    expect(text).not.toContain('must be distributed under');
  });
});