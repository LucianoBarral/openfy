<div align="center">

<img src="ui/logo.png" width="112" alt="Logo do Openfy">

# Openfy

**Player de música para desktop, leve e de código aberto, feito em Rust.**

Busca, fila, rádio automática e biblioteca local — o áudio vem do [yt-dlp](https://github.com/yt-dlp/yt-dlp).

[![CI](https://github.com/LucianoBarral/openfy/actions/workflows/ci.yml/badge.svg)](https://github.com/LucianoBarral/openfy/actions/workflows/ci.yml)
[![Última release](https://img.shields.io/github/v/release/LucianoBarral/openfy?label=release)](https://github.com/LucianoBarral/openfy/releases/latest)
[![Licença MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-green.svg)](LICENSE)

[Baixar](https://github.com/LucianoBarral/openfy/releases/latest) · [Reportar um bug](https://github.com/LucianoBarral/openfy/issues/new/choose) · [Contribuir](CONTRIBUTING.md) · [English](#english)

<img src="docs/screenshot.png" width="860" alt="Janela do Openfy com resultados de busca e uma faixa tocando">

</div>

## O que ele faz

- **Busca com sugestões** — as sugestões aparecem enquanto você digita; Enter faz a busca completa.
- **Play imediato** — a URL de áudio das faixas visíveis é resolvida antes do clique, então a música começa sem espera.
- **Fila de verdade** — só entra na fila o que você coloca nela ("Tocar a seguir" e "Adicionar à fila").
- **Rádio automática** — quando a fila acaba, o Openfy continua com faixas parecidas, sem repetir o que já tocou.
- **Biblioteca local** — músicas curtidas, playlists e histórico ficam em um arquivo JSON no seu computador.
- **Controles completos** — ordem aleatória, repetir, avançar/voltar, barra de progresso, volume e mudo.
- **Atualização automática** — cada release nova do GitHub é baixada e instalada sozinha.
- **Sem conta, sem telemetria** — o app só fala com o yt-dlp e com o GitHub (para se atualizar).

## Instalação

> Hoje o Openfy é distribuído para **Windows 10/11 (x64)**. O código é Tauri e portável; builds para Linux e macOS são bem-vindos como contribuição.

1. Instale o **yt-dlp** e confirme que ele está no `PATH`:

   ```powershell
   winget install yt-dlp.yt-dlp
   ```

2. Baixe o instalador `Openfy_x.y.z_x64-setup.exe` na [última release](https://github.com/LucianoBarral/openfy/releases/latest) e execute.

O instalador ainda não tem certificado de assinatura de código do Windows, então o SmartScreen pode mostrar um aviso na primeira execução ("Mais informações" → "Executar assim mesmo").

Se o yt-dlp estiver fora do `PATH`, aponte para ele com a variável de ambiente `OPENFY_YTDLP` (caminho completo do executável).

## Atualização automática

Ao abrir (e depois a cada 6 horas) o Openfy consulta o arquivo `latest.json` da última release deste repositório. Havendo versão nova, ele baixa o instalador em segundo plano e confere a **assinatura digital** contra a chave pública embutida no app — um pacote que não foi assinado pelo projeto é recusado.

- Sem nada tocando: instala e reinicia na hora.
- Com música tocando: aparece o botão **"Reiniciar para atualizar"** na barra de cima, e você escolhe o momento.

Os detalhes de como uma release é gerada estão em [docs/RELEASING.md](docs/RELEASING.md).

## Compilando do código-fonte

Pré-requisitos: [Rust](https://rustup.rs) (stable), yt-dlp e, no Windows, o WebView2 (já vem no Windows 11).

```powershell
git clone https://github.com/LucianoBarral/openfy.git
cd openfy/src-tauri
cargo run
```

Não há etapa de build de front-end: a interface é HTML, CSS e JavaScript puros em `ui/`, embutidos no executável na compilação.

Para gerar o instalador:

```powershell
npm install -g @tauri-apps/cli@^2
tauri build
```

## Estrutura

```
openfy/
├── src-tauri/            Backend em Rust (Tauri v2)
│   ├── src/main.rs       Comandos expostos à interface
│   ├── src/ytdl.rs       Ponte com o yt-dlp: busca, sugestões, relacionadas, stream
│   ├── src/library.rs    Curtidas, playlists e histórico (JSON)
│   ├── src/updater.rs    Atualização automática
│   └── tauri.conf.json   Janela, bundle e endpoint de atualização
├── ui/                   Interface (HTML/CSS/JS, sem framework)
├── docs/                 Arquitetura e processo de release
└── .github/              CI, release e templates
```

Uma explicação mais longa está em [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Testes

```powershell
cd src-tauri
cargo test
```

Além dos testes de unidade, há um autoteste ponta a ponta que abre o app, busca, toca e relata o que observou:

```powershell
$env:OPENFY_SELFTEST = "daft punk"
$env:OPENFY_SELFTEST_OUT = "$env:TEMP\openfy-selftest.txt"
cargo run
```

O autoteste usa a rede, o yt-dlp e a sua biblioteca real.

## Contribuindo

Issues e pull requests são bem-vindos. Leia o [CONTRIBUTING.md](CONTRIBUTING.md) e o [Código de Conduta](CODE_OF_CONDUCT.md). Falhas de segurança: veja [SECURITY.md](SECURITY.md).

## Aviso legal

O Openfy é um projeto independente, **sem afiliação** com Spotify, YouTube, Google ou qualquer serviço de música. Nomes e marcas pertencem aos respectivos donos. O app não hospeda nem distribui conteúdo: ele é uma interface para o yt-dlp, e cabe a cada pessoa respeitar os termos de uso dos serviços acessados e a legislação de direitos autorais do seu país.

## Licença

[MIT](LICENSE).

---

## English

**Openfy** is a lightweight, open-source desktop music player written in Rust with [Tauri v2](https://tauri.app). Audio is resolved through [yt-dlp](https://github.com/yt-dlp/yt-dlp).

- Search with as-you-type suggestions, instant playback (stream URLs are pre-resolved)
- A real user queue, plus an automatic radio that keeps playing similar tracks without repeats
- Local library: liked songs, playlists and history, stored as JSON on your machine
- Signed automatic updates from GitHub Releases; no account, no telemetry

**Install (Windows 10/11 x64):** install yt-dlp (`winget install yt-dlp.yt-dlp`), then run the installer from the [latest release](https://github.com/LucianoBarral/openfy/releases/latest).

**Build from source:** `cd src-tauri && cargo run` (Rust stable + yt-dlp on `PATH`).

Openfy is an independent project, not affiliated with Spotify, YouTube or Google. Released under the [MIT license](LICENSE). The interface and most of the documentation are in Brazilian Portuguese; issues and pull requests in English are welcome.
