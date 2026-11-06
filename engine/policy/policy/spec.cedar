// The mandate rules as one statement: a checkout is allowed exactly when every rule holds.
@id("spec")
permit (
  principal,
  action == Keelson::Action::"checkout",
  resource
)
when {
  // Only the agent the mandate names may spend it.
  principal == resource.agent &&
  // The cart is well formed: no negative amounts, at least one unit on every line.
  0 <= context.total_minor &&
  1 <= context.max_line_qty &&
  0 <= context.max_unit_minor &&
  // Same currency as the mandate.
  resource.currency == context.currency &&
  // The total stays within the per-purchase maximum and the budget left.
  resource.max_total_minor >= context.total_minor &&
  resource.budget_left_minor >= context.total_minor &&
  // The merchant is one the mandate allows.
  resource.merchants.contains(context.merchant) &&
  // Inside the window [not_before, expires_at).
  resource.not_before_ms <= context.now_ms &&
  context.now_ms < resource.expires_at_ms &&
  // No line exceeds the quantity the mandate allows.
  resource.max_qty_per_line >= context.max_line_qty &&
  // Every category and variant in the cart is allowed.
  resource.categories.containsAll(context.categories) &&
  resource.variants.containsAll(context.variants) &&
  // The return policy is long enough, and free when the mandate requires it.
  resource.min_return_days <= context.return_days &&
  (context.returns_free || !resource.returns_free_required)
};
