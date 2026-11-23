function narrativeClauses(prose: string) {
  const unquoted = prose.replace(/“[^”]*”|"[^"]*"|«[^»]*»/gu, ' ').replace(/^\s*[—–-]\s+.+$/gmu, ' ');
  const normalized = unquoted.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return normalized.match(/[^.!?;\n]+[.!?;]?/gu) ?? [];
}

// Generated prose never carries authority to add a consequence. This guard
// catches explicit present-tense assertions; it is not a parser or a fact checker.
export function claimsUnconfirmedPlayerConsequence(prose: string) {
  return narrativeClauses(prose).some((clause) => {
    if (clause.endsWith('?') || /\b(?:caso|se(?!\s+compromete\b))\b/u.test(clause)) return false;
    return /(?:^|\be)\s*(?:samuel|voce|o protagonista)\s+(?:(?:ja|agora|entao|logo)\s+)*(?:entrega|pega|recolhe|larga|compra|vende|transfere|recebe|guarda|decide|escolhe|promete|aceita|recusa|compromete-se|se compromete|diz|responde|sai|entra|chega|volta|parte|abre|fecha|organiza|espera|aguarda|sente|pensa)\b/u.test(clause);
  });
}

export function narratedObjectTransition(prose: string, objects: readonly { name: string; aliases: readonly string[] }[]) {
  let ambiguous = false;
  const labels = objects.map(({ name, aliases }) => [name, ...aliases].map((label) =>
    label.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()));
  for (const clause of narrativeClauses(prose)) {
    if (clause.endsWith('?') ||
        /\b(?:se|caso|talvez|quando|como se|lembra|recorda|ontem|outrora|antigamente|naquele dia|naquela epoca)\b/u.test(clause)) continue;
    for (const match of clause.matchAll(/\b(?:abre|fecha|escancara)\s+(?:\p{L}+mente\s+)?(?:o|a|os|as)\s+([^,]+)/gu)) {
      const prefix = clause.slice(0, match.index).split(/,|\be\b/u).at(-1)!;
      if (/\b(?:nao|nem|nunca|jamais|diz|pergunta|sugere|propoe|afirma|imagina|pensa|pede)\b/u.test(prefix)) continue;
      const target = match[1];
      const matches = labels.map((names) => Math.max(0, ...names.filter((name) =>
        target.startsWith(name) && !/^[\p{L}\p{N}]/u.test(target.slice(name.length))).map((name) => name.length)));
      const longest = Math.max(0, ...matches);
      if (longest && matches.filter((length) => length === longest).length === 1) return 'unconfirmed';
      if (longest) ambiguous = true;
    }
  }
  return ambiguous ? 'ambiguous' : undefined;
}
