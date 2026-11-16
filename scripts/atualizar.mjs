// Perfil GitHub Bazzuka: dados oficiais, três fontes de destaque e SVGs próprios.
// PROFILE_DRY_RUN=1 valida tudo sem modificar arquivos ou fazer commits.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  repositoriesForProfile, selectHighlights, summarizeLanguages,
  languagePercentages, parsePortfolioStack, safeDescription, streakMetrics
} from './profile-logic.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(await readFile(join(ROOT, 'perfil.config.json'), 'utf8'));
const OWNER = cfg.usuario;
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) throw Error('GITHUB_TOKEN obrigatório. Nenhum arquivo modificado.');
const DRY = process.env.PROFILE_DRY_RUN === '1';
const headers = {
  Authorization: 'Bearer ' + TOKEN,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'BAZZUKA-ROOT-profile-updater',
  'X-GitHub-Api-Version': '2022-11-28'
};
const escape = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const isoDate = value => new Date(value).toLocaleDateString('pt-BR', {
  timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric'
});
const safeUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ?
      url.href : '';
  } catch { return ''; }
};
const repoUrl = r => 'https://github.com/' + encodeURIComponent(OWNER) +
  '/' + encodeURIComponent(r.name);
const title = r => cfg.nomes?.[r.name] ||
  r.name.replace(/[-_]+/g, ' ').replace(/\b\p{L}/gu,
    c => c.toLocaleUpperCase('pt-BR'));
const description = r => cfg.descricoes?.[r.name] || r.description ||
  'Repositório público. Consulte o README para saber mais.';
const demo = r => safeUrl(r.homepage) ||
  (r.has_pages ? 'https://' + OWNER.toLowerCase() + '.github.io/' +
    encodeURIComponent(r.name) + '/' : '');

async function request(url, options = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, {
      ...options,
      headers: { ...headers, ...(options.headers || {}) },
      signal: AbortSignal.timeout(20000)
    });
    if (response.ok) return response.json();
    if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 2) {
      await new Promise(resolve => setTimeout(resolve, 1200 * (attempt + 1)));
      continue;
    }
    throw Error('GitHub HTTP ' + response.status + ' em ' +
      new URL(url).pathname + ' (dados antigos não serão publicados).');
  }
  throw Error('GitHub indisponível.');
}
const api = path => request('https://api.github.com' + path);
async function getAll(path, maxPages = 10) {
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await api(path + (path.includes('?') ? '&' : '?') +
      'per_page=100&page=' + page);
    if (!Array.isArray(data)) throw Error('Resposta GitHub inválida.');
    rows.push(...data);
    if (data.length < 100) return rows;
  }
  throw Error('Limite de paginação excedido. Evitando métricas parciais.');
}
async function mapLimit(items, concurrency, fn) {
  const result = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      result[i] = await fn(items[i], i);
    }
  }));
  return result;
}
async function graphqlContributions() {
  const query = 'query($login:String!){user(login:$login){' +
    'contributionsCollection{totalCommitContributions ' +
    'contributionCalendar{totalContributions ' +
    'weeks{contributionDays{date contributionCount}}}}}}';
  const response = await request('https://api.github.com/graphql', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { login: OWNER } })
  });
  if (response.errors?.length || !response.data?.user?.contributionsCollection)
    throw Error('GraphQL não forneceu contribuições verificadas.');
  return response.data.user.contributionsCollection;
}

const all = await getAll('/users/' + encodeURIComponent(OWNER) +
  '/repos?type=owner&sort=created&direction=desc');
const { publicRepos, showcased } = repositoriesForProfile(all, cfg);
if (!publicRepos.length || !showcased.length) throw Error('Nenhum projeto público elegível.');
const languageSources = await mapLimit(showcased, 5, r =>
  api('/repos/' + OWNER + '/' + encodeURIComponent(r.name) + '/languages'));
const langBytes = summarizeLanguages(languageSources);
const percentages = languagePercentages(langBytes);
const contributionData = await graphqlContributions();
const calendar = contributionData.contributionCalendar;
const streak = streakMetrics(calendar.weeks);
const numbers = {
  publicRepos: publicRepos.length,
  contributions: Number(calendar.totalContributions),
  commits: Number(contributionData.totalCommitContributions),
  stars: publicRepos.reduce((sum, r) => sum + Number(r.stargazers_count || 0), 0)
};
if (Object.values(numbers).some(n => !Number.isFinite(n) || n < 0))
  throw Error('Métricas inconsistentes: dados não serão gravados.');

// Fonte da stack: estrutura real da seção Minha Stack do portfólio público.
const portfolioRepo = await api('/repos/' + OWNER + '/portfolio-bazzuka');
const branch = encodeURIComponent(portfolioRepo.default_branch || 'main');
const file = await api('/repos/' + OWNER +
  '/portfolio-bazzuka/contents/index.html?ref=' + branch);
if (file.encoding !== 'base64' || !file.content)
  throw Error('Portfólio indisponível: não utilizar lista manual desatualizada.');
const portfolioHtml = Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8');
const stack = parsePortfolioStack(portfolioHtml);

// Download = apenas download_count de assets de GitHub Releases, jamais clones.
const releaseLists = await mapLimit(showcased, 4, r =>
  getAll('/repos/' + OWNER + '/' + encodeURIComponent(r.name) + '/releases?'));
const downloads = new Map(showcased.map((r, index) => [
  r.name.toLowerCase(),
  releaseLists[index].reduce((sum, release) => sum +
    (release.assets || []).reduce((s, asset) =>
      s + Number(asset.download_count || 0), 0), 0)
]));
const highlights = selectHighlights(showcased, downloads, new Date(), cfg.destaques);
const totalDownloads = [...downloads.values()].reduce((sum, value) => sum + value, 0);
const featured = [...highlights.stars, ...highlights.downloaded, ...highlights.rotating];
if (new Set(featured.map(r => r.name)).size !== featured.length)
  throw Error('Destaques duplicados.');

const COLORS = {
  'PHP': ['777BB4', 'php', 'white'], 'Python': ['3776AB', 'python', 'white'],
  'JavaScript': ['F7DF1E', 'javascript', 'black'],
  'TypeScript': ['3178C6', 'typescript', 'white'],
  'Node.js': ['339933', 'nodedotjs', 'white'],
  'React': ['20232A', 'react', '61DAFB'], 'Next.js': ['000000', 'nextdotjs', 'white'],
  'Electron': ['47848F', 'electron', 'white'],
  'C++ / ESP32': ['00599C', 'cplusplus', 'white'],
  'C++': ['00599C', 'cplusplus', 'white'],
  'MySQL': ['4479A1', 'mysql', 'white'], 'SQLite': ['07405E', 'sqlite', 'white'],
  'Bots & IA': ['7C3AED', '', 'white'], 'Automação': ['A855F7', 'githubactions', 'white'],
  'HTML': ['E34F26', 'html5', 'white'], 'CSS': ['1572B6', 'css3', 'white'],
  'Go': ['00ADD8', 'go', 'white'], 'Shell': ['4EAA25', 'gnubash', 'white']
};
function webBadge(name, size='flat') {
  if (!name) return '';
  const [color, logo, textColor] = COLORS[name] || ['7C3AED', '', 'white'];
  const label = encodeURIComponent(name.replace(/-/g, '--').replace(/ /g, '_'));
  const url = 'https://img.shields.io/badge/' + label + '-' + color +
    '?style=' + size +
    (logo ? '&logo=' + encodeURIComponent(logo) + '&logoColor=' + textColor : '');
  return '<img src="' + url + '" alt="' + escape(name) + '"/>';
}
function button(label, color, icon, href) {
  const target = safeUrl(href);
  if (!target) return '';
  const image = 'https://img.shields.io/badge/' +
    encodeURIComponent(label.replace(/ /g, '_')) + '-' + color +
    '?style=for-the-badge&logo=' + icon + '&logoColor=white';
  return '<a href="' + escape(target) + '"><img src="' + image +
    '" alt="' + escape(label) + '"/></a>';
}
function linksFor(r) {
  const links = [button('Ver código', '7C3AED', 'github', repoUrl(r))];
  if (demo(r)) links.push(button('Abrir demo', '22C55E', 'googlechrome', demo(r)));
  return links.filter(Boolean).join(' ');
}
function latestBlock(r) {
  return [
    '<table align="center"><tr><td align="center" width="900">',
    '<h3>✨ ' + escape(title(r)) + '</h3>',
    '<p>' + escape(description(r)) + '</p>',
    '<p>' + linksFor(r) + '</p>',
    '<p>' + webBadge(r.language) + ' <sub>Criado no GitHub em ' +
      isoDate(r.created_at) + '</sub></p>',
    '</td></tr></table>'
  ].join('\n');
}
function recentBlock(repos) {
  const result = repos.map(r => {
    const links = ['<a href="' + repoUrl(r) + '">código</a>'];
    if (demo(r)) links.push('<a href="' + escape(demo(r)) + '">demo</a>');
    return '| **[' + escape(title(r)).replace(/\|/g, '\\|') + '](' +
      repoUrl(r) + ')** | ' + escape(safeDescription(description(r))) +
      ' | ' + webBadge(r.language) + ' | ' + isoDate(r.created_at) +
      ' | ' + links.join(' · ') + ' |';
  });
  return ['| Projeto | O que faz | Linguagem | Criado no GitHub | Links |',
    '|---|---|:---:|:---:|:---:|', ...result].join('\n');
}
function featuredCard(r, mode) {
  const note = mode === 'stars' ? '⭐ ' + Number(r.stargazers_count) + ' estrela(s)' :
    mode === 'downloads' ? '📦 ' + downloads.get(r.name.toLowerCase()) +
    ' download(s) em Releases' : '🔁 Escolhido pelo rodízio semanal';
  return '<td width="50%" valign="top" align="center">' +
    '<h3>' + escape(title(r)) + '</h3><p>' + linksFor(r) + '</p>' +
    '<p>' + escape(description(r)) + '</p>' +
    '<p>' + webBadge(r.language) + '</p><p><sub>' + note +
    '</sub></p></td>';
}
function featuredTable(repos, mode) {
  if (!repos.length) return '';
  const rows = [];
  for (let i=0;i<repos.length;i+=2) {
    rows.push('<tr>' + featuredCard(repos[i],mode) +
      (repos[i+1] ? featuredCard(repos[i+1],mode) :
        '<td width="50%"></td>') + '</tr>');
  }
  return '<table align="center" width="100%">\n' + rows.join('\n') + '\n</table>';
}
function highlightedBlock() {
  return [
    '<p><sub>Dados oficiais do GitHub; sem popularidade ou downloads simulados.</sub></p>',
    '### ⭐ Mais estrelados',
    highlights.stars.length ? featuredTable(highlights.stars, 'stars') :
      '<p><sub>Nenhum repositório com estrelas registradas até agora.</sub></p>',
    '### 📦 Mais baixados no GitHub Releases',
    highlights.downloaded.length ? featuredTable(highlights.downloaded, 'downloads') :
      '<p><sub>Nenhum download de asset em GitHub Releases registrado.</sub></p>',
    '### 🔄 Escolhas da semana (' + isoDate(highlights.week) + ')',
    featuredTable(highlights.rotating, 'weekly')
  ].join('\n\n');
}


// SVGs próprios para evitar cartões estáticos e serviço de sequência terceirizado.
const font = "'Segoe UI', Ubuntu, 'Helvetica Neue', Arial, sans-serif";
function base(width, height, body) {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width +
    '" height="' + height + '" viewBox="0 0 ' + width + ' ' +
    height + '" role="img">\n<style>\n' +
    '.t{font:600 18px ' + font + ';fill:#C4B5FD}\n' +
    '.n{font:700 30px ' + font + ';fill:#F5F3FF}\n' +
    '.r{font:400 13px ' + font + ';fill:#A1A1AA}\n' +
    '.l{font:500 13px ' + font + ';fill:#E4E4E7}\n' +
    '.p{font:400 12px ' + font + ';fill:#A1A1AA}\n' +
    '</style>\n<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#1E1B2E"/>' +
    '<stop offset="1" stop-color="#13111C"/></linearGradient></defs>\n' +
    '<rect x=".5" y=".5" width="' + (width - 1) +
    '" height="' + (height - 1) + '" rx="14" fill="url(#g)" ' +
    'stroke="#3B2F63"/>\n' + body + '\n</svg>\n';
}
function numbersSvg() {
  const fields = [
    ['Repositórios públicos', numbers.publicRepos],
    ['Contribuições · 12 meses', numbers.contributions],
    ['Commits contabilizados', numbers.commits],
    ['Estrelas recebidas', numbers.stars]
  ];
  const rectangles = fields.map(([name, val], i) => {
    const x = 24 + (i % 2) * 230;
    const y = 82 + Math.floor(i / 2) * 78;
    return '<g><rect x="' + x + '" y="' + (y - 36) +
      '" width="214" height="66" rx="10" fill="#7C3AED" ' +
      'fill-opacity=".09" stroke="#7C3AED" stroke-opacity=".25"/>' +
      '<text x="' + (x + 16) + '" y="' + (y - 4) +
      '" class="n">' + val + '</text>' +
      '<text x="' + (x + 16) + '" y="' + (y + 18) +
      '" class="r">' + escape(name) + '</text></g>';
  }).join('\n');
  return base(478, 210, '<text x="24" y="32" class="t">Números do GitHub</text>\n' +
    rectangles);
}
function languagesSvg() {
  const width = 478;
  const barWidth = 430;
  let offset = 24;
  const bars = percentages.rows.map(row => {
    const w = row.percent * barWidth / 100;
    const fill = COLORS[row.name] ? '#' + COLORS[row.name][0] : '#8B5CF6';
    const rect = '<rect x="' + offset.toFixed(2) +
      '" y="50" width="' + w.toFixed(2) +
      '" height="10" fill="' + fill + '"/>';
    offset += w;
    return rect;
  }).join('');
  const labels = percentages.rows.map((row, i) => {
    const x = 24 + (i % 2) * 220;
    const y = 92 + Math.floor(i / 2) * 26;
    const color = COLORS[row.name] ? '#' + COLORS[row.name][0] : '#8B5CF6';
    return '<g><circle cx="' + (x + 5) + '" cy="' + (y - 4) +
      '" r="5" fill="' + color + '"/>' +
      '<text x="' + (x + 18) + '" y="' + y + '" class="l">' +
      escape(row.name) + '</text><text x="' + (x + 196) +
      '" y="' + y + '" class="p" text-anchor="end">' +
      row.percent.toFixed(1).replace('.', ',') + '%</text></g>';
  }).join('\n');
  return base(width, percentages.rows.length > 8 ? 244 : 210,
    '<text x="24" y="32" class="t">Linguagens · bytes dos projetos</text>\n' +
    '<clipPath id="clip"><rect x="24" y="50" width="' + barWidth +
    '" height="10" rx="5"/></clipPath>\n' +
    '<g clip-path="url(#clip)">' + bars + '</g>\n' + labels);
}
function streakSvg() {
  const fields = [
    ['Contribuições · 12 meses', String(numbers.contributions), 'Total no período'],
    ['Sequência atual', String(streak.current), streak.currentEnd ?
      'Até ' + isoDate(streak.currentEnd) : 'Sem sequência ativa'],
    ['Maior sequência', String(streak.longest), streak.longestEnd ?
      'Até ' + isoDate(streak.longestEnd) : 'Maior na janela móvel']
  ];
  const columns = fields.map(([name, value, note], i) => {
    const x = 15 + i * 290;
    return '<g>' +
      (i > 0 ? '<line x1="' + (x - 12) +
        '" y1="33" x2="' + (x - 12) +
        '" y2="145" stroke="#8B77BD"/>' : '') +
      '<text x="' + (x + 135) +
      '" y="75" text-anchor="middle" font-size="31" font-family="' +
      escape(font) + '" fill="#9B83F9" font-weight="700">' +
      value + '</text>' +
      '<text x="' + (x + 135) + '" y="111" text-anchor="middle" ' +
      'font-size="15" font-family="' + escape(font) +
      '" fill="#C4B5FD">' + escape(name) + '</text>' +
      '<text x="' + (x + 135) + '" y="139" text-anchor="middle" ' +
      'font-size="12" font-family="' + escape(font) +
      '" fill="#10B981">' + escape(note) + '</text></g>';
  }).join('');
  return base(900, 172, columns);
}
const svgNumbers = numbersSvg();
const svgLanguages = languagesSvg();
const svgContributions = streakSvg();
const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 12);
function image(name, content, alt, width) {
  return '<img src="assets/' + name + '?v=' + hash(content) +
    '" alt="' + escape(alt) + '" width="' + width + '"/>';
}
const numbersBlock = '<div align="center">\n' +
  image('numeros.svg', svgNumbers, 'Números reais do GitHub', '48%') + '\n' +
  image('linguagens.svg', svgLanguages, 'Linguagens por bytes de código', '48%') +
  '\n\n' + image('sequencia.svg', svgContributions,
    'Sequências calculadas pelas contribuições oficiais', '95%') +
  '\n</div>\n\n' +
  '<p align="center"><sub>Fonte: GitHub API/GraphQL. Contribuições dos últimos ' +
  '12 meses; linguagens em bytes de código dos projetos públicos. ' +
  'Atualização agendada a cada 2 horas.</sub></p>';
function stackBadge(name) {
  const [color, logo, fontColor] = COLORS[name] || ['7C3AED', '', 'white'];
  const label = encodeURIComponent(name.replace(/-/g, '--').replace(/ /g, '_'));
  const target = 'https://img.shields.io/badge/' + label + '-' + color +
    '?style=for-the-badge' +
    (logo ? '&logo=' + logo + '&logoColor=' + fontColor : '');
  return '![' + name.replace(/[\[\]]/g, '') + '](' + target + ')';
}
const stackBlock = '<div align="center">\n\n' +
  stack.map(stackBadge).join('\n') + '\n\n</div>\n\n' +
  '<p align="center"><sub>Sincronizado com a seção Minha Stack do ' +
  '<a href="https://bazzuka-root.github.io/portfolio-bazzuka/">portfólio</a>.</sub></p>';

function replaceMarked(src, marker, content) {
  const start = '<!-- ' + marker + ':INICIO -->';
  const end = '<!-- ' + marker + ':FIM -->';
  const a = src.indexOf(start);
  const b = src.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw Error('Marcador ausente: ' + marker);
  return src.slice(0, a + start.length) + '\n' + content +
    '\n' + src.slice(b);
}
function replaceSection(src, from, to, body) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw Error('Seção do README não encontrada: ' + from);
  return src.slice(0, a + from.length) + '\n\n' +
    body.trim() + '\n\n---\n\n' + src.slice(b);
}

const readmePath = join(ROOT, 'README.md');
let readme = (await readFile(readmePath, 'utf8')).replace(/\r\n/g, '\n');
readme = replaceMarked(readme, 'ULTIMO', latestBlock(showcased[0]));
readme = replaceSection(readme, '## 🚀 Projetos em destaque',
  '## 🕒 Lançados recentemente',
  '<!-- DESTAQUES:INICIO -->\n' +
  highlightedBlock() + '\n<!-- DESTAQUES:FIM -->');
readme = replaceMarked(readme, 'RECENTES',
  recentBlock(showcased.slice(0, cfg.recentes || 6)));
readme = replaceSection(readme, '## 📊 Números', '## ⚡ Stack', numbersBlock);
const stackPos = readme.indexOf('## ⚡ Stack');
const footerPos = readme.indexOf('\n---\n\n<div align="center">', stackPos);
if (stackPos < 0 || footerPos < 0)
  throw Error('Seção Stack não localizada: preservando README anterior.');
readme = readme.slice(0, stackPos) +
  '## ⚡ Stack\n\n' + stackBlock + '\n' + readme.slice(footerPos);

const summary = {
  publicRepositories: numbers.publicRepos,
  eligibleProjects: showcased.length,
  latest: showcased[0].name,
  recent: showcased.slice(0, cfg.recentes || 6).map(r => r.name),
  starred: highlights.stars.map(r => r.name),
  mostDownloaded: highlights.downloaded.map(r => r.name),
  weekly: highlights.rotating.map(r => r.name),
  week: highlights.week,
  releaseDownloads: totalDownloads,
  stack,
  languages: percentages.rows.map(x => [x.name, Number(x.percent.toFixed(2))]),
  contributions: numbers.contributions,
  commits: numbers.commits,
  stars: numbers.stars,
  streak: { current: streak.current, longest: streak.longest },
  dryRun: DRY
};
if (DRY) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  await mkdir(join(ROOT, 'assets'), { recursive: true });
  async function writeChanged(path, content) {
    let before = null;
    try { before = await readFile(path, 'utf8'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (before === content) return false;
    const tmp = path + '.tmp';
    await writeFile(tmp, content, { encoding: 'utf8' });
    await rename(tmp, path);
    return true;
  }
  const updated = [];
  for (const [path, content] of [
    [readmePath, readme],
    [join(ROOT, 'assets', 'numeros.svg'), svgNumbers],
    [join(ROOT, 'assets', 'linguagens.svg'), svgLanguages],
    [join(ROOT, 'assets', 'sequencia.svg'), svgContributions]
  ]) {
    if (await writeChanged(path, content))
      updated.push(path.split(/[\\/]/).at(-1));
  }
  console.log('PROFILE_UPDATED ' +
    JSON.stringify({ ...summary, changedFiles: updated }, null, 2));
}
