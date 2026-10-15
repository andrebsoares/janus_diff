# Teste end-to-end (Playwright)

`e2e.js` abre o Janus Diff de verdade pelo Playwright (`playwright-core`, modo `_electron`) e o usa com mouse e teclado reais: comparação de pastas, de texto e hex, seleção por arrasto, botão flutuante "Copy N lines", arrastar e soltar bloco, lixeira, salvar preservando CRLF/latin1, recarga por mudança no disco, área de transferência e DPI 125%/150%.

Os dados de teste são gerados por `make_data.js` a cada bateria, dentro da pasta de saída. Cada execução do app usa um `--user-data-dir` próprio e não toca nas sessões do usuário.

## Instalação

O `playwright-core` não está no `package.json`. Instale sem salvar, como o `sharp`:

```
npm install --no-save playwright-core
```

Um `npm install` posterior pode removê-lo; nesse caso, instale de novo.

## Como rodar

Na raiz do repositório:

```
node tools/e2e/e2e.js              # saída em tools/e2e/out (ignorada pelo git)
node tools/e2e/e2e.js C:\temp\e2e  # ou em outra pasta
```

O resultado vai para o console: uma linha `PASS`/`FAIL`/`SKIP` por verificação e o total no fim. Na pasta de saída ficam as capturas `w*.png`, `results.json` e `work/`, com os dados e os perfis.

O código de saída é 0 só se nada falhou. Feche outras janelas do Janus Diff antes de rodar: o teste usa `--wait`, mas foco e área de transferência são compartilhados.

## No Linux (Xvfb / Docker)

```
xvfb-run -a -s "-screen 0 1400x900x24" node tools/e2e/e2e.js
```

Na imagem do teste de fumaça, use `--init`. Sem ele, o processo pode ficar pendurado:

```
docker run --rm --init --user $(id -u):$(id -g) -e HOME=/tmp -v "$PWD":/app -w /app janus-smoke \
  xvfb-run -a -s "-screen 0 1400x900x24" node tools/e2e/e2e.js
```

O teste já passa `--no-sandbox` fora do Windows. Diferenças esperadas no Linux:

- **Lixeira:** sem `gio` (o caso do container), mover para a lixeira falha. O app mostra "Recycle Bin Unavailable", e o teste aceita esse diálogo, confirma "Delete Permanently" e verifica que o arquivo sumiu. No Windows, o teste exige que o arquivo vá para a Lixeira sem esse diálogo.
- **DPI:** se o servidor X não aplicar `--force-device-scale-factor`, as verificações de DPI aparecem como `SKIP`, com o motivo.

## Observações

- Os caminhos a comparar vão direto na linha de comando, depois do caminho do app. O Playwright põe switches do Chromium antes desse caminho, e `appArgs()` em `src/main/cli.js` sabe achá-lo.
- O executável é o de `require('electron')`, o mesmo em qualquer plataforma.
