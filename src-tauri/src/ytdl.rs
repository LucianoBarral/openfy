//! Ponte com o yt-dlp: busca e resolucao da URL de audio.
//! Tudo aqui e sincrono (bloqueia ate o processo terminar); quem chama
//! roda isto em `spawn_blocking` para nao travar a UI.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Track {
    pub id: String,
    pub title: String,
    pub artist: String,
    /// Segundos. `None` quando o yt-dlp nao informa (lives, por exemplo).
    pub duration: Option<f64>,
    // Os campos abaixo so existem para faixas vindas do catalogo. Sao opcionais
    // para que bibliotecas salvas antes deles continuem abrindo.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub album_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artist_id: Option<String>,
    /// URL da capa quadrada. Sem ela, a interface usa a miniatura do video.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
}

/// URLs do googlevideo expiram em ~6h; guardamos por 3h para ter folga.
const STREAM_TTL: Duration = Duration::from_secs(3 * 60 * 60);

/// Uma resolucao em andamento: quem chega depois espera o resultado de quem comecou.
#[derive(Default)]
struct Slot {
    result: Mutex<Option<Result<String, String>>>,
    ready: Condvar,
}

#[derive(Default)]
pub struct StreamCache {
    done: Mutex<HashMap<String, (String, Instant)>>,
    pending: Mutex<HashMap<String, Arc<Slot>>>,
}

impl StreamCache {
    pub fn get(&self, id: &str) -> Option<String> {
        let map = self.done.lock().ok()?;
        map.get(id)
            .filter(|(_, at)| at.elapsed() < STREAM_TTL)
            .map(|(url, _)| url.clone())
    }

    pub fn put(&self, id: &str, url: &str) {
        if let Ok(mut map) = self.done.lock() {
            map.insert(id.to_string(), (url.to_string(), Instant::now()));
        }
    }

    /// URL de audio de `id`, do cache quando possivel. `force` ignora o cache (URL expirada).
    pub fn resolve(&self, id: &str, force: bool) -> Result<String, String> {
        self.resolve_with(id, force, resolve_stream)
    }

    /// Nunca roda dois `fetch` para o mesmo id ao mesmo tempo: o pre-carregamento
    /// e o clique do usuario dividem a mesma chamada ao yt-dlp.
    fn resolve_with(
        &self,
        id: &str,
        force: bool,
        fetch: impl FnOnce(&str) -> Result<String, String>,
    ) -> Result<String, String> {
        if !force {
            if let Some(url) = self.get(id) {
                return Ok(url);
            }
        }
        let (slot, owner) = {
            let mut pending = self.pending.lock().map_err(|e| e.to_string())?;
            match pending.get(id) {
                Some(slot) => (slot.clone(), false),
                None => {
                    let slot = Arc::new(Slot::default());
                    pending.insert(id.to_string(), slot.clone());
                    (slot, true)
                }
            }
        };
        if !owner {
            let mut guard = slot.result.lock().map_err(|e| e.to_string())?;
            loop {
                if let Some(result) = guard.as_ref() {
                    return result.clone();
                }
                guard = slot.ready.wait(guard).map_err(|e| e.to_string())?;
            }
        }
        let result = fetch(id);
        if let Ok(url) = &result {
            self.put(id, url);
        }
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(id);
        }
        if let Ok(mut guard) = slot.result.lock() {
            *guard = Some(result.clone());
        }
        slot.ready.notify_all();
        result
    }
}

/// Onde fica o yt-dlp que o proprio app baixa e mantem (definido uma vez, ao abrir).
static MANAGED: OnceLock<PathBuf> = OnceLock::new();

pub fn set_managed(path: PathBuf) {
    let _ = MANAGED.set(path);
}

pub fn managed() -> Option<&'static Path> {
    MANAGED.get().map(PathBuf::as_path)
}

/// Qual yt-dlp usar, nesta ordem: o de `OPENFY_YTDLP` (escolha explicita de quem
/// roda o app), o gerenciado pelo app (se ja foi baixado), o do PATH.
fn pick_program(env: Option<String>, managed: Option<&Path>) -> (OsString, &'static str) {
    if let Some(exe) = env.filter(|p| !p.trim().is_empty()) {
        return (exe.into(), "env");
    }
    match managed.filter(|p| p.is_file()) {
        Some(path) => (path.into(), "managed"),
        None => ("yt-dlp".into(), "path"),
    }
}

fn program() -> (OsString, &'static str) {
    pick_program(std::env::var("OPENFY_YTDLP").ok(), managed())
}

/// De onde vem o yt-dlp em uso: "env" | "managed" | "path".
pub fn source() -> &'static str {
    program().1
}

/// Versao do yt-dlp em uso (ex.: "2026.10.26"); erro se ele nao existe ou nao roda.
pub fn version() -> Result<String, String> {
    let mut cmd = yt_dlp();
    cmd.arg("--version");
    Ok(run(cmd)?.trim().to_string())
}

fn yt_dlp() -> Command {
    let mut cmd = Command::new(program().0);
    cmd.env("PYTHONIOENCODING", "utf-8").env("PYTHONUTF8", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn run(mut cmd: Command) -> Result<String, String> {
    let out = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "yt-dlp nao encontrado. O Openfy baixa o proprio yt-dlp ao abrir; verifique a internet e abra o app de novo.".to_string()
        } else {
            format!("falha ao executar yt-dlp: {e}")
        }
    })?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let last = err.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("erro desconhecido");
        return Err(format!("yt-dlp: {last}"));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Ids do YouTube tem 11 caracteres de [A-Za-z0-9_-]. Validar impede que um
/// "id" vindo da UI vire uma opcao de linha de comando do yt-dlp.
pub fn is_valid_id(id: &str) -> bool {
    id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Decide se um resultado da busca entra na lista.
///
/// TODO(voce): esta e a regra de negocio que define "o que e musica" no Openfy.
/// O padrao abaixo so corta lives (sem duracao), clipes < 30s e videos > 15min.
/// Ideias: cortar "reaction"/"review" pelo titulo, aceitar sets longos de DJ,
/// preferir canais "- Topic" (uploads oficiais de audio).
pub fn is_music_result(track: &Track) -> bool {
    match track.duration {
        Some(d) => (30.0..=15.0 * 60.0).contains(&d),
        None => false,
    }
}

pub fn parse_search(json: &str) -> Result<Vec<Track>, String> {
    let root: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("resposta invalida do yt-dlp: {e}"))?;
    let entries = root["entries"].as_array().cloned().unwrap_or_default();
    Ok(entries
        .iter()
        .filter_map(|e| {
            let id = e["id"].as_str()?.to_string();
            if !is_valid_id(&id) {
                return None;
            }
            let artist = e["channel"]
                .as_str()
                .or_else(|| e["uploader"].as_str())
                .unwrap_or("Desconhecido")
                .trim_end_matches(" - Topic")
                .to_string();
            Some(Track {
                id,
                title: e["title"].as_str()?.to_string(),
                artist,
                duration: e["duration"].as_f64(),
                ..Track::default()
            })
        })
        .filter(is_music_result)
        .collect())
}

pub fn search(query: &str, limit: usize) -> Result<Vec<Track>, String> {
    let mut cmd = yt_dlp();
    // O prefixo "ytsearchN:" garante que a consulta nunca e lida como opcao.
    cmd.arg(format!("ytsearch{limit}:{query}"))
        .args(["--flat-playlist", "-J", "--no-warnings", "--skip-download"]);
    parse_search(&run(cmd)?)
}

/// Faixas no mesmo estilo de `id`: o "Mix" que o YouTube gera para a faixa (lista `RD<id>`).
pub fn related(id: &str, limit: usize) -> Result<Vec<Track>, String> {
    if !is_valid_id(id) {
        return Err(format!("id de faixa invalido: {id}"));
    }
    let mut cmd = yt_dlp();
    cmd.args(["--flat-playlist", "-J", "--no-warnings", "--skip-download", "--playlist-end"])
        .arg(limit.to_string())
        .arg(format!("https://www.youtube.com/watch?v={id}&list=RD{id}"));
    // O Mix comeca pela propria faixa; ela nao e uma recomendacao.
    Ok(parse_search(&run(cmd)?)?.into_iter().filter(|t| t.id != id).collect())
}

/// Codifica `text` para uso como valor de parametro numa URL.
pub fn url_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 3);
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Le a resposta do autocomplete: `["consulta", ["sugestao 1", "sugestao 2", ...], ...]`.
pub fn parse_suggestions(json: &str, limit: usize) -> Result<Vec<String>, String> {
    let root: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("resposta invalida do autocomplete: {e}"))?;
    Ok(root[1]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|s| s.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .take(limit)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default())
}

/// Sugestoes de busca do YouTube para o que o usuario ja digitou.
pub fn suggest(query: &str, limit: usize) -> Result<Vec<String>, String> {
    let url = format!(
        "https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=pt-BR&ie=utf-8&oe=utf-8&q={}",
        url_encode(query)
    );
    let body = ureq::get(&url)
        .timeout(Duration::from_secs(4))
        .call()
        .map_err(|e| format!("autocomplete: {e}"))?
        .into_string()
        .map_err(|e| format!("autocomplete: {e}"))?;
    parse_suggestions(&body, limit)
}

pub fn resolve_stream(id: &str) -> Result<String, String> {
    if !is_valid_id(id) {
        return Err(format!("id de faixa invalido: {id}"));
    }
    let mut cmd = yt_dlp();
    cmd.args(["-f", "bestaudio[ext=m4a]/bestaudio/best", "-g", "--no-warnings", "--no-playlist"])
        .arg(format!("https://www.youtube.com/watch?v={id}"));
    let out = run(cmd)?;
    out.lines()
        .map(str::trim)
        .find(|l| l.starts_with("http"))
        .map(str::to_string)
        .ok_or_else(|| "yt-dlp nao retornou URL de audio".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escolhe_o_yt_dlp_na_ordem_certa() {
        let here = std::env::current_exe().unwrap();
        let missing = Path::new("nao-existe/yt-dlp");
        assert_eq!(pick_program(Some("C:/meu/yt-dlp.exe".into()), Some(&here)).1, "env");
        assert_eq!(pick_program(Some("  ".into()), Some(&here)), (here.clone().into_os_string(), "managed"));
        assert_eq!(pick_program(None, Some(missing)), ("yt-dlp".into(), "path"), "gerenciado ainda nao baixado");
        assert_eq!(pick_program(None, None).1, "path");
    }

    #[test]
    fn valida_ids() {
        assert!(is_valid_id("dQw4w9WgXcQ"));
        assert!(!is_valid_id("--exec=calc"));
        assert!(!is_valid_id("curto"));
    }

    #[test]
    fn resolucoes_simultaneas_dividem_uma_chamada() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let cache = Arc::new(StreamCache::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let workers: Vec<_> = (0..4)
            .map(|_| {
                let (cache, calls) = (cache.clone(), calls.clone());
                std::thread::spawn(move || {
                    cache.resolve_with("aaaaaaaaaaa", false, |_| {
                        calls.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(200));
                        Ok("http://exemplo/audio".to_string())
                    })
                })
            })
            .collect();
        for w in workers {
            assert_eq!(w.join().unwrap().unwrap(), "http://exemplo/audio");
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // Depois de pronta, a URL vem do cache; `force` busca de novo.
        assert!(cache.resolve_with("aaaaaaaaaaa", false, |_| Err("nao devia chamar".into())).is_ok());
        assert_eq!(cache.resolve_with("aaaaaaaaaaa", true, |_| Ok("nova".into())).unwrap(), "nova");
    }

    #[test]
    fn sugestoes_e_url() {
        assert_eq!(url_encode("céu & mar"), "c%C3%A9u%20%26%20mar");
        let json = r#"["amor",["amor de fim de noite"," amor i love you ","",3],[],{"k":1}]"#;
        assert_eq!(parse_suggestions(json, 8).unwrap(), vec!["amor de fim de noite", "amor i love you"]);
        assert_eq!(parse_suggestions(json, 1).unwrap().len(), 1);
        assert!(parse_suggestions("[]", 8).unwrap().is_empty());
    }

    #[test]
    fn parse_filtra_e_normaliza() {
        let json = r#"{"entries":[
            {"id":"aaaaaaaaaaa","title":"Musica","channel":"Artista - Topic","duration":200},
            {"id":"bbbbbbbbbbb","title":"Live","channel":"X","duration":null},
            {"id":"ccccccccccc","title":"Podcast 2h","uploader":"Y","duration":7200},
            {"id":"ruim","title":"id invalido","duration":100}
        ]}"#;
        let tracks = parse_search(json).unwrap();
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].artist, "Artista");
        assert_eq!(tracks[0].duration, Some(200.0));
    }
}
