# XP-to-XMC exclusions

Apply only when target flavor is xmc. XP Headless migrations retain XP capabilities unless an explicit target decision says otherwise. Search source templates and captured IDs before excluding anything.

| Source area | Why review for XMC |
| --- | --- |
| Analytics, profiles, patterns and engagement | XP runtime dependencies may not have a target equivalent |
| Marketing Automation and campaign activities | Workflows/automation do not become cloud functionality through serialization |
| xDB/Data Exchange | Integration/runtime dependencies need separate mapping |
| Forms and form handlers | Confirm the selected target forms platform and backend; do not assume compatibility |
| Custom system templates/config dependencies | Determine actual target support and descendant impact |

Capture path/ID, incompatibility evidence, descendant/dependent count and target alternative. A path substring is a triage clue, not proof of incompatibility. Prefer an explicit supported template remap when it preserves the required contract; otherwise route the scope change to the hub.

Review the target template areas under `/sitecore/templates/System/`: Email, Analytics, Marketing Automation, Marketing Control Panel, xDB and List Management. Treat these as target-specific review/suggestion categories, not proof that the selected site uses them. Preserve the actual observed path casing and ID, dependency/consumer evidence and counts when available. For a policy suggestion without a confirmed site dependency, explicitly label its basis `target-policy-review`, mark it unapproved and leave affected counts unknown. Distinguish these from confirmed dependency findings; do not manufacture site-specific issues to fill a list.

Store suggestedExclusions separately from approved exclusions. Merge approved paths into the complete module input, preserving unchanged YAML. Compare namespace and item counts; unexplained drops block transfer. No automatic baseline exclusions or mandatory non-empty list. Reviewing the baseline categories is required for XMC; proposing or applying every baseline path is not.

Validate the remaining template graph and report every affected rendering/content item. Excluding a parent may orphan references elsewhere; local syntax success alone is insufficient. See [recovery](error-recovery.md) and [native execution](native-execution.md).
