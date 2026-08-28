/*
 * Guarda de clases: comprueba que toda clase de utilidad escrita en el código
 * existe realmente en el CSS compilado.
 *
 * Nació de un fallo real: `shadow-modal` y `py-0.2` se usaban en siete sitios
 * sin estar definidas en ninguno. Tailwind no avisa —una clase que no existe
 * simplemente no genera CSS—, así que el estilo se perdía en silencio.
 *
 * Uso: node scripts/check-classes.mjs <ruta-al-css-compilado>
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const cssPath = process.argv[2];
if (!cssPath) {
  console.error('Uso: node scripts/check-classes.mjs <ruta-al-css-compilado>');
  process.exit(2);
}
const css = readFileSync(cssPath, 'utf8');

/** Familias de utilidades que nos interesa vigilar (las de color y forma). */
const PREFIXES = ['shadow', 'rounded', 'text', 'bg', 'border', 'ring', 'fill', 'stroke', 'from', 'to', 'via', 'divide', 'outline', 'decoration'];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (['.ts', '.tsx'].includes(extname(p))) out.push(p);
  }
  return out;
}

/**
 * Tailwind escapa el nombre de la clase para formar el selector: `hover:x` pasa
 * a `.hover\:x` y `bg-acc/40` a `.bg-acc\/40`. Hay que buscar el selector
 * completo, con variantes incluidas: la clase base a secas no llega a existir.
 */
function selectorOf(cls) {
  return '.' + cls.replace(/[.:/[\]()#,%!+*~>^$&|?{}'"\\@]/g, (ch) => '\\' + ch);
}

const used = new Map(); // clase completa -> [ficheros]
for (const file of walk('src')) {
  const src = readFileSync(file, 'utf8');
  // Solo literales de cadena: evita arrastrar identificadores del código.
  for (const m of src.matchAll(/['"`]([^'"`\n]{2,400})['"`]/g)) {
    for (const raw of m[1].split(/\s+/)) {
      const cls = raw.replace(/^!/, '');
      if (!cls || cls.includes('${')) continue;
      // La utilidad base es lo que queda tras las variantes (`sm:hover:bg-x`).
      const base = cls.slice(cls.lastIndexOf(':') + 1).replace(/^-/, '');
      const dash = base.indexOf('-');
      if (dash < 1) continue; // exige prefijo + guion: descarta palabras sueltas de prosa
      if (!PREFIXES.includes(base.slice(0, dash))) continue;
      if (base.includes('[')) continue; // los valores arbitrarios siempre se generan
      if (!/^[a-zA-Z0-9:/._-]+$/.test(cls)) continue;
      if (!used.has(cls)) used.set(cls, []);
      if (!used.get(cls).includes(file)) used.get(cls).push(file);
    }
  }
}

const missing = [];
for (const [cls, files] of used) {
  const sel = selectorOf(cls);
  // El selector va seguido de `{`, `,`, `:` (pseudo), espacio o `>`.
  if (!css.includes(sel + '{') && !css.includes(sel + ',') && !css.includes(sel + ' ') && !css.includes(sel + ':') && !css.includes(sel + '>')) {
    missing.push({ cls, files });
  }
}

if (missing.length) {
  console.error(`\n✖ ${missing.length} clase(s) usadas que NO generan CSS:\n`);
  for (const { cls, files } of missing) console.error(`  ${cls}\n      ${files.join('\n      ')}`);
  console.error('\nO están mal escritas, o falta definirlas en tailwind.config.js / index.css.\n');
  process.exit(1);
}
console.log(`✔ ${used.size} clases verificadas contra el CSS compilado; ninguna huérfana.`);
