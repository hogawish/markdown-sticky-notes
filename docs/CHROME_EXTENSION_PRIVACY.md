# Privacy Policy — Markdown Sticky Notes: Tab Links

Effective date: November 22, 2026

This policy describes the Chrome extension **Markdown Sticky Notes — Tab Links** and its local connection to the Markdown Sticky Notes desktop app for Windows. The project is maintained by **hogawish**.

## Purpose

The extension links a local sticky note to an existing Chrome tab. You can create a linked note, choose a tab for a note, and return to that tab from the desktop app. It requires the separately installed desktop app and its Native Messaging host.

## Information processed

To provide these features, the extension processes:

- Tab titles, used as human-readable labels for tab links and linked notes.
- Tab and window identifiers, used to locate the specific existing tab.
- A randomly generated browser-session identifier, used to distinguish browser sessions. It is not an account identifier and is not used for advertising or analytics.
- Window focus state and, when returning to a tab in another window, window position and dimensions, used to identify the destination window and update the note's window attachment.
- Requests and responses for connecting, creating a linked note, selecting a tab, and activating an existing tab, including operational success or error messages.

After you connect a Chrome window, the extension can update the local desktop app with the active tab's identifier and available title when the active tab or its title changes. These updates support tab selection and link labels; they do not automatically show or hide notes when you switch tabs.

The extension does **not** read page bodies, images, video, forms, passwords, cookies, or messages inside web pages. It does not request Chrome's history API or retrieve your browsing-history database. Tab titles are nevertheless browsing-related information, and are disclosed as web history in the store's data-use categories. The current extension does not include page URLs in the messages it sends to the desktop app.

## Local processing and storage

The extension communicates with the desktop app through Chrome Native Messaging: a local process using standard input and output. This connection is not an internet service or a network listening port.

The random session identifier is stored in `chrome.storage.session`, rather than Chrome's synchronized storage. The desktop app stores local tab-link and window-attachment metadata in its configuration and local integration files. Notes created through the extension are saved by the desktop app as local Markdown files. This metadata and these notes are not automatically uploaded by the extension.

The extension contains no advertising, analytics, telemetry, or developer-operated data-collection endpoint. It does not send the information described above to the developer or external servers. A website you visit, Chrome itself, GitHub, or a synchronization service you separately configure may have their own data practices; those are not services operated by this extension.

## Use and sharing

The information is used only to provide the tab-linking features described above. We do not sell it, use it for advertising or credit decisions, or transfer it for unrelated purposes. The developer does not receive or routinely access your local notes or tab-link metadata.

The use of information received from Google APIs adheres to the **Chrome Web Store User Data Policy**, including its **Limited Use** requirements.

## Retention and your controls

Session-only extension storage follows Chrome's session-storage lifecycle. The desktop app may retain saved links, notes, and local integration files until you remove or clear them; a tab becoming unavailable does not guarantee immediate deletion of all local metadata.

You can unlink a tab from a note, use the desktop app's bulk link-removal feature, disable or remove the Chrome extension, and remove local desktop-app data if no longer needed. Removing the extension does not by itself delete Markdown notes or the desktop app's saved data. If you export notes, share your configuration, or synchronize their folders with another service, those are actions under your control.

## Permissions

- `activeTab`: access available information about a user-selected tab after a user action to create or label its link.
- `contextMenus`: offer the command to create a note linked to the selected tab/page.
- `nativeMessaging`: communicate with the installed local desktop app.
- `storage`: store the random browser-session identifier in session storage.

## Contact and updates

For privacy questions or reports, contact the maintainer through the project's [GitHub issue tracker](https://github.com/hogawish/markdown-sticky-notes/issues). Do not include private tab titles, credentials, or note contents in a public issue.

Changes to this policy will be published in this repository with an updated effective date and visible revision history.
