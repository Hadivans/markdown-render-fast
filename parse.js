// parse.js — a fast CommonMark 0.31.2 + GFM renderer whose parse(markdown) returns
// exactly the HTML marked 18.1.3 renders with its default options (GFM on).
// Clean-room implementation, written from the CommonMark/GFM specs and verified
// against marked's own practice set. No dependencies, no caching across calls:
// parse() is pure per call and keeps nothing from an earlier call.

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  // A trailing newline makes the last split element ''; drop it (it is not a line).
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const state = { refs: new Map(), lines };
  const blocks = parseBlocks(state);
  stripHtmlTrailingNewlines(blocks, lines);
  const out = [];
  renderBlocks(blocks, state.refs, out);
  return out.join('');
}

// Strip the trailing newline from an HTML block when the source line
// immediately after the block's last line is blank (the blank line
// absorbs it), or when a type 6/7 block is not the document's last leaf
// (its container ended, e.g. cm-175 `<div></li>`). Types 1-5 end at
// their closing tag and keep the newline when the next line is not
// blank (cm-169) but drop it when a blank line follows (cm-183, cm-308).
function stripHtmlTrailingNewlines(children, lines) {
  const leaves = [];
  (function walk(nodes) {
    for (const n of nodes) {
      if (n.children) walk(n.children);
      else leaves.push(n);
    }
  })(children);
  const last = leaves.length ? leaves[leaves.length - 1] : null;
  for (const n of leaves) {
    if (n.t === 'html' && n.text.endsWith('\n')) {
      const next = lines[n.endLine + 1];
      const nextBlank = next !== undefined && isBlankLine(next);
      if (nextBlank || (n.type >= 6 && n !== last)) {
        n.text = n.text.slice(0, -1);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Character helpers (char codes, fast paths for ASCII)
// ---------------------------------------------------------------------------

function isSpace(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
}
function isDigit(c) {
  return c >= 48 && c <= 57;
}
function isAlpha(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isAlnum(c) {
  return isAlpha(c) || isDigit(c);
}
// ASCII punctuation, as CommonMark defines it.
function isAsciiPunct(c) {
  return (
    (c >= 33 && c <= 47) ||
    (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) ||
    (c >= 123 && c <= 126)
  );
}
// Unicode punctuation (for emphasis flanking): ASCII punct plus anything that
// is not a letter, number, space or combining mark. Approximated with a
// regex test on the single character; only used off the ASCII fast path.
const unicodePunctRe = /[\p{P}\p{S}]/u;
function isPunctChar(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return isAsciiPunct(c);
  return unicodePunctRe.test(ch);
}
function isWhitespaceChar(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return isSpace(c);
  return /\s/.test(ch);
}

// ---------------------------------------------------------------------------
// Entities
//
// marked decodes numeric character references (&#35; &#x22;) in inline text
// and leaves named references (&copy; &AElig;) untouched. A numeric reference
// is valid only as &# + 1-7 decimal digits, or &#[Xx] + 1-6 hex digits, plus
// ';'. Code points 0, surrogates and > 0x10FFFF become U+FFFD. The decoded
// character is plain text: it never re-enters markdown parsing.
// ---------------------------------------------------------------------------

function decodeNumericEntity(s, i) {
  // s[i] === '&', s[i+1] === '#'. Returns [char, endIndex] or null.
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
  if (j >= s.length || s.charCodeAt(j) !== 59) return null; // ';'
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
  return [String.fromCodePoint(cp), j + 1];
}

// Does an entity-like reference start at s[i]? Used by the text escaper:
// `&` is left alone when it begins &#digits; / &#x hex; / &word;.
function isEntityRefAt(s, i) {
  let j = i + 1;
  if (j < s.length && s.charCodeAt(j) === 35) {
    j++;
    if (j < s.length && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) {
      j++;
      let n = 0;
      while (j < s.length && n < 7) {
        const c = s.charCodeAt(j);
        if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70))) break;
        j++;
        n++;
      }
      return n >= 1 && n <= 6 && j < s.length && s.charCodeAt(j) === 59;
    }
    let n = 0;
    while (j < s.length && n < 8) {
      const c = s.charCodeAt(j);
      if (c < 48 || c > 57) break;
      j++;
      n++;
    }
    return n >= 1 && n <= 7 && j < s.length && s.charCodeAt(j) === 59;
  }
  let n = 0;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95)) break;
    j++;
    n++;
    if (n > 32) return false;
  }
  return n >= 1 && j < s.length && s.charCodeAt(j) === 59;
}

// ---------------------------------------------------------------------------
// HTML escaping. Two modes, exactly like marked's escape():
//   escText  — escape & < > " ' but leave an & alone when it starts an
//              entity-like reference (&copy; &#35; &x; &ThisIsNotDefined;).
//   escCode  — escape every & < > " ' (code spans and code blocks).
// ---------------------------------------------------------------------------

function escText(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) {
      if (!isEntityRefAt(s, i)) rep = '&amp;';
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

// Decode numeric entities inside a plain-text run (used for link titles and
// destinations that marked does NOT decode -- kept for reference; marked
// leaves those alone, so this is only for inline text, handled inline).
function decodeEntitiesInText(s) {
  if (s.indexOf('&') < 0) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 38 && i + 1 < s.length && s.charCodeAt(i + 1) === 35) {
      const d = decodeNumericEntity(s, i);
      if (d) {
        out += s.slice(start, i) + d[0];
        i = d[1] - 1;
        start = d[1];
      }
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// ---------------------------------------------------------------------------
// Inline parsing
//
// Nodes are small arrays: ['t', text] text (raw, escaped at render),
// ['c', code] code span, ['h', html] raw HTML, ['b'] hard break,
// ['d', ch, n, canOpen, canClose] emphasis delimiter run,
// ['l', href, title, children] link, ['i', src, alt, title] image,
// ['[', isImage] bracket opener (renders as '[' or '![' when no link forms).
// ---------------------------------------------------------------------------

const DISALLOWED_HTML = new Set([
  'title', 'textarea', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'script', 'plaintext',
]);

// Parse a link destination starting at s[i]. Returns [dest, end] or null.
// dest is either <...> (no line endings, backslash escapes kept raw) or a
// run of non-space chars with balanced parens and backslash escapes.
function parseDestination(s, i) {
  const n = s.length;
  if (i < n && s.charCodeAt(i) === 60) {
    // <...>
    let j = i + 1;
    let out = '';
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 62) return [out, j + 1];
      if (c === 60 || c === 10) return null;
      if (c === 92 && j + 1 < n && isAsciiPunct(s.charCodeAt(j + 1))) {
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
    } else if (c === 92 && j + 1 < n && isAsciiPunct(s.charCodeAt(j + 1))) {
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

// Parse a link title starting at s[i] (after optional whitespace/newlines
// have been skipped by the caller). Returns [title, end] or null.
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
      // A title may span lines; a blank line ends it.
      if (j + 1 < n && s.charCodeAt(j + 1) === 10) return null;
      out += '\n';
      j++;
    } else if (ch === 92 && j + 1 < n && isAsciiPunct(s.charCodeAt(j + 1))) {
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

// Skip spaces/tabs/newlines (at most one blank line is allowed between the
// destination and the title, and none before the closing paren of an inline
// link -- the caller checks that). Returns the new index.
function skipInlineSpace(s, i) {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10) i++;
    else break;
  }
  return i;
}

// Normalize a link label: collapse whitespace to single spaces, trim,
// case-fold (full Unicode folding for characters that fold to multiple
// characters, e.g. sharp S -> ss, ligatures).
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

// Parse a link label starting at s[i] === '['. Returns [label, end] (end is
// just past ']') or null. Handles balanced brackets and multi-line labels.
// Backslash escapes are NOT resolved here: label matching uses the raw text
// (so `foo\!` does not match a `foo!` reference).
function parseLabel(s, i) {
  const n = s.length;
  let j = i + 1;
  let depth = 0;
  let out = '';
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 10) {
      // A label may span lines; a blank line ends it.
      let k = j + 1;
      while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) k++;
      if (k >= n || s.charCodeAt(k) === 10) return null;
      out += '\n';
      j++;
      continue;
    }
    if (c === 92 && j + 1 < n) {
      // Keep the escape raw; the next char is not a bracket delimiter.
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

// Try to parse an inline link's (destination title) starting at s[i] === '('.
// Returns [href, title, end] (end just past ')') or null.
function parseInlineLink(s, i) {
  const n = s.length;
  let j = skipInlineSpace(s, i + 1);
  if (j >= n) return null;
  if (s.charCodeAt(j) === 41) return ['', null, j + 1];
  const dest = parseDestination(s, j);
  if (!dest) return null;
  j = skipInlineSpace(s, dest[1]);
  if (j >= n) return null;
  if (s.charCodeAt(j) === 41) return [dest[0], null, j + 1];
  const title = parseTitle(s, j);
  if (!title) return null;
  j = skipInlineSpace(s, title[1]);
  if (j >= n || s.charCodeAt(j) !== 41) return null;
  return [dest[0], title[0], j + 1];
}

// ---------------------------------------------------------------------------
// Autolinks
// ---------------------------------------------------------------------------

// Safe URL characters (cmark clean_url): alphanumerics plus
// ; / ? : @ & = + $ , _ . ! ~ * ' ( ) - #
const URL_SAFE = new Uint8Array(128);
for (let i = 48; i <= 57; i++) URL_SAFE[i] = 1;
for (let i = 65; i <= 90; i++) URL_SAFE[i] = 1;
for (let i = 97; i <= 122; i++) URL_SAFE[i] = 1;
for (const ch of ';/?:@&=+$,_.!~*\'()-#%') URL_SAFE[ch.charCodeAt(0)] = 1;
const HEXD = '0123456789ABCDEF';
function isHexDigit(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}
function utf8Percent(cp) {
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
// Percent-encode a link href the way marked/cmark do: every byte not in the
// safe set becomes %XX (UTF-8 for non-ASCII); an existing %XX hex sequence
// is left alone.
function cleanUrl(href) {
  let needs = false;
  for (let i = 0; i < href.length; i++) {
    const c = href.charCodeAt(i);
    if (c >= 128) {
      needs = true;
      break;
    }
    if (URL_SAFE[c]) continue;
    if (c === 37 && i + 2 < href.length && isHexDigit(href.charCodeAt(i + 1)) && isHexDigit(href.charCodeAt(i + 2))) {
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
      } else if (c === 37 && i + 2 < href.length && isHexDigit(href.charCodeAt(i + 1)) && isHexDigit(href.charCodeAt(i + 2))) {
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
      out += utf8Percent(cp);
    }
  }
  return out;
}

// <scheme:...> or <email>. Returns [html, end] or null.
function tryAutolink(s, i) {
  const n = s.length;
  // scheme: 2-32 chars, letter first, then letters/digits/+/./-
  let j = i + 1;
  let k = j;
  while (k < n) {
    const c = s.charCodeAt(k);
    if (isAlpha(c) || isDigit(c) || c === 43 || c === 46 || c === 45) k++;
    else break;
  }
  if (k - j >= 2 && k - j <= 32 && k < n && s.charCodeAt(k) === 58) {
    // must be a letter first
    if (!isAlpha(s.charCodeAt(j))) return null;
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
  // email: something@something.tld
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

// Raw inline HTML: comment, PI, declaration, CDATA, open/close tag.
// Returns [html, end] or null.
function tryInlineHtml(s, i) {
  const n = s.length;
  if (i + 1 >= n || s.charCodeAt(i + 1) === 32) return null;
  // comment <!-- ... -->  (`<!-->` and `<!--->` are complete empty
  // comments by themselves, cm-626; they do not run on to a later `-->`.)
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
  // CDATA <![CDATA[ ... ]]>  (must come before the <! declaration check)
  if (s.startsWith('<![CDATA[', i)) {
    const j = s.indexOf(']]>', i + 9);
    if (j < 0) return null;
    return [s.slice(i, j + 3), j + 3];
  }
  // processing instruction <? ... ?>
  if (s.startsWith('<?', i)) {
    const j = s.indexOf('?>', i + 2);
    if (j < 0) return null;
    return [s.slice(i, j + 2), j + 2];
  }
  // declaration <!A ... >
  if (s.startsWith('<!', i)) {
    if (i + 2 < n && isAlpha(s.charCodeAt(i + 2))) {
      let j = i + 2;
      while (j < n && s.charCodeAt(j) !== 62) j++;
      if (j >= n) return null;
      return [s.slice(i, j + 1), j + 1];
    }
    return null;
  }
  // open or close tag
  let j = i + 1;
  let closing = false;
  if (s.charCodeAt(j) === 47) {
    closing = true;
    j++;
  }
  if (j >= n || !isAlpha(s.charCodeAt(j))) return null;
  while (j < n && (isAlnum(s.charCodeAt(j)) || s.charCodeAt(j) === 45)) j++;
  // attributes: each one must be preceded by whitespace (cm-622
  // `<a href='bar'title=title>` and cm-609 `<m:abc>` are NOT tags).
  // A closing tag takes no attributes at all (cm-624 `</a href="foo">`).
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 62) return [s.slice(i, j + 1), j + 1];
    if (c === 47 && j + 1 < n && s.charCodeAt(j + 1) === 62) return [s.slice(i, j + 2), j + 2];
    if (c !== 32 && c !== 9 && c !== 10) return null;
    // Skip the whitespace run; the next token must be `>`, `/>`, or an
    // attribute name. (A closing tag has no attributes.)
    let k = j;
    while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
    if (k >= n) return null;
    const nc = s.charCodeAt(k);
    if (nc === 62) return [s.slice(i, k + 1), k + 1];
    if (nc === 47 && k + 1 < n && s.charCodeAt(k + 1) === 62) return [s.slice(i, k + 2), k + 2];
    if (closing) return null;
    // attribute name
    if (!(isAlpha(nc) || nc === 95 || nc === 58)) return null;
    j = k;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (isAlnum(d) || d === 95 || d === 58 || d === 46 || d === 45) j++;
      else break;
    }
    // optional = value
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
        // unquoted value: no space, ", ', =, <, >, `
        let e = v;
        while (e < n) {
          const d = s.charCodeAt(e);
          if (d === 32 || d === 9 || d === 10 || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
          e++;
        }
        if (e === v) return null;
        j = e;
      }
    } else {
      // Valueless attribute: leave j at the end of the name so the loop
      // top sees (and skips) the following whitespace (cm-616
      // `_boolean zoop:33=...`).
    }
  }
  return null;
}

// GFM extended autolinks: www. / http(s):// / email, at a word boundary.
// Returns [node, end] or null. `prev` is the char code before i (-1 at start).
function tryExtendedAutolink(s, i, prev) {
  const n = s.length;
  // Must be at start or after whitespace or punctuation (a `<` before a
  // bare URL still allows the link, cm-602 `<https://foo.bar/baz bim>`).
  if (prev !== -1) {
    const p = prev;
    if (isAlnum(p)) return null;
  }
  // www. domain
  if (s.startsWith('www.', i)) {
    const m = /^www\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/.exec(s.slice(i));
    if (!m) return null;
    let end = i + m[0].length;
    end = extendUrlPath(s, end);
    const dest = s.slice(i, end);
    return [['l', 'http://' + cleanUrl(dest), null, [['t', dest]]], end];
  }
  // http:// or https://
  if (s.startsWith('http://', i) || s.startsWith('https://', i)) {
    const m = /^https?:\/\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*(?::\d+)?/.exec(s.slice(i));
    if (!m) return null;
    let end = i + m[0].length;
    end = extendUrlPath(s, end);
    const dest = s.slice(i, end);
    return [['l', cleanUrl(dest), null, [['t', dest]]], end];
  }
  // scheme: email[/single-path-segment]  (mailto:, xmpp:, gfm-633/634/635)
  {
    const sm = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/.exec(s.slice(i));
    if (sm && !s.startsWith('http://', i) && !s.startsWith('https://', i)) {
      const after = i + sm[0].length;
      const em = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/.exec(s.slice(after));
      if (em) {
        let end = after + em[0].length;
        // Reject if the domain is immediately followed by - or _
        // (the domain would end with it, gfm-632).
        if (end < n && (s.charCodeAt(end) === 45 || s.charCodeAt(end) === 95)) return null;
        // One optional path segment (/txt, /txt@bin), no second segment
        // (gfm-635). The segment allows @ and other URL path chars.
        if (end < n && s.charCodeAt(end) === 47) {
          let q = end + 1;
          while (q < n) {
            const c = s.charCodeAt(q);
            if (isAlnum(c) || c === 45 || c === 46 || c === 95 || c === 126 || c === 64 || c === 58 || c === 43 || c === 61 || c === 38 || c === 37 || c === 59 || c === 44) q++;
            else break;
          }
          if (q > end + 1) end = q;
        }
        const dest = s.slice(i, end);
        return [['l', cleanUrl(dest), null, [['t', dest]]], end];
      }
    }
  }
  // email: word@domain.tld
  if (isAlnum(s.charCodeAt(i)) || s.charCodeAt(i) === 95 || s.charCodeAt(i) === 46) {
    const m = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/.exec(s.slice(i));
    if (!m) return null;
    let end = i + m[0].length;
    // Reject if the domain is immediately followed by - or _
    // (gfm-632 `a.b-c_d@a.b-` / `a.b-c_d@a.b_` are not links at all).
    if (end < n && (s.charCodeAt(end) === 45 || s.charCodeAt(end) === 95)) return null;
    // Trailing punctuation is not part of an email autolink.
    while (end > i && /[?!.,:;*_~]/.test(s[end - 1])) end--;
    const dest = s.slice(i, end);
    if (dest.length === 0) return null;
    return [['l', 'mailto:' + cleanUrl(dest), null, [['t', dest]]], end];
  }
  return null;
}

// Extend a URL with its path/query/fragment, trimming trailing
// punctuation per the GFM autolink rules. A `)` is part of the URL when
// it is followed by more URL characters; a TRAILING `)` is kept only
// while it balances an earlier `(` (gfm-626 `(business))+ok` keeps both
// `)`, `foo(bar))` drops the last). A trailing `&word;` entity-like
// suffix is excluded (gfm-627 `&hl;`).
function extendUrlPath(s, end) {
  const n = s.length;
  let j = end;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 60 || c === 10 || c === 93) break;
    j++;
  }
  // Trim a trailing entity-like `&word;` suffix FIRST (before the
  // punctuation trim removes the `;`, gfm-627 `&hl;`).
  const tail = s.slice(end, j);
  const em = /&[A-Za-z0-9]+;$/.exec(tail);
  if (em) j -= em[0].length;
  // Trim trailing punctuation.
  while (j > end && /[?!.,:;*_~'"'\]}]/.test(s[j - 1])) j--;
  // Trim unbalanced trailing `)`.
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

// ---------------------------------------------------------------------------
// Inline tokenizer + emphasis + rendering
// ---------------------------------------------------------------------------

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
  let delimSeq = 0;
  const flush = () => {
    if (cur !== '') {
      nodes.push(['t', cur]);
      cur = '';
    }
  };
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    // newline: soft break, or hard break after 2+ spaces
    if (c === 10) {
      let k = cur.length;
      while (k > 0 && cur.charCodeAt(k - 1) === 32) k--;
      if (cur.length - k >= 2) {
        cur = cur.slice(0, k);
        flush();
        nodes.push(['b']);
        i++;
        // After a hard break, the next line's leading spaces/tabs are
        // stripped (cm-636 `foo  \n     bar` -> `foo<br>bar`). A soft
        // break keeps them.
        while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
        continue;
      } else {
        cur += '\n';
      }
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
          // Same leading-space strip as a two-space hard break (cm-637).
          while (i < n && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
          continue;
        }
        if (isAsciiPunct(d)) {
          // An escaped '&' must be emitted already-escaped: a raw '&'
          // here would be mistaken for an entity start by escText.
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
      // Strikethrough: a run of 1 or 2 tildes is a delimiter (single
      // `~there~` strikes, gfm-491); a run of 3+ is literal text
      // (gfm-493 `~~~not~~~` does not strike).
      if (c === 126 && run > 2) {
        cur += src.slice(i, j);
        i = j;
        continue;
      }
      const before = charBefore(src, i);
      const after = charAfter(src, j);
      const beforeIsSpace = before === null ? true : isWhitespaceChar(before);
      const afterIsSpace = after === null ? true : isWhitespaceChar(after);
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
      nodes.push(['d', c === 42 ? '*' : c === 95 ? '_' : '~', run, canOpen, canClose, delimSeq++]);
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
            // Not a valid inline link: fall back to a shortcut reference
            // for the link text, leaving "(...)" as literal text.
            const labelText = src.slice(opener.srcIdx, i);
            const ref = refs.get(normalizeLabel(labelText));
            if (ref) {
              href = ref.href;
              title = ref.title;
              end = j;
            }
          }
        } else if (j + 1 < n && src.charCodeAt(j) === 91 && src.charCodeAt(j + 1) === 93) {
          // Collapsed reference [foo][] — check before the full form,
          // since [] parses as an (empty) label.
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
            // A link's text cannot contain another link.
            let hasLink = false;
            for (const ch of children) {
              if (ch[0] === 'l') {
                hasLink = true;
                break;
              }
            }
            if (hasLink) {
              // Not a link: restore the children and the opener, treat
              // this ']' as literal text, and drop the failed opener.
              nodes.splice(opener.idx, 0, ['[', opener.isImage], ...children);
              brackets.splice(bi, 1);
              cur += ']';
              i++;
              continue;
            }
            node = ['l', cleanUrl(href), title, children];
            // Remove the matched opener and any opened after it; an
            // outer image opener below it stays (images may contain
            // links in their alt text).
            brackets.splice(bi);
          }
          nodes.splice(opener.idx, 0, node);
          i = end;
          continue;
        }
        // No link formed: this '[' is no longer a potential opener.
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
        // NOTE: marked 18.1.3 does NOT escape the GFM "disallowed" tags
        // (title/style/xmp/...) in practice output (verified by probing
        // the vendored baseline on gfm-657), so all valid inline HTML is
        // passed through raw.
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
        const d = decodeNumericEntity(src, i);
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
    // text `[...]` is plain text, not an autolink (doc-04: the
    // `https://...` inside `[inline and data ...](...)` stays literal).
    if (brackets.length === 0 && (c === 119 || c === 104 || isAlnum(c) || c === 95 || c === 46)) {
      const prev = i === 0 ? -1 : src.charCodeAt(i - 1);
      const atBoundary =
        i === 0 ||
        prev === 32 || prev === 9 || prev === 10 || prev === 42 || prev === 95 || prev === 126 ||
        prev === 40 || prev === 91 || prev === 123 || prev === 34 || prev === 39 || prev === 60;
      if (atBoundary) {
        let tried = false;
        if (c === 119 && src.startsWith('www.', i)) tried = true;
        else if (c === 104 && (src.startsWith('http://', i) || src.startsWith('https://', i))) tried = true;
        else if (isAlnum(c) || c === 95 || c === 46) {
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
          const al = tryExtendedAutolink(src, i, prev);
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
    if (s.charCodeAt(i) === 92 && i + 1 < s.length && isAsciiPunct(s.charCodeAt(i + 1))) {
      out += s[i + 1];
      i++;
    } else out += s[i];
  }
  return out;
}

// Plain text of inline nodes (for image alt text and link labels).
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

// ---------------------------------------------------------------------------
// Emphasis processing (delimiter-stack algorithm, CommonMark rules)
// ---------------------------------------------------------------------------

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
        // Rule of 3 (emphasis `*`/`_` only, not strikethrough `~`):
        // when the total length is a multiple of 3 and the closer can
        // also open, the pair can only match when BOTH delimiters can
        // both open and close. (A closer that cannot open never
        // triggers the rule, e.g. cm-408 `__foo_ bar_`.)
        if (closer.ch !== 126) {
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
      // Strikethrough uses 2 tildes when both sides have 2+, else 1
      // (single `~there~` strikes, gfm-491).
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

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

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

// Parse inline content (a paragraph's text, a heading's text, a table cell)
// to HTML, using the document's link reference map.
function inline(src, refs) {
  if (src === '') return '';
  const nodes = tokenizeInline(src, refs);
  processEmphasis(nodes);
  return renderInline(nodes);
}

// ---------------------------------------------------------------------------
// Block parsing (CommonMark phase 1/2, container stack + leaf blocks)
// ---------------------------------------------------------------------------

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
// Consume up to n columns of indentation (spaces/tabs). Returns columns used.
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
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function parseBlocks(state) {
  const lines = state.lines;
  const refs = state.refs;
  const doc = { t: 'doc', children: [] };
  const open = [doc];
  const top = () => open[open.length - 1];
  let lastLineBlank = false;

  // True if the line is a list marker that continues the nearest open
  // list (same ordered flag and same bullet/delimiter). Such a line must
  // not be treated as a lazy paragraph continuation (cm-302 `2. bar`
  // continues an ordered list even though it does not start with 1).
  // An EMPTY marker also continues the list (cm-281 `-` starts a new
  // empty item); the content-emptiness check lives in startsInterruptor.
  function continuesOpenList(s) {
    let lst = null;
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i].t === 'list') { lst = open[i]; break; }
      if (open[i].t === 'doc') break;
    }
    if (!lst) return false;
    const lm = listMarker(s, 0);
    if (!lm) return false;
    const ic = listItemContent(s, lm.end);
    if (!ic) return false;
    return lm.ordered === lst.ordered && lm.delim === lst.delim;
  }

  // True if the line is any list marker while the paragraph sits inside
  // a list item: the marker ends the current item (starting a new item
  // in the same list, or a new list if the marker differs, cm-302 `3)`).
  // An EMPTY marker also ends the item (cm-281/282).
  function listMarkerInItem(s) {
    let inItem = false;
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i].t === 'item') { inItem = true; break; }
      if (open[i].t === 'doc') break;
    }
    if (!inItem) return false;
    const lm = listMarker(s, 0);
    if (!lm) return false;
    const ic = listItemContent(s, lm.end);
    return !!ic;
  }

  function isContainer(b) {
    return b.t === 'doc' || b.t === 'quote' || b.t === 'list' || b.t === 'item';
  }
  function finalize(b) {
    if (b.t === 'p') {
      // A paragraph whose first line looks like a table header and whose
      // second line is a delimiter row becomes a table.
      const tab = tryTable(b.lines);
      if (tab) {
        const parent = open[open.length - 1];
        const kids = parent ? parent.children : doc.children;
        const idx = kids.indexOf(b);
        if (idx >= 0) kids[idx] = tab;
      }
    } else if (b.t === 'code') {
      if (b.fenced) {
        // Fenced code: strip exactly ONE trailing newline (cm-318:
        // `b` + 2 blank lines -> `b\n\n`, not `b\n`).
        if (b.text.endsWith('\n\n')) b.text = b.text.slice(0, -1);
      } else {
        // Indented code: strip trailing blank lines; keep a single
        // trailing newline.
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
    const blank = isBlankLine(line);
    const c = makeCursor(line);

    if (blank) {
      // A truly blank line (no container marker) ends any open
      // blockquote, even if it looks like code content (cm-252: the
      // blank line after `>     code` closes the blockquote).
      let hasQuote = false;
      for (let i = open.length - 1; i >= 0; i--) {
        if (open[i].t === 'quote') { hasQuote = true; break; }
        if (open[i].t === 'doc') break;
      }
      if (hasQuote) {
        closeLeaf();
        while (open.length > 1) {
          const t = top().t;
          if (t === 'doc') break;
          if (t === 'list' || t === 'item') {
            let insideQuote = false;
            for (let i = open.length - 2; i >= 0; i--) {
              if (open[i].t === 'quote') { insideQuote = true; break; }
              if (open[i].t === 'doc') break;
            }
            if (!insideQuote) break;
          }
          open.pop();
        }
        lastLineBlank = true;
        continue;
      }
      // Blank lines are content inside fenced and indented code blocks,
      // and inside HTML blocks of types 1-5 (which end at their closing
      // tag, not at a blank line).
      const cur0 = top();
      if (cur0.t === 'code') {
        // A whitespace-only line inside a fenced code block keeps its
        // spaces (after the fence indent is stripped, cm-129).
        if (cur0.fenced) cur0.text += stripFenceIndent(line, cur0.fenceIndent || 0) + '\n';
        // A whitespace-only line inside an INDENTED code block keeps its
        // spaces after the 4-column code indent is stripped (cm-112:
        // `      ` -> `  `).
        else cur0.text += stripIndentSpaces(line, 4) + '\n';
        lastLineBlank = true;
        continue;
      }
      if (cur0.t === 'html' && cur0.type >= 1 && cur0.type <= 5) {
        cur0.text += '\n';
        lastLineBlank = true;
        continue;
      }
      // Otherwise a blank line ends a paragraph and may loosen a list.
      // It also closes any open blockquote (a blank line has no `>`
      // marker, so a later `>` starts a NEW blockquote, cm-242/252).
      // A top-level list stays open (it just goes loose), but an EMPTY
      // list item is closed by a blank line (cm-280: `  foo` after an
      // empty `-` is a top-level paragraph, not item content).
      closeLeaf();
      while (open.length > 1 && top().t === 'item' && top().children.length === 0) open.pop();
      while (open.length > 1) {
        const t = top().t;
        if (t === 'doc') break;
        if (t === 'list' || t === 'item') {
          let insideQuote = false;
          for (let i = open.length - 2; i >= 0; i--) {
            if (open[i].t === 'quote') { insideQuote = true; break; }
            if (open[i].t === 'doc') break;
          }
          if (!insideQuote) break;
        }
        open.pop();
      }
      lastLineBlank = true;
      continue;
    }

    // ---- 1. Match open containers, deepest first. ----
    let k = 1;
    let lastGood = curSave(c);
    let allMatched = true;
    while (k < open.length && isContainer(open[k])) {
      const b = open[k];
      if (b.t === 'quote') {
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
      } else if (b.t === 'item') {
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
      // Restore the cursor to the last matched container BEFORE testing
      // for an interruptor: a failed container match may have consumed
      // indent, making `    - bar` look like a list item (cm-238).
      curRestore(c, lastGood);
      const lazyRest = curRest(c);
      if (deepest.t === 'p' && lazyRest.trim() === '') {
        // An empty container line (e.g. `>>` inside nested blockquotes)
        // ends the paragraph, it is not a lazy continuation (cm-259/260).
        // It counts as a blank line for list-looseness only when the
        // paragraph is a direct child of a list item (same rule as
        // the empty-rest branch above).
        let parent = null;
        for (let i = open.length - 1; i >= 0; i--) {
          if (open[i] === deepest) { parent = open[i - 1] || null; break; }
        }
        const inItem = parent && parent.t === 'item';
        closeLeaf();
        if (inItem) lastLineBlank = true;
        continue;
      }
      if (deepest.t === 'p' && !startsInterruptor(lazyRest, state) && !continuesOpenList(lazyRest) && !listMarkerInItem(lazyRest)) {
        // Lazy paragraph continuation: the line (after matched
        // containers) belongs to the paragraph, with its leading
        // whitespace stripped (cm-238 `    - bar` -> `- bar`).
        deepest.lines.push(lazyRest.replace(/^[ \t]+/, ''));
        lastLineBlank = false;
        continue;
      }
      closeTo(matchDepth + 1);
    }

    // ---- 2. Continue or start blocks from the remaining content. ----
    const rest = curRest(c);
    const restCol = c.col;
    const cur0 = top();
    // An empty line inside containers (e.g. a lone `>` line) ends the
    // current paragraph but not the containers (cm-244 `> foo\n>\n> bar`
    // is two paragraphs in one blockquote).
    if (rest === '' && cur0.t === 'p') {
      // An empty line inside containers (e.g. a lone `>` line) ends the
      // current paragraph but not the containers (cm-244 `> foo\n>\n> bar`
      // is two paragraphs in one blockquote). It counts as a blank line
      // for list-looseness ONLY when the paragraph is a direct child of
      // a list item (cm-259: `>>` separates two paragraphs in the item
      // -> loose; cm-320: `>` inside a blockquote child does not).
      const parent = open.length >= 2 ? open[open.length - 2] : null;
      const inItem = parent && parent.t === 'item';
      closeLeaf();
      if (inItem) lastLineBlank = true;
      continue;
    }
    if (cur0.t === 'p') {
      if (isSetextUnderline(rest)) {
        // Level 1 if the (leading-whitespace-stripped) underline
        // starts with `=`, else level 2 (cm-084 `  ===` is level 1).
        const level = rest.trimStart().charCodeAt(0) === 61 ? 1 : 2;
        // Setext heading text is the paragraph text trimmed of
        // leading/trailing whitespace (cm-082, cm-084).
        const text = cur0.lines.join('\n').trim();
        open.pop();
        const parent = top();
        const kids = parent.children;
        const idx = kids.indexOf(cur0);
        const h = { t: 'h', level, text };
        if (idx >= 0) kids[idx] = h;
        else kids.push(h);
        lastLineBlank = false;
        continue;
      } else if (startsInterruptor(rest, state)) {
        closeLeaf();
      } else {
        cur0.lines.push(rest);
        lastLineBlank = false;
        continue;
      }
    }
    if (cur0.t === 'code' && cur0.fenced) {
      if (isClosingFence(rest, cur0)) {
        closeLeaf();
      } else {
        // Strip up to the opening fence's indent from the content line.
        cur0.text += stripFenceIndent(rest, cur0.fenceIndent || 0) + '\n';
      }
      lastLineBlank = false;
      continue;
    }
    if (cur0.t === 'code' && !cur0.fenced) {
      const used = curConsumeIndent(c, 4);
      if (used >= 4) {
        cur0.text += curRest(c) + '\n';
        lastLineBlank = false;
        continue;
      }
      closeLeaf();
      // fall through to parse new blocks from this line
    }
    if (cur0.t === 'html') {
      if (htmlBlockEnds(cur0, rest)) {
        // Include the closing-tag line in the block, then close it.
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
  return doc.children;

  // Parse new blocks starting at the given line content. Returns the number
  // of extra lines consumed (multi-line link reference definitions).
  // Mark the enclosing list loose when a block is added to an item that
  // already has content, after a blank line.
  function markLooseIfNeeded() {
    const t = top();
    if (t.t === 'item' && t.children.length > 0 && lastLineBlank) {
      const parent = open[open.length - 2];
      if (parent && parent.t === 'list') parent.loose = true;
    }
  }

  function parseNewBlocks(text, li, startCol) {
    startCol = startCol || 0;
    let extra = 0;
    let guard = 0;
    while (text !== '' && guard++ < 20) {
      // Leading whitespace in COLUMNS (a tab advances to the next multiple
      // of 4, measured from the ABSOLUTE column startCol, since a tab's
      // width depends on its absolute position). 4+ columns means an
      // indented code block.
      let leadCols = 0;
      let leadEnd = 0;
      while (leadEnd < text.length) {
        const c = text.charCodeAt(leadEnd);
        if (c === 32) {
          leadCols++;
          leadEnd++;
        } else if (c === 9) {
          leadCols += 4 - ((startCol + leadCols) % 4);
          leadEnd++;
        } else {
          break;
        }
      }
      if (leadCols >= 4) {
        const node = { t: 'code', lang: null, text: sliceAtColumn(text, 4, startCol) + '\n', fenced: false };
        // An indented code block is not a list item: close an open list.
        if (top().t === 'list') open.pop();
        markLooseIfNeeded();
        top().children.push(node);
        open.push(node);
        return extra;
      }
      const s = text.slice(leadEnd);
      if (s === '') break;

      // If the open top is a list and this line is not a new item for it,
      // the list is over: close it before starting any other block.
      // (A thematic break line looks like a list marker but wins over it.)
      const lmTop = listMarker(s, 0);
      const icTop = lmTop ? listItemContent(s, lmTop.end) : null;
      if (top().t === 'list') {
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
          // A ref def is a block-level element: if it follows a blank
          // line inside a list item, the list goes loose (cm-317).
          markLooseIfNeeded();
          if (def.rest !== '') {
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
          // Closing sequence: hashes at the end preceded by a space
          // OR the whole content being hashes (cm-079 `### ###`).
          content = content.replace(/(?:^|[ \t]+)#+[ \t]*$/, '').replace(/[ \t]+$/, '');
          markLooseIfNeeded();
          top().children.push({ t: 'h', level: m[1].length, text: content });
          return extra;
        }
      }
      // Fenced code
      if (s.charCodeAt(0) === 96 || s.charCodeAt(0) === 126) {
        const f = parseFenceStart(s);
        if (f) {
          // Content lines have up to the fence's indent stripped
          // (cm-131/132/133).
          const node = { t: 'code', lang: f.lang, text: '', fenced: true, fenceChar: f.ch, fenceLen: f.len, fenceIndent: leadCols };
          markLooseIfNeeded();
          top().children.push(node);
          open.push(node);
          return extra;
        }
      }
      // Thematic break
      if (isThematicBreak(s)) {
        markLooseIfNeeded();
        top().children.push({ t: 'hr' });
        return extra;
      }
      // HTML block. The first line keeps its leading spaces (up to 3)
      // as block content (cm-150 ` <div>`).
      const hbt = htmlBlockType(s);
      if (hbt >= 1) {
        const node = { t: 'html', text: text + '\n', type: hbt, endLine: li + extra };
        markLooseIfNeeded();
        top().children.push(node);
        // If the first line already contains the block's closing
        // terminator, the block ends immediately (cm-176 `<style>..</style>`
        // on one line, cm-177 `<!-- foo -->` on one line).
        if (!htmlFirstLineEnds(hbt, text)) open.push(node);
        return extra;
      }
      // Blockquote
      if (s.charCodeAt(0) === 62) {
        let j = 1;
        if (j < s.length && s.charCodeAt(j) === 32) j++;
        const node = { t: 'quote', children: [] };
        markLooseIfNeeded();
        top().children.push(node);
        open.push(node);
        text = s.slice(j);
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
              listNode.t === 'list' &&
              listNode.ordered === lm.ordered &&
              listNode.delim === lm.delim
            )
          ) {
            listNode = { t: 'list', ordered: lm.ordered, start: lm.num, delim: lm.delim, loose: false, children: [] };
            markLooseIfNeeded();
            top().children.push(listNode);
            open.push(listNode);
          }
          if (listNode.children.length > 0 && lastLineBlank) listNode.loose = true;
          // The item's content indent is relative to the whole line:
          // leading whitespace columns + the indent inside `s`.
          const itemNode = { t: 'item', children: [], indent: leadCols + ic.indent };
          listNode.children.push(itemNode);
          open.push(itemNode);
          if (ic.content !== '') {
            parseNewBlocks(ic.content, li + extra);
          }
          return extra;
        }
      }
      // Paragraph (default). The first line keeps its leading spaces
      // (up to 3) as paragraph content (cm-056 ` *-*`).
      const node = { t: 'p', lines: [text] };
      markLooseIfNeeded();
      top().children.push(node);
      open.push(node);
      return extra;
    }
    return extra;
  }

}

// ------------------------- block helpers -------------------------

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

// Strip up to maxCols columns of leading whitespace (spaces/tabs) from s.
// A partially-consumed tab leaves the remaining columns as spaces.
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
// but if the line is indented 4+ columns (indented code, which cannot
// interrupt a paragraph) keep the line verbatim.
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

// Parse a list marker at position `start` of `s` (s has no leading spaces
// beyond the up-to-3 allowed). Returns {ordered, num, delim, end} or null.
function listMarker(s, start) {
  const ch = s.charCodeAt(start);
  if (ch === 45 || ch === 43 || ch === 42) {
    // '-', '+', '*'
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
function listItemContent(s, mEnd) {
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
      const w = 4 - (col % 4);
      if (spaces + w >= 5) {
        return { indent: mEnd + 1, content: sliceAtColumn(s, mEnd + 1) };
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
    return { indent: mEnd + 1, content: sliceAtColumn(s, mEnd + 1) };
  }
  return { indent: col, content: s.slice(i) };
}

function isThematicBreak(s) {
  // -, _, * repeated 3+ times with optional spaces between, nothing else.
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
  // Leading whitespace must be < 4 columns (cm-087: 4 spaces is not
  // a setext underline, it is a lazy paragraph continuation).
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
  // The language class uses the FIRST WORD of the info string
  // (cm-143 `ruby startline=3` -> `language-ruby`).
  const first = resolveEscapes(info.trim()).split(/[ \t]+/)[0] || '';
  return { ch: String.fromCharCode(ch), len: j, lang: first };
}

// Strip up to n leading columns from a whitespace-only line,
// expanding a straddling tab to spaces (like stripFenceIndent).
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

function stripFenceIndent(s, indent) {
  // Remove up to `indent` leading columns (spaces/tabs) from a fenced
  // code content line. A tab that straddles the indent boundary is
  // replaced by spaces for its remainder (doc-01: ` \tindented` with a
  // 1-column fence indent becomes `   indented`, not a literal tab).
  if (indent <= 0) return s;
  let cols = 0;
  let i = 0;
  let prefix = '';
  while (i < s.length && cols < indent) {
    const c = s.charCodeAt(i);
    if (c === 32) { cols++; i++; }
    else if (c === 9) {
      const adv = 4 - (cols % 4);
      if (cols + adv > indent) {
        // Tab straddles the boundary: the overshoot becomes spaces.
        prefix = ' '.repeat(cols + adv - indent);
        i++;
        break;
      }
      cols += adv;
      i++;
    } else break;
  }
  return prefix + s.slice(i);
}

function isClosingFence(rest, node) {
  // Leading indent must be < 4 columns (cm-137: 4 spaces is content,
  // not a closing fence).
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
  // Only spaces/tabs may follow.
  for (let k = j; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

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
  // s has no leading spaces (up to 3 stripped by caller).
  if (s.charCodeAt(0) !== 60) return 0;
  // Type 1: <script, <pre, <style, <textarea (case-insensitive),
  // followed by space, tab, >, or end.
  const m1 = /^<(script|pre|style|textarea)(?:[ \t>]|$)/i.exec(s);
  if (m1) return 1;
  // Type 2: <!-- comment
  if (s.startsWith('<!--')) return 2;
  // Type 3: <? processing instruction
  if (s.startsWith('<?')) return 3;
  // Type 4: <!A-Z letter (declaration)
  if (s.length > 2 && s.charCodeAt(1) === 33 && /[A-Za-z]/.test(s.charAt(2))) return 4;
  // Type 5: <![CDATA[
  if (s.startsWith('<![CDATA[')) return 5;
  // Type 6: block-level tag (open or close), followed by space/tab/>/end.
  const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t/>]|$)/.exec(s);
  if (m6 && HTML_BLOCK_NAMES.has(m6[1].toLowerCase())) return 6;
  // Type 7: any other complete open or close tag on its own line.
  // A closing tag takes NO attributes (cm-624 `</a href="foo">` is
  // not an HTML block, it is a paragraph).
  if (s.startsWith('</')) {
    if (/^<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>[ \t]*$/.test(s)) return 7;
    return 0;
  }
  const m7 = /^<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>[ \t]*$/.exec(s);
  if (m7) return 7;
  return 0;
}

function htmlFirstLineEnds(type, line) {
  // True if the opening line already contains the block's terminator.
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
  // Types 1-5 end at their specific closing tag/terminator, not at a
  // blank line. Types 6-7 end at a blank line (handled by the main loop).
  if (node.type === 1) {
    // Ends at a line containing the matching end tag.
    const tag = node.text.match(/^<(script|pre|style|textarea)/i);
    if (tag) {
      const re = new RegExp('</' + tag[1] + '\\s*>', 'i');
      return re.test(rest);
    }
  } else if (node.type === 2) {
    return rest.includes('-->');
  } else if (node.type === 3) {
    return rest.includes('?>');
  } else if (node.type === 4) {
    return rest.includes('>');
  } else if (node.type === 5) {
    return rest.includes(']]>');
  }
  return false;
}

// ------------------------- link reference definitions -------------------------

function countNewlines(s, from, to) {
  let n = 0;
  for (let i = from; i < to; i++) {
    if (s.charCodeAt(i) === 10) n++;
  }
  return n;
}

// Try to parse a link reference definition starting at the given line.
// `s` is the first line's content (label at position 0). Returns
// {consumed, rest} or null. Consumed is the number of lines used.
// NOTE: parseLabel/parseDestination/parseTitle return [value, end] arrays.
// The label may span lines; the destination and title may each be on a
// following line, and a title may span several lines.
function tryLinkRefDef(lines, li, s, refs) {
  if (s.charCodeAt(0) !== 91) return null;
  // Combined text: this line plus following lines (for multi-line labels,
  // destinations, and titles).
  let text = s;
  for (let k = 1; k <= 9 && li + k < lines.length; k++) {
    text += '\n' + lines[li + k];
  }
  const lbl = parseLabel(text, 0);
  if (!lbl) return null;
  // A reference-definition label must not be empty and must not contain
  // unescaped brackets (nested brackets are not valid in a definition).
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
  // Only spaces/tabs (not a newline) may separate the label from ':'.
  while (j < text.length && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
  if (j >= text.length || text.charCodeAt(j) !== 58) return null;
  j++; // past ':'
  // Skip whitespace (spaces/tabs/newline) to the destination.
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
  const dest = parseDestination(text, p);
  if (!dest) return null;
  p = dest[1];
  // After the destination: optional title on the same line or the next.
  // A title on the same line requires whitespace before it.
  let q = p;
  let skipped = 0;
  while (q < text.length && (text.charCodeAt(q) === 32 || text.charCodeAt(q) === 9)) {
    q++;
    skipped++;
  }
  let title = null;
  let endPos = p;
  if (q < text.length && text.charCodeAt(q) !== 10) {
    if (skipped === 0) return null; // junk directly after the destination
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
        // The title is valid only if nothing but whitespace follows it
        // on its line. Otherwise the definition ends after the
        // destination and this line starts a new block.
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

// ------------------------- tables (GFM) -------------------------

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
      // An escaped pipe `\|` is a literal pipe in the cell (gfm-200:
      // the code span `` `\|` `` renders as `<code>|</code>`). Other
      // escapes are left for the inline parser.
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
  // The delimiter row must not be indented 4+ columns (cm-087:
  // `    ---` is a paragraph continuation, not a table delimiter).
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
  return { t: 'table', aligns, header: headerCells, rows };
}

// ------------------------- interruptor check -------------------------

function startsInterruptor(s, state) {
  // A line indented 4+ columns is indented code, which cannot interrupt a
  // paragraph.
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
    // An empty list item (marker with no content on its line) cannot
    // interrupt a paragraph.
    const ic = listItemContent(t, lm.end);
    if (!ic || ic.content === '') return false;
    if (!lm.ordered) return true;
    return lm.num === 1;
  }
  return false;
}

// ------------------------- block renderer -------------------------

function renderBlocks(children, refs, out) {
  for (let bi = 0; bi < children.length; bi++) {
    const b = children[bi];
    switch (b.t) {
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
        renderBlocks(b.children, refs, out);
        out.push('</blockquote>\n');
        break;
      }
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        out.push('<' + tag);
        if (b.ordered && b.start !== 1) out.push(' start="' + b.start + '"');
        out.push('>\n');
        for (const item of b.children) {
          renderListItem(item, b, refs, out);
        }
        out.push('</' + tag + '>\n');
        break;
      }
      case 'html': {
        // Trailing-newline handling is done by stripHtmlTrailingNewlines
        // before rendering.
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
  const children = item.children;
  if (!list.loose) {
    for (let i = 0; i < children.length; i++) {
      const b = children[i];
      if (b.t === 'p') {
        let text = b.lines.join('\n');
        if (i === 0) {
          const m = /^\[([ xX])\] /.exec(text);
          if (m) {
            const checked = m[1] !== ' ';
            out.push(checked ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ');
            text = text.slice(m[0].length);
          }
        }
        // Tight list: paragraph renders inline with NO trailing newline,
        // even when followed by a nested list/block (cm-307 `foo<ul>`).
        out.push(inline(text, refs));
      } else {
        renderBlocks([b], refs, out);
      }
    }
  } else {
    for (let i = 0; i < children.length; i++) {
      const b = children[i];
      if (b.t === 'p') {
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
  // A table with no body rows has no <tbody> at all (gfm-205).
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
