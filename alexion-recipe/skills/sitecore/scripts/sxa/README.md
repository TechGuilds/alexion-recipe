# SXA provisioning scripts (`run-powershell-script` on `target-sitecore`)

The 17 `xmc-*` SPE scripts backing the SXA conversion, in execution order. See `../../references/sxa/provisioning.md` for the step-by-step procedure, HITL gates, and invariants. Run each via `run-powershell-script` (params from the `.INJECTED_VARIABLES` header) and rely on automatic terminal delivery. Use `get-tool-results` only to recover a missing terminal result or inspect the exact known interrupted run; do not routine-poll or start a duplicate while a result is pending.

| Step | Script | Purpose |
|---|---|---|
| 2 | `xmc-register-rendering-folders.ps1` | register rendering folders as thin SXA modules (needs `renderingsPrefix`) |
| 2 | `xmc-ensure-rendering-parameters.ps1` | fix RP-template base inheritance — run per module, **sequentially** |
| 2 | `xmc-list-modules.ps1` | enumerate registered modules |
| 3 | `xmc-adopt-site-into-tenant.ps1` | move site under tenant, fix path refs, patch page-template inheritance |
| 4 | `xmc-convert-to-headless-site.ps1` | ChangeTemplate + skeleton + settings + system modules |
| 4 | `xmc-apply-rendering-modules.ps1` | apply custom rendering modules to the site |
| 5 | `xmc-discover-presentation-patterns.ps1` | discover shared-layout patterns from page templates |
| 5 | `xmc-create-partial-designs.ps1` | create Partial Designs |
| 5 | `xmc-create-page-designs.ps1` | compose Page Designs |
| 5 | `xmc-assign-page-design.ps1` | assign Page Designs to templates (TemplatesMapping) |
| 5 | `xmc-list-partial-designs.ps1` / `xmc-list-site-page-templates.ps1` | inspect existing PDs / page templates |
| 6 | `xmc-migrate-to-page-designs.ps1` | strip PD-covered renderings from SVs + page items |
| 6 | `xmc-backup-renderings.ps1` / `xmc-restore-renderings.ps1` | backup before migration / restore on rollback |
| — | `xmc-create-module.ps1` / `xmc-create-rendering.ps1` | create a missing module / rendering |

> The tenant/site/publish ops (`xmc-ensure-collection`, `xmc-ensure-site`, `xmc-publish`, `xmc-list-sites`, `xmc-list-collections`, `xmc-list-site-templates`) are **XM Cloud REST tools**, not scripts — call them directly.
