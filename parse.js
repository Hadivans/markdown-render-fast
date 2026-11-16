// parse.js — a fast CommonMark 0.31.2 + GFM 0.29 renderer.
// parse(markdown) returns exactly the HTML marked 18.1.3 produces with its
// default options (GFM on, breaks off). Clean-room implementation, written
// from the specs and verified against marked's practice set. Dependency-free,
// and pure per call: parse() keeps nothing between calls.

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const refs = new Map();
  const blocks = buildBlocks(lines, refs);
  fixHtmlTrailingNewlines(blocks, lines, src.endsWith('\n'));
  const out = [];
  renderBlocks(blocks, refs, out);
  return out.join('');
}

// An HTML block's text ends with '\n'. marked drops that newline when the
// line right after the block is blank, or (for type 6/7 blocks) when the
// block is not the document's last leaf, or when the block is the last leaf
// but the input itself had no trailing newline (the '\n' is synthetic).
function fixHtmlTrailingNewlines(children, lines, inputEndsWithNL) {
  const leaves = [];
  (function walk(nodes) {
    for (const n of nodes) {
      if (n.kids) walk(n.kids);
      else leaves.push(n);
    }
  })(children);
  const last = leaves.length ? leaves[leaves.length - 1] : null;
  for (const n of leaves) {
    if (n.kind !== 'html' || !n.text.endsWith('\n')) continue;
    const next = lines[n.endLine + 1];
    const nextBlank = next !== undefined && blankLine(next);
    if (nextBlank || (n.htmlType >= 6 && n !== last)) n.text = n.text.slice(0, -1);
    else if (n === last && n.endLine === lines.length - 1 && !inputEndsWithNL) n.text = n.text.slice(0, -1);
  }
}

// --- character classification (char codes; ASCII fast paths) ---

function isSpaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
}
function isDigitCode(c) {
  return c >= 48 && c <= 57;
}
function isAlphaCode(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isAlnumCode(c) {
  return isAlphaCode(c) || isDigitCode(c);
}
function isAsciiPunctCode(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
const uniPunctRe = /[\p{P}\p{S}]/u;
function isPunctChar(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return isAsciiPunctCode(c);
  return uniPunctRe.test(ch);
}
function isWsChar(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return isSpaceCode(c);
  return /\s/.test(ch);
}

// --- numeric character references ---
// marked decodes &#35; / &#x22; in inline text and leaves named references
// (&copy;) alone. Valid forms: &# + 1-7 decimal digits, or &#[Xx] + 1-6
// hex digits, then ';'. Code points 0, surrogates and > 0x10FFFF become U+FFFD.

function decodeNumRef(s, i) {
  let j = i + 2;
  let hex = false;
  if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) {
    hex = true;
    j++;
  }
  const start = j;
  let cp = 0;
  let digits = 0;
  if (hex) {
    while (j < s.length) {
      const c = s.charCodeAt(j);
      let v = -1;
      if (c >= 48 && c <= 57) v = c - 48;
      else if (c >= 97 && c <= 102) v = c - 87;
      else if (c >= 65 && c <= 70) v = c - 55;
      else break;
      cp = cp * 16 + v;
      j++;
      digits++;
      if (digits > 6) return null;
    }
  } else {
    while (j < s.length && digits < 8) {
      const c = s.charCodeAt(j);
      if (c < 48 || c > 57) break;
      cp = cp * 10 + (c - 48);
      j++;
      digits++;
    }
    if (digits > 7) return null;
  }
  if (digits === 0) return null;
  if (j >= s.length || s.charCodeAt(j) !== 59) return null;
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
  return [String.fromCodePoint(cp), j + 1];
}

// Does an entity-like reference begin at s[i]? Used by the text escaper:
// `&` is left alone when it starts &#digits; / &#x hex; / &word;.
function entityRefAt(s, i) {
  let j = i + 1;
  if (j < s.length && s.charCodeAt(j) === 35) {
    j++;
    if (j < s.length && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) {
      j++;
      let n = 0;
      while (j < s.length && n < 7) {
        const c = s.charCodeAt(j);
        if (!isDigitCode(c) && !(c >= 97 && c <= 102) && !(c >= 65 && c <= 70)) break;
        j++;
        n++;
      }
      return n >= 1 && n <= 6 && j < s.length && s.charCodeAt(j) === 59;
    }
    let n = 0;
    while (j < s.length && n < 8) {
      const c = s.charCodeAt(j);
      if (!isDigitCode(c)) break;
      j++;
      n++;
    }
    return n >= 1 && n <= 7 && j < s.length && s.charCodeAt(j) === 59;
  }
  let n = 0;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (!(isAlnumCode(c) || c === 95)) break;
    j++;
    n++;
    if (n > 32) return false;
  }
  return n >= 1 && j < s.length && s.charCodeAt(j) === 59;
}

// --- HTML escaping, exactly like marked's escape() ---
// escText: escape & < > " ' but leave `&` alone when it starts an
// entity-like reference. escCode: escape every & < > " '.

function escText(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) {
      if (!entityRefAt(s, i)) rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

function escCode(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// --- link destination / title / label parsing ---
// A destination is <...> (no line endings, backslash escapes resolved) or a
// run of non-space chars with balanced parens and backslash escapes.

function parseDest(s, i) {
  const n = s.length;
  if (i < n && s.charCodeAt(i) === 60) {
    let j = i + 1;
    let out = '';
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 62) return [out, j + 1];
      if (c === 60 || c === 10) return null;
      if (c === 92 && j + 1 < n && isAsciiPunctCode(s.charCodeAt(j + 1))) {
        out += s[j + 1];
        j += 2;
      } else {
        out += s[j];
        j++;
      }
    }
    return null;
  }
  let j = i;
  let out = '';
  let depth = 0;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 10 || c === 9) break;
    if (c === 40) {
      depth++;
      out += '(';
      j++;
    } else if (c === 41) {
      if (depth === 0) break;
      depth--;
      out += ')';
      j++;
    } else if (c === 92 && j + 1 < n && isAsciiPunctCode(s.charCodeAt(j + 1))) {
      out += s[j + 1];
      j += 2;
    } else if (c < 32) {
      return null;
    } else {
      out += s[j];
      j++;
    }
  }
  if (j === i) return null;
  return [out, j];
}

// A title starts with ", ' or ( and ends with the matching closer. It may
// span lines, but a blank line ends it.
function parseTitle(s, i) {
  const n = s.length;
  if (i >= n) return null;
  const c = s.charCodeAt(i);
  let close;
  if (c === 34) close = 34;
  else if (c === 39) close = 39;
  else if (c === 40) close = 41;
  else return null;
  let j = i + 1;
  let out = '';
  while (j < n) {
    const ch = s.charCodeAt(j);
    if (ch === close) return [out, j + 1];
    if (ch === 10) {
      if (j + 1 < n && s.charCodeAt(j + 1) === 10) return null;
      out += '\n';
      j++;
    } else if (ch === 92 && j + 1 < n && isAsciiPunctCode(s.charCodeAt(j + 1))) {
      out += s[j + 1];
      j += 2;
    } else if (ch === 92 && j + 1 < n && s.charCodeAt(j + 1) === 10) {
      out += '\n';
      j += 2;
    } else {
      out += s[j];
      j++;
    }
  }
  return null;
}

function skipInlineWs(s, i) {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10) i++;
    else break;
  }
  return i;
}

// Normalize a link label: collapse whitespace, trim, case-fold (with the
// multi-character folds: sharp S -> ss, common ligatures).
function normalizeLabel(label) {
  const folded = label
    .replace(/\u00DF/g, 'ss')
    .replace(/\u1E9E/g, 'ss')
    .replace(/\uFB00/g, 'fi')
    .replace(/\uFB01/g, 'fl')
    .replace(/\uFB02/g, 'ff')
    .replace(/\uFB03/g, 'ffi')
    .replace(/\uFB04/g, 'ffl')
    .replace(/\uFB05/g, 'st')
    .replace(/\uFB06/g, 'st');
  return folded.replace(/\s+/g, ' ').trim().toLowerCase();
}

// Parse a link label at s[i] === '['. Returns [label, end] (end just past
// ']') or null. Handles balanced brackets and multi-line labels. Backslash
// escapes stay raw here: label matching uses the raw text.
function parseLabel(s, i) {
  const n = s.length;
  let j = i + 1;
  let depth = 0;
  let out = '';
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 10) {
      let k = j + 1;
      while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) k++;
      if (k >= n || s.charCodeAt(k) === 10) return null;
      out += '\n';
      j++;
      continue;
    }
    if (c === 92 && j + 1 < n) {
      out += s[j] + s[j + 1];
      j += 2;
      continue;
    }
    if (c === 91) {
      depth++;
      out += '[';
      j++;
    } else if (c === 93) {
      if (depth === 0) return [out, j + 1];
      depth--;
      out += ']';
      j++;
    } else {
      out += s[j];
      j++;
    }
  }
  return null;
}

// Parse an inline link's (destination title) at s[i] === '('.
// Returns [href, title, end] (end just past ')') or null.
function parseInlineLink(s, i) {
  const n = s.length;
  let j = skipInlineWs(s, i + 1);
  if (j >= n) return null;
  if (s.charCodeAt(j) === 41) return ['', null, j + 1];
  const dest = parseDest(s, j);
  if (!dest) return null;
  j = skipInlineWs(s, dest[1]);
  if (j >= n) return null;
  if (s.charCodeAt(j) === 41) return [dest[0], null, j + 1];
  const title = parseTitle(s, j);
  if (!title) return null;
  j = skipInlineWs(s, title[1]);
  if (j >= n || s.charCodeAt(j) !== 41) return null;
  return [dest[0], title[0], j + 1];
}

// --- URL cleaning ---
// Safe URL characters (cmark clean_url): alphanumerics plus ; / ? : @ & = + $
// , _ . ! ~ * ' ( ) - # %. Everything else becomes %XX (UTF-8 for
// non-ASCII); an existing %XX hex sequence is left alone.

const URL_SAFE = new Uint8Array(128);
for (let i = 48; i <= 57; i++) URL_SAFE[i] = 1;
for (let i = 65; i <= 90; i++) URL_SAFE[i] = 1;
for (let i = 97; i <= 122; i++) URL_SAFE[i] = 1;
for (const ch of ';/?:@&=+$,_.!~*\'()-#%') URL_SAFE[ch.charCodeAt(0)] = 1;
const HEXD = '0123456789ABCDEF';
function isHex(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}
function utf8Pct(cp) {
  const bytes = [];
  if (cp < 0x800) {
    bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
  } else if (cp < 0x10000) {
    bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  } else {
    bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  let s = '';
  for (const b of bytes) s += '%' + HEXD[b >> 4] + HEXD[b & 15];
  return s;
}
function cleanUrl(href) {
  let needs = false;
  for (let i = 0; i < href.length; i++) {
    const c = href.charCodeAt(i);
    if (c >= 128) {
      needs = true;
      break;
    }
    if (URL_SAFE[c]) continue;
    if (c === 37 && i + 2 < href.length && isHex(href.charCodeAt(i + 1)) && isHex(href.charCodeAt(i + 2))) {
      i += 2;
      continue;
    }
    needs = true;
    break;
  }
  if (!needs) return href;
  let out = '';
  for (let i = 0; i < href.length; i++) {
    const c = href.charCodeAt(i);
    if (c < 128) {
      if (URL_SAFE[c]) {
        out += href[i];
      } else if (c === 37 && i + 2 < href.length && isHex(href.charCodeAt(i + 1)) && isHex(href.charCodeAt(i + 2))) {
        out += href.slice(i, i + 3);
        i += 2;
      } else {
        out += '%' + HEXD[c >> 4] + HEXD[c & 15];
      }
    } else {
      let cp = c;
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < href.length) {
        const lo = href.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          cp = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
          i++;
        }
      }
      out += utf8Pct(cp);
    }
  }
  return out;
}

// --- autolinks: <scheme:...> or <email> ---

function tryAutolink(s, i) {
  const n = s.length;
  let j = i + 1;
  let k = j;
  while (k < n) {
    const c = s.charCodeAt(k);
    if (isAlnumCode(c) || c === 43 || c === 46 || c === 45) k++;
    else break;
  }
  if (k - j >= 2 && k - j <= 32 && k < n && s.charCodeAt(k) === 58) {
    if (!isAlphaCode(s.charCodeAt(j))) return null;
    let e = k + 1;
    while (e < n) {
      const c = s.charCodeAt(e);
      if (c === 62) {
        const dest = s.slice(j, e);
        if (dest.length === 0) return null;
        return [['l', cleanUrl(dest), null, [['t', dest]]], e + 1];
      }
      if (c === 32 || c === 60 || c === 10) return null;
      e++;
    }
    return null;
  }
  const m = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/.exec(s.slice(i + 1));
  if (m) {
    const end = i + 1 + m[0].length;
    if (end < n && s.charCodeAt(end) === 62) {
      const dest = m[0];
      return [['l', 'mailto:' + cleanUrl(dest), null, [['t', dest]]], end + 1];
    }
  }
  return null;
}

// --- raw inline HTML: comment, PI, declaration, CDATA, open/close tag ---

function tryInlineHtml(s, i) {
  const n = s.length;
  if (i + 1 >= n || s.charCodeAt(i + 1) === 32) return null;
  if (s.startsWith('<!--', i)) {
    if (i + 4 < n && s.charCodeAt(i + 4) === 62) return [s.slice(i, i + 5), i + 5];
    if (i + 5 < n && s.charCodeAt(i + 4) === 45 && s.charCodeAt(i + 5) === 62) return [s.slice(i, i + 6), i + 6];
    let j = i + 4;
    while (j < n) {
      if (s.startsWith('-->', j)) return [s.slice(i, j + 3), j + 3];
      if (s.startsWith('--!>', j)) return [s.slice(i, j + 4), j + 4];
      j++;
    }
    return null;
  }
  if (s.startsWith('<![CDATA[', i)) {
    const j = s.indexOf(']]>', i + 9);
    if (j < 0) return null;
    return [s.slice(i, j + 3), j + 3];
  }
  if (s.startsWith('<?', i)) {
    const j = s.indexOf('?>', i + 2);
    if (j < 0) return null;
    return [s.slice(i, j + 2), j + 2];
  }
  if (s.startsWith('<!', i)) {
    if (i + 2 < n && isAlphaCode(s.charCodeAt(i + 2))) {
      let j = i + 2;
      while (j < n && s.charCodeAt(j) !== 62) j++;
      if (j >= n) return null;
      return [s.slice(i, j + 1), j + 1];
    }
    return null;
  }
  let j = i + 1;
  let closing = false;
  if (s.charCodeAt(j) === 47) {
    closing = true;
    j++;
  }
  if (j >= n || !isAlphaCode(s.charCodeAt(j))) return null;
  while (j < n && (isAlnumCode(s.charCodeAt(j)) || s.charCodeAt(j) === 45)) j++;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 62) return [s.slice(i, j + 1), j + 1];
    if (c === 47 && j + 1 < n && s.charCodeAt(j + 1) === 62) return [s.slice(i, j + 2), j + 2];
    if (c !== 32 && c !== 9 && c !== 10) return null;
    let k = j;
    while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
    if (k >= n) return null;
    const nc = s.charCodeAt(k);
    if (nc === 62) return [s.slice(i, k + 1), k + 1];
    if (nc === 47 && k + 1 < n && s.charCodeAt(k + 1) === 62) return [s.slice(i, k + 2), k + 2];
    if (closing) return null;
    if (!(isAlphaCode(nc) || nc === 95 || nc === 58)) return null;
    j = k;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (isAlnumCode(d) || d === 95 || d === 58 || d === 46 || d === 45) j++;
      else break;
    }
    let v = j;
    while (v < n && (s.charCodeAt(v) === 32 || s.charCodeAt(v) === 9 || s.charCodeAt(v) === 10)) v++;
    if (v < n && s.charCodeAt(v) === 61) {
      v++;
      while (v < n && (s.charCodeAt(v) === 32 || s.charCodeAt(v) === 9 || s.charCodeAt(v) === 10)) v++;
      if (v >= n) return null;
      const q = s.charCodeAt(v);
      if (q === 34 || q === 39) {
        const endq = s.indexOf(String.fromCharCode(q), v + 1);
        if (endq < 0) return null;
        j = endq + 1;
      } else {
        let e = v;
        while (e < n) {
          const d = s.charCodeAt(e);
          if (d === 32 || d === 9 || d === 10 || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
          e++;
        }
        if (e === v) return null;
        j = e;
      }
    }
  }
  return null;
}

// --- GFM extended autolinks: www. / http(s):// / email at a word boundary ---

function tryExtAutolink(s, i, prev) {
  const n = s.length;
  if (prev !== -1 && isAlnumCode(prev)) return null;
  if (s.startsWith('www.', i)) {
    const m = /^www\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/.exec(s.slice(i));
    if (!m) return null;
    let end = i + m[0].length;
    end = extendUrl(s, end);
    const dest = s.slice(i, end);
    return [['l', 'http://' + cleanUrl(dest), null, [['t', dest]]], end];
  }
  const low7 = s.slice(i, i + 7).toLowerCase();
  const low8 = s.slice(i, i + 8).toLowerCase();
  if (low7 === 'http://' || low8 === 'https://') {
    const m = /^https?:\/\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*(?::\d+)?/i.exec(s.slice(i));
    if (!m) return null;
    let end = i + m[0].length;
    end = extendUrl(s, end);
    const dest = s.slice(i, end);
    return [['l', cleanUrl(dest), null, [['t', dest]]], end];
  }
  {
    const sm = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.exec(s.slice(i));
    if (sm && low7 !== 'http://' && low8 !== 'https://') {
      const after = i + sm[0].length;
      const em = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/.exec(s.slice(after));
      if (em) {
        let end = after + em[0].length;
        if (end < n && (s.charCodeAt(end) === 45 || s.charCodeAt(end) === 95)) return null;
        if (end < n && s.charCodeAt(end) === 47) {
          let q = end + 1;
          while (q < n) {
            const c = s.charCodeAt(q);
            if (isAlnumCode(c) || c === 45 || c === 46 || c === 95 || c === 126 || c === 64 || c === 58 || c === 43 || c === 61 || c === 38 || c === 37 || c === 59 || c === 44) q++;
            else break;
          }
          if (q > end + 1) end = q;
        }
        const dest = s.slice(i, end);
        return [['l', cleanUrl(dest), null, [['t', dest]]], end];
      }
    }
  }
  if (isAlnumCode(s.charCodeAt(i)) || s.charCodeAt(i) === 95 || s.charCodeAt(i) === 46) {
    const m = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/.exec(s.slice(i));
    if (!m) return null;
    let end = i + m[0].length;
    if (end < n && (s.charCodeAt(end) === 45 || s.charCodeAt(end) === 95)) return null;
    while (end > i && /[?!.,:;*_~]/.test(s[end - 1])) end--;
    const dest = s.slice(i, end);
    if (dest.length === 0) return null;
    return [['l', 'mailto:' + cleanUrl(dest), null, [['t', dest]]], end];
  }
  return null;
}

// Extend a URL with its path/query/fragment, trimming trailing punctuation
// per GFM rules. A trailing `)` is kept only while it balances an earlier
// `(`. A trailing `&word;` entity-like suffix is excluded first.
function extendUrl(s, end) {
  const n = s.length;
  let j = end;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 60 || c === 10 || c === 93) break;
    j++;
  }
  const tail = s.slice(end, j);
  const em = /&[A-Za-z0-9]+;$/.exec(tail);
  if (em) j -= em[0].length;
  while (j > end && /[?!.,:;*_~'"'\]}]/.test(s[j - 1])) j--;
  let opens = 0, closes = 0;
  for (let k = end; k < j; k++) {
    if (s.charCodeAt(k) === 40) opens++;
    else if (s.charCodeAt(k) === 41) closes++;
  }
  while (j > end && s.charCodeAt(j - 1) === 41 && closes > opens) {
    j--;
    closes--;
  }
  return j;
}

// --- inline tokenizer ---
// Node kinds (small arrays): ['t', text] text (escaped at render),
// ['c', code] code span, ['h', html] raw HTML, ['b'] hard break,
// ['d', ch, n, canOpen, canClose] emphasis delimiter run,
// ['l', href, title, children] link, ['i', src, alt, title] image,
// ['[', isImage] bracket opener (renders as '[' / '![' when no link forms).

function charBefore(s, i) {
  if (i <= 0) return null;
  const c = s.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) {
    const hi = s.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return s.slice(i - 2, i);
  }
  return s[i - 1];
}
function charAfter(s, i) {
  if (i >= s.length) return null;
  const c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const lo = s.charCodeAt(i + 1);
    if (lo >= 0xdc00 && lo <= 0xdfff) return s.slice(i, i + 2);
  }
  return s[i];
}

function tokenizeInline(src, refs) {
  const n = src.length;
  const nodes = [];
  const brackets = [];
  let cur = '';
  const flush = () => {
    if (cur !== '') {
      nodes.push(['t', cur]);
      cur = '';
    }
  };
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    // newline: soft break, or hard break after 2+ trailing spaces
    if (c === 10) {
      let k = cur.length;
      while (k > 0 && cur.charCodeAt(k - 1) === 32) k--;
      if (cur.length - k >= 2) {
        cur = cur.slice(0, k);
        flush();
        nodes.push(['b']);
        i++;
        while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
        continue;
      }
      cur += '\n';
      i++;
      continue;
    }
    // backslash escape (or hard break before a newline)
    if (c === 92) {
      if (i + 1 < n) {
        const d = src.charCodeAt(i + 1);
        if (d === 10) {
          flush();
          nodes.push(['b']);
          i += 2;
          while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
          continue;
        }
        if (isAsciiPunctCode(d)) {
          cur += d === 38 ? '&amp;' : src[i + 1];
          i += 2;
          continue;
        }
      }
      cur += '\\';
      i++;
      continue;
    }
    // code span
    if (c === 96) {
      let j = i;
      while (j < n && src.charCodeAt(j) === 96) j++;
      const run = j - i;
      let k = j;
      let found = -1;
      while (k < n) {
        if (src.charCodeAt(k) === 96) {
          let e = k;
          while (e < n && src.charCodeAt(e) === 96) e++;
          if (e - k === run) {
            found = k;
            break;
          }
          k = e;
        } else k++;
      }
      if (found >= 0) {
        let content = src.slice(j, found).replace(/\n/g, ' ');
        if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && content.trim() !== '') {
          content = content.slice(1, -1);
        }
        flush();
        nodes.push(['c', content]);
        i = found + run;
        continue;
      }
      cur += src.slice(i, j);
      i = j;
      continue;
    }
    // emphasis / strikethrough delimiter runs
    if (c === 42 || c === 95 || c === 126) {
      let j = i;
      while (j < n && src.charCodeAt(j) === c) j++;
      const run = j - i;
      if (c === 126 && run > 2) {
        cur += src.slice(i, j);
        i = j;
        continue;
      }
      const before = charBefore(src, i);
      const after = charAfter(src, j);
      const beforeIsSpace = before === null ? true : isWsChar(before);
      const afterIsSpace = after === null ? true : isWsChar(after);
      const beforeIsPunct = before === null ? false : isPunctChar(before);
      const afterIsPunct = after === null ? false : isPunctChar(after);
      const leftFlanking = !afterIsSpace && (!afterIsPunct || beforeIsSpace || beforeIsPunct);
      const rightFlanking = !beforeIsSpace && (!beforeIsPunct || afterIsSpace || afterIsPunct);
      let canOpen, canClose;
      if (c === 95) {
        canOpen = leftFlanking && (!rightFlanking || beforeIsPunct);
        canClose = rightFlanking && (!leftFlanking || afterIsPunct);
      } else {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      }
      flush();
      nodes.push(['d', c === 42 ? '*' : c === 95 ? '_' : '~', run, canOpen, canClose]);
      i = j;
      continue;
    }
    // bracket openers: [ and ![
    if (c === 91 || (c === 33 && i + 1 < n && src.charCodeAt(i + 1) === 91)) {
      const isImage = c === 33;
      flush();
      nodes.push(['[', isImage]);
      brackets.push({ idx: nodes.length - 1, isImage, srcIdx: i + (isImage ? 2 : 1) });
      i += isImage ? 2 : 1;
      continue;
    }
    // bracket closer: try to form a link or image
    if (c === 93) {
      if (brackets.length > 0) {
        const bi = brackets.length - 1;
        const opener = brackets[bi];
        let j = i + 1;
        let href = null;
        let title = null;
        let end = -1;
        if (j < n && src.charCodeAt(j) === 40) {
          const il = parseInlineLink(src, j);
          if (il) {
            href = il[0];
            title = il[1];
            end = il[2];
          } else {
            const labelText = src.slice(opener.srcIdx, i);
            const ref = refs.get(normalizeLabel(labelText));
            if (ref) {
              href = ref.href;
              title = ref.title;
              end = j;
            }
          }
        } else if (j + 1 < n && src.charCodeAt(j) === 91 && src.charCodeAt(j + 1) === 93) {
          const labelText = src.slice(opener.srcIdx, i);
          const ref = refs.get(normalizeLabel(labelText));
          if (ref) {
            href = ref.href;
            title = ref.title;
            end = j + 2;
          }
        } else if (j < n && src.charCodeAt(j) === 91) {
          const lab = parseLabel(src, j);
          if (lab) {
            const ref = refs.get(normalizeLabel(lab[0]));
            if (ref) {
              href = ref.href;
              title = ref.title;
              end = lab[1];
            }
          }
        } else {
          const labelText = src.slice(opener.srcIdx, i);
          const ref = refs.get(normalizeLabel(labelText));
          if (ref) {
            href = ref.href;
            title = ref.title;
            end = j;
          }
        }
        if (href !== null) {
          flush();
          const children = nodes.splice(opener.idx + 1);
          nodes.splice(opener.idx, 1);
          let node;
          if (opener.isImage) {
            node = ['i', cleanUrl(href), plainText(children), title];
            brackets.splice(bi, 1);
          } else {
            let hasLink = false;
            for (const ch of children) {
              if (ch[0] === 'l') {
                hasLink = true;
                break;
              }
            }
            if (hasLink) {
              nodes.splice(opener.idx, 0, ['[', opener.isImage], ...children);
              brackets.splice(bi, 1);
              cur += ']';
              i++;
              continue;
            }
            node = ['l', cleanUrl(href), title, children];
            brackets.splice(bi);
          }
          nodes.splice(opener.idx, 0, node);
          i = end;
          continue;
        }
        brackets.splice(bi, 1);
      }
      cur += ']';
      i++;
      continue;
    }
    // < : autolink or raw HTML
    if (c === 60) {
      const al = tryAutolink(src, i);
      if (al) {
        flush();
        nodes.push(al[0]);
        i = al[1];
        continue;
      }
      const html = tryInlineHtml(src, i);
      if (html) {
        flush();
        nodes.push(['h', html[0]]);
        i = html[1];
        continue;
      }
      cur += '<';
      i++;
      continue;
    }
    // & : numeric entity decode, else literal
    if (c === 38) {
      if (i + 1 < n && src.charCodeAt(i + 1) === 35) {
        const d = decodeNumRef(src, i);
        if (d) {
          cur += d[0] === '&' ? '&amp;' : d[0];
          i = d[1];
          continue;
        }
      }
      cur += '&';
      i++;
      continue;
    }
    // GFM extended autolinks at a word boundary. A bare URL inside link
    // text [...] is plain text, not an autolink.
    if (brackets.length === 0 && (c === 119 || c === 104 || c === 72 || isAlnumCode(c) || c === 95 || c === 46)) {
      const prev = i === 0 ? -1 : src.charCodeAt(i - 1);
      const atBoundary =
        i === 0 ||
        prev === 32 || prev === 9 || prev === 10 || prev === 42 || prev === 95 || prev === 126 ||
        prev === 40 || prev === 91 || prev === 123 || prev === 34 || prev === 39 || prev === 60;
      if (atBoundary) {
        let tried = false;
        if (c === 119 && src.startsWith('www.', i)) tried = true;
        else if ((c === 104 || c === 72) && (src.slice(i, i + 7).toLowerCase() === 'http://' || src.slice(i, i + 8).toLowerCase() === 'https://')) tried = true;
        else if (isAlnumCode(c) || c === 95 || c === 46) {
          const at = src.indexOf('@', i);
          if (at > i && at - i < 64) {
            let ok = true;
            for (let k = i; k < at; k++) {
              const ch = src.charCodeAt(k);
              if (ch === 32 || ch === 10 || ch === 60 || ch === 91 || ch === 93) {
                ok = false;
                break;
              }
            }
            if (ok) tried = true;
          }
        }
        if (tried) {
          const al = tryExtAutolink(src, i, prev);
          if (al) {
            flush();
            nodes.push(al[0]);
            i = al[1];
            continue;
          }
        }
      }
      cur += src[i];
      i++;
      continue;
    }
    // ordinary character
    cur += src[i];
    i++;
  }
  flush();
  return nodes;
}

// Resolve backslash escapes (backslash + ASCII punct -> punct) in a label.
function resolveEscapes(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 && i + 1 < s.length && isAsciiPunctCode(s.charCodeAt(i + 1))) {
      out += s[i + 1];
      i++;
    } else out += s[i];
  }
  return out;
}

// Plain text of inline nodes (for image alt text).
function plainText(nodes) {
  let out = '';
  for (const node of nodes) {
    switch (node[0]) {
      case 't':
      case 'c':
      case 'h':
        out += node[1];
        break;
      case 'e':
        out += plainText(node[2]);
        break;
      case 'l':
        out += plainText(node[3]);
        break;
      case 'i':
        out += node[2];
        break;
      case '[':
        out += node[1] ? '![' : '[';
        break;
      default:
        break;
    }
  }
  return out;
}

// --- emphasis processing (delimiter-stack algorithm, CommonMark rules) ---

function processEmphasis(nodes) {
  for (const node of nodes) {
    if (node[0] === 'l') processEmphasis(node[3]);
  }
  let delims = collectDelims(nodes);
  if (delims.length === 0) return;
  let ci = 0;
  while (ci < delims.length) {
    const closer = delims[ci];
    if (!closer.close) {
      ci++;
      continue;
    }
    let oi = ci - 1;
    let found = -1;
    while (oi >= 0) {
      const opener = delims[oi];
      if (opener.ch === closer.ch && opener.open) {
        // Rule of 3 (emphasis `*`/`_` only, not `~`): when the total
        // length is a multiple of 3 and the closer can also open, the
        // pair can only match when BOTH delimiters can both open and
        // close. (A closer that cannot open never triggers the rule,
        // e.g. cm-408 `__foo_ bar_`.)
        if (closer.ch !== '~') {
          const bothClose = opener.close && closer.close;
          if ((opener.n + closer.n) % 3 === 0 && closer.open && !bothClose) {
            oi--;
            continue;
          }
        }
        found = oi;
        break;
      }
      oi--;
    }
    if (found === -1) {
      ci++;
      continue;
    }
    const opener = delims[found];
    let use;
    if (closer.ch === '~') {
      use = opener.n >= 2 && closer.n >= 2 ? 2 : 1;
    } else {
      use = opener.n >= 2 && closer.n >= 2 ? 2 : 1;
    }
    const tag = closer.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
    const startIdx = opener.idx;
    const endIdx = closer.idx;
    const inner = nodes.slice(startIdx + 1, endIdx);
    const wrapped = ['e', tag, inner];
    opener.n -= use;
    closer.n -= use;
    const rebuilt = nodes.slice(0, startIdx);
    if (opener.n > 0) rebuilt.push(['d', opener.ch, opener.n, opener.open, opener.close]);
    rebuilt.push(wrapped);
    if (closer.n > 0) rebuilt.push(['d', closer.ch, closer.n, closer.open, closer.close]);
    rebuilt.push(...nodes.slice(endIdx + 1));
    nodes.length = 0;
    nodes.push(...rebuilt);
    delims = collectDelims(nodes);
    ci = 0;
  }
}

function collectDelims(nodes) {
  const out = [];
  for (let idx = 0; idx < nodes.length; idx++) {
    const node = nodes[idx];
    if (node[0] === 'd') out.push({ idx, ch: node[1], n: node[2], open: node[3], close: node[4] });
  }
  return out;
}

// --- inline rendering ---

function renderInline(nodes) {
  let out = '';
  for (const node of nodes) {
    switch (node[0]) {
      case 't':
        out += escText(node[1]);
        break;
      case 'c':
        out += '<code>' + escCode(node[1]) + '</code>';
        break;
      case 'h':
        out += node[1];
        break;
      case 'b':
        out += '<br>';
        break;
      case 'd':
        out += escText(node[1].repeat(node[2]));
        break;
      case 'e':
        out += '<' + node[1] + '>' + renderInline(node[2]) + '</' + node[1] + '>';
        break;
      case 'l':
        out += '<a href="' + escText(node[1]) + '"';
        if (node[2] !== null && node[2] !== undefined) out += ' title="' + escText(node[2]) + '"';
        out += '>' + renderInline(node[3]) + '</a>';
        break;
      case 'i':
        out += '<img src="' + escText(node[1]) + '" alt="' + escText(node[2]) + '"';
        if (node[3] !== null && node[3] !== undefined) out += ' title="' + escText(node[3]) + '"';
        out += '>';
        break;
      case '[':
        out += node[1] ? '![' : '[';
        break;
    }
  }
  return out;
}

// Parse inline content (paragraph text, heading text, table cell) to HTML.
function inline(src, refs) {
  if (src === '') return '';
  const nodes = tokenizeInline(src, refs);
  processEmphasis(nodes);
  return renderInline(nodes);
}

// --- block parsing: line cursor (tracks absolute column for tab math) ---

function makeCursor(line) {
  return { line, pos: 0, col: 0, pend: 0 };
}
function curPeek(c) {
  if (c.pend > 0) return 32;
  if (c.pos >= c.line.length) return -1;
  return c.line.charCodeAt(c.pos);
}
function curAdvance(c) {
  if (c.pend > 0) {
    c.pend--;
    c.col++;
  } else {
    c.pos++;
    c.col++;
  }
}
function curRest(c) {
  return (c.pend > 0 ? ' '.repeat(c.pend) : '') + c.line.slice(c.pos);
}
function curSave(c) {
  return { pos: c.pos, col: c.col, pend: c.pend };
}
function curRestore(c, s) {
  c.pos = s.pos;
  c.col = s.col;
  c.pend = s.pend;
}
// Consume up to n columns of indentation. Returns columns used.
function curConsumeIndent(c, n) {
  let used = 0;
  while (used < n) {
    if (c.pend > 0) {
      const take = Math.min(c.pend, n - used);
      c.pend -= take;
      c.col += take;
      used += take;
      continue;
    }
    if (c.pos >= c.line.length) break;
    const ch = c.line.charCodeAt(c.pos);
    if (ch === 32) {
      c.pos++;
      c.col++;
      used++;
    } else if (ch === 9) {
      const w = 4 - (c.col % 4);
      if (used + w <= n) {
        c.pos++;
        c.col += w;
        used += w;
      } else {
        c.pend = w - (n - used);
        c.pos++;
        c.col += n - used;
        used = n;
      }
    } else break;
  }
  return used;
}
// Skip spaces/tabs, up to max columns. Returns columns skipped.
function curSkipSpaces(c, max) {
  if (max === undefined) max = 1e9;
  let n = 0;
  while (n < max) {
    if (c.pend > 0) {
      c.pend--;
      c.col++;
      n++;
      continue;
    }
    if (c.pos >= c.line.length) break;
    const ch = c.line.charCodeAt(c.pos);
    if (ch === 32) {
      c.pos++;
      c.col++;
      n++;
    } else if (ch === 9) {
      const w = 4 - (c.col % 4);
      if (n + w <= max) {
        c.pos++;
        c.col += w;
        n += w;
      } else {
        c.pend = w - (max - n);
        c.pos++;
        c.col += max - n;
        n = max;
      }
    } else break;
  }
  return n;
}
function blankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// --- block parser: container stack + leaf blocks ---
// Node kinds: doc/quote/list/item are containers (kids); p (lines),
// h (level, text), code (lang, text, fenced, fenceChar, fenceLen,
// fenceIndent), html (text, htmlType, endLine), hr, table (aligns, header, rows).

function buildBlocks(lines, refs) {
  const doc = { kind: 'doc', kids: [] };
  const open = [doc];
  const top = () => open[open.length - 1];
  let lastLineBlank = false;

  function continuesOpenList(s) {
    let lst = null;
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i].kind === 'list') { lst = open[i]; break; }
      if (open[i].kind === 'doc') break;
    }
    if (!lst) return false;
    const lm = listMarker(s, 0);
    if (!lm) return false;
    const ic = listItemContent(s, lm.end);
    if (!ic) return false;
    return lm.ordered === lst.ordered && lm.delim === lst.delim;
  }

  function listMarkerInItem(s) {
    let inItem = false;
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i].kind === 'item') { inItem = true; break; }
      if (open[i].kind === 'doc') break;
    }
    if (!inItem) return false;
    const lm = listMarker(s, 0);
    if (!lm) return false;
    const ic = listItemContent(s, lm.end);
    return !!ic;
  }

  function isContainer(b) {
    return b.kind === 'doc' || b.kind === 'quote' || b.kind === 'list' || b.kind === 'item';
  }
  function finalize(b) {
    if (b.kind === 'p') {
      const tab = tryTable(b.lines);
      if (tab) {
        const parent = open[open.length - 1];
        const kids = parent ? parent.kids : doc.kids;
        const idx = kids.indexOf(b);
        if (idx >= 0) kids[idx] = tab;
      }
    } else if (b.kind === 'code') {
      if (b.fenced) {
        if (b.text.endsWith('\n\n')) b.text = b.text.slice(0, -1);
      } else {
        b.text = b.text.replace(/\n+$/, '');
        if (b.text !== '') b.text += '\n';
      }
    }
  }
  function closeTo(keep) {
    while (open.length > keep) {
      const b = open.pop();
      finalize(b);
    }
  }
  function closeLeaf() {
    while (open.length > 1 && !isContainer(top())) {
      const b = open.pop();
      finalize(b);
    }
  }

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const blank = blankLine(line);
    const c = makeCursor(line);

    if (blank) {
      let hasQuote = false;
      for (let i = open.length - 1; i >= 0; i--) {
        if (open[i].kind === 'quote') { hasQuote = true; break; }
        if (open[i].kind === 'doc') break;
      }
      if (hasQuote) {
        closeLeaf();
        while (open.length > 1) {
          const t = top().kind;
          if (t === 'doc') break;
          if (t === 'list' || t === 'item') {
            let insideQuote = false;
            for (let i = open.length - 2; i >= 0; i--) {
              if (open[i].kind === 'quote') { insideQuote = true; break; }
              if (open[i].kind === 'doc') break;
            }
            if (!insideQuote) break;
          }
          open.pop();
        }
        lastLineBlank = true;
        continue;
      }
      const cur0 = top();
      if (cur0.kind === 'code') {
        if (cur0.fenced) cur0.text += stripFenceIndent(line, cur0.fenceIndent || 0) + '\n';
        else cur0.text += stripIndentSpaces(line, 4) + '\n';
        lastLineBlank = true;
        continue;
      }
      if (cur0.kind === 'html' && cur0.htmlType >= 1 && cur0.htmlType <= 5) {
        cur0.text += '\n';
        lastLineBlank = true;
        continue;
      }
      closeLeaf();
      while (open.length > 1 && top().kind === 'item' && top().kids.length === 0) open.pop();
      while (open.length > 1) {
        const t = top().kind;
        if (t === 'doc') break;
        if (t === 'list' || t === 'item') {
          let insideQuote = false;
          for (let i = open.length - 2; i >= 0; i--) {
            if (open[i].kind === 'quote') { insideQuote = true; break; }
            if (open[i].kind === 'doc') break;
          }
          if (!insideQuote) break;
        }
        open.pop();
      }
      lastLineBlank = true;
      continue;
    }

    // 1. Match open containers, deepest first.
    let k = 1;
    let lastGood = curSave(c);
    let allMatched = true;
    while (k < open.length && isContainer(open[k])) {
      const b = open[k];
      if (b.kind === 'quote') {
        curConsumeIndent(c, 3);
        if (curPeek(c) === 62) {
          curAdvance(c);
          if (curPeek(c) === 32) curAdvance(c);
          lastGood = curSave(c);
          k++;
        } else {
          allMatched = false;
          break;
        }
      } else if (b.kind === 'item') {
        const used = curConsumeIndent(c, b.indent);
        if (used >= b.indent) {
          lastGood = curSave(c);
          k++;
        } else {
          allMatched = false;
          break;
        }
      } else {
        lastGood = curSave(c);
        k++;
      }
    }
    const matchDepth = k - 1;

    if (!allMatched) {
      const deepest = top();
      curRestore(c, lastGood);
      const lazyRest = curRest(c);
      if (deepest.kind === 'p' && lazyRest.trim() === '') {
        let parent = null;
        for (let i = open.length - 1; i >= 0; i--) {
          if (open[i] === deepest) { parent = open[i - 1] || null; break; }
        }
        const inItem = parent && parent.kind === 'item';
        closeLeaf();
        if (inItem) lastLineBlank = true;
        continue;
      }
      if (deepest.kind === 'p' && !startsInterruptor(lazyRest, refs) && !continuesOpenList(lazyRest) && !listMarkerInItem(lazyRest)) {
        const stripped = lazyRest.replace(/^[ \t]+/, '');
        if (deepest.hadLazy && /^=+[ \t]*$/.test(stripped)) {
          deepest.lines.push('    ' + stripped);
        } else {
          deepest.lines.push(stripped);
        }
        deepest.hadLazy = true;
        lastLineBlank = false;
        continue;
      }
      closeTo(matchDepth + 1);
    }

    // 2. Continue or start blocks from the remaining content.
    const rest = curRest(c);
    const restCol = c.col;
    const cur0 = top();
    if (rest === '' && cur0.kind === 'p') {
      const parent = open.length >= 2 ? open[open.length - 2] : null;
      const inItem = parent && parent.kind === 'item';
      closeLeaf();
      if (inItem) lastLineBlank = true;
      continue;
    }
    if (cur0.kind === 'p') {
      if (isSetextUnderline(rest)) {
        const level = rest.trimStart().charCodeAt(0) === 61 ? 1 : 2;
        const text = cur0.lines.join('\n').trim();
        open.pop();
        const parent = top();
        const kids = parent.kids;
        const idx = kids.indexOf(cur0);
        const h = { kind: 'h', level, text };
        if (idx >= 0) kids[idx] = h;
        else kids.push(h);
        lastLineBlank = false;
        continue;
      } else if (startsInterruptor(rest, refs)) {
        closeLeaf();
      } else {
        cur0.lines.push(rest);
        lastLineBlank = false;
        continue;
      }
    }
    if (cur0.kind === 'code' && cur0.fenced) {
      if (isClosingFence(rest, cur0)) {
        closeLeaf();
      } else {
        cur0.text += stripFenceIndent(rest, cur0.fenceIndent || 0, restCol) + '\n';
      }
      lastLineBlank = false;
      continue;
    }
    if (cur0.kind === 'code' && !cur0.fenced) {
      const used = curConsumeIndent(c, 4);
      if (used >= 4) {
        cur0.text += curRest(c) + '\n';
        lastLineBlank = false;
        continue;
      }
      closeLeaf();
    }
    if (cur0.kind === 'html') {
      if (htmlBlockEnds(cur0, rest)) {
        cur0.text += rest + '\n';
        cur0.endLine = li;
        closeLeaf();
        lastLineBlank = false;
        continue;
      } else {
        cur0.text += rest + '\n';
        cur0.endLine = li;
        lastLineBlank = false;
        continue;
      }
    }

    li += parseNewBlocks(rest, li, restCol);
    lastLineBlank = false;
  }

  closeTo(1);
  return doc.kids;

  function markLooseIfNeeded() {
    const t = top();
    if (t.kind === 'item' && t.kids.length > 0 && lastLineBlank) {
      const parent = open[open.length - 2];
      if (parent && parent.kind === 'list') parent.loose = true;
    }
  }

  // Parse new blocks starting at the given line content. Returns the number
  // of extra lines consumed (multi-line link reference definitions).
  function parseNewBlocks(text, li, startCol) {
    let curCol = startCol || 0;
    let extra = 0;
    let guard = 0;
    while (text !== '' && guard++ < 20) {
      let leadCols = 0;
      let leadEnd = 0;
      while (leadEnd < text.length) {
        const c = text.charCodeAt(leadEnd);
        if (c === 32) {
          leadCols++;
          leadEnd++;
        } else if (c === 9) {
          leadCols += 4 - ((curCol + leadCols) % 4);
          leadEnd++;
        } else {
          break;
        }
      }
      if (leadCols >= 4) {
        const node = { kind: 'code', lang: null, text: sliceAtColumn(text, 4, curCol) + '\n', fenced: false };
        if (top().kind === 'list') open.pop();
        markLooseIfNeeded();
        top().kids.push(node);
        open.push(node);
        return extra;
      }
      const s = text.slice(leadEnd);
      if (s === '') break;

      const lmTop = listMarker(s, 0);
      const icTop = lmTop ? listItemContent(s, lmTop.end, curCol + leadCols) : null;
      if (top().kind === 'list') {
        const lst = top();
        if (
          isThematicBreak(s) ||
          !(
            lmTop &&
            icTop &&
            lmTop.ordered === lst.ordered &&
            lmTop.delim === lst.delim
          )
        ) {
          open.pop();
        }
      }

      // Link reference definitions at the start of a paragraph.
      if (s.charCodeAt(0) === 91) {
        const def = tryLinkRefDef(lines, li + extra, s, refs);
        if (def) {
          extra += def.consumed - 1;
          markLooseIfNeeded();
          if (def.rest !== '') {
            curCol = curCol + leadCols + colWidth(s.slice(0, s.length - def.rest.length), curCol + leadCols);
            text = def.rest;
            continue;
          }
          return extra;
        }
      }

      // ATX heading
      if (s.charCodeAt(0) === 35) {
        const m = /^(#{1,6})(?:[ \t]+(.*))?$/.exec(s);
        if (m) {
          let content = m[2] === undefined ? '' : m[2];
          content = content.replace(/(?:^|[ \t]+)#+[ \t]*$/, '').replace(/[ \t]+$/, '');
          markLooseIfNeeded();
          top().kids.push({ kind: 'h', level: m[1].length, text: content });
          return extra;
        }
      }
      // Fenced code
      if (s.charCodeAt(0) === 96 || s.charCodeAt(0) === 126) {
        const f = parseFenceStart(s);
        if (f) {
          const node = { kind: 'code', lang: f.lang, text: '', fenced: true, fenceChar: f.ch, fenceLen: f.len, fenceIndent: leadCols };
          markLooseIfNeeded();
          top().kids.push(node);
          open.push(node);
          return extra;
        }
      }
      // Thematic break
      if (isThematicBreak(s)) {
        markLooseIfNeeded();
        top().kids.push({ kind: 'hr' });
        return extra;
      }
      // HTML block. The first line keeps its leading spaces (up to 3).
      const hbt = htmlBlockType(s);
      if (hbt >= 1) {
        const node = { kind: 'html', text: text + '\n', htmlType: hbt, endLine: li + extra };
        markLooseIfNeeded();
        top().kids.push(node);
        if (!htmlFirstLineEnds(hbt, text)) open.push(node);
        return extra;
      }
      // Blockquote
      if (s.charCodeAt(0) === 62) {
        let j = 1;
        if (j < s.length && s.charCodeAt(j) === 32) j++;
        else if (j < s.length && s.charCodeAt(j) === 9) {
          const tabCol = curCol + leadCols + 1;
          const w = 4 - (tabCol % 4);
          text = ' '.repeat(w - 1) + s.slice(2);
          curCol = tabCol + 1;
          const node = { kind: 'quote', kids: [] };
          markLooseIfNeeded();
          top().kids.push(node);
          open.push(node);
          continue;
        }
        const node = { kind: 'quote', kids: [] };
        markLooseIfNeeded();
        top().kids.push(node);
        open.push(node);
        text = s.slice(j);
        curCol = curCol + leadCols + j;
        continue;
      }
      // List
      const lm = lmTop;
      if (lm) {
        const ic = icTop;
        if (ic) {
          let listNode = top();
          if (
            !(
              listNode.kind === 'list' &&
              listNode.ordered === lm.ordered &&
              listNode.delim === lm.delim
            )
          ) {
            listNode = { kind: 'list', ordered: lm.ordered, start: lm.num, delim: lm.delim, loose: false, kids: [] };
            markLooseIfNeeded();
            top().kids.push(listNode);
            open.push(listNode);
          }
          if (listNode.kids.length > 0 && lastLineBlank) listNode.loose = true;
          const itemNode = { kind: 'item', kids: [], indent: leadCols + ic.indent };
          listNode.kids.push(itemNode);
          open.push(itemNode);
          if (ic.content !== '') {
            parseNewBlocks(ic.content, li + extra, curCol + leadCols + ic.indent);
          }
          return extra;
        }
      }
      // Paragraph (default). The first line keeps its leading spaces.
      const node = { kind: 'p', lines: [text] };
      markLooseIfNeeded();
      top().kids.push(node);
      open.push(node);
      return extra;
    }
    return extra;
  }
}

// --- block helpers ---

// Column width of s when it starts at absolute column startCol.
function colWidth(s, startCol) {
  let c = startCol || 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 9) c += 4 - (c % 4);
    else c++;
  }
  return c - (startCol || 0);
}

function sliceAtColumn(s, col, startCol) {
  startCol = startCol || 0;
  let c = 0;
  let i = 0;
  while (i < s.length && c < col) {
    const ch = s.charCodeAt(i);
    if (ch === 9) {
      const w = 4 - ((startCol + c) % 4);
      if (c + w > col) {
        return ' '.repeat(c + w - col) + s.slice(i + 1);
      }
      c += w;
      i++;
    } else {
      c++;
      i++;
    }
  }
  return s.slice(i);
}

// Strip up to maxCols columns of leading whitespace. A partially-consumed
// tab leaves the remaining columns as spaces.
function stripLeadingIndent(s, maxCols) {
  let col = 0;
  let i = 0;
  while (i < s.length && col < maxCols) {
    const c = s.charCodeAt(i);
    if (c === 32) {
      col++;
      i++;
    } else if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w > maxCols) {
        return ' '.repeat(col + w - maxCols) + s.slice(i + 1);
      }
      col += w;
      i++;
    } else {
      break;
    }
  }
  return s.slice(i);
}

// A paragraph continuation line: strip up to 3 columns of leading indent,
// but if the line is indented 4+ columns keep it verbatim (indented code
// cannot interrupt a paragraph).
function paragraphLine(s) {
  let leadCols = 0;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32) {
      leadCols++;
      i++;
    } else if (c === 9) {
      leadCols += 4 - (leadCols % 4);
      i++;
    } else {
      break;
    }
  }
  if (leadCols >= 4) return s;
  return stripLeadingIndent(s, 3);
}

// Parse a list marker at position `start` of `s`. Returns
// {ordered, num, delim, end} or null.
function listMarker(s, start) {
  const ch = s.charCodeAt(start);
  if (ch === 45 || ch === 43 || ch === 42) {
    const next = s.charCodeAt(start + 1);
    if (next === 32 || next === 9 || start + 1 >= s.length || next === 10) {
      return { ordered: false, num: 0, delim: String.fromCharCode(ch), end: start + 1 };
    }
    return null;
  }
  if (ch >= 48 && ch <= 57) {
    let j = start;
    while (j < s.length && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
    const digits = j - start;
    if (digits > 9) return null;
    const dc = s.charCodeAt(j);
    if (dc !== 46 && dc !== 41) return null;
    const next = s.charCodeAt(j + 1);
    if (next === 32 || next === 9 || j + 1 >= s.length || next === 10) {
      const num = parseInt(s.slice(start, j), 10);
      return { ordered: true, num, delim: String.fromCharCode(dc), end: j + 1 };
    }
  }
  return null;
}

// Given a line `s` and the marker end index, compute the item's content
// indent (columns) and content string. Returns null if not a valid item.
function listItemContent(s, mEnd, startCol) {
  startCol = startCol || 0;
  let col = mEnd;
  let i = mEnd;
  let spaces = 0;
  while (i < s.length) {
    const ch = s.charCodeAt(i);
    if (ch === 32) {
      spaces++;
      col++;
      i++;
    } else if (ch === 9) {
      const w = 4 - ((startCol + col) % 4);
      if (spaces + w >= 5) {
        return { indent: mEnd + 1, content: sliceAtColumn(s, mEnd + 1, startCol) };
      }
      spaces += w;
      col += w;
      i++;
    } else {
      break;
    }
  }
  if (i >= s.length) {
    return { indent: mEnd + 1, content: '' };
  }
  if (spaces === 0) return null;
  if (spaces >= 5) {
    return { indent: mEnd + 1, content: sliceAtColumn(s, mEnd + 1, startCol) };
  }
  return { indent: col, content: s.slice(i) };
}

function isThematicBreak(s) {
  let ch = 0;
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9) continue;
    if (count === 0) {
      if (c === 45 || c === 95 || c === 42) {
        ch = c;
        count = 1;
      } else {
        return false;
      }
    } else if (c === ch) {
      count++;
    } else {
      return false;
    }
  }
  return count >= 3;
}

function isSetextUnderline(s) {
  let cols = 0;
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32) { cols++; i++; }
    else if (c === 9) { cols += 4 - (cols % 4); i++; }
    else break;
  }
  if (cols >= 4) return false;
  const rest = s.slice(i);
  return /^=+ *[ \t]*$/.test(rest) || /^-+ *[ \t]*$/.test(rest);
}

function parseFenceStart(s) {
  const ch = s.charCodeAt(0);
  if (ch !== 96 && ch !== 126) return null;
  let j = 0;
  while (j < s.length && s.charCodeAt(j) === ch) j++;
  if (j < 3) return null;
  const info = s.slice(j);
  if (ch === 96 && info.includes('`')) return null;
  const first = resolveEscapes(info.trim()).split(/[ \t]+/)[0] || '';
  return { ch: String.fromCharCode(ch), len: j, lang: first };
}

// Strip up to n leading columns from a whitespace-only line.
function stripIndentSpaces(s, n) {
  let cols = 0;
  let i = 0;
  let prefix = '';
  while (i < s.length && cols < n) {
    const c = s.charCodeAt(i);
    if (c === 32) { cols++; i++; }
    else if (c === 9) {
      const adv = 4 - (cols % 4);
      if (cols + adv > n) {
        prefix = ' '.repeat(cols + adv - n);
        i++;
        break;
      }
      cols += adv;
      i++;
    } else break;
  }
  return prefix + s.slice(i);
}

function stripFenceIndent(s, indent, startCol) {
  startCol = startCol || 0;
  let absCol = startCol;
  let i = 0;
  while (i < s.length && absCol - startCol < indent) {
    const c = s.charCodeAt(i);
    if (c === 32) { absCol++; i++; }
    else if (c === 9) {
      const adv = 4 - (absCol % 4);
      if (absCol - startCol + adv > indent) {
        absCol += adv;
        i++;
        break;
      }
      absCol += adv;
      i++;
    } else break;
  }
  let prefix = '';
  while (i < s.length && s.charCodeAt(i) === 9) {
    if (absCol === 0) break;
    const w = 4 - (absCol % 4);
    prefix += ' '.repeat(w);
    absCol += w;
    i++;
  }
  return prefix + s.slice(i);
}

function isClosingFence(rest, node) {
  let cols = 0;
  let i = 0;
  while (i < rest.length) {
    const c = rest.charCodeAt(i);
    if (c === 32) { cols++; i++; }
    else if (c === 9) { cols += 4 - (cols % 4); i++; }
    else break;
  }
  if (cols >= 4) return false;
  const s = rest.slice(i);
  if (s === '') return false;
  const ch = s.charCodeAt(0);
  if (ch !== node.fenceChar.charCodeAt(0)) return false;
  let j = 0;
  while (j < s.length && s.charCodeAt(j) === ch) j++;
  if (j < node.fenceLen) return false;
  for (let k = j; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// --- HTML blocks ---

const HTML_BLOCK_NAMES = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

function htmlBlockType(s) {
  if (s.charCodeAt(0) !== 60) return 0;
  const m1 = /^<(script|pre|style|textarea)(?:[ \t>]|$)/i.exec(s);
  if (m1) return 1;
  if (s.startsWith('<!--')) return 2;
  if (s.startsWith('<?')) return 3;
  if (s.length > 2 && s.charCodeAt(1) === 33 && /[A-Za-z]/.test(s.charAt(2))) return 4;
  if (s.startsWith('<![CDATA[')) return 5;
  const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t/>]|$)/.exec(s);
  if (m6 && HTML_BLOCK_NAMES.has(m6[1].toLowerCase())) return 6;
  if (s.startsWith('</')) {
    if (/^<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>[ \t]*$/.test(s)) return 7;
    return 0;
  }
  const m7 = /^<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>[ \t]*$/.exec(s);
  if (m7) return 7;
  return 0;
}

function htmlFirstLineEnds(type, line) {
  if (type === 1) {
    const m = /^<(script|pre|style|textarea)/i.exec(line.trimStart());
    if (m) return new RegExp('</' + m[1] + '\\s*>', 'i').test(line);
    return false;
  }
  if (type === 2) return line.includes('-->');
  if (type === 3) return line.includes('?>');
  if (type === 4) return line.includes('>');
  if (type === 5) return line.includes(']]>');
  return false;
}

function htmlBlockEnds(node, rest) {
  if (node.htmlType === 1) {
    const tag = node.text.match(/^<(script|pre|style|textarea)/i);
    if (tag) {
      const re = new RegExp('</' + tag[1] + '\\s*>', 'i');
      return re.test(rest);
    }
  } else if (node.htmlType === 2) {
    return rest.includes('-->');
  } else if (node.htmlType === 3) {
    return rest.includes('?>');
  } else if (node.htmlType === 4) {
    return rest.includes('>');
  } else if (node.htmlType === 5) {
    return rest.includes(']]>');
  }
  return false;
}

// --- link reference definitions ---

function countNewlines(s, from, to) {
  let n = 0;
  for (let i = from; i < to; i++) {
    if (s.charCodeAt(i) === 10) n++;
  }
  return n;
}

function tryLinkRefDef(lines, li, s, refs) {
  if (s.charCodeAt(0) !== 91) return null;
  let text = s;
  for (let k = 1; k <= 9 && li + k < lines.length; k++) {
    text += '\n' + lines[li + k];
  }
  const lbl = parseLabel(text, 0);
  if (!lbl) return null;
  const rawLabel = lbl[0];
  if (rawLabel.trim() === '') return null;
  for (let q = 0; q < rawLabel.length; q++) {
    if (rawLabel.charCodeAt(q) === 92) {
      q++;
      continue;
    }
    const cc = rawLabel.charCodeAt(q);
    if (cc === 91 || cc === 93) return null;
  }
  let j = lbl[1];
  while (j < text.length && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
  if (j >= text.length || text.charCodeAt(j) !== 58) return null;
  j++;
  let p = j;
  while (p < text.length) {
    const c = text.charCodeAt(p);
    if (c === 32 || c === 9) {
      p++;
      continue;
    }
    if (c === 10) {
      let q = p + 1;
      while (q < text.length && (text.charCodeAt(q) === 32 || text.charCodeAt(q) === 9)) q++;
      if (q >= text.length || text.charCodeAt(q) === 10) return null;
      p = q;
      continue;
    }
    break;
  }
  const dest = parseDest(text, p);
  if (!dest) return null;
  p = dest[1];
  let q = p;
  let skipped = 0;
  while (q < text.length && (text.charCodeAt(q) === 32 || text.charCodeAt(q) === 9)) {
    q++;
    skipped++;
  }
  let title = null;
  let endPos = p;
  if (q < text.length && text.charCodeAt(q) !== 10) {
    if (skipped === 0) return null;
    const t = parseTitle(text, q);
    if (!t) return null;
    title = t[0];
    endPos = t[1];
    q = t[1];
    while (q < text.length && (text.charCodeAt(q) === 32 || text.charCodeAt(q) === 9)) q++;
    if (q < text.length && text.charCodeAt(q) !== 10) return null;
  } else if (q < text.length && text.charCodeAt(q) === 10) {
    let r = q + 1;
    while (r < text.length && (text.charCodeAt(r) === 32 || text.charCodeAt(r) === 9)) r++;
    if (r < text.length && text.charCodeAt(r) !== 10) {
      const t = parseTitle(text, r);
      if (t) {
        let after = t[1];
        while (after < text.length && (text.charCodeAt(after) === 32 || text.charCodeAt(after) === 9)) after++;
        if (after >= text.length || text.charCodeAt(after) === 10) {
          title = t[0];
          endPos = t[1];
        }
      }
    }
  }
  const consumed = 1 + countNewlines(text, 0, endPos);
  const key = normalizeLabel(rawLabel);
  if (!refs.has(key)) {
    refs.set(key, { href: dest[0], title });
  }
  return { consumed, rest: '' };
}

// --- tables (GFM) ---

function splitTableRow(line) {
  let start = 0;
  let end = line.length;
  while (start < end && line.charCodeAt(start) === 32) start++;
  while (end > start && line.charCodeAt(end - 1) === 32) end--;
  if (start < end && line.charCodeAt(start) === 124) start++;
  if (end > start && line.charCodeAt(end - 1) === 124) end--;
  const inner = line.slice(start, end);
  const cells = [];
  let cur = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner.charCodeAt(i);
    if (c === 92 && i + 1 < inner.length) {
      if (inner.charCodeAt(i + 1) === 124) {
        cur += '|';
        i++;
      } else {
        cur += inner[i] + inner[i + 1];
        i++;
      }
    } else if (c === 124) {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += inner[i];
    }
  }
  cells.push(cur.trim());
  return cells;
}

function tryTable(lines) {
  if (lines.length < 2) return null;
  let cols = 0;
  let i = 0;
  const dl = lines[1];
  while (i < dl.length) {
    const c = dl.charCodeAt(i);
    if (c === 32) { cols++; i++; }
    else if (c === 9) { cols += 4 - (cols % 4); i++; }
    else break;
  }
  if (cols >= 4) return null;
  const delimCells = splitTableRow(dl);
  if (delimCells.length === 0) return null;
  const aligns = [];
  for (const cell of delimCells) {
    const m = /^(:?)-+(:?)$/.exec(cell);
    if (!m) return null;
    if (m[1] && m[2]) aligns.push('center');
    else if (m[2]) aligns.push('right');
    else if (m[1]) aligns.push('left');
    else aligns.push(null);
  }
  const headerCells = splitTableRow(lines[0]);
  if (headerCells.length !== aligns.length) return null;
  const rows = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = splitTableRow(lines[i]);
    rows.push(cells);
  }
  return { kind: 'table', aligns, header: headerCells, rows };
}

// --- interruptor check: can this line interrupt a paragraph? ---

function startsInterruptor(s, refs) {
  let leadCols = 0;
  let leadEnd = 0;
  while (leadEnd < s.length) {
    const c = s.charCodeAt(leadEnd);
    if (c === 32) {
      leadCols++;
      leadEnd++;
    } else if (c === 9) {
      leadCols += 4 - (leadCols % 4);
      leadEnd++;
    } else {
      break;
    }
  }
  if (leadCols >= 4) return false;
  const t = s.slice(leadEnd);
  if (t === '') return false;
  const ch = t.charCodeAt(0);
  if (ch === 35) return /^(#{1,6})(?:[ \t]+|$)/.test(t);
  if (ch === 96 || ch === 126) return parseFenceStart(t) !== null;
  if (ch === 62) return true;
  if (ch === 60) {
    const hbt = htmlBlockType(t);
    return hbt >= 1 && hbt <= 6;
  }
  if (isThematicBreak(t)) return true;
  const lm = listMarker(t, 0);
  if (lm) {
    const ic = listItemContent(t, lm.end);
    if (!ic || ic.content === '') return false;
    if (!lm.ordered) return true;
    return lm.num === 1;
  }
  return false;
}

// --- block renderer ---

function renderBlocks(children, refs, out) {
  for (let bi = 0; bi < children.length; bi++) {
    const b = children[bi];
    switch (b.kind) {
      case 'p': {
        out.push('<p>');
        out.push(inline(b.lines.join('\n'), refs));
        out.push('</p>\n');
        break;
      }
      case 'h': {
        out.push('<h' + b.level + '>');
        out.push(inline(b.text, refs));
        out.push('</h' + b.level + '>\n');
        break;
      }
      case 'code': {
        out.push('<pre><code');
        if (b.lang) out.push(' class="language-' + escText(b.lang) + '"');
        out.push('>');
        out.push(escCode(b.text));
        out.push('</code></pre>\n');
        break;
      }
      case 'quote': {
        out.push('<blockquote>\n');
        renderBlocks(b.kids, refs, out);
        out.push('</blockquote>\n');
        break;
      }
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        out.push('<' + tag);
        if (b.ordered && b.start !== 1) out.push(' start="' + b.start + '"');
        out.push('>\n');
        for (const item of b.kids) {
          renderListItem(item, b, refs, out);
        }
        out.push('</' + tag + '>\n');
        break;
      }
      case 'html': {
        out.push(b.text);
        break;
      }
      case 'hr': {
        out.push('<hr>\n');
        break;
      }
      case 'table': {
        renderTable(b, refs, out);
        break;
      }
    }
  }
}

function renderListItem(item, list, refs, out) {
  out.push('<li>');
  const children = item.kids;
  if (!list.loose) {
    for (let i = 0; i < children.length; i++) {
      const b = children[i];
      if (b.kind === 'p') {
        let text = b.lines.join('\n');
        if (i === 0) {
          const m = /^\[([ xX])\] /.exec(text);
          if (m) {
            const checked = m[1] !== ' ';
            out.push(checked ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ');
            text = text.slice(m[0].length);
          }
        }
        out.push(inline(text, refs));
      } else {
        renderBlocks([b], refs, out);
      }
    }
  } else {
    for (let i = 0; i < children.length; i++) {
      const b = children[i];
      if (b.kind === 'p') {
        let text = b.lines.join('\n');
        if (i === 0) {
          const m = /^\[([ xX])\] /.exec(text);
          if (m) {
            const checked = m[1] !== ' ';
            out.push('<p>');
            out.push(checked ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ');
            text = text.slice(m[0].length);
            out.push(inline(text, refs));
            out.push('</p>\n');
            continue;
          }
        }
        out.push('<p>');
        out.push(inline(text, refs));
        out.push('</p>\n');
      } else {
        renderBlocks([b], refs, out);
      }
    }
  }
  out.push('</li>\n');
}

function renderTable(tab, refs, out) {
  out.push('<table>\n<thead>\n<tr>\n');
  for (let i = 0; i < tab.header.length; i++) {
    const align = tab.aligns[i];
    out.push('<th');
    if (align) out.push(' align="' + align + '"');
    out.push('>');
    out.push(inline(tab.header[i], refs));
    out.push('</th>\n');
  }
  out.push('</tr>\n</thead>\n');
  if (tab.rows.length === 0) {
    out.push('</table>\n');
    return;
  }
  out.push('<tbody>');
  for (const row of tab.rows) {
    out.push('<tr>\n');
    for (let i = 0; i < tab.aligns.length; i++) {
      const cell = i < row.length ? row[i] : '';
      const align = tab.aligns[i];
      out.push('<td');
      if (align) out.push(' align="' + align + '"');
      out.push('>');
      out.push(inline(cell, refs));
      out.push('</td>\n');
    }
    out.push('</tr>\n');
  }
  out.push('</tbody></table>\n');
}
