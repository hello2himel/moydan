# Licence policy

Moydan is a licence-first platform. Source availability is not permission: a game must declare an
explicit, machine-checkable licence for its code and for every redistributable asset, and the
platform refuses to publish or remix work whose licence is missing, unknown, ambiguous or
incompatible.

The policy lives in code (`packages/core/src/license.ts`) as a versioned, curated table. It is not
inferred, and it is never extended at runtime from a game's own claims.

## Principles

1. **Explicit grant only.** No licence file and no manifest declaration means no publication.
2. **SPDX identifiers only.** A free-text licence name is rejected with `license_rejected`.
3. **Assets are separate.** Code licence and asset licences are validated independently; an
   asset-only licence (a font, a sprite sheet) may not be used as the code licence.
4. **Copyleft is respected.** Share-alike parents constrain the child's licence. The platform never
   claims that two arbitrary licences are compatible.
5. **No invention.** The platform never assigns, rewrites or "fixes" a creator's licence, and never
   applies its own licence to creator work.
6. **Notices travel.** Required notice files are preserved verbatim in every descendant.

## Supported code licences

| SPDX | Family | Source remix | Parameter remix | Share-alike constraint |
| --- | --- | --- | --- | --- |
| MIT | permissive | yes | yes | — |
| ISC | permissive | yes | yes | — |
| BSD-2-Clause | permissive | yes | yes | — |
| BSD-3-Clause | permissive | yes | yes | — |
| Apache-2.0 | permissive | yes | yes | — (must keep `LICENSE`, `NOTICE`) |
| Unlicense | public domain | yes | yes | — |
| CC0-1.0 | public domain | yes | yes | — |
| MPL-2.0 | weak copyleft | yes | yes | MPL-2.0 |
| LGPL-3.0-only | weak copyleft | yes | yes | LGPL-3.0-only, GPL-3.0-only, AGPL-3.0-only |
| GPL-3.0-only | strong copyleft | yes | yes | GPL-3.0-only, AGPL-3.0-only |
| AGPL-3.0-only | network copyleft | yes | yes | AGPL-3.0-only |

## Supported asset licences

`CC0-1.0`, `CC-BY-4.0`, `CC-BY-SA-4.0`, `OFL-1.1`, plus every code licence above that applies to
assets (MIT, ISC, BSD-*, Apache-2.0, Unlicense, CC0).

`CC-BY-4.0` and `OFL-1.1` are asset-only: they cannot be declared as the game's code licence.

## Prohibited cases

| Case | Result |
| --- | --- |
| `LicenseRef-AllRightsReserved` / proprietary | publication rejected; no remix |
| `CC-BY-ND-4.0` (NoDerivatives) | asset use allowed; **no** remix of any mode |
| Unknown or misspelled SPDX | `license_rejected` |
| Declared code licence is asset-only (CC-BY, OFL) | `license_rejected` |
| Declared licence file missing from the project | `license_rejected` |
| An asset with no `license.assets` entry | `validation_failed` naming the file |
| Asset licence forbids redistribution | `license_rejected` |
| Child declares a licence the parent does not permit | `license_rejected` with the allowed list |
| Required notice removed by a remix | rejected; notices are re-attached automatically |

## What validation actually checks

For the code licence:

1. `license.spdx` is a known identifier with `appliesToCode: true`.
2. The licence file exists in the project (`license.file`, default `LICENSE`).
3. When `attributionText` is present it is displayed on the game's source panel and carried into
   every remix.

For every asset under `assets/` and `public/`:

1. It is covered by a `license.assets` entry (exact path or a single `*` within one segment).
2. That entry's licence is known and `appliesToAssets: true`.
3. The entry records a `source` (where it came from) and, when attribution is required, the
   attribution text.

The same table drives the UI: the create form, the remix editor and the licence pages read from
`GET /api/meta` and `GET /api/licenses`, so policy changes appear everywhere at once.

## Attribution and display

A published game shows, in its source panel:

- Code licence (SPDX identifier, human name, link).
- Asset licensing entries and required attribution.
- Attribution text supplied by the creator.
- Required notice files that are preserved in the project.
- The repository URL, **if** the creator declared one. It is informational; the platform never
  fetches it and never treats it as a licence.

Remixes additionally show the parent's licence and the full attribution chain.

## Platform licence vs. game licence

These are independent. This repository is AGPL-3.0-only. Publishing a game on a Moydan instance
does not change the game's licence, and a game's licence never changes the platform's. The
platform's own AGPL obligations (including the network source offer) are satisfied by this
repository being the source of the running software.
