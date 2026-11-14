# Application source

See the [project README](../README.md) for setup, build commands, storage, known limitations and licenses.

On Windows, run the regular tests and then use the exact executable being handed off for the WebView smoke test.

```powershell
npm test
node tests/release-smoke.cjs C:\path\to\app.exe
```

The smoke test uses its own notes and settings. It checks that a note opens from the list, Ctrl+wheel changes its font size, the size survives reload, and Ctrl+0 restores the default. Pass the built `window_fixture.exe` as a second argument to repeat Ctrl+wheel with a native window attachment. The WebView test injects input through Chromium, so use a physical wheel and a real drag for the final Windows input check.
