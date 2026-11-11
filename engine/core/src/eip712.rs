//! EIP-712 types of the Keelson protocol.

use alloy_primitives::{Address, U256};
use alloy_sol_types::{Eip712Domain, sol};

use crate::Error;

const ARBITRUM_SEPOLIA: u64 = 421_614;
const ARBITRUM_ONE: u64 = 42_161;

sol! {
    struct Countersign {
        bytes32 requestId;
        bytes32 mandateHash;
        bytes32 mandateCommitment;
        bytes32 cartHash;
        uint256 agentId;
        bytes32 merchantId;
        uint64 amount;
        uint16 currency;
        uint8 category;
        bytes32 evidenceRoot;
        bytes32 evalHash;
        bytes32 policySetHash;
        uint8 decision;
        uint32 failedFieldsMask;
        uint40 issuedAt;
        uint40 expiresAt;
    }

    struct Verdict {
        bytes32 disputeId;
        bytes32 coverageId;
        uint256 agentId;
        address payee;
        uint96 amount;
        uint8 ruleId;
        uint8 liable;
        uint8 fieldId;
        bytes32 evidenceHash;
        bytes32 inputsHash;
        bytes32 policySetHash;
        bytes32 checkpointRoot;
        uint40 issuedAt;
        uint40 deadline;
    }

    struct Checkpoint {
        bytes32 origin;
        uint64 treeSize;
        bytes32 rootHash;
    }

    struct Coverage {
        bytes32 coverageId;
        uint256 agentId;
        address merchant;
        uint96 amount;
        uint96 premium;
        uint40 expiresAt;
        bytes32 mandateHash;
        bytes32 amberCommitment;
        bytes32 userKeyHash;
    }

    struct CoverageBatch {
        uint256 agentId;
        bytes32 root;
        uint128 total;
        uint96 premium;
        uint40 expiresAt;
        bytes32 checkpointRoot;
        uint64 treeSize;
    }

    struct AmberAttestation {
        bytes32 coverageId;
        uint256 agentId;
        bytes32 amberCommitment;
    }

    struct WithdrawalRequest {
        uint256 agentId;
        uint128 amount;
        address to;
        uint256 nonce;
        uint256 deadline;
    }

    struct PayoutAddress {
        address merchant;
        address payout;
        uint256 nonce;
        uint256 deadline;
    }

    struct Claim {
        address account;
        address to;
        uint256 nonce;
        uint256 deadline;
    }

    struct CardAuthorization {
        bytes32 requestId;
        bytes32 countersignDigest;
        bytes32 authorizationHash;
        bytes32 merchantHash;
        uint16 mcc;
        bytes2 country;
        uint64 amount;
        uint16 currency;
        uint8 decision;
        uint32 failedMask;
        uint40 issuedAt;
    }

    struct CardSettlement {
        bytes32 requestId;
        bytes32 cardRef;
        bytes32 transactionHash;
        uint64 settledMinor;
        uint16 currency;
        uint8 status;
        uint40 settledAt;
        uint40 observedAt;
    }

    struct WebFact {
        bytes32 hostHash;
        bytes32 urlPathHash;
        uint40 tCapture;
        bytes32 rangeCommitment;
        bytes32 attId;
    }
}

/// Builds the Keelson EIP-712 domain; only Arbitrum Sepolia and Arbitrum One are accepted.
pub fn domain(chain_id: u64, verifying_contract: Address) -> Result<Eip712Domain, Error> {
    if chain_id != ARBITRUM_SEPOLIA && chain_id != ARBITRUM_ONE {
        return Err(Error::UnsupportedChain(chain_id));
    }
    Ok(Eip712Domain::new(
        Some("Keelson".into()),
        Some("1".into()),
        Some(U256::from(chain_id)),
        Some(verifying_contract),
        None,
    ))
}
