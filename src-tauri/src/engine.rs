//! yt-dlp gerenciado pelo app.
//!
//! O Openfy guarda o proprio yt-dlp em `<dados do app>/bin` e o mantem em dia:
//! ao abrir (e depois a cada `RECHECK`) compara o SHA-256 do arquivo local com o
//! publicado na ultima release oficial e so baixa quando sao diferentes. O
//! arquivo baixado so entra no lugar se o hash conferir com o `SHA2-256SUMS` da
//! mesma release. Isso protege contra download corrompido ou trocado no caminho;
//! a origem continua sendo o GitHub do yt-dlp, acessado por HTTPS.
//!
//! Quem define `OPENFY_YTDLP` escolheu o proprio binario: nada e baixado.

use crate::ytdl;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

const BASE: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
const SUMS: &str = "SHA2-256SUMS";
/// Intervalo entre verificacoes enquanto o app fica aberto.
const RECHECK: Duration = Duration::from_secs(24 * 60 * 60);
/// Teto de seguranca para o download (o binario tem algumas dezenas de MB).
const MAX_BYTES: u64 = 300 * 1024 * 1024;

#[derive(Clone, Serialize)]
pub struct EngineInfo {
    /// "checking" | "downloading" | "ready" | "error"
    status: &'static str,
    /// De onde vem o yt-dlp em uso: "env" | "managed" | "path".
    source: &'static str,
    version: Option<String>,
    /// Com status "ready", e um aviso (ex.: nao deu para atualizar); com "error", o motivo.
    error: Option<String>,
}

pub struct EngineState {
    info: Mutex<EngineInfo>,
    /// Impede duas verificacoes ao mesmo tempo (a automatica e a pedida pelo usuario).
    busy: Mutex<()>,
}

impl Default for EngineState {
    fn default() -> Self {
        Self {
            info: Mutex::new(EngineInfo { status: "checking", source: ytdl::source(), version: None, error: None }),
            busy: Mutex::new(()),
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn set(app: &AppHandle, change: impl FnOnce(&mut EngineInfo)) {
    let state = app.state::<EngineState>();
    let snapshot = {
        let mut info = lock(&state.info);
        change(&mut info);
        info.source = ytdl::source();
        info.clone()
    };
    let _ = app.emit("ytdlp-state", snapshot);
}

/// Onde o yt-dlp do app fica dentro da pasta de dados.
pub fn managed_path(data_dir: &Path) -> PathBuf {
    data_dir.join("bin").join(if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" })
}

/// Nome do binario oficial para este sistema, como aparece na release.
fn asset_name() -> Option<&'static str> {
    if cfg!(all(windows, target_arch = "x86_64")) {
        Some("yt-dlp.exe")
    } else if cfg!(all(windows, target_arch = "aarch64")) {
        Some("yt-dlp_arm64.exe")
    } else if cfg!(all(windows, target_arch = "x86")) {
        Some("yt-dlp_x86.exe")
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some("yt-dlp_linux")
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Some("yt-dlp_linux_aarch64")
    } else if cfg!(target_os = "macos") {
        Some("yt-dlp_macos")
    } else {
        None
    }
}

/// Acha o SHA-256 de `asset` no `SHA2-256SUMS` (linhas `<64 hex>  <nome>`).
pub fn parse_sums(text: &str, asset: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let name = parts.next()?.trim_start_matches('*');
        let valid = hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit());
        (name == asset && valid).then(|| hash.to_ascii_lowercase())
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

/// Grava `reader` em `tmp` calculando o hash; se nao bater com `want`, apaga e falha.
fn copy_verified(mut reader: impl Read, tmp: &Path, want: &str) -> Result<(), String> {
    let result = (|| {
        let mut file = fs::File::create(tmp).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let mut buf = [0u8; 64 * 1024];
        loop {
            let n = reader.read(&mut buf).map_err(|e| format!("download interrompido: {e}"))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        }
        file.flush().map_err(|e| e.to_string())?;
        let got = hex(&hasher.finalize());
        if got != want {
            return Err(format!("o arquivo baixado nao confere com o hash oficial (esperado {want}, veio {got})"));
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}

/// Poe `tmp` no lugar de `dest`. O binario antigo e renomeado antes: no Windows
/// um executavel em uso pode ser renomeado, mas nao sobrescrito.
fn install(tmp: &Path, dest: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(tmp, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    let old = dest.with_extension("old");
    let had_old = dest.exists();
    if had_old {
        let _ = fs::remove_file(&old);
        fs::rename(dest, &old).map_err(|e| format!("nao foi possivel trocar o yt-dlp: {e}"))?;
    }
    if let Err(e) = fs::rename(tmp, dest) {
        if had_old {
            let _ = fs::rename(&old, dest);
        }
        return Err(format!("nao foi possivel instalar o yt-dlp: {e}"));
    }
    let _ = fs::remove_file(&old);
    Ok(())
}

fn request(url: &str, timeout: Duration) -> Result<ureq::Response, String> {
    ureq::get(url)
        .set("User-Agent", concat!("Openfy/", env!("CARGO_PKG_VERSION")))
        .timeout(timeout)
        .call()
        .map_err(|e| format!("nao foi possivel falar com o GitHub: {e}"))
}

/// Deixa o yt-dlp do app igual ao da ultima release oficial.
fn sync(app: &AppHandle) -> Result<(), String> {
    let asset = asset_name().ok_or("nao ha yt-dlp oficial para este sistema")?;
    let dest = ytdl::managed().ok_or("pasta do yt-dlp nao definida")?;
    set(app, |i| {
        i.status = "checking";
        i.error = None;
    });
    let sums = request(&format!("{BASE}/{SUMS}"), Duration::from_secs(15))?
        .into_string()
        .map_err(|e| e.to_string())?;
    let want = parse_sums(&sums, asset).ok_or_else(|| format!("{asset} nao aparece na lista de hashes"))?;
    if dest.is_file() && hash_file(dest)? == want {
        return Ok(());
    }
    set(app, |i| i.status = "downloading");
    if let Some(dir) = dest.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = dest.with_extension("part");
    let body = request(&format!("{BASE}/{asset}"), Duration::from_secs(600))?.into_reader().take(MAX_BYTES);
    copy_verified(body, &tmp, &want)?;
    install(&tmp, dest)
}

/// Atualiza (se `download`) e publica qual yt-dlp esta valendo.
fn refresh(app: &AppHandle, download: bool) {
    let state = app.state::<EngineState>();
    let Ok(_guard) = state.busy.try_lock() else {
        return;
    };
    let problem = if download { sync(app).err() } else { None };
    match ytdl::version() {
        Ok(version) => set(app, |i| {
            i.status = "ready";
            i.version = Some(version);
            i.error = problem;
        }),
        Err(e) => set(app, |i| {
            i.status = "error";
            i.version = None;
            i.error = Some(problem.unwrap_or(e));
        }),
    }
}

/// Builds de desenvolvimento nao baixam nada sozinhos; `OPENFY_YTDLP_MANAGE=1`
/// liga o download para testes. Com `OPENFY_YTDLP` definido, nunca.
fn auto() -> bool {
    ytdl::source() != "env" && (!cfg!(debug_assertions) || std::env::var("OPENFY_YTDLP_MANAGE").is_ok_and(|v| v == "1"))
}

/// Verifica em segundo plano ao abrir e depois a cada `RECHECK`.
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        if !auto() {
            refresh(&app, false);
            return;
        }
        loop {
            refresh(&app, true);
            std::thread::sleep(RECHECK);
        }
    });
}

#[tauri::command]
pub fn ytdlp_state(state: State<EngineState>) -> EngineInfo {
    lock(&state.info).clone()
}

/// Pedido do usuario: baixar ou atualizar o yt-dlp do app agora.
#[tauri::command]
pub async fn ytdlp_install(app: AppHandle) -> Result<EngineInfo, String> {
    if ytdl::source() == "env" {
        return Err("OPENFY_YTDLP está definido; o Openfy não troca esse yt-dlp.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        refresh(&app, true);
        let info = lock(&app.state::<EngineState>().info).clone();
        info
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SHA-256 de "abc" (vetor de teste do FIPS 180-2).
    const ABC: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    fn temp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("openfy-engine-{}-{name}", std::process::id()))
    }

    #[test]
    fn acha_o_hash_do_arquivo_certo() {
        let sums = format!("{}  yt-dlp\n{ABC}  yt-dlp.exe\n{}  yt-dlp_x86.exe\n", "1".repeat(64), "2".repeat(64));
        assert_eq!(parse_sums(&sums, "yt-dlp.exe").as_deref(), Some(ABC));
        assert_eq!(parse_sums(&sums, "yt-dlp_macos"), None);
        assert_eq!(parse_sums("curto  yt-dlp.exe", "yt-dlp.exe"), None, "hash invalido nao vale");
        assert_eq!(parse_sums(&format!("{}  *yt-dlp.exe", ABC.to_uppercase()), "yt-dlp.exe").as_deref(), Some(ABC));
    }

    #[test]
    fn so_aceita_download_com_hash_correto() {
        let tmp = temp("ok.part");
        copy_verified(&b"abc"[..], &tmp, ABC).unwrap();
        assert_eq!(hash_file(&tmp).unwrap(), ABC);
        let _ = fs::remove_file(&tmp);

        let bad = temp("bad.part");
        let err = copy_verified(&b"abd"[..], &bad, ABC).unwrap_err();
        assert!(err.contains("nao confere"), "{err}");
        assert!(!bad.exists(), "arquivo reprovado nao pode ficar no disco");
    }

    #[test]
    fn instalar_troca_o_binario_antigo() {
        let dest = temp("yt-dlp.exe");
        let tmp = dest.with_extension("part");
        fs::write(&dest, "velho").unwrap();
        fs::write(&tmp, "novo").unwrap();
        install(&tmp, &dest).unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), "novo");
        assert!(!tmp.exists() && !dest.with_extension("old").exists());
        let _ = fs::remove_file(&dest);
    }

    #[test]
    fn caminho_gerenciado_fica_em_bin() {
        let path = managed_path(Path::new("dados"));
        assert_eq!(path.parent().unwrap(), Path::new("dados").join("bin"));
    }
}
