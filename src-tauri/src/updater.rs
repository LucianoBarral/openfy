//! Atualizacao automatica.
//!
//! O app consulta o `latest.json` da ultima release no GitHub (endereco em
//! `tauri.conf.json`), baixa o instalador em segundo plano e avisa a UI pelo
//! evento `update-state`. O pacote so e aceito se a assinatura conferir com a
//! chave publica embutida no app.

use serde::Serialize;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Intervalo entre consultas enquanto o app fica aberto.
const RECHECK: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Serialize)]
pub struct UpdateInfo {
    /// Versao em execucao.
    current: String,
    /// "off" | "checking" | "idle" | "downloading" | "ready" | "error"
    status: &'static str,
    /// Versao nova, quando existe.
    version: Option<String>,
    error: Option<String>,
}

pub struct UpdateState {
    info: Mutex<UpdateInfo>,
    /// Atualizacao ja baixada e verificada, esperando a instalacao.
    ready: Mutex<Option<(Update, Vec<u8>)>>,
}

impl UpdateState {
    pub fn new(current: String) -> Self {
        Self {
            info: Mutex::new(UpdateInfo { current, status: "off", version: None, error: None }),
            ready: Mutex::new(None),
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn set(app: &AppHandle, change: impl FnOnce(&mut UpdateInfo)) {
    let state = app.state::<UpdateState>();
    let snapshot = {
        let mut info = lock(&state.info);
        change(&mut info);
        info.clone()
    };
    let _ = app.emit("update-state", snapshot);
}

/// Builds de desenvolvimento nao se atualizam sozinhos (trocariam o binario que
/// voce esta depurando); `OPENFY_UPDATE_CHECK=1` liga a consulta para testes.
fn enabled() -> bool {
    !cfg!(debug_assertions) || std::env::var("OPENFY_UPDATE_CHECK").is_ok_and(|v| v == "1")
}

/// Consulta uma vez. `Ok(true)` = ha uma atualizacao baixada e pronta.
async fn check_once(app: &AppHandle) -> Result<bool, String> {
    set(app, |i| {
        i.status = "checking";
        i.error = None;
    });
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        set(app, |i| i.status = "idle");
        return Ok(false);
    };
    let version = update.version.clone();
    set(app, |i| {
        i.status = "downloading";
        i.version = Some(version);
    });
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    *lock(&app.state::<UpdateState>().ready) = Some((update, bytes));
    set(app, |i| i.status = "ready");
    Ok(true)
}

/// Inicia a verificacao em segundo plano (ao abrir e depois a cada `RECHECK`).
pub fn spawn(app: AppHandle) {
    if !enabled() {
        return;
    }
    std::thread::spawn(move || loop {
        match tauri::async_runtime::block_on(check_once(&app)) {
            Ok(true) => break,
            Ok(false) => {}
            Err(error) => set(&app, |i| {
                i.status = "error";
                i.error = Some(error);
            }),
        }
        std::thread::sleep(RECHECK);
    });
}

#[tauri::command]
pub fn update_state(state: State<UpdateState>) -> UpdateInfo {
    lock(&state.info).clone()
}

/// Instala a atualizacao ja baixada e reinicia o app.
#[tauri::command]
pub fn update_install(app: AppHandle, state: State<UpdateState>) -> Result<(), String> {
    let (update, bytes) = lock(&state.ready).take().ok_or("Nenhuma atualização pronta.")?;
    if let Err(e) = update.install(&bytes) {
        // Devolve o pacote para o usuario poder tentar de novo.
        *lock(&state.ready) = Some((update, bytes));
        return Err(e.to_string());
    }
    app.restart()
}
