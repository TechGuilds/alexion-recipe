# xpmvc2xpheadless target scope

This supported migration scope converts XP MVC presentation to XP Headless in place. It is not an implicit XMC deployment. Record migration type xpmvc2xpheadless, sourcePlatform mvc, target flavor xp-headless, XP/SXA/Headless Services/JSS versions and separate connector roles.

Supported content procedure: inspect existing templates, items, renderings and presentation; preserve IDs and source baselines; map MVC rendering/controller/model behavior into the verified XP JSS target; configure compatible headless rendering definitions and validate source/target Layout Service behavior. Source and target may share an instance, making backups and narrowly scoped writes essential.

Reuse the MVC translation cadence, helper inventory, data-flow and selector gates. Use target-installed JSS types, field components, registration and placeholders. XMC Content SDK imports, Pages, Edge-only enrichment, cloud collections and XMC REST provisioning are not prerequisites for this path.

Existing XP resolvers and server services may remain when supported by the target topology. Verify actual headless output before replacing them. Do not apply XP-to-XMC analytics/forms/system exclusions by default. Serialize or provision only the changes required by the selected XP target design.

Deferred pending target-version evidence: automated SXA conversion scripts branded xmc, custom rule evaluation, authentication, analytics/forms parity and any Content SDK-on-XP proposal. Inspect script template IDs and assumptions before use; a matching script filename is not compatibility evidence.

Completion requires normal/editing layout captures, registration and populated placeholders, representative behavior checks and documented rollback scope for remote items. The cms-migration Sitecore profile owns phase selection and approval gates; report unsupported steps there rather than silently switching migration type.
