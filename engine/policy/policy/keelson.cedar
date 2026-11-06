@id("base") @field("agent") @color("green")
permit(principal, action == Keelson::Action::"checkout", resource) when { resource.agent == principal };
@id("agent") @field("agent") @color("green")
forbid(principal, action == Keelson::Action::"checkout", resource) unless { resource.agent == principal };
@id("sanity") @field("cart") @color("green")
forbid(principal, action == Keelson::Action::"checkout", resource) when { context.total_minor < 0 || context.max_line_qty < 1 || context.max_unit_minor < 0 };
@id("currency") @field("currency") @color("green")
forbid(principal, action == Keelson::Action::"checkout", resource) unless { context.currency == resource.currency };
@id("amount") @field("total") @color("green")
forbid(principal, action == Keelson::Action::"checkout", resource) unless { context.total_minor <= resource.max_total_minor };
@id("budget") @field("budget") @color("green")
forbid(principal, action == Keelson::Action::"checkout", resource) unless { context.total_minor <= resource.budget_left_minor };
@id("merchant") @field("merchant") @color("green")
forbid(principal, action == Keelson::Action::"checkout", resource) unless { resource.merchants.contains(context.merchant) };
@id("window") @field("deadline") @color("green")
forbid(principal, action == Keelson::Action::"checkout", resource) unless { context.now_ms >= resource.not_before_ms && context.now_ms < resource.expires_at_ms };
@id("quantity") @field("quantity") @color("green")
forbid(principal, action == Keelson::Action::"checkout", resource) unless { context.max_line_qty <= resource.max_qty_per_line };
@id("category") @field("category") @color("amber")
forbid(principal, action == Keelson::Action::"checkout", resource) unless { resource.categories.containsAll(context.categories) };
@id("variant") @field("variant") @color("amber")
forbid(principal, action == Keelson::Action::"checkout", resource) unless { resource.variants.containsAll(context.variants) };
@id("returns") @field("return_policy") @color("amber")
forbid(principal, action == Keelson::Action::"checkout", resource) unless { context.return_days >= resource.min_return_days };
@id("returns_free") @field("return_policy") @color("amber")
forbid(principal, action == Keelson::Action::"checkout", resource) unless { !resource.returns_free_required || context.returns_free };
