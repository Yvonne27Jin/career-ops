# IND recognised-sponsor register snapshots

Bundled snapshots of the [IND public register of recognised sponsors](https://ind.nl/en/public-register-recognised-sponsors), read by [`sponsor-check.mjs`](../../sponsor-check.mjs).

| File | Register | Snapshot date | Rows |
|------|----------|---------------|------|
| `list_of_KM_sponsors.csv` | **Work / highly skilled migrant** ("kennismigrant" / KM) — the register that matters for a normal KM work-permit job | 1 September 2026 | ~12,900 |
| `list_of_research_visa_sponsors.csv` | **Research** (EU Directive 2016/801) — formal researcher roles at recognised research institutions only | 1 July 2026 | ~160 |

Both are `"Organisation","KVK number"` CSVs, verbatim from the IND publication.

## System layer, not user data

These live under `templates/` (system layer) and are refreshed by `update-system.mjs apply`, the same as the jurisdiction tables. They are NOT under the user's `DATA_ROOT` and carry no personalization — do not edit them by hand.

## Snapshot, not live

The IND updates the live register **monthly**. Treat a match as a strong indicator, never a legal guarantee, and re-check the live page for anything decision-critical. Being on the register also does not mean a company will sponsor a specific role — a recognised sponsor can still decline, and a KM permit carries a salary threshold.

## Refreshing the snapshot

Download the current register from the IND page above (Work / highly skilled migrant, and Research), save each as its CSV here preserving the `"Organisation","KVK number"` header, and update the snapshot date + row count in the table above. `node sponsor-check.mjs --self-test` sanity-checks that both files load.
