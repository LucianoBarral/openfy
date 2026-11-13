//! Letras das musicas, vindas do LRCLIB (https://lrclib.net), um banco aberto
//! de letras que nao exige chave. So saem daqui titulo, artista, album e
//! duracao da faixa; nada que identifique quem esta ouvindo.

use crate::ytdl::url_encode;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

const API: &str = "https://lrclib.net/api";
/// Diferenca maxima de duracao (s) para aceitar uma letra como sendo desta gravacao.
const TOLERANCE: f64 = 5.0;

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Line {
    /// Segundo da musica em que a linha comeca.
    pub time: f64,
    pub text: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Lyrics {
    /// Linhas com tempo, em ordem. Vazio quando so existe a letra sem sincronia.
    pub synced: Vec<Line>,
    pub plain: String,
    pub instrumental: bool,
}

/// Le um tempo `mm:ss`, `mm:ss.xx` ou `hh:mm:ss.xx`. Tags como `ar:Nome` nao sao tempo.
fn parse_stamp(tag: &str) -> Option<f64> {
    let mut total = 0.0;
    let mut parts = 0;
    for part in tag.split(':') {
        let value: f64 = part.trim().parse().ok()?;
        if !value.is_finite() || value < 0.0 {
            return None;
        }
        total = total * 60.0 + value;
        parts += 1;
    }
    (2..=3).contains(&parts).then_some(total)
}

/// Converte o texto LRC em linhas ordenadas por tempo.
///
/// Uma linha pode ter varios tempos (`[00:10.00][01:20.00] refrao`) e vira uma
/// entrada para cada um. Linhas de metadados (`[ar:...]`) e sem tempo sao ignoradas.
pub fn parse_lrc(text: &str) -> Vec<Line> {
    let mut lines = Vec::new();
    for raw in text.lines() {
        let mut rest = raw.trim();
        let mut stamps = Vec::new();
        while let Some(inner) = rest.strip_prefix('[') {
            let Some(end) = inner.find(']') else { break };
            let Some(time) = parse_stamp(&inner[..end]) else { break };
            stamps.push(time);
            rest = inner[end + 1..].trim_start();
        }
        for time in stamps {
            lines.push(Line { time, text: rest.trim().to_string() });
        }
    }
    lines.sort_by(|a, b| a.time.total_cmp(&b.time));
    lines
}

fn from_record(record: &Value) -> Option<Lyrics> {
    let lyrics = Lyrics {
        synced: parse_lrc(record["syncedLyrics"].as_str().unwrap_or_default()),
        plain: record["plainLyrics"].as_str().unwrap_or_default().trim().to_string(),
        instrumental: record["instrumental"].as_bool().unwrap_or(false),
    };
    (lyrics.instrumental || !lyrics.synced.is_empty() || !lyrics.plain.is_empty()).then_some(lyrics)
}

/// Escolhe, entre os resultados da busca, a letra desta gravacao: duracao
/// dentro da tolerancia, preferindo a sincronizada e depois a mais proxima.
/// Sem duracao conhecida, fica com a primeira sincronizada (ou a primeira).
pub fn pick(records: &[Value], duration: Option<f64>) -> Option<Lyrics> {
    let mut best: Option<(bool, f64, Lyrics)> = None;
    for record in records {
        let Some(lyrics) = from_record(record) else { continue };
        let diff = match (duration, record["duration"].as_f64()) {
            (Some(want), Some(got)) => (want - got).abs(),
            (Some(_), None) => continue,
            (None, _) => 0.0,
        };
        if diff > TOLERANCE {
            continue;
        }
        let synced = !lyrics.synced.is_empty();
        let better = match &best {
            None => true,
            Some((best_synced, best_diff, _)) => (synced && !best_synced) || (synced == *best_synced && diff < *best_diff),
        };
        if better {
            best = Some((synced, diff, lyrics));
        }
    }
    best.map(|(_, _, lyrics)| lyrics)
}

/// GET que devolve `None` em 404 (o LRCLIB responde assim quando nao tem a letra).
fn get(url: &str) -> Result<Option<Value>, String> {
    let response = ureq::get(url)
        .set("User-Agent", concat!("Openfy/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(8))
        .call();
    match response {
        Ok(r) => {
            let body = r.into_string().map_err(|e| format!("letras: {e}"))?;
            serde_json::from_str(&body).map(Some).map_err(|e| format!("letras: resposta invalida ({e})"))
        }
        Err(ureq::Error::Status(404, _)) => Ok(None),
        Err(e) => Err(format!("letras: {e}")),
    }
}

/// Busca a letra de uma faixa. `Ok(None)` = o LRCLIB nao tem letra para ela.
pub fn fetch(title: &str, artist: &str, album: Option<&str>, duration: Option<f64>) -> Result<Option<Lyrics>, String> {
    let title = title.trim();
    // "Artista A, Artista B" -> o primeiro nome basta e casa melhor com o banco.
    let artist = artist.split(',').next().unwrap_or_default().trim();
    if title.is_empty() || artist.is_empty() {
        return Ok(None);
    }
    let base = format!("track_name={}&artist_name={}", url_encode(title), url_encode(artist));

    // 1) Casamento exato: mesma faixa, mesmo artista e duracao a ±2 s.
    if let Some(seconds) = duration.filter(|d| d.is_finite() && *d > 0.0) {
        let mut url = format!("{API}/get?{base}&duration={}", seconds.round() as u64);
        if let Some(album) = album.map(str::trim).filter(|a| !a.is_empty()) {
            url.push_str(&format!("&album_name={}", url_encode(album)));
        }
        if let Some(lyrics) = get(&url)?.as_ref().and_then(from_record) {
            return Ok(Some(lyrics));
        }
    }

    // 2) Busca aberta, filtrando pela duracao para nao pegar outra versao.
    let found = get(&format!("{API}/search?{base}"))?;
    let records = found.as_ref().and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    Ok(pick(records, duration))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn le_tempos_e_ordena() {
        let lrc = "[ar:Daft Punk]\n[00:30.75] One more time\n[00:05.00]\n\n[01:02.5][00:10] refrao\nsem tempo";
        let lines = parse_lrc(lrc);
        let got: Vec<(f64, &str)> = lines.iter().map(|l| (l.time, l.text.as_str())).collect();
        assert_eq!(got, [(5.0, ""), (10.0, "refrao"), (30.75, "One more time"), (62.5, "refrao")]);
    }

    #[test]
    fn tempo_com_horas_e_tags_que_nao_sao_tempo() {
        assert_eq!(parse_stamp("01:02:03.5"), Some(3723.5));
        assert_eq!(parse_stamp("02:03"), Some(123.0));
        assert_eq!(parse_stamp("ar:Nome"), None);
        assert_eq!(parse_stamp("length: 03:20"), None);
        assert_eq!(parse_stamp("12"), None);
        assert_eq!(parse_stamp("-1:00"), None);
    }

    #[test]
    fn colchete_no_meio_da_letra_fica_no_texto() {
        let lines = parse_lrc("[00:01.00] oi [risos] tchau");
        assert_eq!(lines, [Line { time: 1.0, text: "oi [risos] tchau".into() }]);
    }

    #[test]
    fn escolhe_a_gravacao_certa_e_prefere_sincronizada() {
        let records = vec![
            json!({"duration": 236.0, "syncedLyrics": "[00:01.00] radio edit", "plainLyrics": "radio edit"}),
            json!({"duration": 320.0, "plainLyrics": "album, sem tempo"}),
            json!({"duration": 322.0, "syncedLyrics": "[00:02.00] album", "plainLyrics": "album"}),
        ];
        let got = pick(&records, Some(321.0)).unwrap();
        assert_eq!(got.synced[0].text, "album", "sincronizada vence a sem tempo, mesmo um pouco mais longe");
        assert_eq!(pick(&records, Some(236.4)).unwrap().synced[0].text, "radio edit");
        assert_eq!(pick(&records, Some(500.0)), None, "nenhuma versao com essa duracao");
        assert_eq!(pick(&records, None).unwrap().synced[0].text, "radio edit");
    }

    #[test]
    fn registro_vazio_nao_e_letra_mas_instrumental_e() {
        assert_eq!(from_record(&json!({"syncedLyrics": null, "plainLyrics": "  "})), None);
        assert!(from_record(&json!({"instrumental": true})).unwrap().instrumental);
    }
}
