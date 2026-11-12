# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Janus Diff: comparador lado a lado (pastas, texto, hex) em Electron, sem dependências de runtime — só `electron` e `electron-builder` como devDependencies. JavaScript puro (CommonJS, `'use strict'`), sem bundler, sem TypeScript, sem linter configurado. README e mensagens ao usuário do README estão em português; a UI e os comentários do código estão em inglês.

## Comandos

```
npm install
npm start                          # tela inicial
npm start -- <esquerda> <direita>  # abre comparação de duas pastas ou dois arquivos
npm test                           # node --test (test/*.test.js)
node --test test/core.test.js      # um arquivo de teste
node --test --test-name-pattern="myers" test/core.test.js   # um teste pelo nome
npm run dist:win                   # instalador NSIS + portátil em dist/ (Windows, ou Linux com Wine)
npm install --no-save sharp && node tools/icon/build.js     # regenera icon.ico/icon.png a partir de installer/icon.svg
```

`npm test` cobre só o código sem Electron (`src/core/*`, `src/main/cli.js`, `src/main/shellmenu.js`, `src/main/updater.js`). A UI é verificada pelo teste de fumaça em `tools/smoke/`: `main.js` carrega o app real dentro do Electron (`electron tools/smoke/main.js <proj> <saida> <esq> <dir>`, sob Xvfb no Linux; o `Dockerfile` instala as libs necessárias), executa comandos via `executeJavaScript` no objeto global `App`, imprime estado/erros no console e salva capturas PNG em `<saida>` (são a origem de `docs/screenshots/`). Ele espera pastas de exemplo com `src/app.js` e `logo.bin` diferentes entre os lados.

## Arquitetura

**Três camadas, isolamento estrito.** O renderer roda com `contextIsolation: true` e `nodeIntegration: false` e não tem acesso a Node. Todo acesso a disco/diálogos/shell passa por `window.api`, definido em `src/main/preload.js` e implementado como handlers `ipcMain.handle` em `registerIpc()` de `src/main/main.js`. Uma nova capacidade do renderer exige mexer nos dois arquivos. O preload é sandboxed e por isso reimplementa um `path` mínimo (`api.path`).

**`src/core/` é compartilhado.** `textdiff.js` é UMD: `require` no Node (testes, comparação de pastas "rules-based") e `<script>` no renderer (expõe `TextDiff` global). `dircompare.js` é só Node (usa `fs`) e roda no processo principal via IPC `dir:compare`, mandando progresso por `dir:progress`. Também concentra decodificação/codificação de texto (`decodeText`/`encodeText`: detecção de binário, encoding, fim de linha), usada por `fs:readText`/`fs:writeText`.

**Renderer sem módulos.** `index.html` carrega scripts clássicos em ordem (`textdiff`, `markdown`, `util`, `textview`, `hexview`, `dirview`, `helpview`, `app`) que compartilham o escopo global — `h()`, `Modal`, `VScroller`, `fmtDate` etc. vêm de `util.js`. Cada aba é uma view (`HomeView`, `DirView`, `TextView`, `HexView`, `HelpView`) com interface comum: `el`, `type`, `title`, `keymap`, `command(name)`, `onShow()`, `onClose()`. `App` (em `app.js`) gerencia abas e roteia comandos.

**Guia do usuário.** `docs/AJUDA.md` é o conteúdo de **Help → User Guide**: o IPC `app:guide` lê o arquivo, embute as imagens de `docs/screenshots/` como data URLs (a CSP só permite `data:`) e `HelpView` renderiza com `src/core/markdown.js` (UMD, testado em `test/markdown.test.js`). Ao mudar uma funcionalidade visível, atualize o guia; `docs/AJUDA.md` e as capturas entram no pacote via `build.files`.

**Menus e atalhos.** O menu nativo (`buildMenu()` em `main.js`) só exibe aceleradores (`registerAccelerator: false`) e envia o nome do comando por `menu:command`; quem trata a tecla é o renderer, porque a mesma tecla muda de sentido conforme a view. Os keymaps ficam em `APP_KEYS`/`DV_KEYS`/`TV_KEYS`/`HV_KEYS`, e a ajuda do F1 em `SHORTCUT_HELP` (`app.js`). O menu se refaz a cada troca de aba (`menu:view`) e desabilita os comandos que a view não trata, conforme `VIEW_COMMANDS` em `main.js`. Ao adicionar um comando, atualize menu, `VIEW_COMMANDS`, keymap da view, `SHORTCUT_HELP` e `docs/AJUDA.md` juntos.

**Inicialização e instância única.** `src/main/cli.js` (sem Electron, testável) traduz argv em `{ mode, paths, wait, target }`. Em `main.js`: modos headless (`--select-left`, `--register-shell`, `--unregister-shell`, `--git-setup`, `--version`) executam e saem sem janela; `--wait` cria processo próprio (necessário para `git difftool`); caso contrário usa `requestSingleInstanceLock` e repassa caminhos para a janela existente (`app:open`). `--compare-selected` existe porque o Explorer dispara um processo por item selecionado — os itens são agrupados por `GATHER_MS` antes de abrir.

**Integração Windows.** `src/main/shellmenu.js` gera um "plano" de chaves de registro (`plan`/`removalPlan`) e o aplica com `reg.exe` (`apply`); `gitSetup` grava a configuração de difftool e o alias `git jd` (`git diff` com `diff.external` só naquele comando, recebido por `--git-external`) via `git config --global`. Os testes usam um registro falso que interpreta os mesmos argumentos do `reg.exe`, então essa lógica é testável em Linux. O desinstalador remove as chaves via `installer/installer.nsh`. Estado persistido em `userData`: `sessions.json` (sessões recentes) e `shell-left.json` (lado esquerdo memorizado pelo menu de contexto).

**Atualizações.** `src/main/updater.js` (sem Electron; recebe `fetch`) consulta `releases/latest` do repositório na constante `PUBLISH` (cópia de `build.publish` do `package.json`, mantida igual por teste), escolhe o asset conforme a cópia (`installKind`: instalador NSIS, portátil — detectado por `PORTABLE_EXECUTABLE_FILE` — ou `none` no código-fonte) e baixa conferindo tamanho e o `digest` SHA-256 que o GitHub publica para cada asset. Não usa `electron-updater` para manter zero dependências de runtime. Em `main.js`, o estado (release e arquivo baixado) fica no processo principal, e o renderer só pede `update:check`/`download`/`install`, sem passar URLs nem caminhos. O instalador roda com `/S --updated --force-run` via `cmd start`, para o Windows poder pedir elevação. O portátil é salvo ao lado do executável atual e iniciado. A checagem automática (`update:check` com `quiet`) só roda empacotado e sem `--wait`. Exige que o repositório (ou as releases) seja público: para repositório privado a API responde 404.

**O app empacotado não pode ler `package.json`.** O electron-builder tira o campo `build` da cópia que vai para o `app.asar`; ler `build.*` em tempo de execução funciona no código-fonte e quebra só depois de instalado (foi o que impediu a 0.4.0 e a 0.4.1 de abrir). Um teste em `test/updater.test.js` falha se algo em `src/` fizer `require` do `package.json`.

## Fluxo de desenvolvimento entre máquinas

O desenvolvimento é feito por uma instância do Claude Code numa máquina Linux (acessada por SSH), que programa, testa, faz commit/push num branch e abre o PR; a validação final acontece na máquina Windows do usuário (`git pull`, `npm install`, `npm test`, `npm start`, e `npm run dist:win` quando relevante). Consequências práticas:

- A `main` é protegida por um ruleset do GitHub: push direto e force push são recusados, toda mudança entra por PR e o merge só é liberado com o CI (`test (ubuntu-latest)` e `test (windows-latest)`) verde. Trabalhe num branch (`feat/…`, `fix/…`, `docs/…`, `ci/…`, `release/…`) e abra o PR com `gh pr create`; o merge usa commit de merge (`gh pr merge --merge --delete-branch`). Para releases, veja a seção abaixo.
- No Linux, valide com `npm test` e, para mudanças de UI, com o teste de fumaça sob Xvfb/Docker. Não há como validar lá o menu de contexto do Explorer, o registro, os diálogos nativos do Windows nem o instalador — diga explicitamente no commit/relato o que ficou para validar no Windows.
- Código de caminhos precisa funcionar com `\` e letras de unidade (vide o `path` do preload e a comparação case-insensitive em `ops:rename`); prefira cobrir com testes que rodem nas duas plataformas.
- Mantenha `package-lock.json` versionado e coerente, já que o Windows reinstala a partir dele.
- `dist/` e `node_modules/` são ignorados; não versione artefatos de build.

## Release

1. Num branch `release/x.y.z`: `npm version x.y.z --no-git-tag-version` (muda só `package.json` e `package-lock.json`), commit `Release x.y.z`, PR, CI verde, merge.
2. Na `main` atualizada, confira que `HEAD` é o commit de merge e envie a tag: `git tag vx.y.z && git push origin vx.y.z`.
3. `release.yml` (Windows) confere que a tag bate com a versão do `package.json`, roda `npm test`, gera instalador NSIS e portátil, executa o app empacotado com `--version` (falha se o processo principal não carregar; o diálogo de erro trava o app, daí o timeout) e só então publica com `gh release create … --generate-notes`.
4. Acompanhe com `gh run watch`. Sem bump de versão não há release: a tag precisa bater com o `package.json`.

O que torna cada passo definitivo — confira antes de enviar a tag:

- **Tags `v*` são protegidas** (ruleset "Protect release tags"): criar é livre, mas apagar ou mover é recusado. Tag no commit errado não tem conserto; a saída é lançar a versão seguinte.
- **Releases são imutáveis:** depois de publicada, não se troca, acrescenta nem remove arquivo, e a tag fica presa. Só o texto das notas pode ser editado. Uma release com defeito se resolve com uma nova versão (e, se for o caso, um aviso nas notas da quebrada, como nas 0.4.0/0.4.1).
- **Actions só do GitHub e fixadas por SHA** (exigência do repositório): `uses:` com `@v4` ou `@main` faz o workflow falhar antes de rodar. O Dependabot (`.github/dependabot.yml`) abre PRs semanais atualizando os SHAs; quando dois mexem nas mesmas linhas, depois do primeiro merge comente `@dependabot rebase` no outro e espere o CI.
- **O atualizador dos usuários pega a release "latest"** assim que ela sai, e uma versão que não abre também não consegue se atualizar. Por isso a checagem do executável empacotado vem antes de publicar; para mudanças no processo principal, vale também gerar o pacote localmente (`npx electron-builder --win dir`) e rodar `"Janus Diff.exe" --version`.
- A API do GitHub às vezes responde 502/504 em `gh pr merge` mesmo concluindo o merge: confira com `gh pr view <n> --json state` antes de tentar de novo.
