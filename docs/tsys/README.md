# TSYS / TransIT API 3.0 reference

Text dumps of the Global Payments TransIT API 3.0 spec pages, pulled 2026-11-05
from `https://developerportal.transit-pass.com/developerportal/resources/dist/assets/build/api/<page>/index.html`
(public, no sign-in). Re-pull with curl and strip tags if a page changes.

| file | page |
|---|---|
| Overview, Authentication, API3.0_Authentication_GenerateKey | endpoints, deviceID + transactionKey / manifest, GenerateKey |
| CreditServices_Auth / Sale / Capture, API3.0_CreditServices_Return / ForcedAuth / CardVerification | credit messages |
| Other_Payment_Services_Void / TipAdjustment, API3.0_Other_Payment_Services_TransactionAdjustment / GenerateReceipt | post-auth messages |
| ValueAddedServices_IncrementalAuth, API3.0_ValueAddedServices_Tokenization / THIP | bar-tab increments, tokens |
| API3.0_ResponseCodes, API3.0_Appendix | A/D/E/F code families, AVS codes |
| API3.0_UseCases_Resturant | certification use cases (restaurant tip adjust, auth+capture, partial approval) |
| API3.0_Product_OpenOrder, TSEP_Overview, API3.0_DebitServices_DebitSale | not used by the driver |

Not fetched (paths unknown): the reporting messages (ConciseTransactionDetailsReport
etc.) and BatchClose. Add them when a status lookup by externalReferenceID is wanted.

## Driver: `src/payments/tsys.ts`

Endpoints: UAT `https://stagegw.transnox.com/servlets/Transnox_API_server/<Op>`,
production `https://gateway.transit-pass.com/servlets/TransNox_API_Server/<Op>`,
chosen by Store `cc_test_mode` / bundle `testMode`. XML with `Content-Type: text/xml`;
field order follows the spec tables; amounts always carry a decimal point.

Back-office bundle (MerchantPassword JSON, non-secret): `mid`, `deviceId`, `developerId`,
`testMode`, optional `tokens: true` to ask for a TransIT token on every payment (bar tabs;
needs in-house tokenization enabled on the merchant).

Transaction key: merchant-level, never expires, secret. Stored per terminal in local
storage (`apos.payments.tsys.keys.v1`, keyed by MID) by `provisionTsysKey(cfg, userID,
password)` (GenerateKey; the credentials are used once and not stored) or `setTsysKey`.
No UI is wired for this yet.

| seam op | TransIT message | notes |
|---|---|---|
| authorize | Auth | keyed (MANUAL) or stored token; `partialAuthSupport YES`, `authorizationIndicator PREAUTH` |
| sale | Sale | same, tip included |
| capture | Capture | base + tip |
| adjust | TipAdjustment / partial Void | tip change; smaller base voids the difference (PARTIAL_REVERSAL); larger base refused |
| increment | IncrementalAuth | sends the increment, reads `totalAmount` |
| cancel | Void | full (POST_AUTH_USER_DECLINE) or partial with amount |
| refund | Return with reference | A0014 = TransIT voided instead (unsettled) |
| status | local replay | TransIT answers synchronously; the last result per transactionID is kept per terminal |
| tokenize | GetOnusToken | keyed card → token |

Card-present entry (swipe / dip / tap) needs the payment device. Until that integration
lands, authorize / sale / tokenize without keyed data or a token return an error.
