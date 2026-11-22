# Chrome Web Store reviewer setup

Extension: **Markdown Sticky Notes — Tab Links**

Item ID: `gmddcmanllooimaoidnndbpblohcopip`

## Requirements

- Windows 10 or 11, Google Chrome, and Microsoft Edge WebView2 Runtime (the desktop installer can prompt for the runtime if needed).
- The separately installed Markdown Sticky Notes desktop app **0.12.1 or later**.
- No application account, login, paid subscription, or cloud service is needed.

Desktop installer and source: [v0.12.1 review build](https://github.com/hogawish/markdown-sticky-notes/releases/tag/v0.12.1).

## Installation

1. Download `markdown-sticky-notes-0.12.1-windows-x64-setup.exe` from the release above and install it for the current Windows user. This registers the Native Messaging host for this extension ID. No PowerShell command or administrator access is needed for the default per-user installation.
2. Install this extension in the same Windows user account and Chrome profile used for testing.
3. Launch Markdown Sticky Notes. Register a local folder with **フォルダを追加…** (Add folder) in the note list if no folder is registered.
4. Open an ordinary HTTPS page in Chrome. Click the extension's toolbar action to connect the Chrome window to the local desktop app. A check mark indicates connection; a badge with `!` indicates an error. This is a manual connection, not a browser or account sign-in.

## Test the user-facing feature

1. Right-click inside the page and choose **このタブにリンクした付箋を作成** (Create a sticky note linked to this tab). On browsers that support the extension's tab-context-menu entry, the same command is also available by right-clicking the tab.
2. Keep that Chrome window in front while creation completes. A new sticky note appears, with a tab-link button near the bottom. The note is saved as a Markdown file in the selected local folder.
3. Enter a short note. Switch Chrome to another tab. Click the original tab's label/link in the sticky note. Chrome returns to the original existing tab.
4. Move the linked tab to another Chrome window and click the link again. It should activate that tab in its new window. If the note was attached to the previous Chrome window, the attachment follows the destination window when returning to the tab.
5. Changing the active Chrome tab does not automatically show or hide notes.

To link an existing note instead: hold its **🔗** button, choose **クリックでタブをリンク** (Click to link a tab), then select the Chrome tab. **新規付箋** in the note list creates an ordinary new note.

## Data use and permissions

The extension processes tab titles and temporary tab/window/session identifiers locally for tab linking. It uses window focus and bounds to confirm and locate the destination. It does not read page bodies or send page URLs to the desktop app. It has no remote-code download, analytics, advertising, or developer data-collection endpoint.

Native Messaging uses a local process's standard input/output; it does not open a network command port. The host is registered under the current user's Chrome NativeMessagingHosts registry key. A fresh installation allows this Web Store item ID only. An upgrade preserves explicitly registered development-extension IDs already belonging to the same installation.

[Privacy policy](CHROME_EXTENSION_PRIVACY.md).

## Troubleshooting and cleanup

- If Chrome reports that the native host is missing, ensure desktop version 0.12.1+ is installed for the same Windows user. If its installer reports a registration conflict, do not overwrite an unrelated native host; inspect the existing registration first.
- Chrome internal/restricted pages may not expose a title or page context menu. Test on an ordinary HTTPS page. A generic `Chrome tab <ID>` label is used if a title is unavailable.
- Restarting Chrome or reloading the extension can require reconnecting and linking the tab again. Closing a target tab produces an unavailable-link error rather than silently opening a replacement.
- Uninstalling the desktop app removes the host registry registration only if it still points to that installation. It preserves notes and other local data. Remove the Chrome extension separately through Chrome's extension settings.
