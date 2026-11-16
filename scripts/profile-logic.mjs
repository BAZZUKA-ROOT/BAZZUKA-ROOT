// Funções puras de seleção; GitHub Actions usa as mesmas regras dos testes.
import { createHash } from 'node:crypto';

const isDate = (value) => Number.isFinite(Date.parse(value));
const normalize = (name) => String(name || '').toLowerCase();

export function repositoriesForProfile(all, config) {
  const hidden = new Set((config.ocultar || []).map(normalize));
  const publicRepos = all.filter(r => r && !r.private && !r.fork && !r.archived);
  const showcased = publicRepos.filter(r =>
    !hidden.has(normalize(r.name)) &&
    normalize(r.name) !== normalize(config.usuario) &&
    !/^(qa-|test-|teste-|ci-)/i.test(r.name) &&
    isDate(r.created_at));
  showcased.sort((a, b) =>
    Date.parse(b.created_at) - Date.parse(a.created_at) ||
    a.name.localeCompare(b.name));
  return { publicRepos, showcased };
}

export function mondayUtc(date = new Date()) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error('Data inválida para rodízio');
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function weeklySelection(repos, amount, date = new Date(), excluded = new Set()) {
  const week = mondayUtc(date);
  return repos
    .filter(r => !excluded.has(normalize(r.name)))
    .map(r => ({
      repo: r,
      key: createHash('sha256').update(week + ':' + normalize(r.name)).digest('hex')
    }))
    .sort((a, b) => a.key.localeCompare(b.key) ||
      a.repo.name.localeCompare(b.repo.name))
    .slice(0, amount)
    .map(x => x.repo);
}

export function rankByStars(repos, amount) {
  return repos.filter(r => (r.stargazers_count || 0) > 0)
    .sort((a, b) =>
      (b.stargazers_count || 0) - (a.stargazers_count || 0) ||
      Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, amount);
}

export function rankByDownloads(repos, downloads, amount, excluded = new Set()) {
  return repos.filter(r => !excluded.has(normalize(r.name)) &&
      Number(downloads.get(normalize(r.name)) || 0) > 0)
    .sort((a, b) =>
      Number(downloads.get(normalize(b.name))) - Number(downloads.get(normalize(a.name))) ||
      Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, amount);
}

export function selectHighlights(repos, downloads, date, limits = {}) {
  const starLimit = Math.max(0, Math.min(8, Number(limits.estrelas ?? 2)));
  const downloadLimit = Math.max(0, Math.min(8, Number(limits.downloads ?? 2)));
  const weeklyLimit = Math.max(1, Math.min(12, Number(limits.rotacao ?? 8)));
  const stars = rankByStars(repos, starLimit);
  const selected = new Set(stars.map(r => normalize(r.name)));
  const downloaded = rankByDownloads(repos, downloads, downloadLimit, selected);
  downloaded.forEach(r => selected.add(normalize(r.name)));
  const rotating = weeklySelection(repos, weeklyLimit, date, selected);
  return { stars, downloaded, rotating, week: mondayUtc(date) };
}

export function parsePortfolioStack(html) {
  // Fonte: <div class="skill-name">Tech</div> no index.html do portfólio.
  const result = [];
  const rx = /<div\s+class=["'][^"']*\bskill-name\b[^"']*["'][^>]*>\s*([^<]+?)\s*<\/div>/gi;
  for (const match of html.matchAll(rx)) {
    const name = match[1].trim()
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    if (name && !result.includes(name)) result.push(name);
  }
  if (!result.length) throw new Error('A stack não foi encontrada no portfólio: não será inventada.');
  return result;
}

export function summarizeLanguages(languagesByRepo) {
  const amounts = {};
  for (const langs of languagesByRepo) {
    for (const [language, bytes] of Object.entries(langs)) {
      if (!Number.isFinite(bytes) || bytes <= 0) continue;
      amounts[language] = (amounts[language] || 0) + bytes;
    }
  }
  return amounts;
}

export function languagePercentages(amounts, limit = 8) {
  const total = Object.values(amounts).reduce((sum, b) => sum + b, 0);
  const sorted = Object.entries(amounts).sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, limit);
  const remainder = sorted.slice(limit).reduce((sum, [,bytes]) => sum + bytes, 0);
  if (remainder) top.push(['Outras', remainder]);
  return { total, rows: top.map(([name, bytes]) =>
    ({ name, bytes, percent: total ? bytes * 100 / total : 0 })) };
}

export function safeDescription(value) {
  return String(value || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}


export function streakMetrics(weeks, todayISO = new Date().toISOString().slice(0, 10)) {
  const days = (weeks || []).flatMap(w => w.contributionDays || [])
    .filter(d => /^\d{4}-\d\d-\d\d$/.test(d.date))
    .sort((a, b) => a.date.localeCompare(b.date));
  const unique = new Map(days.map(d => [d.date, Number(d.contributionCount || 0)]));
  const dates = [...unique.keys()].sort();
  let longest = 0, running = 0, longestEnd = '';
  for (const date of dates) {
    if ((unique.get(date) || 0) > 0) {
      running++;
      if (running > longest) {
        longest = running;
        longestEnd = date;
      }
    } else {
      running = 0;
    }
  }
  const predecessor = d => {
    const t = new Date(d + 'T00:00:00Z');
    t.setUTCDate(t.getUTCDate() - 1);
    return t.toISOString().slice(0, 10);
  };
  let cursor = todayISO;
  if (!(unique.get(cursor) > 0)) cursor = predecessor(cursor);
  const currentEnd = (unique.get(cursor) || 0) > 0 ? cursor : '';
  let current = 0;
  while ((unique.get(cursor) || 0) > 0) {
    current++;
    cursor = predecessor(cursor);
  }
  return {
    current, longest, currentEnd, longestEnd,
    from: dates[0] || '', to: dates.at(-1) || '',
    total: [...unique.values()].reduce((s, n) => s + n, 0)
  };
}
