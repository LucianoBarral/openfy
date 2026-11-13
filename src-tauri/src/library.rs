//! Biblioteca do usuario (curtidas, playlists, albuns, artistas, historico e
//! contagem de reproducoes) e a sessao de reproducao, persistidas em JSON.

use crate::catalog::Release;
use crate::ytdl::Track;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const HISTORY_MAX: usize = 50;
/// Faixas distintas com contagem guardada. Passando disso, sai a ouvida ha mais tempo.
const PLAYS_MAX: usize = 500;
/// A sessao guarda a fila para reabrir o app onde parou; filas gigantes sao cortadas.
const SESSION_QUEUE_MAX: usize = 500;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub tracks: Vec<Track>,
}

/// Quantas vezes uma faixa tocou e quando foi a ultima (segundos desde 1970).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Played {
    pub track: Track,
    pub count: u32,
    pub at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Library {
    pub liked: Vec<Track>,
    pub playlists: Vec<Playlist>,
    pub history: Vec<Track>,
    /// Albuns salvos, do mais recente para o mais antigo.
    pub albums: Vec<Release>,
    /// Artistas seguidos, do mais recente para o mais antigo.
    pub artists: Vec<Release>,
    /// Contagem de reproducoes por faixa; alimenta o Inicio personalizado.
    pub plays: Vec<Played>,
}

/// Poe `item` no comeco da lista, ou tira se ja estava la.
fn toggle_release(list: &mut Vec<Release>, item: Release) {
    match list.iter().position(|r| r.id == item.id) {
        Some(i) => {
            list.remove(i);
        }
        None => list.insert(0, item),
    }
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

    pub fn toggle_album(&mut self, album: Release) {
        toggle_release(&mut self.albums, album);
    }

    pub fn toggle_artist(&mut self, artist: Release) {
        toggle_release(&mut self.artists, artist);
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

    /// Registra que `track` comecou a tocar em `now` (segundos desde 1970):
    /// vai para o topo do historico e soma uma reproducao.
    pub fn push_history(&mut self, track: Track, now: u64) {
        self.history.retain(|t| t.id != track.id);
        self.history.insert(0, track.clone());
        self.history.truncate(HISTORY_MAX);

        match self.plays.iter_mut().find(|p| p.track.id == track.id) {
            Some(p) => {
                p.count = p.count.saturating_add(1);
                p.at = now;
                p.track = track; // metadados mais novos (capa, album) substituem os antigos
            }
            None => {
                if self.plays.len() >= PLAYS_MAX {
                    if let Some(oldest) = (0..self.plays.len()).min_by_key(|&i| self.plays[i].at) {
                        self.plays.swap_remove(oldest);
                    }
                }
                self.plays.push(Played { track, count: 1, at: now });
            }
        }
    }
}

/// O que estava tocando quando o app fechou, para reabrir no mesmo ponto.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Session {
    pub queue: Vec<Track>,
    /// Posicao da faixa atual em `queue`; -1 quando ela veio da fila do usuario.
    pub index: i64,
    pub current: Option<Track>,
    /// Segundos ja tocados da faixa atual.
    pub position: f64,
    pub user_queue: Vec<Track>,
}

impl Session {
    /// Corta filas enormes e descarta numeros que nao fazem sentido.
    fn sanitized(mut self) -> Self {
        self.queue.truncate(SESSION_QUEUE_MAX);
        self.user_queue.truncate(SESSION_QUEUE_MAX);
        if !self.position.is_finite() || self.position < 0.0 {
            self.position = 0.0;
        }
        if self.index < -1 || self.index >= self.queue.len() as i64 {
            self.index = -1;
        }
        self
    }
}

/// Le a sessao salva. Arquivo ausente ou ilegivel significa "sem sessao": ela e
/// descartavel, entao nao vale interromper a abertura do app por causa dela.
pub fn load_session(path: &Path) -> Option<Session> {
    let text = fs::read_to_string(path).ok()?;
    let session: Session = serde_json::from_str(&text).ok()?;
    let session = session.sanitized();
    session.current.is_some().then_some(session)
}

pub fn save_session(path: &Path, session: Session) -> Result<(), String> {
    let json = serde_json::to_string(&session.sanitized()).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, json).map_err(|e| format!("nao foi possivel salvar a sessao: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("nao foi possivel salvar a sessao: {e}"))
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
        Track { id: id.into(), title: id.into(), artist: "a".into(), duration: Some(100.0), ..Track::default() }
    }

    fn r(id: &str) -> Release {
        Release { id: id.into(), title: id.into(), ..Release::default() }
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
    fn salvar_album_e_seguir_artista_alternam() {
        let mut lib = Library::default();
        lib.toggle_album(r("a1"));
        lib.toggle_album(r("a2"));
        assert_eq!(lib.albums.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["a2", "a1"]);
        lib.toggle_album(r("a1"));
        assert_eq!(lib.albums.len(), 1);
        lib.toggle_artist(r("u1"));
        assert_eq!(lib.artists.len(), 1);
        assert_eq!(lib.albums.len(), 1, "artistas e albuns nao se misturam");
        lib.toggle_artist(r("u1"));
        assert!(lib.artists.is_empty());
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
            lib.push_history(t(&format!("id{i}")), i);
        }
        lib.push_history(t("id10"), 100);
        assert_eq!(lib.history.len(), HISTORY_MAX);
        assert_eq!(lib.history[0].id, "id10");
        assert_eq!(lib.history.iter().filter(|x| x.id == "id10").count(), 1);
    }

    #[test]
    fn reproducoes_contam_e_guardam_a_ultima_vez() {
        let mut lib = Library::default();
        lib.push_history(t("a"), 10);
        lib.push_history(t("b"), 20);
        lib.push_history(t("a"), 30);
        let a = lib.plays.iter().find(|p| p.track.id == "a").unwrap();
        assert_eq!((a.count, a.at), (2, 30));
        let b = lib.plays.iter().find(|p| p.track.id == "b").unwrap();
        assert_eq!((b.count, b.at), (1, 20));
    }

    #[test]
    fn reproducoes_cheias_descartam_a_mais_antiga() {
        let mut lib = Library::default();
        for i in 0..PLAYS_MAX as u64 {
            lib.push_history(t(&format!("id{i}")), 1000 + i);
        }
        lib.push_history(t("id0"), 5000); // id0 deixa de ser a mais antiga
        lib.push_history(t("nova"), 6000);
        assert_eq!(lib.plays.len(), PLAYS_MAX);
        assert!(lib.plays.iter().any(|p| p.track.id == "id0"));
        assert!(lib.plays.iter().any(|p| p.track.id == "nova"));
        assert!(!lib.plays.iter().any(|p| p.track.id == "id1"), "id1 era a mais antiga");
    }

    #[test]
    fn biblioteca_antiga_continua_abrindo() {
        let old = r#"{"liked":[],"playlists":[],"history":[{"id":"a","title":"A","artist":"x","duration":1.0}]}"#;
        let lib: Library = serde_json::from_str(old).unwrap();
        assert_eq!(lib.history.len(), 1);
        assert!(lib.albums.is_empty() && lib.artists.is_empty() && lib.plays.is_empty());
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

    #[test]
    fn sessao_vai_e_volta_e_corrige_numeros_ruins() {
        let path = std::env::temp_dir().join(format!("openfy-session-{}.json", std::process::id()));
        let _ = fs::remove_file(&path);
        assert_eq!(load_session(&path), None, "sem arquivo, sem sessao");

        let session = Session { queue: vec![t("a"), t("b")], index: 1, current: Some(t("b")), position: 42.5, user_queue: vec![t("c")] };
        save_session(&path, session.clone()).unwrap();
        assert_eq!(load_session(&path), Some(session));

        let bad = Session { queue: vec![t("a")], index: 9, current: Some(t("a")), position: f64::NAN, user_queue: vec![] };
        save_session(&path, bad).unwrap();
        let got = load_session(&path).unwrap();
        assert_eq!((got.index, got.position), (-1, 0.0));

        save_session(&path, Session::default()).unwrap();
        assert_eq!(load_session(&path), None, "sem faixa atual nao ha o que retomar");

        fs::write(&path, "{ lixo").unwrap();
        assert_eq!(load_session(&path), None);
        let _ = fs::remove_file(&path);
    }
}
