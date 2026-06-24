/*
 * Minimal parser for the `INSERT INTO <table> VALUES (...),(...);` rows found in
 * the LandSandBoat SQL dumps. We can't run the dump through a MySQL engine, so
 * we tokenize the VALUES tuples ourselves.
 *
 * Handles:
 *   - single-quoted strings with '' and \' escapes (commas inside are ignored)
 *   - NULL  -> null
 *   - numbers -> Number
 *   - bare tokens / @CONSTANT | @CONSTANT expressions -> kept as trimmed string
 *
 * It does NOT evaluate the @CONSTANT tokens (e.g. @FLAG_EX) — callers only read
 * numeric/string columns, so unparsed flag expressions are returned verbatim.
 */

/**
 * Yield each VALUES tuple (as an array of cells) for INSERT statements that
 * target `tableName`. Streams line-aware over the whole file text.
 * @param {string} sql
 * @param {string} tableName
 * @returns {Generator<Array<string|number|null>>}
 */
export function* parseInserts(sql, tableName) {
  // Match the `... VALUES` prefix for the target table (case/backtick tolerant).
  const re = new RegExp(
    `INSERT\\s+INTO\\s+\`?${tableName}\`?\\s*(?:\\([^)]*\\))?\\s*VALUES`,
    'ig'
  );
  let m;
  while ((m = re.exec(sql)) !== null) {
    // Parse tuples starting right after the VALUES keyword, up to the ending ';'.
    let i = m.index + m[0].length;
    const end = sql.indexOf(';', i);
    const segment = sql.slice(i, end === -1 ? sql.length : end);
    yield* parseTuples(segment);
    re.lastIndex = end === -1 ? sql.length : end;
  }
}

function* parseTuples(segment) {
  let i = 0;
  const n = segment.length;
  while (i < n) {
    // Advance to the next '('.
    while (i < n && segment[i] !== '(') i++;
    if (i >= n) break;
    i++; // skip '('
    const cells = [];
    let cur = '';
    let inStr = false;

    while (i < n) {
      const c = segment[i];
      if (inStr) {
        if (c === '\\') {
          cur += c + (segment[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (c === "'") {
          if (segment[i + 1] === "'") {
            // escaped quote inside string
            cur += "''";
            i += 2;
            continue;
          }
          inStr = false;
          cur += c;
          i++;
          continue;
        }
        cur += c;
        i++;
        continue;
      }

      if (c === "'") {
        inStr = true;
        cur += c;
        i++;
        continue;
      }
      if (c === ',') {
        cells.push(coerce(cur));
        cur = '';
        i++;
        continue;
      }
      if (c === ')') {
        cells.push(coerce(cur));
        i++;
        yield cells;
        break;
      }
      cur += c;
      i++;
    }
  }
}

function coerce(raw) {
  const t = raw.trim();
  if (t === '') return null;
  if (/^NULL$/i.test(t)) return null;
  if (t[0] === "'" && t[t.length - 1] === "'") {
    return t
      .slice(1, -1)
      .replace(/''/g, "'")
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t; // bare token or @CONST | @CONST expression
}
