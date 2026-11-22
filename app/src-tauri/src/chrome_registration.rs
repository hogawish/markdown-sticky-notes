use serde::{Deserialize, Serialize};
use std::{fs::{self, File}, io::Read, path::{Path, PathBuf}};
use winreg::{RegKey, enums::HKEY_CURRENT_USER};

const HOST_NAME: &str = "io.github.hogawish.stickynotes";
const HOST_KEY: &str = r"Software\Google\Chrome\NativeMessagingHosts\io.github.hogawish.stickynotes";
const STORE_EXTENSION_ID: &str = "gmddcmanllooimaoidnndbpblohcopip";

#[derive(Deserialize, Serialize)]
struct Manifest {
    name: String,
    path: PathBuf,
    #[serde(default)]
    description: String,
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    allowed_origins: Vec<String>,
}

fn read_manifest(path: &Path) -> Result<Manifest, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(16 * 1024 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() > 16 * 1024 { return Err("Chrome host manifest is too large".into()); }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

fn valid_origin(origin: &str) -> bool {
    origin.strip_prefix("chrome-extension://").and_then(|v| v.strip_suffix('/'))
        .is_some_and(|id| id.len() == 32 && id.bytes().all(|c| (b'a'..=b'p').contains(&c)))
}

fn register_at(registry: &RegKey, key_path: &str, root: &Path, executable: &Path) -> Result<(), String> {
    let manifest_path = root.join("chrome-native-host.json");
    let mut origins = Vec::new();
    match registry.open_subkey(key_path) {
        Ok(key) => {
            let registered: String = key.get_value("").map_err(|e| e.to_string())?;
            if !same_file(Path::new(&registered), &manifest_path) {
                return Err("Another Chrome native host registration exists; it was not changed".into());
            }
            let old = read_manifest(&manifest_path)?;
            if old.name != HOST_NAME || old.kind != "stdio" || !same_file(&old.path, executable)
                || !old.allowed_origins.iter().all(|o| valid_origin(o)) {
                return Err("Existing Chrome host belongs to another installation or is invalid; it was not changed".into());
            }
            origins = old.allowed_origins;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
        Err(e) => return Err(e.to_string()),
    }
    let origin = format!("chrome-extension://{STORE_EXTENSION_ID}/");
    if !origins.contains(&origin) { origins.push(origin); }
    let manifest = Manifest {
        name: HOST_NAME.into(), path: executable.to_path_buf(),
        description: "Markdown Sticky Notes tab context".into(), kind: "stdio".into(),
        allowed_origins: origins,
    };
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
    super::atomic_write(&manifest_path, &bytes)?;
    let (key, _) = registry.create_subkey(key_path).map_err(|e| e.to_string())?;
    key.set_value("", &manifest_path.to_string_lossy().as_ref()).map_err(|e| e.to_string())
}

pub fn register_current_installation() -> Result<(), String> {
    let appdata = std::env::var_os("APPDATA").ok_or("APPDATA is not configured")?;
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    register_at(&RegKey::predef(HKEY_CURRENT_USER), HOST_KEY, &PathBuf::from(appdata).join(HOST_NAME), &executable)
}

pub fn unregister_current_installation() {
    let (Some(appdata), Ok(executable)) = (std::env::var_os("APPDATA"), std::env::current_exe()) else {
        return;
    };
    unregister_at(&RegKey::predef(HKEY_CURRENT_USER), HOST_KEY, &PathBuf::from(appdata).join(HOST_NAME), &executable);
}

fn unregister_at(registry: &RegKey, key_path: &str, root: &Path, executable: &Path) {
    let manifest_path = root.join("chrome-native-host.json");
    let Ok(key) = registry.open_subkey(key_path) else { return };
    let Ok(registered): Result<String, _> = key.get_value("") else { return };
    if !same_file(&PathBuf::from(registered), &manifest_path) { return; }
    let Ok(file) = File::open(&manifest_path) else { return };
    let mut bytes = Vec::new();
    if file.take(16 * 1024 + 1).read_to_end(&mut bytes).is_err() || bytes.len() > 16 * 1024 { return; }
    let Ok(manifest) = serde_json::from_slice::<Manifest>(&bytes) else { return };
    if manifest.name == HOST_NAME && same_file(&manifest.path, &executable) {
        drop(key);
        let _ = registry.delete_subkey(key_path);
    }
}

fn same_file(left: &std::path::Path, right: &std::path::Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture { root: tempfile::TempDir, registry: RegKey, key: String }
    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let key = format!(r"Software\MarkdownStickyNotesTests\chrome-registration-{}-{}", std::process::id(), root.path().file_name().unwrap().to_string_lossy());
            Self {root, registry: RegKey::predef(HKEY_CURRENT_USER), key}
        }
        fn exe(&self) -> PathBuf { let exe = self.root.path().join("app.exe"); fs::write(&exe,b"fixture").unwrap(); exe }
    }
    impl Drop for Fixture {fn drop(&mut self) {let _ = self.registry.delete_subkey_all(&self.key);}}
    #[test]
    fn fresh_registration_and_repeat_have_only_store_origin() {
        assert_eq!(STORE_EXTENSION_ID.len(),32);
        let f=Fixture::new();let exe=f.exe();
        register_at(&f.registry,&f.key,f.root.path(),&exe).unwrap();
        register_at(&f.registry,&f.key,f.root.path(),&exe).unwrap();
        let manifest=read_manifest(&f.root.path().join("chrome-native-host.json")).unwrap();
        assert_eq!(manifest.allowed_origins,vec![format!("chrome-extension://{STORE_EXTENSION_ID}/")]);
        assert_eq!(manifest.path,exe);
        let registered:String=f.registry.open_subkey(&f.key).unwrap().get_value("").unwrap();
        assert!(same_file(Path::new(&registered),&f.root.path().join("chrome-native-host.json")));
    }
    #[test]
    fn upgrade_preserves_explicit_developer_origin() {
        let f=Fixture::new();let exe=f.exe();
        register_at(&f.registry,&f.key,f.root.path(),&exe).unwrap();
        let path=f.root.path().join("chrome-native-host.json");
        let mut manifest=read_manifest(&path).unwrap();
        let dev="chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/".to_string();
        manifest.allowed_origins=vec![dev.clone()];
        fs::write(&path,serde_json::to_vec(&manifest).unwrap()).unwrap();
        register_at(&f.registry,&f.key,f.root.path(),&exe).unwrap();
        assert_eq!(read_manifest(&path).unwrap().allowed_origins,vec![dev,format!("chrome-extension://{STORE_EXTENSION_ID}/")]);
    }
    #[test]
    fn foreign_registration_is_not_overwritten() {
        let f=Fixture::new();let exe=f.exe();
        let (key,_)=f.registry.create_subkey(&f.key).unwrap();
        key.set_value("",&"C:\\other-host.json").unwrap();drop(key);
        assert!(register_at(&f.registry,&f.key,f.root.path(),&exe).is_err());
        assert!(!f.root.path().join("chrome-native-host.json").exists());
        let registered:String=f.registry.open_subkey(&f.key).unwrap().get_value("").unwrap();
        assert_eq!(registered,"C:\\other-host.json");
    }
    #[test]
    fn other_installation_or_wildcard_is_not_overwritten() {
        let f=Fixture::new();let exe=f.exe();
        register_at(&f.registry,&f.key,f.root.path(),&exe).unwrap();
        let path=f.root.path().join("chrome-native-host.json");
        let mut manifest=read_manifest(&path).unwrap();manifest.allowed_origins=vec!["chrome-extension://*/".into()];
        let old=serde_json::to_vec(&manifest).unwrap();fs::write(&path,&old).unwrap();
        assert!(register_at(&f.registry,&f.key,f.root.path(),&exe).is_err());assert_eq!(fs::read(&path).unwrap(),old);
        manifest.allowed_origins.clear();manifest.path=f.root.path().join("other.exe");fs::write(&manifest.path,b"other").unwrap();
        let old=serde_json::to_vec(&manifest).unwrap();fs::write(&path,&old).unwrap();
        assert!(register_at(&f.registry,&f.key,f.root.path(),&exe).is_err());assert_eq!(fs::read(&path).unwrap(),old);
    }
    #[test]
    fn uninstall_removes_only_the_matching_installation_and_keeps_notes() {
        let f=Fixture::new();let exe=f.exe();
        let note=f.root.path().join("note.md");fs::write(&note,b"keep me").unwrap();
        register_at(&f.registry,&f.key,f.root.path(),&exe).unwrap();
        let other=f.root.path().join("other.exe");fs::write(&other,b"other").unwrap();
        unregister_at(&f.registry,&f.key,f.root.path(),&other);
        assert!(f.registry.open_subkey(&f.key).is_ok());
        unregister_at(&f.registry,&f.key,f.root.path(),&exe);
        assert!(f.registry.open_subkey(&f.key).is_err());assert_eq!(fs::read(&note).unwrap(),b"keep me");
        register_at(&f.registry,&f.key,f.root.path(),&exe).unwrap();
        assert!(f.registry.open_subkey(&f.key).is_ok());
    }
}
