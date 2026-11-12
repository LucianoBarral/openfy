# Publicando uma release

Toda release sai do GitHub Actions. Quem tem o Openfy instalado recebe a versão nova sozinho, em até 6 horas (ou na próxima vez que abrir o app).

## Passo a passo

1. **Suba a versão** em `src-tauri/Cargo.toml` (campo `version`). É a única fonte: o `tauri.conf.json` não repete o número.
2. Rode `cargo build` em `src-tauri` para o `Cargo.lock` acompanhar.
3. **Atualize o `CHANGELOG.md`**: mova o conteúdo de "Não lançado" para uma seção com a versão nova.
4. Faça o commit e envie para a `main`.
5. **Crie e envie a tag**, com o mesmo número e o prefixo `v`:

   ```powershell
   git tag v0.2.0
   ```

   ```powershell
   git push origin v0.2.0
   ```

O workflow [`release.yml`](../.github/workflows/release.yml) então:

- confere que a tag bate com a versão do `Cargo.toml` (se não bater, falha antes de compilar);
- compila o instalador NSIS para Windows;
- assina o instalador com a chave do atualizador;
- publica a release com o instalador, a assinatura (`.sig`) e o `latest.json`.

O app consulta `https://github.com/LucianoBarral/openfy/releases/latest/download/latest.json`. Esse endereço sempre aponta para a release publicada mais recente, então **rascunhos e pré-releases não chegam a ninguém**.

## Ensaiando sem publicar

Em *Actions → Release → Run workflow*, o mesmo processo roda e cria a release como **rascunho**. Serve para conferir os arquivos; publicar o rascunho pela página de releases torna a versão oficial.

> **Atenção:** publicar um rascunho cria a tag `v…`, e isso dispara o workflow de release mais uma vez. Como os arquivos já estão publicados e assinados, cancele essa segunda execução em *Actions* para ela não recompilar e substituir o instalador.

## A chave de assinatura

O atualizador só aceita pacotes assinados pela chave privada do projeto. A chave pública correspondente está em `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`).

- A chave privada fica no segredo `TAURI_SIGNING_PRIVATE_KEY` do repositório e **nunca** entra no código.
- Guarde uma cópia da chave privada fora do computador (gerenciador de senhas, por exemplo).
- **Se a chave se perder, as instalações existentes não conseguem mais se atualizar**: seria preciso gerar outra chave, e cada pessoa teria de instalar manualmente a versão seguinte.

Para gerar um par novo (só em caso de perda ou vazamento):

```powershell
npx @tauri-apps/cli@2 signer generate -w "$HOME\.tauri\openfy.key"
```

Depois, troque a `pubkey` no `tauri.conf.json` e atualize o segredo no GitHub.

## Quando algo dá errado

| Sintoma | Causa provável |
| --- | --- |
| Workflow falha em "Conferir tag e versao" | A tag e o `Cargo.toml` têm números diferentes |
| Release sai sem `latest.json` | O segredo `TAURI_SIGNING_PRIVATE_KEY` está vazio ou ausente |
| App não vê a versão nova | A release ainda é rascunho ou pré-release, ou a versão não é maior que a instalada |
| App mostra erro de assinatura | A release foi assinada com uma chave diferente da `pubkey` embutida |
