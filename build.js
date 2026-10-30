/* Shrinks index.html for deploy: comments and whitespace go, names stay. Nothing is renamed or rewritten, so the
   minified page behaves exactly like the source. Usage: node build.js <out file> (defaults to dist/index.html). */
const fs = require('fs'), path = require('path'), esbuild = require('esbuild');

const js = code => esbuild.transformSync(code, { minifyWhitespace: true, legalComments: 'none', charset: 'utf8', target: 'esnext' }).code;
const css = code => esbuild.transformSync(code, { loader: 'css', minifyWhitespace: true, legalComments: 'none', charset: 'utf8' }).code;

function minify(html) {
  /* Scripts and styles go through esbuild. Pre and textarea keep their whitespace. Everything else loses comments and indentation. */
  const parts = html.split(/(<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<pre\b[^>]*>[\s\S]*?<\/pre>|<textarea\b[^>]*>[\s\S]*?<\/textarea>)/i);
  return parts.map((p, i) => {
    if (i % 2 === 0) return p.replace(/<!--[\s\S]*?-->/g, '').replace(/^[ \t]+/gm, '').replace(/\n{2,}/g, '\n');
    const m = /^(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2>)$/i.exec(p);
    if (!m) return p;
    if (m[2].toLowerCase() === 'style') return m[1] + css(m[3]) + m[4];
    return /\bsrc=|type="(?!module|text\/javascript)/i.test(m[1]) ? p : m[1] + js(m[3]) + m[4];
  }).join('');
}

module.exports = { minify };
if (require.main === module) {
  const out = path.resolve(process.argv[2] || path.join(__dirname, 'dist', 'index.html'));
  const src = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'), min = minify(src);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, min);
  console.log('index.html ' + (src.length / 1024).toFixed(0) + ' KB -> ' + (min.length / 1024).toFixed(0) + ' KB');
}
