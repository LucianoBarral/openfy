//! Catalogo de musica: faixas, albuns e artistas com metadados limpos.
//!
//! Consulta o servico que o site do YouTube Music usa. A resposta e uma arvore
//! de blocos de interface ("renderers"), nao uma lista de musicas; por isso o
//! parser procura os blocos pelo nome, em qualquer profundidade, e reconhece
//! artista e album pelo formato do id. Assim uma reorganizacao do layout nao
//! quebra a leitura.
//!
//! Tudo aqui e sincrono; quem chama roda em `spawn_blocking`.

use crate::ytdl::{is_valid_id, Track};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

const ENDPOINT: &str = "https://music.youtube.com/youtubei/v1";
const CLIENT_VERSION: &str = "1.20241106.01.00";
/// Filtro "Musicas" da busca: so faixas do catalogo, sem videos nem playlists.
const SONGS_FILTER: &str = "EgWKAQIIAWoMEAMQBBAJEA4QChAF";
const COVER_SMALL: u32 = 240;
const COVER_LARGE: u32 = 544;
const UNKNOWN_ARTIST: &str = "Desconhecido";

/// Um album, single ou EP na pagina de um artista.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Release {
    pub id: String,
    pub title: String,
    /// Texto pronto para exibir, como "Single • 2023" ou "2013".
    pub subtitle: String,
    pub cover: Option<String>,
}

/// Uma fileira da pagina do artista ("Albuns", "Singles e EPs").
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Shelf {
    pub title: String,
    pub items: Vec<Release>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Album {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub artist_id: Option<String>,
    pub year: Option<String>,
    pub cover: Option<String>,
    pub tracks: Vec<Track>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Artist {
    pub id: String,
    pub name: String,
    pub cover: Option<String>,
    pub top: Vec<Track>,
    pub shelves: Vec<Shelf>,
}

fn id_chars(id: &str) -> bool {
    id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn is_album_id(id: &str) -> bool {
    id.starts_with("MPREb_") && id.len() <= 40 && id_chars(id)
}

pub fn is_artist_id(id: &str) -> bool {
    id.starts_with("UC") && id.len() == 24 && id_chars(id)
}

/* ---------- leitura da arvore ---------- */

/// Junta todo valor guardado sob `key`, em qualquer profundidade, na ordem do documento.
fn collect<'a>(value: &'a Value, key: &str, out: &mut Vec<&'a Value>) {
    match value {
        Value::Object(map) => {
            for (k, child) in map {
                if k == key {
                    out.push(child);
                }
                collect(child, key, out);
            }
        }
        Value::Array(items) => items.iter().for_each(|child| collect(child, key, out)),
        _ => {}
    }
}

fn find_all<'a>(value: &'a Value, key: &str) -> Vec<&'a Value> {
    let mut out = Vec::new();
    collect(value, key, &mut out);
    out
}

/// Um trecho de texto e, quando ele e um link, o id da pagina de destino.
struct Run<'a> {
    text: &'a str,
    browse: Option<&'a str>,
}

fn runs(value: &Value) -> Vec<Run<'_>> {
    value["runs"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|r| {
                    Some(Run {
                        text: r["text"].as_str()?,
                        browse: r["navigationEndpoint"]["browseEndpoint"]["browseId"].as_str(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn text(value: &Value) -> String {
    runs(value).iter().map(|r| r.text).collect::<String>().trim().to_string()
}

/// "6:10" -> 370.0; "1:02:03" -> 3723.0.
fn parse_duration(text: &str) -> Option<f64> {
    let parts: Vec<&str> = text.trim().split(':').collect();
    if !(2..=3).contains(&parts.len()) || parts.iter().any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    parts.iter().try_fold(0.0, |total, p| Some(total * 60.0 + p.parse::<f64>().ok()?))
}

fn is_year(text: &str) -> bool {
    text.len() == 4 && text.bytes().all(|b| b.is_ascii_digit())
}

/// Pede a capa no tamanho `size`. So as capas do catalogo aceitam o sufixo de tamanho.
fn resize(url: &str, size: u32) -> String {
    match url.rfind("=w") {
        Some(at) if url.contains("googleusercontent.com") => format!("{}=w{size}-h{size}-p-l90-rj", &url[..at]),
        _ => url.to_string(),
    }
}

fn cover(value: &Value, size: u32) -> Option<String> {
    let lists = find_all(value, "thumbnails");
    let url = lists.first()?.as_array()?.last()?["url"].as_str()?;
    Some(resize(url, size))
}

/// O que uma linha de creditos ("Artista • Album • 6:10") diz sobre a faixa.
#[derive(Default)]
struct Credits {
    artist: String,
    artist_id: Option<String>,
    album: Option<String>,
    album_id: Option<String>,
    duration: Option<f64>,
}

impl Credits {
    /// Le links e duracao de `line`. Com `names`, o primeiro trecho (antes do "•") e o artista.
    fn read(&mut self, line: &[Run<'_>], names: bool) {
        if names && self.artist.is_empty() {
            let first = line.split(|r| r.text.trim() == "•").next().unwrap_or_default();
            self.artist = first.iter().map(|r| r.text).collect::<String>().trim().to_string();
        }
        for run in line {
            match run.browse {
                Some(id) if is_artist_id(id) && self.artist_id.is_none() => self.artist_id = Some(id.to_string()),
                Some(id) if is_album_id(id) && self.album_id.is_none() => {
                    self.album_id = Some(id.to_string());
                    self.album = Some(run.text.trim().to_string());
                }
                _ => {}
            }
            if self.duration.is_none() {
                self.duration = parse_duration(run.text);
            }
        }
    }

    fn into_track(self, id: &str, title: String, cover: Option<String>) -> Option<Track> {
        if !is_valid_id(id) || title.is_empty() {
            return None;
        }
        Some(Track {
            id: id.to_string(),
            title,
            artist: if self.artist.is_empty() { UNKNOWN_ARTIST.to_string() } else { self.artist },
            duration: self.duration,
            album: self.album,
            album_id: self.album_id,
            artist_id: self.artist_id,
            cover,
        })
    }
}

/// Uma faixa numa lista (busca, album, "top musicas" do artista).
fn list_item(item: &Value) -> Option<Track> {
    let columns: Vec<&Value> = item["flexColumns"]
        .as_array()?
        .iter()
        .map(|c| &c["musicResponsiveListItemFlexColumnRenderer"]["text"])
        .collect();
    let title = *columns.first()?;
    let linked = find_all(title, "videoId");
    let id = item["playlistItemData"]["videoId"].as_str().or_else(|| linked.first()?.as_str())?;
    let mut credits = Credits::default();
    for (i, column) in columns.iter().enumerate().skip(1) {
        credits.read(&runs(column), i == 1);
    }
    for fixed in item["fixedColumns"].as_array().into_iter().flatten() {
        credits.read(&runs(&fixed["musicResponsiveListItemFixedColumnRenderer"]["text"]), false);
    }
    credits.into_track(id, text(title), cover(&item["thumbnail"], COVER_SMALL))
}

/// Uma faixa na fila de reproducao que o catalogo monta (o radio).
fn panel_item(item: &Value) -> Option<Track> {
    let mut credits = Credits::default();
    credits.read(&runs(&item["longBylineText"]), true);
    // Aqui o ultimo trecho dos creditos e o ano; a duracao vem em campo proprio.
    credits.duration = parse_duration(&text(&item["lengthText"]));
    credits.into_track(item["videoId"].as_str()?, text(&item["title"]), cover(&item["thumbnail"], COVER_SMALL))
}

/// Tira ids repetidos, mantendo a primeira ocorrencia.
fn unique(tracks: impl Iterator<Item = Track>) -> Vec<Track> {
    let mut seen = std::collections::HashSet::new();
    tracks.filter(|t| seen.insert(t.id.clone())).collect()
}

pub fn parse_songs(root: &Value) -> Vec<Track> {
    unique(find_all(root, "musicResponsiveListItemRenderer").into_iter().filter_map(list_item))
}

/// As faixas do radio de `seed`, sem a propria `seed`.
pub fn parse_radio(root: &Value, seed: &str) -> Vec<Track> {
    unique(find_all(root, "playlistPanelVideoRenderer").into_iter().filter_map(panel_item).filter(|t| t.id != seed))
}

pub fn parse_album(root: &Value, id: &str) -> Result<Album, String> {
    let headers = find_all(root, "musicResponsiveHeaderRenderer");
    let header = headers.first().ok_or("album nao encontrado no catalogo")?;
    let title = text(&header["title"]);
    let strapline = runs(&header["straplineTextOne"]);
    let artist = strapline.iter().map(|r| r.text).collect::<String>().trim().to_string();
    let artist_id = strapline.iter().filter_map(|r| r.browse).find(|b| is_artist_id(b)).map(str::to_string);
    let year = runs(&header["subtitle"]).iter().map(|r| r.text.trim()).find(|t| is_year(t)).map(str::to_string);
    let small = cover(&header["thumbnail"], COVER_SMALL);

    // Dentro do album as faixas nao repetem album nem capa: vem do cabecalho.
    let tracks = parse_songs(root)
        .into_iter()
        .map(|mut t| {
            t.album.get_or_insert_with(|| title.clone());
            t.album_id.get_or_insert_with(|| id.to_string());
            if small.is_some() {
                t.cover = small.clone();
            }
            if t.artist == UNKNOWN_ARTIST && !artist.is_empty() {
                t.artist = artist.clone();
            }
            if t.artist_id.is_none() {
                t.artist_id = artist_id.clone();
            }
            t
        })
        .collect();

    Ok(Album {
        id: id.to_string(),
        title,
        artist: if artist.is_empty() { UNKNOWN_ARTIST.to_string() } else { artist },
        artist_id,
        year,
        cover: cover(&header["thumbnail"], COVER_LARGE),
        tracks,
    })
}

pub fn parse_artist(root: &Value, id: &str) -> Result<Artist, String> {
    let header = ["musicImmersiveHeaderRenderer", "musicVisualHeaderRenderer"]
        .iter()
        .find_map(|key| find_all(root, key).first().copied())
        .ok_or("artista nao encontrado no catalogo")?;

    let top = find_all(root, "musicShelfRenderer")
        .first()
        .map(|shelf| unique(find_all(shelf, "musicResponsiveListItemRenderer").into_iter().filter_map(list_item)))
        .unwrap_or_default();

    let shelves = find_all(root, "musicCarouselShelfRenderer")
        .into_iter()
        .filter_map(|shelf| {
            let items: Vec<Release> = find_all(shelf, "musicTwoRowItemRenderer")
                .into_iter()
                .filter_map(|item| {
                    let id = item["navigationEndpoint"]["browseEndpoint"]["browseId"].as_str()?;
                    is_album_id(id).then(|| Release {
                        id: id.to_string(),
                        title: text(&item["title"]),
                        subtitle: text(&item["subtitle"]),
                        cover: cover(&item["thumbnailRenderer"], COVER_SMALL),
                    })
                })
                .collect();
            (!items.is_empty()).then(|| Shelf {
                title: text(&shelf["header"]["musicCarouselShelfBasicHeaderRenderer"]["title"]),
                items,
            })
        })
        .collect();

    Ok(Artist { id: id.to_string(), name: text(&header["title"]), cover: cover(&header["thumbnail"], COVER_LARGE), top, shelves })
}

/* ---------- rede ---------- */

fn post(path: &str, mut body: Value) -> Result<Value, String> {
    body["context"] = json!({
        "client": { "clientName": "WEB_REMIX", "clientVersion": CLIENT_VERSION, "hl": "pt", "gl": "BR" }
    });
    let text = ureq::post(&format!("{ENDPOINT}/{path}?prettyPrint=false"))
        .timeout(Duration::from_secs(12))
        .set("Content-Type", "application/json")
        .set("User-Agent", "Mozilla/5.0")
        .send_string(&body.to_string())
        .map_err(|e| format!("catalogo: {e}"))?
        .into_string()
        .map_err(|e| format!("catalogo: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("resposta invalida do catalogo: {e}"))
}

pub fn search(query: &str) -> Result<Vec<Track>, String> {
    Ok(parse_songs(&post("search", json!({ "query": query, "params": SONGS_FILTER }))?))
}

/// Faixas no mesmo estilo de `id`: o radio que o catalogo monta para a faixa.
pub fn radio(id: &str) -> Result<Vec<Track>, String> {
    if !is_valid_id(id) {
        return Err(format!("id de faixa invalido: {id}"));
    }
    let body = json!({ "videoId": id, "playlistId": format!("RDAMVM{id}"), "isAudioOnly": true });
    Ok(parse_radio(&post("next", body)?, id))
}

pub fn album(id: &str) -> Result<Album, String> {
    if !is_album_id(id) {
        return Err(format!("id de album invalido: {id}"));
    }
    parse_album(&post("browse", json!({ "browseId": id }))?, id)
}

pub fn artist(id: &str) -> Result<Artist, String> {
    if !is_artist_id(id) {
        return Err(format!("id de artista invalido: {id}"));
    }
    parse_artist(&post("browse", json!({ "browseId": id }))?, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ARTIST_ID: &str = "UCRr1xG_2WIDs18a6cIiCxeA";
    const ALBUM_ID: &str = "MPREb_K8qWMWVqXGi";

    fn link(text: &str, id: &str) -> Value {
        json!({ "text": text, "navigationEndpoint": { "browseEndpoint": { "browseId": id } } })
    }

    fn column(runs: Vec<Value>) -> Value {
        json!({ "musicResponsiveListItemFlexColumnRenderer": { "text": { "runs": runs } } })
    }

    fn thumbs(url: &str) -> Value {
        json!({ "musicThumbnailRenderer": { "thumbnail": { "thumbnails": [
            { "url": "https://lh3.googleusercontent.com/pequena=w60-h60-l90-rj" },
            { "url": url }
        ] } } })
    }

    fn song(id: &str, title: &str, byline: Vec<Value>) -> Value {
        json!({ "musicResponsiveListItemRenderer": {
            "thumbnail": thumbs("https://lh3.googleusercontent.com/capa=w120-h120-l90-rj"),
            "playlistItemData": { "videoId": id },
            "flexColumns": [column(vec![json!({ "text": title })]), column(byline), column(vec![json!({ "text": "Tocou 1,9 bi vezes" })])]
        } })
    }

    #[test]
    fn duracao_e_ids() {
        assert_eq!(parse_duration("6:10"), Some(370.0));
        assert_eq!(parse_duration("1:02:03"), Some(3723.0));
        assert_eq!(parse_duration("2013"), None);
        assert_eq!(parse_duration("Tocou 1:2"), None);
        assert!(is_album_id(ALBUM_ID) && !is_album_id("MPREb_; rm") && !is_album_id(ARTIST_ID));
        assert!(is_artist_id(ARTIST_ID) && !is_artist_id("UCcurto"));
    }

    #[test]
    fn capa_so_muda_de_tamanho_no_catalogo() {
        assert_eq!(resize("https://lh3.googleusercontent.com/x=w60-h60-l90-rj", 240), "https://lh3.googleusercontent.com/x=w240-h240-p-l90-rj");
        assert_eq!(resize("https://i.ytimg.com/vi/a/hq.jpg?rs=wABC", 240), "https://i.ytimg.com/vi/a/hq.jpg?rs=wABC");
    }

    #[test]
    fn busca_le_artistas_album_duracao_e_capa() {
        let root = json!({ "contents": { "shelf": { "contents": [
            song("4D7u5KF7SP8", "Get Lucky (feat. Pharrell Williams)", vec![
                link("Daft Punk", ARTIST_ID), json!({ "text": " e " }), link("Pharrell Williams", "UCJw8VyO6e3v6S0327AsgwcQ"),
                json!({ "text": " • " }), link("Random Access Memories", ALBUM_ID), json!({ "text": " • " }), json!({ "text": "6:10" }),
            ]),
            song("4D7u5KF7SP8", "repetida", vec![json!({ "text": "X" })]),
            song("ruim", "id invalido", vec![json!({ "text": "X" })]),
            song("CoMwzNkNGcs", "Sem links", vec![json!({ "text": "Banda Local" }), json!({ "text": " • " }), json!({ "text": "2:59" })]),
        ] } } });

        let tracks = parse_songs(&root);
        assert_eq!(tracks.len(), 2, "repetida e id invalido saem");
        let first = &tracks[0];
        assert_eq!(first.title, "Get Lucky (feat. Pharrell Williams)");
        assert_eq!(first.artist, "Daft Punk e Pharrell Williams");
        assert_eq!(first.artist_id.as_deref(), Some(ARTIST_ID));
        assert_eq!(first.album.as_deref(), Some("Random Access Memories"));
        assert_eq!(first.album_id.as_deref(), Some(ALBUM_ID));
        assert_eq!(first.duration, Some(370.0));
        assert_eq!(first.cover.as_deref(), Some("https://lh3.googleusercontent.com/capa=w240-h240-p-l90-rj"));

        assert_eq!(tracks[1].artist, "Banda Local");
        assert_eq!((tracks[1].artist_id.clone(), tracks[1].album.clone()), (None, None));
        assert_eq!(tracks[1].duration, Some(179.0));
    }

    #[test]
    fn radio_tira_a_semente() {
        let item = |id: &str, title: &str| {
            json!({ "playlistPanelVideoRenderer": {
                "videoId": id,
                "title": { "runs": [{ "text": title }] },
                "longBylineText": { "runs": [link("The Weeknd", "UClYV6hHlupm_S_ObS1W-DYw"), json!({ "text": " • " }), link("Starboy", "MPREb_FWIMEPTHFsY"), json!({ "text": " • " }), json!({ "text": "2016" })] },
                "lengthText": { "runs": [{ "text": "4:30" }] },
                "thumbnail": { "thumbnails": [{ "url": "https://lh3.googleusercontent.com/c=w544-h544-l90-rj" }] }
            } })
        };
        let root = json!({ "panel": [item("4D7u5KF7SP8", "Semente"), item("qPRNIHxLhmc", "I Feel It Coming")] });
        let tracks = parse_radio(&root, "4D7u5KF7SP8");
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].artist, "The Weeknd");
        assert_eq!(tracks[0].album.as_deref(), Some("Starboy"));
        assert_eq!(tracks[0].duration, Some(270.0), "o ano nao e duracao");
    }

    #[test]
    fn album_empresta_cabecalho_para_as_faixas() {
        let mut track = song("IluRBvnYMoY", "Give Life Back to Music", vec![]);
        track["musicResponsiveListItemRenderer"]["fixedColumns"] =
            json!([{ "musicResponsiveListItemFixedColumnRenderer": { "text": { "runs": [{ "text": "4:36" }] } } }]);
        let root = json!({
            "header": { "musicResponsiveHeaderRenderer": {
                "title": { "runs": [{ "text": "Random Access Memories" }] },
                "subtitle": { "runs": [{ "text": "Álbum" }, { "text": " • " }, { "text": "2013" }] },
                "straplineTextOne": { "runs": [link("Daft Punk", ARTIST_ID)] },
                "thumbnail": thumbs("https://lh3.googleusercontent.com/ram=w544-h544-l90-rj")
            } },
            "tracks": [track]
        });

        let album = parse_album(&root, ALBUM_ID).unwrap();
        assert_eq!((album.title.as_str(), album.artist.as_str(), album.year.as_deref()), ("Random Access Memories", "Daft Punk", Some("2013")));
        assert_eq!(album.cover.as_deref(), Some("https://lh3.googleusercontent.com/ram=w544-h544-p-l90-rj"));
        let t = &album.tracks[0];
        assert_eq!((t.artist.as_str(), t.artist_id.as_deref()), ("Daft Punk", Some(ARTIST_ID)));
        assert_eq!((t.album.as_deref(), t.album_id.as_deref()), (Some("Random Access Memories"), Some(ALBUM_ID)));
        assert_eq!(t.duration, Some(276.0));
        assert_eq!(t.cover.as_deref(), Some("https://lh3.googleusercontent.com/ram=w240-h240-p-l90-rj"));
        assert!(parse_album(&json!({}), ALBUM_ID).is_err());
    }

    #[test]
    fn artista_separa_top_e_lancamentos() {
        let release = |id: &str, title: &str| {
            json!({ "musicTwoRowItemRenderer": {
                "title": { "runs": [{ "text": title }] },
                "subtitle": { "runs": [{ "text": "Single" }, { "text": " • " }, { "text": "2023" }] },
                "navigationEndpoint": { "browseEndpoint": { "browseId": id } },
                "thumbnailRenderer": thumbs("https://lh3.googleusercontent.com/r=w226-h226-l90-rj")
            } })
        };
        let carousel = |title: &str, items: Vec<Value>| {
            json!({ "musicCarouselShelfRenderer": {
                "header": { "musicCarouselShelfBasicHeaderRenderer": { "title": { "runs": [{ "text": title }] } } },
                "contents": items
            } })
        };
        let root = json!({
            "header": { "musicImmersiveHeaderRenderer": {
                "title": { "runs": [{ "text": "Daft Punk" }] },
                "thumbnail": thumbs("https://lh3.googleusercontent.com/dp=w540-h225-p-l90-rj")
            } },
            "sections": [
                { "musicShelfRenderer": { "contents": [song("khnokW3Mw24", "Instant Crush", vec![link("Daft Punk", ARTIST_ID)])] } },
                carousel("Singles e EPs", vec![release("MPREb_X1DQ1j0PPrX", "GLBTM")]),
                carousel("Os fãs também podem gostar de...", vec![release("UCq7VAQmXDurV-9VN2bSFXvw", "Gesaffelstein")]),
            ]
        });

        let artist = parse_artist(&root, ARTIST_ID).unwrap();
        assert_eq!(artist.name, "Daft Punk");
        assert_eq!(artist.top.len(), 1);
        assert_eq!(artist.shelves.len(), 1, "fileira sem albuns nao entra");
        assert_eq!(artist.shelves[0].title, "Singles e EPs");
        assert_eq!(artist.shelves[0].items[0], Release {
            id: "MPREb_X1DQ1j0PPrX".into(),
            title: "GLBTM".into(),
            subtitle: "Single • 2023".into(),
            cover: Some("https://lh3.googleusercontent.com/r=w240-h240-p-l90-rj".into()),
        });
        assert!(parse_artist(&json!({}), ARTIST_ID).is_err());
    }
}
