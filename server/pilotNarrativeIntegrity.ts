// Generated prose never carries authority to add a consequence. This guard
// catches explicit present-tense assertions; it is not a parser or a fact checker.
export function claimsUnconfirmedPlayerConsequence(prose: string) {
  const unquoted = prose.replace(/“[^”]*”|"[^"]*"|«[^»]*»/gu, ' ').replace(/^\s*[—–-]\s+.+$/gmu, ' ');
  const normalized = unquoted.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const clauses = normalized.match(/[^.!?;\n]+[.!?;]?/gu) ?? [];
  return clauses.some((clause) => {
    if (clause.endsWith('?') || /\b(?:caso|se(?!\s+compromete\b))\b/u.test(clause)) return false;
    return /(?:^|\be)\s*(?:samuel|voce|o protagonista)\s+(?:(?:ja|agora|entao|logo)\s+)*(?:entrega|pega|recolhe|larga|compra|vende|transfere|recebe|guarda|decide|escolhe|promete|aceita|recusa|compromete-se|se compromete|diz|responde|sai|entra|chega|volta|parte|abre|fecha|organiza|espera|aguarda|sente|pensa)\b/u.test(clause);
  });
}
