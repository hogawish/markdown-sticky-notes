# Manual Chrome extension → Chrome Web Store

## Finding (2026-11-22)

“Add to Chrome will replace an unpacked copy with the same ID” is **not a supported rollout assumption**.

In an isolated Chrome for Testing 158.0.8127.36 profile, an inert unpacked extension with the public key / ID of an already published Google extension reported `installType: development`. The real Chrome Web Store API reported `enabled`, and `beginInstallWithManifest3` returned `already_installed` / “This item is already installed”. After removing that owned fixture, the status changed to `installable`.

The fixture included no third-party extension code or permissions; it did not install the Google extension. This checks Chrome's same-ID behavior with a published item, not the still-pending Sticky Notes listing. Chromium's [fixed-revision implementation](https://chromium.googlesource.com/chromium/src/+/f14825c400b800086cd6c7056bc3f906b0de6a85/chrome/browser/extensions/api/webstore_private/webstore_private_api.cc) checks `ExtensionRegistry::EVERYTHING` and rejects an existing ID before beginning installation. Disabling a copy is therefore not a reliable substitute for removing it.

The initial interactive screenshot attempt could not select the dedicated test Chrome window due to the computer-use helper's window-ownership error. No successful interactive replacement test is claimed. The API evidence above was obtained in a separate headless fixture.

## Distribution before approval

Use desktop v0.12.1 and **markdown-sticky-notes-chrome-0.4.1-manual.zip**. Its public key / ID and runtime permissions match the submitted extension. The manual ZIP adds an options page; its tab-linking background script is unchanged. The submitted `-webstore.zip`, desktop exe and store review are unchanged.

Open `chrome://extensions`, enable developer mode and load the folder containing `manifest.json`. Keep that folder until the store migration finishes. See [setup](../extensions/README.md).

## User's migration after the listing is public

1. Right-click this extension's toolbar icon and choose **Options / オプション**.
2. Open the store link and confirm the listing is public. A publication acknowledgement is required before the migration button is enabled; the page does not fetch availability or silently remove anything.
3. Select **ストア版へ切り替える** and accept Chrome's confirmation to remove this specific manual extension.
4. Chrome opens the store listing automatically after removal. Choose **Add to Chrome / Chromeに追加** and confirm installation.
5. Reconnect through the extension's toolbar action and re-establish tab links as needed. Desktop Markdown notes and images are not removed.

The page uses `chrome.runtime.setUninstallURL` and `chrome.management.uninstallSelf({showConfirmDialog:true})`. It never enumerates or removes another extension. `getSelf` and `uninstallSelf` require no additional management permission. If the user cancels removal, the handoff URL is cleared and the manual extension remains usable.

The real browser fixture confirmed that self-removal changes the status to `installable` and opens a new store tab. The production helper's cancellation, acknowledgement, fixed-ID and development-install guards are covered by JS tests. The final Add/installation confirmation for Sticky Notes remains to be checked once its listing is public.

## Implementation references

- [Chrome management: getSelf / uninstallSelf](https://developer.chrome.com/docs/extensions/reference/api/management)
- [Chrome runtime: setUninstallURL](https://developer.chrome.com/docs/extensions/reference/api/runtime#method-setUninstallURL)

Build a manual package without changing the store package:

```powershell
./extensions/package-chrome.ps1 -Manual -Output <absolute-output-path>/markdown-sticky-notes-chrome-0.4.1-manual.zip
```

The store upload continues to use the original package without `-Manual`. Do not cancel an in-progress store review just to distribute this helper to early users.
