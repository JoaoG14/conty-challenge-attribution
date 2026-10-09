## Nota para quem avalia

Comece por `src/attribution.ts` e `test/attribution.test.ts`. Vence o último toque válido antes do cadastro; em empate de horário, vence o primeiro gravado. Sem toque válido, o cadastro fica como orgânico. A decisão salva todos os toques considerados e o motivo de cada resultado.

Toque e cadastro precisam ocorrer antes de completar sete dias da primeira abertura. Reabrir o app não renova esse prazo, e links recebidos após o cadastro não alteram a origem.

Com mais tempo, implementaria:

- Integração com Universal Links/App Links e emissão de um ID por clique
- Entrega offline e atribuição após passar pela loja de apps
- Autenticação da API, validação das campanhas e criadores e assinatura dos links

Defini a arquitetura e o escope e a IA implementou e escreveu os testes

Revisei se o último toque válido vence e se o empate favorece o primeiro gravado. Também conferi se cliques repetidos não duplicam a origem. Tambem removi testes que cobriam os mesmos casos

## Como rodar

Node 22 atualizado (22.13 ou superior).

```bash
npm ci
npm test
npm run typecheck
npm run dev
```

A API sobe em `http://127.0.0.1:3004`
O banco fica em `data/attribution.sqlite`

## Exemplo de Request e Response

O link carrega `type` (`campaign` ou `referral`), `source_id` (campanha ou criador que indicou) e `click_id`. Não depende do header `Referer`, que pode faltar no webview. Estes são exemplos já resolvidos; o domínio `.test` é demonstrativo:

```text
https://app.conty.test/open?type=campaign&source_id=cmp_01&click_id=click_01
https://app.conty.test/open?type=referral&source_id=crt_01&click_id=click_02
```

Um novo clique recebe outro `click_id`; reenviar o mesmo clique mantém o ID. Em produção, o serviço de redirecionamento emitiria esse ID antes de abrir o app.

Na primeira abertura, o app deve gerar e guardar um `installation_id` local, chamar `POST /opens` e guardar a resposta. O servidor grava `first_opened_at`, `expires_at` e o toque, quando houver. Nas próximas aberturas e no cadastro, o app reutiliza a mesma instalação. Uma abertura direta omite `link` e também inicia a janela.

Nesta API, a abertura é o recebimento de `/opens` pelo servidor. As datas são geradas pelo servidor, em UTC; datas enviadas pelo cliente são ignoradas. O exemplo pressupõe o app online e enviando os eventos em ordem. Não há cliente mobile implementado, e `/signups` representa a conclusão do cadastro, sem criar conta ou login.

Registre a primeira abertura por campanha:

```bash
curl -s -X POST localhost:3004/opens \
  -H 'content-type: application/json' \
  -d '{"installation_id":"install_01","link":"https://app.conty.test/open?type=campaign&source_id=cmp_01&click_id=click_01"}'
```

A resposta `200` traz `status: "recorded"`, os dados da instalação em `installation` e o clique em `touch`. Repetir esse clique retorna `status: "duplicate"`, sem duplicar nem atualizar sua data. Reutilizar o `click_id` com outra origem retorna `409`.

Registre outro link antes do cadastro, agora por indicação, e conclua o cadastro:

```bash
curl -s -X POST localhost:3004/opens \
  -H 'content-type: application/json' \
  -d '{"installation_id":"install_01","link":"https://app.conty.test/open?type=referral&source_id=crt_01&click_id=click_02"}'

curl -s -X POST localhost:3004/signups \
  -H 'content-type: application/json' \
  -d '{"installation_id":"install_01","user_id":"user_01"}'
```

Resposta `200`. As datas abaixo ilustram a sequência; na execução são geradas pelo servidor. Os IDs dos toques são sequenciais no banco:

```json
{
  "user_id": "user_01",
  "installation_id": "install_01",
  "signed_up_at": "2026-10-09T14:00:00.000Z",
  "first_opened_at": "2026-10-09T12:00:00.000Z",
  "expires_at": "2026-10-16T12:00:00.000Z",
  "rule": "last_touch_v1",
  "origin": "referral",
  "source_id": "crt_01",
  "reason": "attributed",
  "touches": [
    {
      "id": 2,
      "click_id": "click_02",
      "type": "referral",
      "source_id": "crt_01",
      "opened_at": "2026-10-09T13:00:00.000Z",
      "won": true,
      "reason": "winner"
    },
    {
      "id": 1,
      "click_id": "click_01",
      "type": "campaign",
      "source_id": "cmp_01",
      "opened_at": "2026-10-09T12:00:00.000Z",
      "won": false,
      "reason": "earlier_touch"
    }
  ]
}
```

Consulte a decisão e envie um link depois do cadastro. Os próximos exemplos usam `jq` só para mostrar os campos principais da resposta:

```bash
curl -s localhost:3004/signups/user_01 \
  | jq '{origin, source_id, reason}'
# {"origin":"referral","source_id":"crt_01","reason":"attributed"}

curl -s -X POST localhost:3004/opens \
  -H 'content-type: application/json' \
  -d '{"installation_id":"install_01","link":"https://app.conty.test/open?type=campaign&source_id=cmp_02&click_id=click_03"}'
# {"status":"ignored","reason":"after_signup"}
```

Repetir o cadastro com o mesmo usuário e instalação devolve a decisão salva, mesmo depois do prazo. A API aceita um cadastro por instalação e uma instalação por usuário; tentar reutilizar um deles em outro cadastro retorna `409`.

Para um cadastro orgânico, registre uma abertura sem link e conclua o cadastro:

```bash
curl -s -X POST localhost:3004/opens \
  -H 'content-type: application/json' \
  -d '{"installation_id":"install_02"}'

curl -s -X POST localhost:3004/signups \
  -H 'content-type: application/json' \
  -d '{"installation_id":"install_02","user_id":"user_02"}' \
  | jq '{origin, source_id, reason, touches}'
# {"origin":"organic","source_id":null,"reason":"no_touch","touches":[]}
```

Na auditoria, `earlier_touch` indica um toque mais antigo; `tie_lost`, um empate perdido; `outside_window`, um toque fora da janela; `signup_after_window`, um toque dentro da janela cujo cadastro ocorreu após o prazo; e `after_signup`, um toque com data posterior à do cadastro. A resposta lista os toques por data decrescente e, em empate, por ID crescente.

Para cadastros orgânicos, `no_touch` indica ausência de toques, `window_expired` indica que havia toques mas o cadastro ocorreu após o prazo, e `no_eligible_touch` cobre toques sem elegibilidade temporal, por exemplo após um ajuste do relógio do servidor.

Corpo ou link inválido retorna `400` sem gravar nada. Cadastro sem primeira abertura ou com conflito de identidade retorna `409`. Consulta de cadastro inexistente retorna `404`. Um link válido recebido fora da janela é gravado para auditoria, mas não pode vencer.
