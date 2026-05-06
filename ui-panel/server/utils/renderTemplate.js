const fs = require('fs');
const YAML = require('yaml');

// ---------- Placeholder substitution ----------
//
// Syntax: ${VAR_NAME}  (uppercase + digits + underscore)
// Rules:
//   - Fully-matching scalar "${VAR}": replaced with the raw value.
//       • If the template quoted it ("${VAR}"), output is forced to string.
//       • If unquoted (${VAR}), output uses the value's native type (number/bool/string).
//   - Partial match inside a longer string: every ${VAR} replaced with String(value).
//   - Any ${VAR} whose key is not in `values` throws.
//
const PLACEHOLDER_FULL = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;
const PLACEHOLDER_ANY = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

function substitutePlaceholders(doc, values) {
  YAML.visit(doc, {
    Scalar(_key, node) {
      if (typeof node.value !== 'string') return;

      const full = node.value.match(PLACEHOLDER_FULL);
      if (full) {
        const key = full[1];
        if (!(key in values)) throw new Error(`Missing placeholder value: ${key}`);
        const wasQuoted = node.type === 'QUOTE_DOUBLE' || node.type === 'QUOTE_SINGLE';
        if (wasQuoted) {
          // Template author wrote "${VAR}" — keep it a string regardless of value type
          node.value = String(values[key]);
          return;
        }
        // Unquoted — replace with a fresh node so type (number/bool/null/string) is inferred
        return doc.createNode(values[key]);
      }

      if (node.value.includes('${')) {
        node.value = node.value.replace(PLACEHOLDER_ANY, (_, k) => {
          if (!(k in values)) throw new Error(`Missing placeholder value: ${k}`);
          return String(values[k]);
        });
      }
    },
  });
}

// ---------- Structural patches ----------
//
// Paths are arrays of strings/numbers, mirroring yaml's getIn/setIn/deleteIn.
// Example: ['spec', 'worker', 'resources', 'requests', 'nvidia.com/gpumem']
//
const patches = {
  set: (path, value) => ({ op: 'set', path, value }),
  remove: (path) => ({ op: 'remove', path }),
  merge: (path, value) => ({ op: 'merge', path, value }),
  append: (path, value) => ({ op: 'append', path, value }),
  prepend: (path, value) => ({ op: 'prepend', path, value }),
};

function applyPatch(doc, p) {
  switch (p.op) {
    case 'set':
      doc.setIn(p.path, p.value);
      return;

    case 'remove':
      doc.deleteIn(p.path);
      return;

    case 'merge': {
      const existing = doc.getIn(p.path, true);
      if (existing && YAML.isMap(existing)) {
        for (const [k, v] of Object.entries(p.value)) {
          existing.set(k, doc.createNode(v));
        }
      } else {
        doc.setIn(p.path, p.value);
      }
      return;
    }

    case 'append': {
      const existing = doc.getIn(p.path, true);
      if (existing && YAML.isSeq(existing)) {
        existing.add(doc.createNode(p.value));
      } else {
        doc.setIn(p.path, [p.value]);
      }
      return;
    }

    case 'prepend': {
      const existing = doc.getIn(p.path, true);
      if (existing && YAML.isSeq(existing)) {
        existing.items.unshift(doc.createNode(p.value));
      } else {
        doc.setIn(p.path, [p.value]);
      }
      return;
    }

    default:
      throw new Error(`Unknown patch op: ${p.op}`);
  }
}

// ---------- Public API ----------

function renderTemplate(templatePath, { values = {}, patches: patchList = [] } = {}) {
  const source = fs.readFileSync(templatePath, 'utf8');
  const doc = YAML.parseDocument(source);

  if (doc.errors.length > 0) {
    throw new Error(`Template parse error in ${templatePath}: ${doc.errors[0].message}`);
  }

  substitutePlaceholders(doc, values);
  for (const p of patchList) applyPatch(doc, p);

  const rendered = doc.toString({ lineWidth: 0 });

  // Leak check — ignore comment lines; they're documentation, not output.
  const nonComment = rendered
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  const leaked = [...nonComment.matchAll(PLACEHOLDER_ANY)].map((m) => m[1]);
  if (leaked.length > 0) {
    const unique = [...new Set(leaked)];
    throw new Error(
      `Unsubstituted placeholders in ${templatePath}: ${unique.join(', ')}. ` +
      `Provide them in values or use a patch.`
    );
  }

  return rendered;
}

module.exports = { renderTemplate, patches };
