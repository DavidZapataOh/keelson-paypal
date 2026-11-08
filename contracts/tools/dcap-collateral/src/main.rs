//! Checks that Automata's on-chain PCCS holds current collateral for a TDX quote, so the quote
//! verifies on-chain.
//!
//! ```text
//! dcap-collateral <rpc-url> <quote-hex>
//! ```
//!
//! Lists the collateral the chain is missing or holds expired and exits 1 if there is any. On
//! Automata's v1.1 deployments the TCB info and identities from TCB evaluation data number 17 on
//! are published by Automata's attester, so a missing FMSPC is fixed by registering it in Automata's
//! DCAP Dashboard for that network.

use std::process::ExitCode;

use anyhow::{bail, Context, Result};
use automata_dcap_network_registry::Network;
use automata_dcap_qpl::{CollateralError, PccsReader};

async fn check(rpc: &str, quote: &[u8]) -> Result<bool> {
    let probe = Network::default_network(None)
        .context("no default network")?
        .create_provider(Some(rpc), None)?;
    let network = Network::from_provider(&probe, None).await?;
    let provider = network.create_provider(Some(rpc), None)?;
    match PccsReader::from_network(&provider, network)
        .find_missing_collaterals_from_quote(quote, false, None)
        .await
    {
        Ok(_) => {
            println!("{}: all collateral present", network.chain_id);
            Ok(true)
        }
        Err(CollateralError::Missing(report)) => {
            println!("{}: {} missing\n{report}", network.chain_id, report.len());
            Ok(false)
        }
        Err(CollateralError::Validation(message)) => bail!("{message}"),
    }
}

fn run() -> Result<bool> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [rpc, quote] = args.as_slice() else {
        bail!("usage: dcap-collateral <rpc-url> <quote-hex>");
    };
    let quote =
        hex::decode(quote.trim().trim_start_matches("0x")).context("the quote is not hex")?;
    tokio::runtime::Runtime::new()?.block_on(check(rpc, &quote))
}

fn main() -> ExitCode {
    match run() {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(e) => {
            eprintln!("dcap-collateral: {e:#}");
            ExitCode::from(2)
        }
    }
}
