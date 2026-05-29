// build-standalone.js — собирает единый автономный pm-assistant-standalone.html:
// инлайнит style.css и объединяет storage.js + agent.js + app.js в один
// не-модульный <script>, чтобы файл работал при открытии двойным кликом (file://).
const fs = require('fs');

const css = fs.readFileSync('style.css', 'utf8');
const storageSrc = fs.readFileSync('storage.js', 'utf8');
const agentSrc = fs.readFileSync('agent.js', 'utf8');
const syncSrc = fs.readFileSync('sync.js', 'utf8');
const appSrc = fs.readFileSync('app.js', 'utf8');
let html = fs.readFileSync('index.html', 'utf8');

// Собрать имена экспортов модуля (function/const, в т.ч. async).
function collectExports(src) {
  const names = new Set();
  const re = /export\s+(?:async\s+)?(?:function|const)\s+(\w+)/g;
  let m;
  while ((m = re.exec(src))) names.add(m[1]);
  return [...names];
}
// Убрать ключевое слово export, оставив объявления.
const stripExport = (src) => src.replace(/export\s+/g, '');
// Убрать строки import.
const stripImports = (src) => src.replace(/^\s*import\s.*$/gm, '');

// storage.js → const store = (function(){ ...; return { exports } })();
const storeExports = collectExports(storageSrc);
const storeIIFE =
  `const store = (function () {\n${stripExport(storageSrc)}\n` +
  `return { ${storeExports.join(', ')} };\n})();`;

// agent.js → const agent = (function(){ ...; return { exports } })();
const agentExports = collectExports(agentSrc);
const agentIIFE =
  `const agent = (function () {\n${stripExport(agentSrc)}\n` +
  `return { ${agentExports.join(', ')} };\n})();\n` +
  `const { ${agentExports.join(', ')} } = agent;`;

// app.js: убрать import-ы и export-ы (оно само вызывает init()).
const appCode = stripExport(stripImports(appSrc));

// sync.js → const sync = (function(){ ...; return { exports } })();
const syncExports = collectExports(syncSrc);
const syncIIFE =
  `const sync = (function () {\n${stripExport(syncSrc)}\n` +
  `return { ${syncExports.join(', ')} };\n})();`;

const bundle = `${storeIIFE}\n\n${agentIIFE}\n\n${syncIIFE}\n\n${appCode}`;

// Встроить CSS и заменить внешние скрипты на один инлайновый.
// Замены передаём функциями: иначе String.replace трактует спецсимволы
// ($$, $&, …) в строке-замене (из-за этого, например, $$ → $).
html = html
  .replace(/<link rel="stylesheet" href="style\.css"\s*\/?>/, () => `<style>\n${css}\n</style>`)
  .replace(/<script src="config\.js"><\/script>\s*/, '')
  .replace(/<script type="module" src="app\.js"><\/script>/, () => `<script>\n${bundle}\n</script>`);

fs.writeFileSync('pm-assistant-standalone.html', html);
console.log('Готово: pm-assistant-standalone.html', `(${(html.length / 1024).toFixed(1)} КБ)`);
