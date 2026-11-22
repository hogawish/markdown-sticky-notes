# Chrome Web Store rollout

## Prepared build

- Desktop: v0.12.1, currently a GitHub prerelease.
- Chrome extension: 0.4.1; store item ID `gmddcmanllooimaoidnndbpblohcopip`.
- Human reported on 2026-11-22 that the item was submitted for review with automatic publishing disabled. This is a report of submission, not evidence of approval.
- The tested installer and submitted extension ZIP must be reused without rebuilding or replacing their contents during promotion.
- Runtime code: `e86abd15b7dd95cea0e522a6d6e2eff92f16c473`. Subsequent documentation-only commits do not alter those artifacts.

## Before public rollout

1. Confirm the store dashboard reports approval / ready to publish for extension 0.4.1. If Google requests code or permission changes, make those changes and repeat the affected tests; do not promote a different package silently.
2. Check that v0.12.1 installer and extension asset digests still match the verified hashes below. The Windows CI, JS/Rust tests, installer-payload smoke test and isolated real-Chrome connection test have passed.
3. Promote the existing GitHub v0.12.1 prerelease to a normal latest release, keeping its tag and uploaded installer/ZIP. This makes the compatible desktop installer available before store distribution.
4. Publish the approved Chrome item in the developer dashboard. The expected store link is `https://chromewebstore.google.com/detail/gmddcmanllooimaoidnndbpblohcopip`; do not advertise this link as live until it opens the published listing.
5. Change the extension setup documentation from “公開準備中” to the public store link after publication. Retain the manual-install path.
6. On one Windows PC, install/update the desktop app, add the store extension, connect, create one synthetic linked note and return to its original tab. Confirm saved notes remain. Do not stop or replace a person's running app without authorization for that PC.

No new scheduled Agent or polling service is required. Pending review is an external dependency; resume rollout when its result is known.

## Verified artifacts

| Asset | SHA-256 |
| --- | --- |
| markdown-sticky-notes-0.12.1-windows-x64-setup.exe | b05d097858251fb51a52fcfea814a43e455a1866066abac837f06a603057a63a |
| markdown-sticky-notes-chrome-0.4.1-webstore.zip | f9d56f2837640ef58dbf35455f0e0a0ef516be58eb1e31959d1624a3cd2c2f5d |

## Promotion commands

Run only after approval is confirmed, from the verified repository:

```powershell
gh release view v0.12.1 --repo hogawish/markdown-sticky-notes --json isDraft,isPrerelease,assets
gh release edit v0.12.1 --repo hogawish/markdown-sticky-notes --prerelease=false --latest --title 'Markdown Sticky Notes v0.12.1'
gh api repos/hogawish/markdown-sticky-notes/releases/latest --jq .tag_name
```

Update the release description to describe the completed store rollout rather than claiming the store item is already live before it is published.

## Recovery

If a rollout issue appears, pause store distribution in the dashboard and restore v0.12.0 as GitHub's latest release. Mark v0.12.1 as prerelease again rather than deleting its tag or rewriting history. Keep the v0.12.1 installer available to reviewers while investigating.

```powershell
gh release edit v0.12.1 --repo hogawish/markdown-sticky-notes --prerelease --latest=false
gh release edit v0.12.0 --repo hogawish/markdown-sticky-notes --latest
```

For a local app update, preserve Markdown folders and the app configuration before replacing the installation. A rollback uses the previous installer without uninstalling or deleting note data. Native-host registration is separate: an older installer may leave the current manifest in place, so inspect its executable path and explicit allowed extension IDs rather than assuming a downgrade resets them.

## Before store publication

The same extension can be loaded unpacked using the [manual setup instructions](../extensions/README.md). Its bundled public key keeps the extension ID consistent with the store item. This does not publish the item or bypass store review for ordinary store distribution.
