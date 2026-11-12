# Contribuindo com o Openfy

Obrigado por querer ajudar. Este guia é curto de propósito.

## Antes de começar

- **Bug ou ideia?** Abra uma [issue](https://github.com/LucianoBarral/openfy/issues/new/choose) usando o modelo correspondente.
- **Mudança grande?** Combine na issue antes de escrever código, para ninguém perder trabalho.
- **Falha de segurança?** Não abra issue pública; siga o [SECURITY.md](SECURITY.md).

## Ambiente

Você precisa de [Rust](https://rustup.rs) stable e do [yt-dlp](https://github.com/yt-dlp/yt-dlp) no `PATH` (ou da variável `OPENFY_YTDLP` apontando para o executável).

```powershell
cd src-tauri
cargo run
```

A interface em `ui/` é embutida no executável durante a compilação: depois de mexer em HTML, CSS ou JS, rode `cargo run` de novo.

Builds de desenvolvimento não procuram atualização. Para exercitar o atualizador, defina `OPENFY_UPDATE_CHECK=1`.

## Antes de abrir o pull request

```powershell
cd src-tauri
cargo test
cargo build
```

As duas etapas rodam no CI e precisam passar. Se a mudança toca busca, reprodução ou fila, rode também o autoteste descrito no [README](README.md#testes).

## Como o código é organizado

Leia [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Em resumo:

- Lógica que dá para testar sem janela mora em `ytdl.rs` e `library.rs`, com testes no próprio arquivo.
- `main.rs` só registra comandos e repassa chamadas.
- A interface não usa framework nem etapa de build; mantenha assim.

## Estilo

- Mude só o que a tarefa pede; refatorações vão em pull requests separados.
- Comportamento novo vem com teste quando a lógica é testável sem rede.
- Comentários explicam o *porquê*, não o *o quê*.
- Textos da interface em português do Brasil.
- Nada de código, ícones, fontes ou marcas de terceiros sem licença compatível com MIT.

## Commits e pull requests

- Mensagens no imperativo e diretas: `Corrige fila ao remover a faixa atual`.
- Um pull request por assunto, com a descrição dizendo o que mudou e como você testou.
- Mudanças visíveis para quem usa o app entram no [CHANGELOG.md](CHANGELOG.md), na seção "Não lançado".

Ao contribuir, você concorda em licenciar seu trabalho sob a [licença MIT](LICENSE) do projeto.
