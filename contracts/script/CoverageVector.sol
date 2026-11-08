// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {KeelsonTypes} from "../src/libraries/KeelsonTypes.sol";
import {PasskeyAssertion} from "../src/libraries/PasskeyAssertion.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice A coverage captured live (`test/vectors/coverage-*.json`): the demo mandate signed with a real passkey,
/// countersigned by the live legs, and the `Coverage` the operator signs for it.
struct Vector {
    KeelsonTypes.Coverage coverage;
    KeelsonTypes.Countersign countersign;
    bytes32 hSd;
    PasskeyAssertion.Assertion assertion;
    bytes32 qx;
    bytes32 qy;
    bytes countersigs;
    bytes tdx;
    bytes nitro;
    bytes32 digest;
    bytes32 userKeyHash;
    bool degraded;
    address vault;
}

library CoverageVector {
    using stdJson for string;

    /// @dev The premium the risk model will set; 1% until it does.
    uint256 internal constant PREMIUM_BPS = 100;

    /// @notice The vector in `json`, with the `Coverage` for `merchant` whose window ends `disputeWindow` after the
    /// countersign was issued.
    function read(string memory json, address merchant, uint40 disputeWindow) internal pure returns (Vector memory v) {
        v.vault = json.readAddress(".vault");
        v.countersign = _countersign(json);
        v.hSd = json.readBytes32(".hSd");
        v.assertion.r = json.readBytes32(".encodedAssertion.r");
        v.assertion.s = json.readBytes32(".encodedAssertion.s");
        v.assertion.challengeIndex = json.readUint(".encodedAssertion.challengeIndex");
        v.assertion.typeIndex = json.readUint(".encodedAssertion.typeIndex");
        v.assertion.authenticatorData = json.readBytes(".encodedAssertion.authenticatorData");
        v.assertion.clientDataJSON = json.readString(".encodedAssertion.clientDataJSON");
        v.qx = json.readBytes32(".qx");
        v.qy = json.readBytes32(".qy");
        v.tdx = json.readBytes(".signatures.tdx");
        v.degraded = keccak256(bytes(json.readString(".mode"))) == keccak256("degraded");
        if (!v.degraded) v.nitro = json.readBytes(".signatures.nitro");
        v.countersigs = bytes.concat(v.tdx, v.nitro);
        v.digest = json.readBytes32(".digest");
        v.userKeyHash = json.readBytes32(".userKeyHash");

        uint96 amount = uint96(v.countersign.amount * 10_000);
        v.coverage = KeelsonTypes.Coverage({
            coverageId: v.countersign.requestId,
            agentId: v.countersign.agentId,
            merchant: merchant,
            amount: amount,
            premium: uint96(amount * PREMIUM_BPS / 10_000),
            expiresAt: v.countersign.issuedAt + disputeWindow,
            mandateHash: v.countersign.mandateHash,
            amberCommitment: keccak256(abi.encode("amber", v.countersign.requestId))
        });
    }

    function _countersign(string memory json) private pure returns (KeelsonTypes.Countersign memory c) {
        c.requestId = json.readBytes32(".countersign.requestId");
        c.mandateHash = json.readBytes32(".countersign.mandateHash");
        c.mandateCommitment = json.readBytes32(".countersign.mandateCommitment");
        c.cartHash = json.readBytes32(".countersign.cartHash");
        c.agentId = json.readUint(".countersign.agentId");
        c.merchantId = json.readBytes32(".countersign.merchantId");
        c.amount = uint64(json.readUint(".countersign.amount"));
        c.currency = uint16(json.readUint(".countersign.currency"));
        c.category = uint8(json.readUint(".countersign.category"));
        c.evidenceRoot = json.readBytes32(".countersign.evidenceRoot");
        c.evalHash = json.readBytes32(".countersign.evalHash");
        c.policySetHash = json.readBytes32(".countersign.policySetHash");
        c.decision = uint8(json.readUint(".countersign.decision"));
        c.failedFieldsMask = uint32(json.readUint(".countersign.failedFieldsMask"));
        c.issuedAt = uint40(json.readUint(".countersign.issuedAt"));
        c.expiresAt = uint40(json.readUint(".countersign.expiresAt"));
    }
}
