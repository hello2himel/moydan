# Remixing

Remixing is native to Moydan. A remix always creates a **new game identity** owned by the remixer,
and always records the exact parent version it came from.

## Modes

### Parameter remix (quick)

Available when the game's author set `remix.allowed: true` and included `parameters` in
`remix.modes`, and the parent's licence permits derivative configuration.

- The platform renders a schema-driven editor from the author's declared parameters
  (`number`, `boolean`, `select`, `color`) — ranges, options, defaults and step are enforced by
  `applyRemixParameters`. Unknown keys are rejected, out-of-range values fail.
- No game bundle is copied. The child stores a small, immutable configuration record that
  references the parent release and the parameter schema it was validated against.
- The child is pinned to the exact parent release. When the parent publishes a new version, the
  child is **not** rebased; migration is a deliberate, validated action.
- The parent author cannot have parameters applied that they did not declare. There is no
  arbitrary JavaScript path in this mode.

### Source remix

Available when the parent declares `source` mode and the licence allows source reuse.

- Creates a new project whose draft references the parent's file blobs — no bytes are copied.
  The first edit of a file creates a new blob and re-points one row.
- The parent project, its drafts and its releases are untouched.
- The remixer becomes the owner of the new project, subject to the licence and attribution
  obligations (below).
- The child publishes from its own immutable snapshot with the same build pipeline as any other
  game.

## Licence gate

Remix is refused unless every condition holds (`remixCapabilities` in
`apps/api/src/services/remix.ts`):

1. The parent is published and has a valid manifest.
2. The parent's SPDX licence is known to the platform.
3. That licence permits the requested mode (`allowsSourceRemix` / `allowsParameterRemix`).
4. The manifest has `remix.allowed: true` and declares the mode.

Copyleft obligations are then applied:

| Parent licence | Child may declare |
| --- | --- |
| MIT, ISC, BSD-2/3, Apache-2.0, Unlicense, CC0 | any code licence the platform accepts |
| MPL-2.0 | MPL-2.0 |
| LGPL-3.0-only | LGPL-3.0-only, GPL-3.0-only, AGPL-3.0-only |
| GPL-3.0-only | GPL-3.0-only, AGPL-3.0-only |
| AGPL-3.0-only | AGPL-3.0-only |
| `LicenseRef-AllRightsReserved`, CC-BY-ND-4.0 | no remix at all |

A child cannot silently relicense a derivative: the platform rejects the request with
`license_rejected` and lists the licences it may use. The platform never invents permission and
never rewrites a creator's licence.

## Attribution and notices

Carried forward automatically and visible on the child:

- The parent's title, creator handle and display name, and the full attribution text.
- The parent's SPDX licence and the required notice files (`LICENSE`, `NOTICE`, …) which must be
  preserved verbatim in the child project.
- Asset licensing statements from the parent manifest for assets the child still ships.
- The remixing creator's own identity as the owner of the child.

## Lineage

`remix_relations` records, for every remix:

| Field | Meaning |
| --- | --- |
| `child_game_id` / `child_version_id` | the derivative |
| `parent_game_id`, `parent_version_id`, `parent_release_id` | the exact parent state |
| `parent_tree_hash` | the parent's immutable tree identity |
| `root_game_id` | the original ancestor (follows the chain, so the root is a single hop away) |
| `parent_creator_id`, `parent_creator_handle` | credit |
| `child_creator_id` | authorship of the derivative |
| `parent_license_spdx`, `child_license_spdx` | licences on both sides |
| `attribution_text` | the notice the child must display |
| `mode` | `source` or `parameters` |
| `params_json` | applied parameter values (parameter remixes) |
| `created_at` | when the relationship was created |

The ancestry endpoint returns the origin plus the full ancestor chain, so the UI can render
"Remixed from *X* by *@y* · View full lineage" and link to every game and creator in the chain.
Parent creator handles changing later do not rewrite history; the recorded identity stays.

Engagement is never inherited: a child starts with zero reactions, comments, saves, plays and
followers.

## Removal and takedowns

- Unpublishing or removing a parent does not delete the lineage row. The chain remains readable
  (with the parent's current visibility), so attribution survives a takedown.
- A removed parent's artifacts stop being served; historical records keep their hashes and
  identity.
- A child whose parent is removed is **not** silently removed. It is flagged in the studio, and
  moderation can act on it separately — that decision belongs to a human, not to a cascade.

## Flows

**As a player** — the Remix control only appears when the game is eligible. The remix screen shows
the parent and its creator, the licence and attribution, and either the parameter editor or the
source-remix path. After creation you land in the studio with a fresh draft; the child appears in
feeds immediately as a draft, and in the public feed once published.

**As a creator** — configure `remix` in `game.json`, describe the parameters in plain language
(labels, groups, min/max), and validate. The studio shows exactly which parameters players may
change.
