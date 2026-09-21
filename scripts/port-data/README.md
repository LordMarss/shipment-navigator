# Port reference data — source & provenance

## Source

**NGA World Port Index (WPI)** — published by the U.S. National
Geospatial-Intelligence Agency as **Pub. 150**.

- Fetched from: `https://msi.nga.mil/api/publications/download?type=view&key=16920959/SFH00000/UpdatedPub150.csv`
- Fetched on: 2026-09-20
- Rows in source: 3,807 ports/harbors worldwide

## Why this source (and not raw UN/LOCODE)

Two candidates were evaluated:

1. **UNECE UN/LOCODE**, filtered to `Function` code `1` (maritime/seaport) —
   yields **~11,800** entries. This is far too permissive: UN/LOCODE marks a
   location "port function" quite liberally (any town with a jetty), so the
   set includes many locations with no meaningful commercial maritime
   facility. It also carries no harbor-size or facility metadata, so there
   is no principled way to separate "major container port" from "village
   dock" — the exact problem the product brief asked to avoid.
2. **NGA World Port Index** — a single authoritative, human-curated
   catalog of ~3,800 ports and harbors NGA considers navigationally
   significant enough to publish sailing directions for. Every entry
   already carries a `Harbor Size` (Very Small/Small/Medium/Large),
   `Harbor Type`, `Harbor Use` (Cargo/Ferry/Fishing/Military/Unknown) and
   per-facility flags (container/bulk/liquid-bulk/oil-terminal/LNG/
   breakbulk terminals). It also embeds the UN/LOCODE directly for ~88% of
   rows, giving us the standardized code "for free" without a second
   fuzzy cross-reference pass.

**Decision: NGA WPI alone**, used as the sole import source. It is
better-curated for "is this a real maritime port" than UN/LOCODE, already
carries the metadata this product needs for geofence sizing and port typing,
and already contains the UN/LOCODE where one applies.

## Licensing

NGA World Port Index is a work of the U.S. federal government (NGA/NIMA)
published as public navigational safety information. Per 17 U.S.C. § 105,
U.S. government works are not subject to domestic copyright and are in the
public domain — safe to use, modify and redistribute in commercial software
without attribution or licensing fees. (See https://msi.nga.mil for the
publication itself.)

## What's committed here

`nga-world-port-index.json` — the source CSV trimmed to the columns this
import actually uses (WPI number, name, UN/LOCODE, country, harbor
size/type/use, six facility flags, latitude, longitude), re-encoded as JSON.
Committing this trimmed snapshot (rather than re-fetching at build/import
time) makes the import fully reproducible without a live network dependency,
and without vendoring 100+ unused WPI columns.

To refresh from a newer WPI edition: re-fetch the URL above, and regenerate
this file keeping the same field names (see `scripts/generate-ports-migration.ts`
for the exact shape expected).

## How it's turned into a migration

`scripts/generate-ports-migration.ts` reads this file, applies the
filtering/derivation rules documented in its own header comment, and writes
a deterministic SQL migration. It does not touch the database itself — it
only generates the `.sql` file, which is then reviewed and applied through
the normal Supabase migration flow like any other migration.
