#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod catalog;
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
    tauri::async_runtime::spawn_blocking(move || {
        or_fallback("busca", catalog::search(&query), || ytdl::search(&query, 30))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Faixas parecidas com `id`, para a reproducao continuar quando a fila acaba.
#[tauri::command]
async fn related(id: String) -> Result<Vec<Track>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        or_fallback("radio", catalog::radio(&id), || ytdl::related(&id, 30))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Usa a resposta do catalogo; se ele falhar ou vier vazio, cai no yt-dlp.
///
/// O catalogo e um servico sem contrato publico: quando ele muda ou sai do ar,
/// o app continua tocando, so que com os metadados mais pobres do yt-dlp.
fn or_fallback(
    what: &str,
    primary: Result<Vec<Track>, String>,
    fallback: impl FnOnce() -> Result<Vec<Track>, String>,
) -> Result<Vec<Track>, String> {
    match primary {
        Ok(tracks) if !tracks.is_empty() => Ok(tracks),
        Ok(_) => fallback(),
        Err(e) => {
            eprintln!("catalogo indisponivel na {what} ({e}); usando yt-dlp");
            fallback()
        }
    }
}

#[tauri::command]
async fn album(id: String) -> Result<catalog::Album, String> {
    tauri::async_runtime::spawn_blocking(move || catalog::album(&id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn artist(id: String) -> Result<catalog::Artist, String> {
    tauri::async_runtime::spawn_blocking(move || catalog::artist(&id))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn t(id: &str) -> Track {
        Track { id: id.into(), ..Track::default() }
    }

    #[test]
    fn catalogo_com_resultado_dispensa_o_yt_dlp() {
        let got = or_fallback("busca", Ok(vec![t("cat")]), || panic!("nao devia chamar o yt-dlp"));
        assert_eq!(got.unwrap()[0].id, "cat");
    }

    #[test]
    fn catalogo_com_erro_ou_vazio_cai_no_yt_dlp() {
        let erro = or_fallback("busca", Err("fora do ar".into()), || Ok(vec![t("yt")]));
        assert_eq!(erro.unwrap()[0].id, "yt");
        let vazio = or_fallback("radio", Ok(vec![]), || Ok(vec![t("yt")]));
        assert_eq!(vazio.unwrap()[0].id, "yt");
    }

    #[test]
    fn os_dois_falhando_devolve_o_erro_do_yt_dlp() {
        let got = or_fallback("busca", Err("catalogo".into()), || Err("yt-dlp".into()));
        assert_eq!(got.unwrap_err(), "yt-dlp");
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
            album,
            artist,
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
