use keelson_policy::{
    Attribution, Facts, Liable, RULES, Reason, attribute, attribution_policy_text, attribution_sets,
};

/// A dispute where every proof checks out and the cart met every field of the mandate.
fn clean(reason: Reason) -> Facts {
    Facts {
        reason,
        proof_valid: true,
        failed_green: false,
        failed_amber: false,
        failed_gray: false,
        captured_eq_countersigned: true,
        duplicate_countersig: false,
        duplicate_capture: false,
        tracking_delivered: false,
        snapshot_matches_item: true,
        refund_recorded: false,
    }
}

fn expect(facts: &Facts, rule: u8, liable: Liable) {
    assert_eq!(
        attribute(facts).unwrap(),
        Attribution { rule, liable },
        "{facts:?}"
    );
}

#[test]
fn every_rule_attributes_its_party() {
    use Reason::*;
    let cases: Vec<(Facts, u8, Liable)> = vec![
        (
            Facts {
                proof_valid: false,
                ..clean(Unauthorised)
            },
            0,
            Liable::Operator,
        ),
        (
            Facts {
                tracking_delivered: true,
                ..clean(MerchandiseOrServiceNotReceived)
            },
            10,
            Liable::User,
        ),
        (clean(MerchandiseOrServiceNotReceived), 11, Liable::Merchant),
        (
            Facts {
                refund_recorded: true,
                ..clean(CreditNotProcessed)
            },
            20,
            Liable::User,
        ),
        (clean(CreditNotProcessed), 21, Liable::Merchant),
        (
            Facts {
                duplicate_countersig: true,
                ..clean(DuplicateTransaction)
            },
            30,
            Liable::Keelson,
        ),
        (
            Facts {
                duplicate_capture: true,
                ..clean(DuplicateTransaction)
            },
            31,
            Liable::Operator,
        ),
        (clean(DuplicateTransaction), 32, Liable::User),
        (clean(PaymentByOtherMeans), 35, Liable::Merchant),
        (clean(CanceledRecurringBilling), 35, Liable::Merchant),
        (clean(ProblemWithRemittance), 35, Liable::Merchant),
        (
            Facts {
                captured_eq_countersigned: false,
                ..clean(IncorrectAmount)
            },
            40,
            Liable::Merchant,
        ),
        (
            Facts {
                snapshot_matches_item: false,
                ..clean(MerchandiseOrServiceNotAsDescribed)
            },
            50,
            Liable::Merchant,
        ),
        (
            Facts {
                failed_green: true,
                ..clean(Unauthorised)
            },
            60,
            Liable::Keelson,
        ),
        (
            Facts {
                failed_amber: true,
                ..clean(Unauthorised)
            },
            61,
            Liable::Operator,
        ),
        (
            Facts {
                failed_gray: true,
                ..clean(Other)
            },
            62,
            Liable::User,
        ),
        (clean(Unauthorised), 70, Liable::User),
        (clean(IncorrectAmount), 70, Liable::User),
        (clean(MerchandiseOrServiceNotAsDescribed), 70, Liable::User),
        (clean(Other), 70, Liable::User),
    ];
    for (facts, rule, liable) in &cases {
        expect(facts, *rule, *liable);
    }
    let covered: std::collections::BTreeSet<u8> = cases.iter().map(|c| c.1).collect();
    let all: std::collections::BTreeSet<u8> = RULES.iter().map(|r| r.id).collect();
    assert_eq!(covered, all, "every rule has a case");
}

#[test]
fn earlier_rules_take_precedence() {
    use Reason::*;
    let everything = |reason| Facts {
        proof_valid: false,
        failed_green: true,
        failed_amber: true,
        failed_gray: true,
        captured_eq_countersigned: false,
        duplicate_countersig: true,
        duplicate_capture: true,
        tracking_delivered: true,
        snapshot_matches_item: false,
        refund_recorded: true,
        ..clean(reason)
    };
    expect(&everything(Unauthorised), 0, Liable::Operator);

    let valid = |reason| Facts {
        proof_valid: true,
        ..everything(reason)
    };
    expect(&valid(MerchandiseOrServiceNotReceived), 10, Liable::User);
    expect(&valid(CreditNotProcessed), 20, Liable::User);
    expect(&valid(DuplicateTransaction), 30, Liable::Keelson);
    expect(&valid(IncorrectAmount), 40, Liable::Merchant);
    expect(
        &valid(MerchandiseOrServiceNotAsDescribed),
        50,
        Liable::Merchant,
    );
    expect(&valid(Unauthorised), 60, Liable::Keelson);
    expect(
        &Facts {
            failed_green: false,
            ..valid(Unauthorised)
        },
        61,
        Liable::Operator,
    );
    expect(
        &Facts {
            duplicate_countersig: false,
            ..valid(DuplicateTransaction)
        },
        31,
        Liable::Operator,
    );
}

#[test]
fn reasons_are_paypal_dispute_reasons() {
    let names = [
        "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
        "UNAUTHORISED",
        "CREDIT_NOT_PROCESSED",
        "DUPLICATE_TRANSACTION",
        "INCORRECT_AMOUNT",
        "PAYMENT_BY_OTHER_MEANS",
        "CANCELED_RECURRING_BILLING",
        "PROBLEM_WITH_REMITTANCE",
        "OTHER",
    ];
    assert_eq!(Reason::ALL.len(), names.len());
    for (reason, name) in Reason::ALL.iter().zip(names) {
        assert_eq!(serde_json::to_value(reason).unwrap(), name);
        assert_eq!(
            serde_json::from_value::<Reason>(name.into()).unwrap(),
            *reason
        );
        assert_eq!(reason.as_str(), name);
        let facts = clean(*reason);
        assert!(attribute(&facts).is_ok(), "{name}");
    }
    assert!(serde_json::from_value::<Reason>("ITEM_NOT_RECEIVED".into()).is_err());
}

#[test]
fn generated_sets_hold_one_policy_per_rule() {
    let sets = attribution_sets();
    assert_eq!(
        sets.iter().map(|(l, _)| *l).collect::<Vec<_>>(),
        [
            Liable::Operator,
            Liable::Keelson,
            Liable::Merchant,
            Liable::User
        ]
    );
    let total: usize = sets.iter().map(|(_, s)| s.policies().count()).sum();
    assert_eq!(total, RULES.len());
    for (liable, set) in sets {
        for p in set.policies() {
            let id: u8 = p.id().to_string()[1..].parse().unwrap();
            let rule = RULES.iter().find(|r| r.id == id).unwrap();
            assert_eq!(rule.liable, *liable);
        }
    }
    let text = attribution_policy_text(&RULES);
    assert_eq!(text.matches("permit(").count(), RULES.len());
    assert_eq!(text, attribution_policy_text(&RULES), "deterministic");
}

#[test]
fn liable_codes_are_the_verdict_codes() {
    assert_eq!(Liable::Operator as u8, 1);
    assert_eq!(Liable::Keelson as u8, 2);
    assert_eq!(Liable::Merchant as u8, 3);
    assert_eq!(Liable::User as u8, 4);
}
