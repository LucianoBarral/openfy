#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod library;
mod updater;
mod ytdl;

use library::{Library, Store};
use std::io::Write;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use ytdl::{StreamCache, Track};

#[tauri::command]
async fn search(query: String) -> Result<Vec<Track>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(vec![]);
    }
    tauri::async_runtime::spawn_blocking(move || ytdl::search(&query, 30))
        .await
        .map_err(|e| e.to_string())?
}

/// Faixas parecidas com `id`, para a reproducao continuar quando a fila acaba.
#[tauri::command]
async fn related(id: String) -> Result<Vec<Track>, String> {
    tauri::async_runtime::spawn_blocking(move || ytdl::related(&id, 30))
        .await
        .map_err(|e| e.to_string())?
}

/// Devolve a URL de audio da faixa. `force` ignora o cache (usado quando a URL expirou).
#[tauri::command]
async fn resolve_stream(id: String, force: bool, cache: State<'_, Arc<StreamCache>>) -> Result<String, String> {
    if !force {
        if let Some(url) = cache.get(&id) {
            return Ok(url);
        }
    }
    // A UI chama isto tambem para pre-carregar; `resolve` junta chamadas repetidas da mesma faixa.
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || cache.resolve(&id, force))
        .await
        .map_err(|e| e.to_string())?
}

/// Sugestoes de busca para o texto digitado ate agora.
#[tauri::command]
async fn suggest(query: String) -> Result<Vec<String>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(vec![]);
    }
    tauri::async_runtime::spawn_blocking(move || ytdl::suggest(&query, 8))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_library(store: State<Store>) -> Result<Library, String> {
    store.snapshot()
}

#[tauri::command]
fn toggle_like(track: Track, store: State<Store>) -> Result<Library, String> {
    store.update(|l| l.toggle_like(track))
}

#[tauri::command]
fn create_playlist(store: State<Store>) -> Result<Library, String> {
    let id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis()
        .to_string();
    store.update(|l| l.create_playlist(id))
}

#[tauri::command]
fn rename_playlist(playlist_id: String, name: String, store: State<Store>) -> Result<Library, String> {
    store.update(|l| l.rename_playlist(&playlist_id, &name))
}

#[tauri::command]
fn delete_playlist(playlist_id: String, store: State<Store>) -> Result<Library, String> {
    store.update(|l| l.delete_playlist(&playlist_id))
}

#[tauri::command]
fn add_to_playlist(playlist_id: String, track: Track, store: State<Store>) -> Result<Library, String> {
    store.update(|l| l.add_to_playlist(&playlist_id, track))
}

#[tauri::command]
fn remove_from_playlist(playlist_id: String, track_id: String, store: State<Store>) -> Result<Library, String> {
    store.update(|l| l.remove_from_playlist(&playlist_id, &track_id))
}

#[tauri::command]
fn push_history(track: Track, store: State<Store>) -> Result<Library, String> {
    store.update(|l| l.push_history(track))
}

/// Autoteste ponta a ponta: com OPENFY_SELFTEST="consulta" a UI busca, toca o
/// primeiro resultado e relata o que observou em OPENFY_SELFTEST_OUT.
#[tauri::command]
fn selftest_query() -> Option<String> {
    std::env::var("OPENFY_SELFTEST").ok().filter(|q| !q.trim().is_empty())
}

#[tauri::command]
fn selftest_report(line: String, app: AppHandle) {
    println!("[selftest] {line}");
    if let Ok(path) = std::env::var("OPENFY_SELFTEST_OUT") {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{line}");
        }
    }
    if line.starts_with("DONE") || line.starts_with("FAIL") {
        app.exit(0);
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(Store::load(dir.join("library.json")));
            app.manage(Arc::new(StreamCache::default()));
            app.manage(updater::UpdateState::new(app.package_info().version.to_string()));
            updater::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            search,
            related,
            resolve_stream,
            suggest,
            get_library,
            toggle_like,
            create_playlist,
            rename_playlist,
            delete_playlist,
            add_to_playlist,
            remove_from_playlist,
            push_history,
            selftest_query,
            selftest_report,
            updater::update_state,
            updater::update_install
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Openfy");
}
