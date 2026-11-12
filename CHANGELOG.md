# Changelog

Todas as mudanças visíveis para quem usa o Openfy ficam registradas aqui.
O formato segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e as versões seguem o [SemVer](https://semver.org/lang/pt-BR/).

## [Não lançado]

## [0.2.0]

### Adicionado

- Catálogo de músicas: a busca e o rádio agora trazem título, artista, álbum e
  capa quadrada de verdade, sem "(Official Video)" nem resultados repetidos.
- Página de álbum, com capa, ano e a lista de faixas.
- Página de artista, com as músicas populares, álbuns, singles e EPs.
- Artista e álbum clicáveis em cada faixa e no player.

### Alterado

- A busca devolve 20 resultados (antes eram 30). Se o catálogo falhar, o app
  volta sozinho para a busca do yt-dlp e continua tocando.

## [0.1.0]

Primeira versão pública.

### Adicionado

- Busca de músicas com sugestões enquanto você digita.
- Reprodução imediata, com a URL de áudio resolvida antes do clique.
- Fila própria do usuário ("Tocar a seguir" e "Adicionar à fila").
- Rádio automática: ao fim da fila, continua com faixas parecidas sem repetir as que já tocaram.
- Biblioteca local com músicas curtidas, playlists e histórico.
- Ordem aleatória, repetição, barra de progresso, volume e mudo.
- Barra de título integrada à janela.
- Atualização automática assinada a partir das releases do GitHub.

[Não lançado]: https://github.com/LucianoBarral/openfy/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/LucianoBarral/openfy/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/LucianoBarral/openfy/releases/tag/v0.1.0
