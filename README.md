# MyCAD — Sketcher 2D paramétrico

Primeiro marco de um sistema CAD: um **sketcher** com pontos, linhas e
**dimensionamento inteligente** (cotas que acionam um solver de restrições).

## Decisão de stack

| Camada | Escolha | Por quê |
|---|---|---|
| Lógica / geometria / solver | **TypeScript** | Segurança de tipos para geometria e restrições, ecossistema maduro, iteração rápida. O núcleo é puro TS — pode ser portado para Rust/WASM depois sem mudar o modelo. |
| Renderização do sketch (2D) | **Canvas 2D** | Controle total sobre grid, snap, glifos de cota e highlight. É o que editores CAD usam para rascunho 2D; leve e suficiente para milhares de entidades. |
| Build / dev | **Vite** | Servidor com HMR e build estático simples, sem configuração. |
| Futuro viewport 3D | **WebGPU** (com Three.js/Babylon) + **Rust→WASM** para o kernel geométrico | Crescimento natural quando a modelagem 3D entrar; o sketch 2D vira o perfil que gera sólidos. |

**Por não começar em C++/Rust puro:** para um sketcher, o gargalo não é GPU — é
interação, snapping e solver de restrições. TypeScript permite validar essas
ideias rápido; quando o kernel 3D exigir performance, ele entra como módulo
WASM atrás da mesma interface.

> Formato de coordenadas: eixo **Y apontando para cima**, origem fixa no centro.

## O que já funciona

- **Ponto (P)** — clique para posicionar; snap em pontos existentes e na grade.
- **Linha (L)** — clique início → clique fim; cadeia contínua (Esc encerra).
  - Infere **coincidência** (snap em ponto), **horizontal (H)** e **vertical (V)** automaticamente.
- **Círculo (C)** — clique no centro → clique no raio. Centro e ponto da circunferência são pontos reais do sketch, então participam do snap e do solver.
- **Arco (A)** — clique centro → início → fim. Pressione **R** para inverter o sentido (↺/↻). Também é formado por pontos + centro, com raio derivado.
- **Perpendicular (E)** — duas retas (ou reta + curva: a reta passa pelo centro).
- **Ângulo entre retas (G)** — duas retas; mede o ângulo dirigido entre elas, que pode ser o externo dependendo da ordem dos pontos.
- **Ângulo interno (I)** — clique no **vértice** e depois em cada lateral (pode clicar no meio da linha; o extremo oposto é usado como referência). Mede sempre o ângulo interno (0–180°), ideal para cantos de polígonos e trapézios. O valor em graus é editável no canvas e o solver gira as laterais. Por medir o menor ângulo entre os raios, cobre ângulos internos de polígonos convexos (0–180°).
- **Simetria (S)** — clique no 1º ponto, na reta-eixo e no 2º ponto; o solver espelha o par em relação ao eixo.
- **Recortar (X)** — passe o cursor sobre uma entidade: o trecho entre interseções consecutivas é destacado em vermelho; clique para removê-lo. Funciona entre linhas, círculos e arcos. Restrições da entidade original são transferidas para o fragmento restante.
- **Tangente (T)** — clique em duas entidades (linha, círculo ou arco) para criar tangência:
  - linha–curva: distância do centro da curva à reta = raio;
  - curva–curva: centros separados pela soma dos raios (externa) ou pela diferença (**Shift** = interna);
  - linha–linha: paralelismo.
  - Ao criar a tangência, o raio atual de cada curva é travado por uma cota **R**, para que o solver mova as entidades em vez de redimensioná-las.
- **Dimensão (D)** — clique numa linha (comprimento), em dois pontos (distância) ou numa curva (raio **R**; **Shift+clique** gera diâmetro **⌀**).
  - A cota é **inteligente**: o valor é editável no canvas e o **solver move a geometria** para satisfazê-lo. No arco, a cota de raio força os dois extremos a permanecerem na mesma circunferência.
- **Selecionar (V)** — clique para selecionar, arraste pontos para mover (restrições são respeitadas), Delete remove.
- **Pan** (botão do meio, Espaço ou ferramenta Pan) e **zoom** com a roda.
- **Undo/Redo** (Ctrl+Z / Ctrl+Y), **Ajustar à vista** (F).
- Painel de entidades/restrições com remoção individual.
- **Graus de liberdade (GL)** na barra de status e **aviso de superdimensionamento**: restrições redundantes são destacadas em vermelho no canvas e no painel; conflitos (resíduo que não vai a zero) geram aviso explícito.

## Solver

Gauss-Newton amortecido (Levenberg-Marquardt). Para `m` restrições e `n` variáveis
(2 por ponto livre), a cada iteração resolve:

```
(JᵀJ + λI) · Δx = -JᵀF
```

O termo `λI` regulariza sistemas subdeterminados: pontos sem restrição recebem
`Δx ≈ 0`, então o sketch se move o mínimo necessário. Derivadas numéricas
genéricas permitem adicionar novos tipos de restrição sem tocar no solver.

Restrições atuais: `distance`, `horizontal`, `vertical`, `radius`, `diameter`, `tangent`,
`perpendicular`, `angle`, `angle3`, `symmetry`.
Uma restrição pode gerar mais de uma equação: `radius`/`diameter` num arco
produzem duas (uma por extremo).

## Como rodar

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # tsc + bundle de produção em dist/
```

## Estrutura

```
src/
  core/
    types.ts       # entidades (ponto, linha, círculo, arco), restrições, snapshot
    sketch.ts      # documento (fonte da verdade) + serialização
    solver.ts      # solver de restrições
  sketcher/
    snapping.ts    # view, transformações, snap e inferência H/V
    renderer.ts    # desenho no Canvas + hit-testing
  main.ts          # app, ferramentas, eventos, undo/redo, UI
```

## Próximos marcos (sugestão)

1. Restrições de ângulo, paralelismo, perpendicularidade, simetria e ponto médio.
2. Constraints de igualdade, raio/arco e spline.
3. Graus de liberdade (DOF) exibidos e diagrama de dependências.
4. Extrusão/revolução → kernel B-rep → viewport 3D WebGPU.
