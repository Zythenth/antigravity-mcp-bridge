# Skills for the delegate

Reference for the [core skill](../SKILL.md). Open it when passing `skills` to the delegate or on `CRAFT_SNAPSHOT_INVALID` or `CRAFT_SNAPSHOT_MISSING`.

## Fornecer skills ao Gemini

Quando o usuário pedir uma skill na delegação, leia sua definição e os recursos necessários e forneça somente os pacotes selecionados em `antigravity_run.skills`: `[{ name, content, resources?: [{ path, content }] }]`. `content` é o texto completo de `SKILL.md`; cada recurso usa um caminho relativo à pasta da skill e conteúdo UTF-8. Não importe todas as skills globais nem envie instruções privadas, credenciais ou documentos internos. Dependências de conectores ou ferramentas do Codex não passam a existir no agy só porque a skill foi copiada.

O bridge conserva o nome e conteúdo, prepara os arquivos em `.agents/skills/<nome-em-minúsculas>/` na cópia e pede ao CLI para carregá-los. Até 8 pacotes, 100 recursos por skill e 1 MiB no total, também sujeitos aos limites da cópia. Os metadados `providedSkills` devolvem nomes e hashes; no modo compacto, `providedSkillSummaries` informa nomes, hashes e contagens sem listas extensas de arquivos. A retomada mantém esses arquivos; não passe `skills` novamente. Alterações nos pacotes bloqueiam verificação/integração. Os auxiliares não são integrados ao original e não ampliam permissões.

## Anti-AI Craft incluído

Em tarefas novas, o bridge prepara automaticamente `anti-ai-code` e `anti-ai-security` e oferece as demais skills do Anti-AI Craft como catálogo somente leitura; não as envie de novo em `skills` nem peça ao usuário para repetir os nomes. Elas ocupam duas das oito vagas de pacotes. Confira `task.craft` (revisão, permanentes e catálogo). `CRAFT_SNAPSHOT_INVALID` ou `CRAFT_SNAPSHOT_MISSING` indicam instalação adulterada ou incompleta: oriente a reinstalar o bridge, sem baixar outra revisão. Declaração do Gemini de ter lido uma skill não comprova a leitura; consulte os eventos de ferramentas quando a evidência importar.
