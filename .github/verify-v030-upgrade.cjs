const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const [install, oldInstaller, newInstaller] = process.argv.slice(2).map(file => path.resolve(file));
const app = path.join(install, "app.exe");
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const registryKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Markdown Sticky Notes";

function installVersion(installer, version) {
  const result = spawnSync(installer, ["/S", "/NS", "/D=" + install], {
    windowsHide: true, timeout: 60000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, "installer exit status");
  const registration = spawnSync("reg.exe", ["query", registryKey], { encoding: "utf8", windowsHide: true });
  assert.equal(registration.status, 0);
  assert(registration.stdout.includes(version), "registered version");
  assert(registration.stdout.includes(install), "registered installation directory");
  assert(fs.existsSync(app), "installed app.exe");
  console.log("Installed and registered " + version + " in the test directory.");
}

installVersion(oldInstaller, "0.3.0-alpha.14");
const oldHash = hash(app);
const notes = path.join(process.env.RUNNER_TEMP, "upgrade-data");
const settings = path.join(process.env.APPDATA, "io.github.hogawish.stickynotes");
fs.mkdirSync(notes, { recursive: true });
fs.mkdirSync(settings, { recursive: true });
const note = path.join(notes, "upgrade.md");
const config = path.join(settings, "config.json");
fs.writeFileSync(note, "---\nid: upgrade\ntags: [test]\ncolor: pink\n---\n# Original note\n");
fs.writeFileSync(config, JSON.stringify({ folders: [{ path: notes, label: "Test notes" }], notes: {} }));
const before = [hash(note), hash(config)];
installVersion(newInstaller, "0.3.0");
assert.notEqual(hash(app), oldHash, "old executable was replaced");
assert.equal(hash(app), "5b6c3042a33b4a0afff3ccf77ed586c50d4fe643c17fc08068559d69416212e7", "installed app equals the locally tested executable");
assert.deepEqual([hash(note), hash(config)], before, "note and settings stayed byte-identical");
console.log("PASS: in-place upgrade, note and settings preservation, and exact app payload.");
