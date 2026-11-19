export function reviewEchoArcNarration(text: string): string[] {
  const flags: string[] = [];
  const patterns: Array<[string, RegExp]> = [
    ['revisar_acao_com_consequencia', /\bSamuel\s+(?:prometeu|aceitou|decidiu|(?:pegou|levou|carregou|entregou) (?:duas tigelas|as sacas|a encomenda))\b/iu],
    ['movimento_ou_postura', /\b(?:(?:Samuel|o jovem)(?: |,[^.!?\n]{1,85}, )(?:se aproxim\w*|cruz\w* o tapete|avan\p{L}* um passo|se encost\w*)|Samuel permanece[^.!?\n]{0,65}encostado)\b/iu],
    ['gesto_voluntario', /\bSamuel(?:,\s+que)?\s+(?:(?:ainda|j[áa])\s+)?(?:segur(?:a|ou|ava)|ergu(?:e|eu|ia) (?:a|uma) m[ãa]o|cruz(?:a|ou|ava) os bra[çc]os|apert(?:a|ou|ava) os punhos|se vir(?:a|ou|ava))\b/iu],
    ['reacao_emocional_atribuida', /\bSamuel\s+(?:observ(?:a|ou|ava)|olh(?:a|ou|ava))\s*,?\s+(?:satisfeito|aliviado|preocupado|ansioso)\b/iu],
    ['atencao_atribuida', /\b(?:olhar|brilho|express[ãa]o) (?:atent[oa]|absort[oa]|distra[íi]d[oa]) de Samuel\b/iu],
    ['acao_passada', /\bSamuel (?:trouxe|comprou|prometeu|decidiu)\b/i],
    ['estado_interno', /\b(?:Samuel (?:sente|sentiu|pensa|pensou|pensava|pondera|ponderou|ponderava|conclui|concluiu|concluía|lembra|lembrou|absorve)\b|(?:sua mente vagueie|anotando mentalmente)\b)/i],
    ['olhar_intencional', /\bSamuel\b[^.!?\n]{0,90}(?:\bos olhos fixos\b|\bfix(?:a|ava|ou) o olhar\b)/iu],
    ['percepcao_interna', /\bSamuel\s+(?:ainda\s+)?(?:n(?:ã|a)o\s+)?(?:percebeu|percebia|percebe|compreendeu|compreendia)\b/iu],
    ['postura_inclinada', /\bSamuel(?:,\s+que)?\s+(?:se inclin(?:a|ava|ou)|estava inclinado)\b/iu],
    ['revisar_escalada_de_trama', /(?=[\s\S]*(?:Academia de Arvend))(?=[\s\S]*(?:comissionamento|recrutamento))(?=[\s\S]*(?:viajantes|preparar armas|produzir armas))/iu],
    ['revisar_coerencia_fisica', /rel[oó]gio de sol[^.!?\n]{0,90}ponteiros de sombra/iu],
    ['pergunta_metanarrativa', /(?:^|\n)[ \t]*(?:\*\*)?o que (?:Samuel|voc\u00ea) (?:faz|far\u00e1|decide fazer)[^?\n]{0,30}\?(?:\*\*)?\s*$/i],
  ];
  for (const [flag, pattern] of patterns) if (pattern.test(text)) flags.push(flag);
  return flags;
}
