//! Biblioteca do usuario (curtidas, playlists, historico) persistida em JSON.

use crate::ytdl::Track;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

const HISTORY_MAX: usize = 50;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub tracks: Vec<Track>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Library {
    pub liked: Vec<Track>,
    pub playlists: Vec<Playlist>,
    pub history: Vec<Track>,
}

impl Library {
    pub fn toggle_like(&mut self, track: Track) {
        match self.liked.iter().position(|t| t.id == track.id) {
            Some(i) => {
                self.liked.remove(i);
            }
            None => self.liked.insert(0, track),
        }
    }

    pub fn create_playlist(&mut self, id: String) {
        let name = format!("Minha playlist nº {}", self.playlists.len() + 1);
        self.playlists.insert(0, Playlist { id, name, tracks: vec![] });
    }

    pub fn rename_playlist(&mut self, id: &str, name: &str) {
        let name = name.trim();
        if name.is_empty() {
            return;
        }
        if let Some(p) = self.playlists.iter_mut().find(|p| p.id == id) {
            p.name = name.to_string();
        }
    }

    pub fn delete_playlist(&mut self, id: &str) {
        self.playlists.retain(|p| p.id != id);
    }

    pub fn add_to_playlist(&mut self, id: &str, track: Track) {
        if let Some(p) = self.playlists.iter_mut().find(|p| p.id == id) {
            if !p.tracks.iter().any(|t| t.id == track.id) {
                p.tracks.push(track);
            }
        }
    }

    pub fn remove_from_playlist(&mut self, id: &str, track_id: &str) {
        if let Some(p) = self.playlists.iter_mut().find(|p| p.id == id) {
            p.tracks.retain(|t| t.id != track_id);
        }
    }

    pub fn push_history(&mut self, track: Track) {
        self.history.retain(|t| t.id != track.id);
        self.history.insert(0, track);
        self.history.truncate(HISTORY_MAX);
    }
}

pub struct Store {
    path: PathBuf,
    lib: Mutex<Library>,
}

impl Store {
    pub fn load(path: PathBuf) -> Self {
        let lib = match fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str(&text) {
                Ok(lib) => lib,
                Err(e) => {
                    // Nunca sobrescrever dados ilegiveis: guarda uma copia antes de recomecar.
                    let backup = path.with_extension("corrupt.json");
                    eprintln!("library.json ilegivel ({e}); copia salva em {}", backup.display());
                    let _ = fs::copy(&path, backup);
                    Library::default()
                }
            },
            Err(_) => Library::default(),
        };
        Self { path, lib: Mutex::new(lib) }
    }

    pub fn snapshot(&self) -> Result<Library, String> {
        Ok(self.lib.lock().map_err(|e| e.to_string())?.clone())
    }

    /// Aplica a mudanca, grava em disco (arquivo temporario + rename) e devolve o novo estado.
    pub fn update(&self, change: impl FnOnce(&mut Library)) -> Result<Library, String> {
        let mut lib = self.lib.lock().map_err(|e| e.to_string())?;
        change(&mut lib);
        let json = serde_json::to_string_pretty(&*lib).map_err(|e| e.to_string())?;
        let tmp = self.path.with_extension("tmp");
        fs::write(&tmp, json).map_err(|e| format!("nao foi possivel salvar a biblioteca: {e}"))?;
        fs::rename(&tmp, &self.path).map_err(|e| format!("nao foi possivel salvar a biblioteca: {e}"))?;
        Ok(lib.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(id: &str) -> Track {
        Track { id: id.into(), title: id.into(), artist: "a".into(), duration: Some(100.0) }
    }

    #[test]
    fn curtir_alterna() {
        let mut lib = Library::default();
        lib.toggle_like(t("a"));
        assert_eq!(lib.liked.len(), 1);
        lib.toggle_like(t("a"));
        assert!(lib.liked.is_empty());
    }

    #[test]
    fn playlist_nao_duplica_e_remove() {
        let mut lib = Library::default();
        lib.create_playlist("p1".into());
        lib.add_to_playlist("p1", t("a"));
        lib.add_to_playlist("p1", t("a"));
        assert_eq!(lib.playlists[0].tracks.len(), 1);
        lib.remove_from_playlist("p1", "a");
        assert!(lib.playlists[0].tracks.is_empty());
        lib.rename_playlist("p1", "  Rock  ");
        assert_eq!(lib.playlists[0].name, "Rock");
    }

    #[test]
    fn historico_dedup_e_limite() {
        let mut lib = Library::default();
        for i in 0..60 {
            lib.push_history(t(&format!("id{i}")));
        }
        lib.push_history(t("id10"));
        assert_eq!(lib.history.len(), HISTORY_MAX);
        assert_eq!(lib.history[0].id, "id10");
        assert_eq!(lib.history.iter().filter(|x| x.id == "id10").count(), 1);
    }

    #[test]
    fn store_persiste() {
        let path = std::env::temp_dir().join(format!("openfy-test-{}.json", std::process::id()));
        let _ = fs::remove_file(&path);
        let store = Store::load(path.clone());
        store.update(|l| l.toggle_like(t("a"))).unwrap();
        let again = Store::load(path.clone());
        assert_eq!(again.snapshot().unwrap().liked.len(), 1);
        let _ = fs::remove_file(&path);
    }
}
