Lithic API responses for the settlement tests, from the examples in Lithic's OpenAPI document
(`lithic-com/lithic-openapi` at `8e799c885838b51938491915955488b3a907afb1`):

- `transaction-settled.json`: the `card_transaction` example, with `status` `SETTLED` and its amounts
  set to the 94.00 USD settlement of the test purchase.
- `card.json`: the required fields of `non_pci_card_response` at their example values, with the
  transaction's card token and the memo the API gives a purchase's single-use card.
