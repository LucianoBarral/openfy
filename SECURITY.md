# Política de segurança

## Versões com suporte

Só a [última release](https://github.com/LucianoBarral/openfy/releases/latest) recebe correções. Como o app se atualiza sozinho, quem o usa normalmente já está nela.

## Como relatar uma vulnerabilidade

**Não abra uma issue pública.** Use o relato privado do GitHub:

1. Abra a aba [Security](https://github.com/LucianoBarral/openfy/security) do repositório.
2. Clique em **Report a vulnerability**.
3. Descreva o problema, como reproduzir e o impacto que você enxerga.

Você recebe uma resposta assim que o relato for lido, e o crédito pela descoberta na nota da correção, se quiser.

## O que interessa mais

- Execução de comandos a partir de dados vindos da busca ou do yt-dlp.
- Qualquer forma de fazer o atualizador aceitar um pacote não assinado pelo projeto.
- Leitura ou escrita de arquivos fora da pasta de dados do app.

## Como a atualização é protegida

Cada release é assinada no GitHub Actions com uma chave privada que existe apenas como segredo do repositório. O app traz a chave pública embutida e recusa qualquer pacote cuja assinatura não confira, mesmo que venha do endereço correto.
