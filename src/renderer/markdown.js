// ─── DOM-based Markdown Renderer ──────────────────────────────────────────────
// Builds safe DOM nodes — never uses innerHTML with raw text.

function formatAnswer(md) {
  if (!md || typeof md !== 'string') return document.createTextNode('');

  const frag = document.createDocumentFragment();
  const blocks = splitBlocks(md);

  for (const block of blocks) {
    const el = renderBlock(block);
    if (el) frag.appendChild(el);
  }

  return frag;
}

// ─── Block splitter ───────────────────────────────────────────────────────────

function splitBlocks(md) {
  const blocks = [];
  let i = 0;
  const lines = md.split('\n');

  while (i < lines.length) {
    const line = lines[i];

    // Display math $$...$$ or \[...\] (multi-line)
    if (/^\$\$/.test(line) || /^\\\[/.test(line)) {
      const isBracket = /^\\\[/.test(line);
      const endMarker = isBracket ? /^\\\]/ : /^\$\$/;
      const mathLines = [];
      i++; // skip opening $$ or \[
      while (i < lines.length && !endMarker.test(lines[i])) {
        mathLines.push(lines[i]);
        i++;
      }
      i++; // skip closing $$ or \]
      blocks.push({ type: 'math', content: mathLines.join('\n') });
      continue;
    }

    // Fenced code block
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({ type: 'code', lang, content: codeLines.join('\n') });
      continue;
    }

    // Table (detect: current line and next line have pipes)
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') &&
        /\|[\s\-:]+\|/.test(lines[i + 1])) {
      const header = line;
      i++; // skip separator
      i++;
      const rows = [];
      while (i < lines.length && lines[i].includes('|')) {
        rows.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1].length, content: headingMatch[2] });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // Blockquote
    if (/^>\s/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'blockquote', content: quoteLines.join('\n') });
      continue;
    }

    // Unordered list
    if (/^[\-\*]\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^[\-\*]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^[\-\*]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    // Ordered list
    if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    // Blank line — skip
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    // Paragraph — collect consecutive non-empty, non-special lines
    const paraLines = [];
    while (i < lines.length && lines[i].trim() !== '' &&
           !/^```/.test(lines[i]) &&
           !/^(#{1,6})\s/.test(lines[i]) &&
           !/^(---|\*\*\*|___)\s*$/.test(lines[i]) &&
           !/^>\s/.test(lines[i]) &&
           !/^[\-\*]\s/.test(lines[i]) &&
           !/^\d+\.\s/.test(lines[i]) &&
           !(lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && /\|[\s\-:]+\|/.test(lines[i + 1]))) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', content: paraLines.join('\n') });
    }
  }

  return blocks;
}

// ─── Block renderer ───────────────────────────────────────────────────────────

function renderBlock(block) {
  switch (block.type) {
    case 'heading': {
      const el = document.createElement(`h${Math.min(block.level, 6)}`);
      el.className = 'md-heading';
      el.appendChild(renderInline(block.content));
      return el;
    }
    case 'paragraph': {
      const el = document.createElement('p');
      el.className = 'md-paragraph';
      el.appendChild(renderInline(block.content));
      return el;
    }
    case 'code':
      return renderCodeBlock(block.lang, block.content);
    case 'math':
      return renderMath(block.content);
    case 'ul': {
      const el = document.createElement('ul');
      el.className = 'md-list';
      for (const item of block.items) {
        const li = document.createElement('li');
        li.appendChild(renderInline(item));
        el.appendChild(li);
      }
      return el;
    }
    case 'ol': {
      const el = document.createElement('ol');
      el.className = 'md-list';
      for (const item of block.items) {
        const li = document.createElement('li');
        li.appendChild(renderInline(item));
        el.appendChild(li);
      }
      return el;
    }
    case 'table':
      return renderTable(block.header, block.rows);
    case 'blockquote': {
      const el = document.createElement('blockquote');
      el.className = 'md-blockquote';
      el.appendChild(renderInline(block.content));
      return el;
    }
    case 'hr': {
      return document.createElement('hr');
    }
    default:
      return document.createTextNode('');
  }
}

// ─── Code block with copy button ──────────────────────────────────────────────

function renderCodeBlock(lang, code) {
  const wrapper = document.createElement('div');
  wrapper.className = 'code-block';

  const header = document.createElement('div');
  header.className = 'code-block-header';

  const langLabel = document.createElement('span');
  langLabel.className = 'code-lang';
  langLabel.textContent = lang || 'code';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'code-copy-btn';
  copyBtn.textContent = 'copy';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(code).then(() => {
      copyBtn.textContent = 'copied!';
      setTimeout(() => { copyBtn.textContent = 'copy'; }, 1500);
    }).catch(() => {
      copyBtn.textContent = 'failed';
      setTimeout(() => { copyBtn.textContent = 'copy'; }, 1500);
    });
  });

  header.appendChild(langLabel);
  header.appendChild(copyBtn);
  wrapper.appendChild(header);

  const pre = document.createElement('pre');
  const codeEl = document.createElement('code');
  codeEl.textContent = code;
  pre.appendChild(codeEl);
  wrapper.appendChild(pre);

  return wrapper;
}

// ─── Table renderer ───────────────────────────────────────────────────────────

function renderTable(headerRow, bodyRows) {
  const table = document.createElement('table');
  table.className = 'md-table';

  const thead = document.createElement('thead');
  const tr = document.createElement('tr');
  for (const cell of headerRow.split('|').map(c => c.trim()).filter(c => c)) {
    const th = document.createElement('th');
    th.appendChild(renderInline(cell));
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  table.appendChild(thead);

  if (bodyRows.length > 0) {
    const tbody = document.createElement('tbody');
    for (const row of bodyRows) {
      const bodyTr = document.createElement('tr');
      for (const cell of row.split('|').map(c => c.trim()).filter(c => c)) {
        const td = document.createElement('td');
        td.appendChild(renderInline(cell));
        bodyTr.appendChild(td);
      }
      tbody.appendChild(bodyTr);
    }
    table.appendChild(tbody);
  }

  return table;
}

// ─── Inline renderer ──────────────────────────────────────────────────────────

function renderInline(text) {
  const frag = document.createDocumentFragment();

  let i = 0;
  let currentText = '';

  function flushText() {
    if (currentText) {
      frag.appendChild(document.createTextNode(currentText));
      currentText = '';
    }
  }

  // Helper: scan past balanced {} groups starting at idx
  function scanBraces(idx) {
    if (idx >= text.length || text[idx] !== '{') return idx;
    let d = 1;
    idx++;
    while (idx < text.length && d > 0) {
      if (text[idx] === '{') d++;
      if (text[idx] === '}') d--;
      idx++;
    }
    return idx;
  }

  // Helper: scan superscript/subscript after ^ or _
  function scanScript(idx) {
    if (text[idx] === '{') return scanBraces(idx);
    if (idx < text.length && /[a-zA-Z0-9]/.test(text[idx])) return idx + 1;
    return idx;
  }

  while (i < text.length) {
    // --- Math delimiters: \(...\), \[...\], $...$, $$...$$ ---
    let mathDelim = null, mathEnd = null, displayMode = false;
    if (text[i] === '\\' && text[i + 1] === '(') {
      mathDelim = '\\('; mathEnd = '\\)'; displayMode = false;
    } else if (text[i] === '\\' && text[i + 1] === '[') {
      mathDelim = '\\['; mathEnd = '\\]'; displayMode = true;
    } else if (text[i] === '$' && text[i + 1] === '$') {
      mathDelim = '$$'; mathEnd = '$$'; displayMode = true;
      i++; // skip second $
    } else if (text[i] === '$' && text[i + 1] !== '$' && text[i + 1] !== ' ') {
      mathDelim = '$'; mathEnd = '$'; displayMode = false;
    }

    if (mathDelim) {
      const searchFrom = i + mathDelim.length;
      const end = text.indexOf(mathEnd, searchFrom);
      if (end > searchFrom) {
        const inner = text.slice(searchFrom, end);
        // Inline math must be single-line; display math can wrap
        if (displayMode || inner.indexOf('\n') === -1) {
          flushText();
          frag.appendChild(renderInlineMath(inner, displayMode));
          i = end + mathEnd.length;
          continue;
        }
      }
    }

    // --- Bare LaTeX: \cmd or \cmd{...} or \cmd{...}{...} ---
    if (text[i] === '\\' && i + 1 < text.length && /[a-zA-Z]/.test(text[i + 1])) {
      // Remove the \ that was already added to currentText
      if (currentText.endsWith('\\')) {
        currentText = currentText.slice(0, -1);
      }
      const cmdStart = i;
      i++; // backslash
      while (i < text.length && /[a-zA-Z]/.test(text[i])) i++;
      let end = i;

      // Scan brace groups
      while (end < text.length && text[end] === '{') {
        end = scanBraces(end);
      }
      // Scan optional ^ or _ after braces
      while (end < text.length && (text[end] === '^' || text[end] === '_')) {
        end = scanScript(end + 1);
      }

      flushText();
      if (end > i) {
        frag.appendChild(renderInlineMath(text.slice(cmdStart, end)));
        i = end;
        continue;
      }

      // Standalone symbol like \cdot, \pm, \alpha
      frag.appendChild(renderInlineMath(text.slice(cmdStart, i)));
      continue;
    }

    // --- Superscript/Subscript: a^2, x_i, x^{n+1} ---
    if ((text[i] === '^' || text[i] === '_') && i > 0 && /[a-zA-Z0-9)]/.test(text[i - 1])) {
      // Backtrack to include the variable
      let start = i - 1;
      while (start >= 0 && /[a-zA-Z0-9)]/.test(text[start])) start--;
      start++;
      let end = scanScript(i + 1);
      if (end > i + 1) {
        // Remove backtracked chars from currentText to avoid doubling
        const backtrackLen = i - start;
        if (backtrackLen > 0 && currentText.length >= backtrackLen) {
          currentText = currentText.slice(0, currentText.length - backtrackLen);
        }
        flushText();
        frag.appendChild(renderInlineMath(text.slice(start, end)));
        i = end;
        continue;
      }
    }

    // --- Bold **...** ---
    if (text[i] === '*' && text[i + 1] === '*' && text[i + 2] && text[i + 2] !== ' ') {
      const end = text.indexOf('**', i + 2);
      if (end !== -1) {
        flushText();
        const strong = document.createElement('strong');
        strong.appendChild(renderInline(text.slice(i + 2, end)));
        frag.appendChild(strong);
        i = end + 2;
        continue;
      }
    }

    // --- Italic *...* ---
    if (text[i] === '*' && text[i + 1] !== '*' && text[i + 1] !== ' ' &&
        (i === 0 || text[i - 1] !== '*')) {
      const end = text.indexOf('*', i + 1);
      if (end !== -1 && text[end - 1] !== ' ') {
        flushText();
        const em = document.createElement('em');
        em.appendChild(renderInline(text.slice(i + 1, end)));
        frag.appendChild(em);
        i = end + 1;
        continue;
      }
    }

    // --- Inline code `...` ---
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        flushText();
        const code = document.createElement('code');
        code.textContent = text.slice(i + 1, end);
        frag.appendChild(code);
        i = end + 1;
        continue;
      }
    }

    // --- Link [text](url) ---
    if (text[i] === '[') {
      const cb = text.indexOf(']', i);
      const op = text.indexOf('(', cb);
      const cp = text.indexOf(')', op);
      if (cb !== -1 && op === cb + 1 && cp !== -1) {
        flushText();
        const a = document.createElement('a');
        a.className = 'md-link';
        a.textContent = text.slice(i + 1, cb);
        a.href = text.slice(op + 1, cp);
        a.target = '_blank';
        a.rel = 'noopener';
        frag.appendChild(a);
        i = cp + 1;
        continue;
      }
    }

    // --- Line break ---
    if (text[i] === '\n') {
      flushText();
      frag.appendChild(document.createElement('br'));
      i++;
      continue;
    }

    currentText += text[i];
    i++;
  }

  flushText();
  return frag;
}

// ─── Math rendering (KaTeX) ──────────────────────────────────────────────────

function renderMath(latex) {
  const wrapper = document.createElement('div');
  wrapper.className = 'math-block';

  try {
    if (typeof katex !== 'undefined') {
      const html = katex.renderToString(latex.trim(), {
        displayMode: true,
        throwOnError: false
      });
      wrapper.innerHTML = html;
    } else {
      wrapper.textContent = '$$ ' + latex.trim() + ' $$';
      wrapper.className += ' math-fallback';
    }
  } catch (e) {
    wrapper.textContent = '$$ ' + latex.trim() + ' $$';
    wrapper.className += ' math-fallback';
  }

  return wrapper;
}

function renderInlineMath(latex, displayMode) {
  const wrapper = displayMode ? document.createElement('div') : document.createElement('span');
  wrapper.className = displayMode ? 'math-block' : 'math-inline';

  try {
    if (typeof katex !== 'undefined') {
      const html = katex.renderToString(latex.trim(), {
        displayMode: !!displayMode,
        throwOnError: false
      });
      wrapper.innerHTML = html;
    } else {
      const delim = displayMode ? '$$' : '$';
      wrapper.textContent = delim + ' ' + latex.trim() + ' ' + delim;
      wrapper.className += ' math-fallback';
    }
  } catch (e) {
    const delim = displayMode ? '$$' : '$';
    wrapper.textContent = delim + ' ' + latex.trim() + ' ' + delim;
    wrapper.className += ' math-fallback';
  }

  return wrapper;
}

// ─── Export ───────────────────────────────────────────────────────────────────

// Make it available globally for renderer.js
window.formatAnswer = formatAnswer;
