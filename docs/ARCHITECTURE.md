# Arquitetura

O Openfy é um app [Tauri v2](https://tauri.app): um processo em Rust que abre uma janela com a WebView do sistema. A interface é uma página estática; tudo que precisa de sistema operacional (rodar o yt-dlp, gravar arquivo, atualizar o app) acontece no Rust e é chamado pela interface como um *comando*.

```
┌──────────────── Interface (ui/) ────────────────┐
│ index.html · styles.css · app.js                │
│ <audio> toca a URL de stream                    │
└──────────┬──────────────────────────▲───────────┘
           │ invoke("comando", args)  │ evento "update-state"
┌──────────▼──────────────────────────┴───────────┐
│ main.rs — comandos Tauri                        │
├────────────┬──────────┬──────────────┬──────────┤
│ catalog.rs │ ytdl.rs  │ library.rs   │updater.rs│
│ YouTube    │ yt-dlp   │ library.json │ GitHub   │
│ Music      │          │              │ Releases │
└────────────┴──────────┴──────────────┴──────────┘
```

## Backend (`src-tauri/src`)

### `main.rs`

Registra os comandos e o estado compartilhado. Cada comando valida a entrada e repassa para um dos módulos abaixo. Comandos que usam a rede ou rodam o yt-dlp usam `spawn_blocking`, porque esperar uma resposta externa travaria a interface.

A única regra que mora aqui é `or_fallback`: `search` e `related` perguntam primeiro ao catálogo e, se ele falhar ou vier vazio, caem no yt-dlp. O app continua tocando, só que com metadados mais pobres.

| Comando | O que faz |
| --- | --- |
| `search` | Busca faixas (catálogo, com reserva no yt-dlp) |
| `suggest` | Sugestões para o texto digitado |
| `related` | Faixas parecidas com uma faixa (rádio automática; catálogo, com reserva no yt-dlp) |
| `album` | Página de um álbum: capa, ano e faixas |
| `artist` | Página de um artista: populares, álbuns, singles e EPs |
| `resolve_stream` | URL de áudio de uma faixa, com cache |
| `get_library`, `toggle_like`, `push_history` | Biblioteca |
| `create_playlist`, `rename_playlist`, `delete_playlist`, `add_to_playlist`, `remove_from_playlist` | Playlists |
| `update_state`, `update_install` | Atualização automática |
| `selftest_query`, `selftest_report` | Autoteste ponta a ponta |

### `catalog.rs`

O catálogo: fala com a API web do YouTube Music por HTTP, sem conta e sem chave, e transforma a resposta em `Track`, `Album` e `Artist`. É daqui que vêm título, artista, álbum e capa quadrada.

- **Rede e interpretação ficam separadas.** `search`, `radio`, `album` e `artist` fazem a requisição; `parse_songs`, `parse_radio`, `parse_album` e `parse_artist` só leem o JSON. Os testes exercitam os `parse_*` com respostas montadas à mão, sem rede.
- **IDs de álbum e de artista são validados** (`is_album_id`, `is_artist_id`) antes de irem para a requisição.
- **A API não tem contrato público.** Ela pode mudar sem aviso; por isso a busca e o rádio têm a reserva no yt-dlp descrita acima. As páginas de álbum e de artista não têm reserva: se o catálogo falhar, a interface mostra o erro com um botão para tentar de novo.
- A prateleira de músicas populares do artista vem sem duração, então a interface esconde essa coluna quando nenhuma faixa da lista a informa.

### `ytdl.rs`

A ponte com o yt-dlp: resolve a URL de áudio, busca sugestões e serve de reserva para a busca e o rádio. Monta a linha de comando, executa e interpreta o JSON que volta. O executável vem do `PATH` ou da variável `OPENFY_YTDLP`.

Dois detalhes importam:

- **IDs são validados** (`is_valid_id`) antes de virar argumento de processo. Nada que venha da interface chega ao yt-dlp sem passar por essa checagem.
- **`StreamCache`** guarda as URLs de áudio já resolvidas e junta pedidos simultâneos da mesma faixa em uma única chamada ao yt-dlp. É isso que permite o pré-carregamento: a interface pede a URL das faixas visíveis antes do clique, e o play encontra a resposta pronta. Como essas URLs expiram, `resolve_stream` aceita `force` para ignorar o cache.

### `library.rs`

`Library` é a estrutura com curtidas, playlists e histórico; `Store` cuida de carregar e gravar o `library.json` na pasta de dados do app (no Windows, `%APPDATA%\dev.openfy.app`). Toda alteração passa por `Store::update`, que aplica a mudança, grava em disco e devolve a biblioteca nova — a interface nunca mantém uma cópia que possa divergir.

### `updater.rs`

Uma thread consulta o `latest.json` da última release ao abrir e a cada 6 horas. Havendo versão nova, baixa o instalador, confere a assinatura e guarda o pacote em memória. O estado (`off`, `checking`, `idle`, `downloading`, `ready`, `error`) vai para a interface pelo evento `update-state`.

A instalação só acontece em `update_install`, chamado pela interface: imediatamente se nada está tocando, ou quando a pessoa clica em "Reiniciar para atualizar". Builds de desenvolvimento não consultam atualização, a menos que `OPENFY_UPDATE_CHECK=1`.

## Interface (`ui/`)

HTML, CSS e JavaScript puros, sem framework e sem etapa de build. O Tauri embute esses arquivos no executável na compilação.

`app.js` guarda o estado da reprodução (faixa atual, fila do usuário, fila automática, histórico da sessão) e desenha as telas: início, busca, curtidas, playlist, álbum e artista. Artista e álbum de cada faixa são links para essas páginas, tanto nas listas quanto no player. O áudio toca em um elemento `<audio>` comum, apontado para a URL devolvida por `resolve_stream`.

A reprodução segue esta ordem quando uma faixa termina:

1. próxima faixa da **fila do usuário**, se houver;
2. senão, próxima do **contexto** (a playlist ou a lista de onde a faixa saiu);
3. senão, a **rádio automática**: `related` devolve faixas parecidas, e as que já tocaram na sessão são descartadas.

## Decisões de projeto

- **yt-dlp como processo externo, não como biblioteca.** Os sites mudam o tempo todo; quem usa o app atualiza o yt-dlp sem esperar uma release do Openfy.
- **Catálogo para os metadados, yt-dlp para o áudio.** A busca de vídeos devolve títulos sujos e resultados repetidos; o catálogo devolve faixas, álbuns e artistas. O yt-dlp continua sendo o único caminho até o áudio e a reserva quando o catálogo falha.
- **Sem framework na interface.** O app é uma tela só. Sem dependências de front-end não há etapa de build nem `node_modules` para manter.
- **Biblioteca em JSON.** O volume de dados é pequeno e um arquivo legível permite backup e inspeção com qualquer editor.
- **Atualizador controlado pelo Rust.** A interface só exibe o estado e pede a instalação; ela não tem permissão para baixar nem executar nada.
