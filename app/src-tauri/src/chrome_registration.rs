use serde::Deserialize;
use std::{fs::File, io::Read, path::PathBuf};
use winreg::{RegKey, enums::HKEY_CURRENT_USER};

const HOST_NAME: &str = "io.github.hogawish.stickynotes";
const HOST_KEY: &str = r"Software\Google\Chrome\NativeMessagingHosts\io.github.hogawish.stickynotes";

#[derive(Deserialize)]
struct Manifest {
    name: String,
    path: PathBuf,
}

pub fn unregister_current_installation() {
    let (Some(appdata), Ok(executable)) = (std::env::var_os("APPDATA"), std::env::current_exe()) else {
        return;
    };
    let manifest_path = PathBuf::from(appdata).join(HOST_NAME).join("chrome-native-host.json");
    let registry = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(key) = registry.open_subkey(HOST_KEY) else { return };
    let Ok(registered): Result<String, _> = key.get_value("") else { return };
    if !same_file(&PathBuf::from(registered), &manifest_path) { return; }
    let Ok(file) = File::open(&manifest_path) else { return };
    let mut bytes = Vec::new();
    if file.take(16 * 1024 + 1).read_to_end(&mut bytes).is_err() || bytes.len() > 16 * 1024 { return; }
    let Ok(manifest) = serde_json::from_slice::<Manifest>(&bytes) else { return };
    if manifest.name == HOST_NAME && same_file(&manifest.path, &executable) {
        drop(key);
        let _ = registry.delete_subkey(HOST_KEY);
    }
}

fn same_file(left: &std::path::Path, right: &std::path::Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}
