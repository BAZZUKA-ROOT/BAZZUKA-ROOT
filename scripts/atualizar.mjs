// Atualiza o README do perfil sozinho (roda no GitHub Actions, sem dependências).
// - "Último lançamento" e "Lançados recentemente" saem da lista de repositórios.
// - Os cards de números e linguagens são SVGs gerados aqui, sem depender de
//   serviços de terceiros que vivem fora do ar.
// Uso local: GITHUB_TOKEN=$(gh auth token) node scripts/atualizar.mjs

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await readFile(join(RAIZ, 'perfil.config.json'), 'utf8'));
const USUARIO = config.usuario;
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) throw new Error('Defina GITHUB_TOKEN');

const cabecalhos = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': `${USUARIO}-perfil`,
};

async function api(caminho) {
  const r = await fetch(`https://api.github.com${caminho}`, { headers: cabecalhos });
  if (!r.ok) throw new Error(`${r.status} em ${caminho}`);
  return r.json();
}

async function graphql(query, variables) {
  const r = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: cabecalhos,
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

// ---------- dados ----------

const todos = await api(`/users/${USUARIO}/repos?per_page=100&type=owner&sort=created&direction=desc`);
const ocultos = new Set(config.ocultar.map((n) => n.toLowerCase()));
const repos = todos
  .filter((r) => !r.fork && !r.archived && !r.private && !ocultos.has(r.name.toLowerCase()))
  .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

const linguagensPorRepo = await Promise.all(repos.map((r) => api(`/repos/${USUARIO}/${r.name}/languages`)));
const bytes = {};
for (const ls of linguagensPorRepo) for (const [l, n] of Object.entries(ls)) bytes[l] = (bytes[l] || 0) + n;

const { user } = await graphql(
  `query($login:String!){ user(login:$login){
    contributionsCollection{ totalCommitContributions contributionCalendar{ totalContributions } }
    pullRequests{ totalCount } followers{ totalCount } } }`,
  { login: USUARIO },
);

const numeros = {
  projetos: repos.length,
  contribuicoes: user.contributionsCollection.contributionCalendar.totalContributions,
  commits: user.contributionsCollection.totalCommitContributions,
  estrelas: repos.reduce((s, r) => s + r.stargazers_count, 0),
};

// ---------- formatação ----------

const CORES = {
  JavaScript: ['F7DF1E', 'javascript', 'black'],
  TypeScript: ['3178C6', 'typescript', 'white'],
  Python: ['3776AB', 'python', 'white'],
  PHP: ['777BB4', 'php', 'white'],
  HTML: ['E34F26', 'html5', 'white'],
  CSS: ['1572B6', 'css3', 'white'],
  'C++': ['00599C', 'cplusplus', 'white'],
  C: ['A8B9CC', 'c', 'black'],
  Shell: ['4EAA25', 'gnubash', 'white'],
  PowerShell: ['5391FE', 'powershell', 'white'],
  Batchfile: ['C1F12E', 'windowsterminal', 'black'],
  Go: ['00ADD8', 'go', 'white'],
  Rust: ['000000', 'rust', 'white'],
  Java: ['B07219', 'openjdk', 'white'],
  Vue: ['4FC08D', 'vuedotjs', 'white'],
};
const corDe = (l) => `#${(CORES[l] || ['8B5CF6'])[0]}`;

const escapaHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escapaTabela = (s) => escapaHtml(s).replace(/\|/g, '\\|');

const data = (iso) =>
  new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' });

const descricao = (r) => config.descricoes[r.name] || r.description || 'Projeto novo — descrição em breve.';
const titulo = (r) => config.nomes?.[r.name] || r.name.replace(/[-_]+/g, ' ').replace(/\b\p{L}/gu, (c) => c.toUpperCase());
const demo = (r) => r.homepage || (r.has_pages ? `https://${USUARIO.toLowerCase()}.github.io/${r.name}/` : '');

function seloLinguagem(l, estilo = 'flat') {
  if (!l) return '';
  const [cor, logo, txt] = CORES[l] || ['8B5CF6', '', 'white'];
  const nome = encodeURIComponent(l.replace(/-/g, '--'));
  return `<img src="https://img.shields.io/badge/${nome}-${cor}?style=${estilo}${logo ? `&logo=${logo}&logoColor=${txt}` : ''}" alt="${escapaHtml(l)}"/>`;
}

const botao = (texto, cor, logo, href) =>
  `<a href="${href}"><img src="https://img.shields.io/badge/${encodeURIComponent(texto)}-${cor}?style=for-the-badge&logo=${logo}&logoColor=white" alt="${escapaHtml(texto.replace(/_/g, ' '))}"/></a>`;

function blocoUltimo(r) {
  const botoes = [botao('Ver_código', '7C3AED', 'github', r.html_url)];
  if (demo(r)) botoes.push(botao('Abrir_demo', '22C55E', 'googlechrome', demo(r)));
  return [
    '<table align="center"><tr><td align="center" width="900">',
    `<h3>✨ ${escapaHtml(titulo(r))}</h3>`,
    `<p>${escapaHtml(descricao(r))}</p>`,
    `<p>${botoes.join(' ')}</p>`,
    `<p>${seloLinguagem(r.language)} <img src="https://img.shields.io/badge/lan%C3%A7ado_em-${encodeURIComponent(data(r.created_at)).replace(/-/g, '--')}-1F2937?style=flat" alt="lançado em ${data(r.created_at)}"/></p>`,
    '</td></tr></table>',
  ].join('\n');
}

function blocoRecentes(lista) {
  const linhas = lista.map((r) => {
    const links = [`<a href="${r.html_url}">código</a>`];
    if (demo(r)) links.push(`<a href="${demo(r)}">demo</a>`);
    return `| **[${escapaTabela(titulo(r))}](${r.html_url})** | ${escapaTabela(descricao(r))} | ${seloLinguagem(r.language)} | ${data(r.created_at)} | ${links.join(' · ')} |`;
  });
  return ['| Projeto | O que faz | Linguagem | Lançado | Links |', '|---|---|:---:|:---:|:---:|', ...linhas].join('\n');
}

// ---------- SVGs ----------

const FONTE = "'Segoe UI', Ubuntu, 'Helvetica Neue', Arial, sans-serif";
const base = (largura, altura, corpo) => `<svg xmlns="http://www.w3.org/2000/svg" width="${largura}" height="${altura}" viewBox="0 0 ${largura} ${altura}" role="img">
<style>
  .t{font:600 18px ${FONTE};fill:#C4B5FD}
  .n{font:700 30px ${FONTE};fill:#F5F3FF}
  .r{font:400 13px ${FONTE};fill:#A1A1AA}
  .l{font:500 13px ${FONTE};fill:#E4E4E7}
  .p{font:400 12px ${FONTE};fill:#A1A1AA}
  .a{opacity:0;animation:e .6s ease-out forwards}
  @keyframes e{to{opacity:1}}
  @media (prefers-reduced-motion:reduce){.a{animation:none;opacity:1}}
</style>
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1E1B2E"/><stop offset="1" stop-color="#13111C"/></linearGradient></defs>
<rect x=".5" y=".5" width="${largura - 1}" height="${altura - 1}" rx="14" fill="url(#g)" stroke="#3B2F63"/>
${corpo}
</svg>
`;

function svgNumeros() {
  const itens = [
    ['Projetos públicos', numeros.projetos],
    ['Contribuições no ano', numeros.contribuicoes],
    ['Commits no ano', numeros.commits],
    ['Estrelas recebidas', numeros.estrelas],
  ];
  const corpo = itens
    .map(([rotulo, valor], i) => {
      const x = 24 + (i % 2) * 230;
      const y = 82 + Math.floor(i / 2) * 78;
      return `<g class="a" style="animation-delay:${0.1 + i * 0.12}s">
  <rect x="${x}" y="${y - 36}" width="214" height="66" rx="10" fill="#7C3AED" fill-opacity=".09" stroke="#7C3AED" stroke-opacity=".25"/>
  <text x="${x + 16}" y="${y - 4}" class="n">${valor}</text>
  <text x="${x + 16}" y="${y + 18}" class="r">${escapaHtml(rotulo)}</text>
</g>`;
    })
    .join('\n');
  return base(478, 210, `<text x="24" y="32" class="t">Números do GitHub</text>\n${corpo}`);
}

function svgLinguagens() {
  const total = Object.values(bytes).reduce((a, b) => a + b, 0) || 1;
  const top = Object.entries(bytes).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const largura = 430;
  let x = 24;
  const barra = top
    .map(([l, n]) => {
      const w = Math.max((n / total) * largura, 2);
      const seg = `<rect x="${x.toFixed(1)}" y="50" width="${w.toFixed(1)}" height="10" fill="${corDe(l)}"/>`;
      x += w;
      return seg;
    })
    .join('');
  const lista = top
    .map(([l, n], i) => {
      const cx = 24 + (i % 2) * 220;
      const cy = 92 + Math.floor(i / 2) * 26;
      const pct = ((n / total) * 100).toFixed(1).replace('.', ',');
      return `<g class="a" style="animation-delay:${0.1 + i * 0.07}s"><circle cx="${cx + 5}" cy="${cy - 4}" r="5" fill="${corDe(l)}"/><text x="${cx + 18}" y="${cy}" class="l">${escapaHtml(l)}</text><text x="${cx + 196}" y="${cy}" class="p" text-anchor="end">${pct}%</text></g>`;
    })
    .join('\n');
  return base(478, 210, `<text x="24" y="32" class="t">Linguagens mais usadas</text>
<clipPath id="c"><rect x="24" y="50" width="${largura}" height="10" rx="5"/></clipPath>
<g clip-path="url(#c)">${barra}</g>
${lista}`);
}

// ---------- README ----------

function troca(texto, marcador, conteudo) {
  const re = new RegExp(`(<!-- ${marcador}:INICIO -->)[\\s\\S]*?(<!-- ${marcador}:FIM -->)`);
  if (!re.test(texto)) throw new Error(`Marcador ${marcador} não encontrado no README`);
  return texto.replace(re, `$1\n${conteudo}\n$2`);
}

const caminhoReadme = join(RAIZ, 'README.md');
let readme = await readFile(caminhoReadme, 'utf8');
const [ultimo, ...resto] = repos;
readme = troca(readme, 'ULTIMO', blocoUltimo(ultimo));
readme = troca(readme, 'RECENTES', blocoRecentes(resto.slice(0, config.recentes)));
await writeFile(caminhoReadme, readme);

await mkdir(join(RAIZ, 'assets'), { recursive: true });
await writeFile(join(RAIZ, 'assets', 'numeros.svg'), svgNumeros());
await writeFile(join(RAIZ, 'assets', 'linguagens.svg'), svgLinguagens());

console.log(`ok: ${repos.length} projetos, último = ${ultimo.name}`, numeros);
