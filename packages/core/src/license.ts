/**
 * Licence policy.
 *
 * Design rules (see docs/LICENSING.md):
 * 1. A game may only be published when its code licence and every redistributable
 *    asset licence is explicitly declared and recognised.
 * 2. Copyleft is respected: share-alike parents restrict the licence of derived
 *    games. We never claim that two arbitrary licences are compatible.
 * 3. "Publicly visible" is not a licence. Repositories/files without an explicit
 *    grant are rejected.
 * 4. The platform never assigns or rewrites a licence on a creator's behalf.
 */

export const SPDX_PATTERN = /^[A-Za-z0-9.+-]{2,64}$/;

export type LicenseFamily =
  | 'permissive'
  | 'weak-copyleft'
  | 'strong-copyleft'
  | 'network-copyleft'
  | 'public-domain'
  | 'proprietary';

export type DerivativeLicenseRule = { kind: 'only'; licenses: string[] };

export interface LicensePolicy {
  spdx: string;
  name: string;
  url: string;
  family: LicenseFamily;
  /** May be used for a game's source code. */
  appliesToCode: boolean;
  /** May be used for redistributable assets. */
  appliesToAssets: boolean;
  /** Derivative games may reuse this code. */
  allowsSourceRemix: boolean;
  /** Derivative games may reuse parameters/configuration without copying code. */
  allowsParameterRemix: boolean;
  /** Attribution/notice must be preserved by derivatives. */
  requiresAttribution: boolean;
  /** Shares must carry the same (or a listed compatible) licence. */
  shareAlike: DerivativeLicenseRule | null;
  /** Source must be offered to network users (AGPL). */
  networkSourceOffer: boolean;
  /** Source code may be redistributed publicly on the platform. */
  sourceRedistributable: boolean;
  /** Files that must be preserved verbatim in derivatives. */
  requiredNotices: string[];
}

function open(license: Omit<LicensePolicy, 'requiresAttribution' | 'shareAlike' | 'networkSourceOffer' | 'sourceRedistributable' | 'requiredNotices'> & Partial<LicensePolicy>): LicensePolicy {
  return {
    requiresAttribution: true,
    shareAlike: null,
    networkSourceOffer: false,
    sourceRedistributable: true,
    requiredNotices: ['LICENSE'],
    ...license,
  };
}

export const LICENSE_POLICIES: Record<string, LicensePolicy> = {
  MIT: open({
    spdx: 'MIT',
    name: 'MIT License',
    url: 'https://spdx.org/licenses/MIT.html',
    family: 'permissive',
    appliesToCode: true,
    appliesToAssets: true,
    allowsSourceRemix: true,
    allowsParameterRemix: true,
  }),
  ISC: open({
    spdx: 'ISC',
    name: 'ISC License',
    url: 'https://spdx.org/licenses/ISC.html',
    family: 'permissive',
    appliesToCode: true,
    appliesToAssets: true,
    allowsSourceRemix: true,
    allowsParameterRemix: true,
  }),
  'BSD-2-Clause': open({
    spdx: 'BSD-2-Clause',
    name: 'BSD 2-Clause "Simplified" License',
    url: 'https://spdx.org/licenses/BSD-2-Clause.html',
    family: 'permissive',
    appliesToCode: true,
    appliesToAssets: true,
    allowsSourceRemix: true,
    allowsParameterRemix: true,
  }),
  'BSD-3-Clause': open({
    spdx: 'BSD-3-Clause',
    name: 'BSD 3-Clause "New" or "Revised" License',
    url: 'https://spdx.org/licenses/BSD-3-Clause.html',
    family: 'permissive',
    appliesToCode: true,
    appliesToAssets: true,
    allowsSourceRemix: true,
    allowsParameterRemix: true,
  }),
  'Apache-2.0': open({
    spdx: 'Apache-2.0',
    name: 'Apache License 2.0',
    url: 'https://spdx.org/licenses/Apache-2.0.html',
    family: 'permissive',
    appliesToCode: true,
    appliesToAssets: true,
    allowsSourceRemix: true,
    allowsParameterRemix: true,
    requiredNotices: ['LICENSE', 'NOTICE'],
  }),
  'MPL-2.0': open({
    spdx: 'MPL-2.0',
    name: 'Mozilla Public License 2.0',
    url: 'https://spdx.org/licenses/MPL-2.0.html',
    family: 'weak-copyleft',
    appliesToCode: true,
    appliesToAssets: false,
    allowsSourceRemix: true,
    allowsParameterRemix: true,
    // MPL is file-level copyleft: modified MPL files stay MPL, so derivatives
    // published here declare MPL-2.0 as their licence.
    shareAlike: { kind: 'only', licenses: ['MPL-2.0'] },
  }),
  'LGPL-3.0-only': open({
    spdx: 'LGPL-3.0-only',
    name: 'GNU Lesser General Public License v3.0 only',
    url: 'https://spdx.org/licenses/LGPL-3.0-only.html',
    family: 'weak-copyleft',
    appliesToCode: true,
    appliesToAssets: false,
    allowsSourceRemix: true,
    allowsParameterRemix: true,
    shareAlike: { kind: 'only', licenses: ['LGPL-3.0-only', 'GPL-3.0-only', 'AGPL-3.0-only'] },
  }),
  'GPL-3.0-only': open({
    spdx: 'GPL-3.0-only',
    name: 'GNU General Public License v3.0 only',
    url: 'https://spdx.org/licenses/GPL-3.0-only.html',
    family: 'strong-copyleft',
    appliesToCode: true,
    appliesToAssets: false,
    allowsSourceRemix: true,
    allowsParameterRemix: true,
    shareAlike: { kind: 'only', licenses: ['GPL-3.0-only', 'AGPL-3.0-only'] },
  }),
  'AGPL-3.0-only': open({
    spdx: 'AGPL-3.0-only',
    name: 'GNU Affero General Public License v3.0 only',
    url: 'https://spdx.org/licenses/AGPL-3.0-only.html',
    family: 'network-copyleft',
    appliesToCode: true,
    appliesToAssets: false,
    allowsSourceRemix: true,
    allowsParameterRemix: true,
    networkSourceOffer: true,
    shareAlike: { kind: 'only', licenses: ['AGPL-3.0-only'] },
  }),
  Unlicense: open({
    spdx: 'Unlicense',
    name: 'The Unlicense',
    url: 'https://spdx.org/licenses/Unlicense.html',
    family: 'public-domain',
    appliesToCode: true,
    appliesToAssets: true,
    allowsSourceRemix: true,
    allowsParameterRemix: true,
    requiresAttribution: false,
  }),
  'CC0-1.0': open({
    spdx: 'CC0-1.0',
    name: 'Creative Commons Zero v1.0 Universal',
    url: 'https://spdx.org/licenses/CC0-1.0.html',
    family: 'public-domain',
    appliesToCode: true,
    appliesToAssets: true,
    allowsSourceRemix: true,
    allowsParameterRemix: true,
    requiresAttribution: false,
  }),
  'CC-BY-4.0': open({
    spdx: 'CC-BY-4.0',
    name: 'Creative Commons Attribution 4.0 International',
    url: 'https://spdx.org/licenses/CC-BY-4.0.html',
    family: 'permissive',
    appliesToCode: false,
    appliesToAssets: true,
    allowsSourceRemix: true,
    allowsParameterRemix: true,
  }),
  'CC-BY-SA-4.0': open({
    spdx: 'CC-BY-SA-4.0',
    name: 'Creative Commons Attribution Share Alike 4.0 International',
    url: 'https://spdx.org/licenses/CC-BY-SA-4.0.html',
    family: 'strong-copyleft',
    appliesToCode: false,
    appliesToAssets: true,
    allowsSourceRemix: true,
    allowsParameterRemix: true,
    shareAlike: { kind: 'only', licenses: ['CC-BY-SA-4.0'] },
  }),
  'OFL-1.1': open({
    spdx: 'OFL-1.1',
    name: 'SIL Open Font License 1.1',
    url: 'https://spdx.org/licenses/OFL-1.1.html',
    family: 'permissive',
    appliesToCode: false,
    appliesToAssets: true,
    allowsSourceRemix: true,
    allowsParameterRemix: true,
    requiredNotices: ['LICENSE', 'FONT-LICENSE'],
  }),
  'CC-BY-ND-4.0': {
    ...open({
      spdx: 'CC-BY-ND-4.0',
      name: 'Creative Commons Attribution NoDerivatives 4.0 International',
      url: 'https://spdx.org/licenses/CC-BY-ND-4.0.html',
      family: 'permissive',
      appliesToCode: false,
      appliesToAssets: true,
      allowsSourceRemix: false,
      allowsParameterRemix: false,
    }),
  },
  'LicenseRef-AllRightsReserved': {
    spdx: 'LicenseRef-AllRightsReserved',
    name: 'All rights reserved (proprietary)',
    url: 'https://moydan.dev/docs/licensing',
    family: 'proprietary',
    appliesToCode: true,
    appliesToAssets: true,
    allowsSourceRemix: false,
    allowsParameterRemix: false,
    requiresAttribution: true,
    shareAlike: null,
    networkSourceOffer: false,
    sourceRedistributable: false,
    requiredNotices: [],
  },
};

/** Licences a creator may pick when creating a new game. */
export function publicationLicenseOptions(): LicensePolicy[] {
  return Object.values(LICENSE_POLICIES).sort((a, b) => a.name.localeCompare(b.name));
}

export function licensePolicy(spdx: string): LicensePolicy | null {
  return LICENSE_POLICIES[spdx] ?? null;
}

export function isKnownLicense(spdx: string): boolean {
  return Object.prototype.hasOwnProperty.call(LICENSE_POLICIES, spdx);
}

export function isOpenSourceLicense(spdx: string): boolean {
  const policy = licensePolicy(spdx);
  if (!policy) return false;
  return policy.family !== 'proprietary';
}

export function licenseAllowsSourceRemix(spdx: string): boolean {
  return licensePolicy(spdx)?.allowsSourceRemix ?? false;
}

export function licenseAllowsParameterRemix(spdx: string): boolean {
  return licensePolicy(spdx)?.allowsParameterRemix ?? false;
}

/**
 * Licences that a derived game may declare, given the parent's licence.
 * An empty list means "no derivative may be published".
 */
export function allowedDerivativeLicenses(parentSpdx: string): string[] {
  const parent = licensePolicy(parentSpdx);
  if (!parent || !parent.allowsSourceRemix) return [];
  const candidates = Object.values(LICENSE_POLICIES).filter((policy) => policy.appliesToCode);
  if (!parent.shareAlike) {
    return candidates
      .filter((policy) => policy.family !== 'proprietary')
      .map((policy) => policy.spdx)
      .sort();
  }
  if (parent.shareAlike.kind !== 'only') return [];
  return parent.shareAlike.licenses.filter((spdx) => isKnownLicense(spdx)).sort();
}

export interface LicenseCheckIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface AssetLicenseDeclaration {
  /** Glob or path the declaration applies to, e.g. `assets/*.png`. */
  path: string;
  license: string;
  /** Where the asset came from: "original", a URL, an author name... */
  source: string;
  attribution?: string;
}

export interface LicenseDeclaration {
  spdx: string;
  /** Relative path to the licence text in the project (defaults to LICENSE). */
  file?: string;
  attributionText?: string;
  assets: AssetLicenseDeclaration[];
}

export function validateLicenseDeclaration(declaration: LicenseDeclaration): LicenseCheckIssue[] {
  const issues: LicenseCheckIssue[] = [];
  const policy = licensePolicy(declaration.spdx);
  if (!policy) {
    issues.push({
      path: 'license.spdx',
      severity: 'error',
      message: `"${declaration.spdx}" is not a supported licence identifier. Pick one of: ${publicationLicenseOptions()
        .map((entry) => entry.spdx)
        .join(', ')}`,
    });
    return issues;
  }
  if (!policy.appliesToCode) {
    issues.push({
      path: 'license.spdx',
      severity: 'error',
      message: `${policy.name} is an asset licence; the game code needs a code licence such as MIT or GPL-3.0-only`,
    });
  }
  for (const [index, asset] of declaration.assets.entries()) {
    const assetPath = `license.assets[${index}]`;
    if (!asset.path.trim()) {
      issues.push({ path: `${assetPath}.path`, severity: 'error', message: 'asset licence needs a path or glob' });
    }
    const assetPolicy = licensePolicy(asset.license);
    if (!assetPolicy) {
      issues.push({
        path: `${assetPath}.license`,
        severity: 'error',
        message: `"${asset.license}" is not a supported asset licence`,
      });
      continue;
    }
    if (!assetPolicy.appliesToAssets) {
      issues.push({
        path: `${assetPath}.license`,
        severity: 'error',
        message: `${assetPolicy.name} cannot be used to licence game assets`,
      });
    }
    if (assetPolicy.family === 'proprietary') {
      issues.push({
        path: `${assetPath}.license`,
        severity: 'error',
        message: 'proprietary assets cannot be redistributed through the platform',
      });
    }
    if (!asset.source.trim()) {
      issues.push({ path: `${assetPath}.source`, severity: 'error', message: 'declare where the asset came from' });
    }
    if (assetPolicy.requiresAttribution && !asset.attribution?.trim()) {
      issues.push({
        path: `${assetPath}.attribution`,
        severity: 'error',
        message: `${assetPolicy.spdx} requires attribution text for assets you did not create yourself`,
      });
    }
  }
  return issues;
}

export interface AttributionInput {
  childTitle: string;
  childHandle: string;
  parentTitle: string;
  parentHandle: string;
  parentSpdx: string;
  parentAttributionText?: string;
  mode: 'source' | 'parameters';
}

/**
 * Attribution line stored immutably with the remix relationship and shown on the
 * derivative's page. Inherits the parent's own attribution text so multi
 * generation chains keep naming every ancestor.
 */
export function buildAttributionText(input: AttributionInput): string {
  const policy = licensePolicy(input.parentSpdx);
  const parts: string[] = [];
  parts.push(
    `"${input.childTitle}" by @${input.childHandle} is a ${
      input.mode === 'parameters' ? 'parameter remix' : 'remix'
    } of "${input.parentTitle}" by @${input.parentHandle} (${input.parentSpdx}${
      policy ? `, ${policy.name}` : ''
    }).`,
  );
  if (input.parentAttributionText?.trim()) {
    parts.push(input.parentAttributionText.trim());
  }
  if (policy?.requiresAttribution) {
    parts.push('Attribution to the original creator is required and must be preserved in further remixes.');
  }
  if (policy?.shareAlike) {
    parts.push(`This derivative must be distributed under: ${policy.shareAlike.licenses.join(', ')}.`);
  }
  if (policy?.networkSourceOffer) {
    parts.push('Network users must be offered the corresponding source of this derivative.');
  }
  return parts.join(' ');
}

/** Files that a source remix must carry over from the parent version. */
export function noticesRequiredFor(spdx: string): string[] {
  const policy = licensePolicy(spdx);
  if (!policy) return ['LICENSE'];
  return [...new Set(['LICENSE', ...policy.requiredNotices, 'ASSET_LICENSES.md'])];
}

export function describeLicense(spdx: string): {
  spdx: string;
  name: string;
  url: string;
  family: LicenseFamily | 'unknown';
  requiresAttribution: boolean;
  allowsSourceRemix: boolean;
  allowsParameterRemix: boolean;
} {
  const policy = licensePolicy(spdx);
  if (!policy) {
    return {
      spdx,
      name: 'Unknown licence',
      url: '',
      family: 'unknown',
      requiresAttribution: true,
      allowsSourceRemix: false,
      allowsParameterRemix: false,
    };
  }
  return {
    spdx: policy.spdx,
    name: policy.name,
    url: policy.url,
    family: policy.family,
    requiresAttribution: policy.requiresAttribution,
    allowsSourceRemix: policy.allowsSourceRemix,
    allowsParameterRemix: policy.allowsParameterRemix,
  };
}
