import test from 'node:test';
import assert from 'node:assert/strict';
import {
  repositoriesForProfile, mondayUtc, weeklySelection,
  rankByStars, rankByDownloads, selectHighlights,
  parsePortfolioStack, summarizeLanguages, languagePercentages,
  streakMetrics, safeDescription
} from './profile-logic.mjs';

const example = (name, created, stars = 0, extra = {}) => ({
  name, created_at: created, stargazers_count: stars,
  private: false, fork: false, archived: false,
  ...extra
});
const day = '2026-11-16T19:50:56Z';

test('exclui perfil e repositórios QA das vitrines, mas contabiliza os públicos', () => {
  const inputs = [
    example('BAZZUKA-ROOT', day),
    example('qa-gestor-projetos-20261116', day),
    example('newest-real', '2026-11-14T15:56:46Z'),
    example('old', '2026-11-03T20:04:30Z'),
    example('private', day, 0, {private:true}),
    example('forked', day, 0, {fork:true})
  ];
  const data = repositoriesForProfile(inputs, {usuario:'BAZZUKA-ROOT',ocultar:[]});
  assert.equal(data.publicRepos.length, 4);
  assert.deepEqual(data.showcased.map(x=>x.name), ['newest-real','old']);
});

test('data de rodízio é segunda-feira UTC', () => {
  assert.equal(mondayUtc('2026-11-16T09:00:00Z'),'2026-11-16');
  assert.equal(mondayUtc('2026-11-22T23:00:00Z'),'2026-11-16');
  assert.equal(mondayUtc('2026-11-23T09:00:00Z'),'2026-11-23');
});

test('rodízio mantém a seleção dentro da semana e muda na semana seguinte', () => {
  const repos=Array.from({length:25},(_,i)=>example('repo-'+i,day));
  const select=date=>weeklySelection(repos,8,date).map(x=>x.name);
  assert.deepEqual(select('2026-11-16'),select('2026-11-22'));
  assert.notDeepEqual(select('2026-11-16'),select('2026-11-23'));
  assert.equal(new Set(select('2026-11-16')).size,8);
});

test('não inventa estrelas', () => {
  const r=[example('a',day,0),example('b',day,3),example('c',day,1)];
  assert.deepEqual(rankByStars(r,5).map(x=>x.name),['b','c']);
  assert.equal(rankByStars([r[0]],8).length,0);
});

test('downloads são contagens reais de assets Release', () => {
  const r=[example('a',day),example('b',day),example('c',day)];
  const map=new Map([['a',0],['b',25],['c',5]]);
  assert.deepEqual(rankByDownloads(r,map,2).map(x=>x.name),['b','c']);
  assert.deepEqual(rankByDownloads(r,new Map(),2),[]);
});

test('três categorias destacam sem duplicar repositório', () => {
  const repos=Array.from({length:20},(_,i)=>example('repo-'+i,
    '2026-11-0'+(i%8+1)+'T10:00:00Z',i===4?10:0));
  const results=selectHighlights(repos,new Map([['repo-6',90]]),
     new Date('2026-11-16T14:00:00Z'),{estrelas:2,downloads:2,rotacao:6});
  const ids=[...results.stars,...results.downloaded,...results.rotating].map(x=>x.name);
  assert.equal(ids.length,8);
  assert.equal(new Set(ids).size,8);
  assert.equal(results.stars[0].name,'repo-4');
  assert.equal(results.downloaded[0].name,'repo-6');
});

test('stack extraída do HTML e não suposta', () => {
  const html='<div class="skill-name">PHP</div><div class="skill-name">C++ / ESP32</div>' +
    '<div class="skill-name">Bots &amp; IA</div><div class="skill-name">PHP</div>';
  assert.deepEqual(parsePortfolioStack(html),['PHP','C++ / ESP32','Bots & IA']);
  assert.throws(()=>parsePortfolioStack('<html></html>'),/stack não foi encontrada/);
});

test('linguagens refletem bytes e incluem categoria Outras', () => {
  const counts=summarizeLanguages([{Python:70,JavaScript:20},{Python:10,HTML:10}]);
  assert.deepEqual(counts,{Python:80,JavaScript:20,HTML:10});
  const perc=languagePercentages(counts,2);
  assert.equal(perc.total,110);
  assert.equal(perc.rows[0].name,'Python');
  assert.equal(perc.rows.at(-1).name,'Outras');
  assert.ok(Math.abs(perc.rows.reduce((s,x)=>s+x.percent,0)-100)<0.00001);
});

test('sequência usa contribuições oficiais e tolera dia ainda não fechado', () => {
  const weeks=[{contributionDays:[
    {date:'2026-11-12',contributionCount:1},
    {date:'2026-11-13',contributionCount:2},
    {date:'2026-11-14',contributionCount:0},
    {date:'2026-11-15',contributionCount:2},
    {date:'2026-11-16',contributionCount:0}
  ]}];
  const stats=streakMetrics(weeks,'2026-11-16');
  assert.equal(stats.current,1);
  assert.equal(stats.longest,2);
  assert.equal(stats.total,5);
});

test('metadados textuais não podem quebrar tabela Markdown', () => {
  assert.equal(safeDescription('teste| com \n linha'), 'teste\\| com linha');
});
