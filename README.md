# Janus Diff

Ferramenta de comparação lado a lado (pastas, texto e hex) em Electron,
pensada para uso com git e com o menu de contexto do Explorer.

![Comparação de pastas](docs/screenshots/1-dir.png)
![Comparação de texto](docs/screenshots/4-text.png)

## Executar

```
npm install
npm start                      # abre a tela inicial
npm start -- <esquerda> <direita>   # duas pastas ou dois arquivos
npm test                       # testes do motor de comparação
```

## Gerar instalador para Windows

```
npm run dist:win
```

Gera instalador NSIS e executável portátil em `dist/`. Rode em uma máquina
Windows (ou em Linux com Wine instalado).

## Menu de contexto do Explorer (Windows)

O instalador registra as opções; rodando do código-fonte, use
**Tools → Install Explorer Context Menu**.

1. Botão direito num arquivo → **Janus Diff: Select Left File**.
2. Botão direito em outro arquivo → **Janus Diff: Compare to "nome.ext"** (abre a
   comparação) ou **Janus Diff: Select Left File** (troca a seleção).

Com dois arquivos (ou duas pastas) selecionados, o menu mostra só
**Janus Diff: Compare**, que abre a comparação direto. Essa opção também
aparece com um item só e, nesse caso, abre o item sozinho no lado esquerdo.

O mesmo vale para pastas (*Janus Diff: Select Left Folder*). No Windows 11 as
opções ficam em "Mostrar mais opções". As chaves ficam em
`HKCU\Software\Classes\*\shell` e `...\Directory\shell` e são removidas pelo
desinstalador ou por **Tools → Remove Explorer Context Menu**.

## Git

**Tools → Configure as Git Diff Tool** (ou `--git-setup`) grava no
`~/.gitconfig` global:

```
git difftool                 # um arquivo por vez
git difftool --dir-diff      # todas as mudanças numa comparação de pastas
```

## Linha de comando

```
<app> <esquerda> [<direita>]   abre a comparação (reusa a janela já aberta)
<app> --wait <esq> <dir>       processo próprio; termina ao fechar a janela
<app> --select-left <caminho>  memoriza o lado esquerdo
<app> --compare-to <caminho>   compara o lado memorizado com este
<app> --compare-selected <c>   junta os itens de uma seleção múltipla do Explorer
<app> --register-shell | --unregister-shell | --git-setup
```

## Recursos

- **Pastas:** árvores alinhadas, cores por resultado (igual, diferente, mais
  novo/antigo, órfão), critérios (tamanho, data com tolerância, conteúdo por
  CRC / binário / regras), filtros de nome e de caminho (`-/src/gen/`),
  filtros de exibição, comparar o conteúdo só da seleção (Ctrl+M), tirar
  itens da comparação (Ctrl+E), copiar, excluir (lixeira, com opção de
  exclusão permanente quando ela não está disponível), renomear, nova pasta,
  sincronizar (Update / Mirror).
- **Texto:** alinhamento de linhas, diferenças dentro da linha, regras de
  importância (espaços, maiúsculas), navegação por seção, realinhamento
  manual (F7 numa linha, depois clique na linha correspondente do outro
  lado), copiar seção (Ctrl+R / Ctrl+L) ou só a linha (Ctrl+Shift+R / L,
  setas → / ← na margem de cada linha diferente, ou clique direito) entre
  os lados. Para passar um trecho, selecione as linhas arrastando o mouse
  (como num editor de texto; passar da borda rola a lista) ou com Shift+clique
  / Shift+setas, PgUp/PgDn, Home/End; depois clique numa seta → / ← dentro da
  seleção, no botão "→ Copy N lines" que aparece ao lado dela ou use
  Ctrl+Shift+R / L: o bloco inteiro vai para o outro lado num passo só de
  desfazer. Também é possível editar, desfazer/refazer, salvar preservando
  codificação e fim de linha, miniatura, localizar, ir para linha, copiar
  (Ctrl+Shift+C) ou salvar as diferenças como diff unificado (patch),
  comparar o texto da área de transferência (Ctrl+Shift+V) e recarregar
  sozinho o arquivo alterado por outro programa (com Ctrl+Z para voltar).
- **Hex:** comparação byte a byte.
- Abas, sessões recentes, arrastar e soltar, lista de atalhos (F1).

## Estrutura

```
src/core/textdiff.js     motor de diff de texto (Node + renderer)
src/core/dircompare.js   motor de comparação de pastas
src/main/                processo principal, menu, IPC
src/renderer/            interface (abas, pastas, texto, hex)
tools/icon/              gera o ícone a partir de installer/icon.svg
tools/smoke/             teste de fumaça da interface (Electron + Xvfb em Docker)
```
